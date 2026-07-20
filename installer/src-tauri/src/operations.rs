use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use fs2::FileExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::bundle::{safe_join, sha256_file, BundleFile, VerifiedBundle};
use crate::models::{
    ClientError, FileCondition, FileStatus, InstallerPhase, InstallerStatus, OperationOutcome,
};
use crate::state::{
    read_state, validate_managed_mirror, InstalledState, ManagedFilesState, STATE_SCHEMA_VERSION,
};

const CONTROL_DIRECTORY: &str = ".lidfly-installer";
const INSTALLED_STATE: &str = ".lidfly-installer/installed-state.json";
const MANAGED_STATE: &str = ".lidfly-installer/managed-files.json";

#[derive(Debug, Clone)]
pub struct InstallLayout {
    pub marketplace_root: PathBuf,
    pub marketplace_manifest: PathBuf,
    control_root: PathBuf,
    installed_state: PathBuf,
    managed_state: PathBuf,
    logs_root: PathBuf,
}

impl InstallLayout {
    pub fn new(app_data_dir: &Path) -> Self {
        let marketplace_root = app_data_dir.join("marketplace");
        let control_root = marketplace_root.join(CONTROL_DIRECTORY);
        Self {
            marketplace_manifest: marketplace_root.join(".agents/plugins/marketplace.json"),
            installed_state: control_root.join("installed-state.json"),
            managed_state: control_root.join("managed-files.json"),
            logs_root: control_root.join("logs"),
            marketplace_root,
            control_root,
        }
    }
}

#[derive(Debug)]
pub struct InstallerCore {
    pub layout: InstallLayout,
    pub bundle: VerifiedBundle,
    pub app_version: String,
}

struct OperationLock {
    file: File,
}

impl Drop for OperationLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailPoint {
    None,
    BeforeAuthoritativeState,
    AfterFirstManagedFile,
}

#[derive(Debug, Serialize, Deserialize)]
struct TransactionJournal {
    schema_version: u32,
    target_bundle_sha256: String,
    entries: Vec<TransactionEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TransactionEntry {
    target: String,
    prepared: String,
    previous: String,
    existed: bool,
    new_sha256: String,
}

struct PreparedTransaction {
    root: PathBuf,
    journal: TransactionJournal,
}

#[derive(Debug)]
struct Classification {
    status: InstallerStatus,
    state: Option<InstalledState>,
    state_consistent: bool,
}

fn create_secure_dir(path: &Path) -> Result<(), ClientError> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_secure_file(path: &Path, bytes: &[u8]) -> Result<(), ClientError> {
    if let Some(parent) = path.parent() {
        create_secure_dir(parent)?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn ensure_root_safe(root: &Path) -> Result<(), ClientError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(ClientError::new(
            "unsafe_marketplace_root",
            "Каталог marketplace заменён ссылкой или файлом. Операция остановлена.",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn ensure_target_parent_safe(root: &Path, relative: &str) -> Result<PathBuf, ClientError> {
    let target = safe_join(root, relative)?;
    let parent = target.parent().ok_or_else(|| {
        ClientError::new(
            "unsafe_path",
            format!("У пути нет родительского каталога: {relative}"),
        )
    })?;
    let relative_parent = parent.strip_prefix(root).map_err(|_| {
        ClientError::new(
            "unsafe_path",
            format!("Путь выходит за пределы marketplace: {relative}"),
        )
    })?;
    let mut current = root.to_path_buf();
    create_secure_dir(root)?;
    for component in relative_parent.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(ClientError::new(
                    "unsafe_parent",
                    format!("Родительский путь небезопасен: {relative}"),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                create_secure_dir(&current)?
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(target)
}

fn relative_slashes(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

impl InstallerCore {
    pub fn new(
        layout: InstallLayout,
        bundle: VerifiedBundle,
        app_version: impl Into<String>,
    ) -> Self {
        Self {
            layout,
            bundle,
            app_version: app_version.into(),
        }
    }

    fn lock(&self) -> Result<OperationLock, ClientError> {
        ensure_root_safe(&self.layout.marketplace_root)?;
        create_secure_dir(&self.layout.control_root)?;
        let lock_path = self.layout.control_root.join("operation.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(lock_path)?;
        file.try_lock_exclusive().map_err(|_| {
            ClientError::new(
                "operation_in_progress",
                "Другая копия установщика уже меняет файлы. Дождитесь завершения и повторите.",
            )
        })?;
        Ok(OperationLock { file })
    }

    pub fn status(&self) -> Result<InstallerStatus, ClientError> {
        let _lock = self.lock()?;
        self.recover_transactions()?;
        Ok(self.classify()?.status)
    }

    fn classify(&self) -> Result<Classification, ClientError> {
        ensure_root_safe(&self.layout.marketplace_root)?;
        let state = read_state(&self.layout.installed_state)?;
        let state_consistent = state.as_ref().is_some_and(|installed| {
            validate_managed_mirror(&self.layout.managed_state, installed).is_ok()
        });
        let previous: BTreeMap<&str, &BundleFile> = state
            .as_ref()
            .map(|installed| {
                installed
                    .managed_files
                    .iter()
                    .map(|file| (file.path.as_str(), file))
                    .collect()
            })
            .unwrap_or_default();

        let mut files = Vec::with_capacity(self.bundle.metadata.files.len());
        for expected in &self.bundle.metadata.files {
            let target = safe_join(&self.layout.marketplace_root, &expected.path)?;
            let (condition, actual_sha256) = match fs::symlink_metadata(&target) {
                Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                    (FileCondition::Unsafe, None)
                }
                Ok(_) => {
                    let (actual, _) = sha256_file(&target)?;
                    let condition = if actual == expected.sha256 {
                        FileCondition::Unchanged
                    } else if previous
                        .get(expected.path.as_str())
                        .is_some_and(|record| record.sha256 == actual)
                    {
                        FileCondition::Outdated
                    } else {
                        FileCondition::Modified
                    };
                    (condition, Some(actual))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    (FileCondition::Missing, None)
                }
                Err(error) => return Err(error.into()),
            };
            files.push(FileStatus {
                path: expected.path.clone(),
                condition,
                expected_sha256: expected.sha256.clone(),
                actual_sha256,
            });
        }
        let unknown_files = self.find_unknown_files()?;
        let has_modified = files.iter().any(|file| {
            matches!(
                file.condition,
                FileCondition::Modified | FileCondition::Unsafe
            )
        });
        let all_current = files
            .iter()
            .all(|file| file.condition == FileCondition::Unchanged);
        let installed_version = state
            .as_ref()
            .map(|installed| installed.plugin_version.clone());
        let state_matches = state.as_ref().is_some_and(|installed| {
            installed.plugin_version == self.bundle.metadata.plugin_version
                && installed.plugin_bundle_sha256 == self.bundle.metadata.plugin_bundle_sha256
                && state_consistent
        });
        let any_present = files
            .iter()
            .any(|file| file.condition != FileCondition::Missing);
        let phase = if has_modified {
            InstallerPhase::ModifiedFiles
        } else if state.is_some() && !state_consistent {
            InstallerPhase::IncompleteState
        } else if all_current && state_matches {
            InstallerPhase::InstalledBundle
        } else if any_present || state.is_some() {
            InstallerPhase::IncompleteState
        } else {
            InstallerPhase::NotPrepared
        };
        let installed_semver = installed_version
            .as_deref()
            .and_then(|value| Version::parse(value).ok());
        let embedded_semver = Version::parse(&self.bundle.metadata.plugin_version).ok();
        let downgrade_detected =
            matches!((installed_semver, embedded_semver), (Some(a), Some(b)) if a > b);
        let update_required = state.as_ref().is_some_and(|installed| {
            installed.plugin_bundle_sha256 != self.bundle.metadata.plugin_bundle_sha256
        });
        let can_open_codex = all_current && state_matches;

        Ok(Classification {
            status: InstallerStatus {
                app_version: self.app_version.clone(),
                embedded_plugin_version: self.bundle.metadata.plugin_version.clone(),
                installed_plugin_version: installed_version,
                plugin_bundle_sha256: self.bundle.metadata.plugin_bundle_sha256.clone(),
                marketplace_path: self
                    .layout
                    .marketplace_manifest
                    .to_string_lossy()
                    .into_owned(),
                phase,
                files,
                unknown_files,
                can_open_codex,
                needs_repair: has_modified || !state_consistent && state.is_some(),
                update_required,
                downgrade_detected,
            },
            state,
            state_consistent,
        })
    }

    fn find_unknown_files(&self) -> Result<Vec<String>, ClientError> {
        if !self.layout.marketplace_root.exists() {
            return Ok(Vec::new());
        }
        let expected: BTreeSet<&str> = self
            .bundle
            .metadata
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        let mut unknown = Vec::new();
        for entry in WalkDir::new(&self.layout.marketplace_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry
                    .path()
                    .strip_prefix(&self.layout.marketplace_root)
                    .map(|relative| !relative.starts_with(CONTROL_DIRECTORY))
                    .unwrap_or(false)
                    || entry.depth() == 0
            })
        {
            let entry = entry.map_err(|error| {
                ClientError::new(
                    "walk_error",
                    format!("Не удалось проверить marketplace: {error}"),
                )
            })?;
            if entry.depth() == 0 || entry.file_type().is_dir() {
                continue;
            }
            let relative = relative_slashes(
                entry
                    .path()
                    .strip_prefix(&self.layout.marketplace_root)
                    .map_err(|_| {
                        ClientError::new("unsafe_path", "Путь вышел за marketplace root.")
                    })?,
            );
            if !expected.contains(relative.as_str()) {
                unknown.push(relative);
            }
        }
        unknown.sort();
        Ok(unknown)
    }

    pub fn prepare(
        &self,
        allow_modified: bool,
        allow_downgrade: bool,
        fail_point: FailPoint,
    ) -> Result<OperationOutcome, ClientError> {
        let _lock = self.lock()?;
        self.recover_transactions()?;
        let classification = self.classify()?;
        if classification.status.downgrade_detected && !allow_downgrade {
            return Err(ClientError::new(
                "downgrade_confirmation_required",
                "На компьютере подготовлена более новая версия. Понижение требует отдельного подтверждения.",
            ));
        }
        let conflicts: Vec<String> = classification
            .status
            .files
            .iter()
            .filter(|file| {
                matches!(
                    file.condition,
                    FileCondition::Modified | FileCondition::Unsafe
                )
            })
            .map(|file| file.path.clone())
            .collect();
        if !conflicts.is_empty() && !allow_modified {
            return Err(ClientError::new(
                "modified_files_confirmation_required",
                "Найдены изменённые файлы. Они не были перезаписаны.",
            )
            .with_details(conflicts));
        }
        if classification.status.can_open_codex && !classification.status.update_required {
            return Ok(OperationOutcome {
                status: classification.status,
                message: "Файлы уже подготовлены и прошли проверку.".to_owned(),
                changed_files: Vec::new(),
                preserved_files: Vec::new(),
                backup_directory: None,
            });
        }

        let transaction_id = Uuid::new_v4().to_string();
        let transaction_root = self
            .layout
            .control_root
            .join("transactions")
            .join(&transaction_id);
        let prepared_root = transaction_root.join("prepared");
        let previous_root = transaction_root.join("previous");
        create_secure_dir(&prepared_root)?;
        create_secure_dir(&previous_root)?;

        let mut changed_files = Vec::new();
        let mut backup_directory = None;
        let mut entries = Vec::new();
        let replace_paths: BTreeSet<&str> = classification
            .status
            .files
            .iter()
            .filter(|file| file.condition != FileCondition::Unchanged)
            .map(|file| file.path.as_str())
            .collect();
        if classification.status.files.iter().any(|file| {
            replace_paths.contains(file.path.as_str())
                && file.condition != FileCondition::Missing
                && file.condition != FileCondition::Unsafe
        }) {
            let backup_root = self.layout.control_root.join("backups").join(format!(
                "{}-{}",
                Utc::now().format("%Y%m%dT%H%M%SZ"),
                transaction_id
            ));
            create_secure_dir(&backup_root)?;
            for file in &classification.status.files {
                if replace_paths.contains(file.path.as_str())
                    && file.condition != FileCondition::Missing
                {
                    let source = safe_join(&self.layout.marketplace_root, &file.path)?;
                    let metadata = fs::symlink_metadata(&source)?;
                    if !metadata.is_file() || metadata.file_type().is_symlink() {
                        return Err(ClientError::new(
                            "unsafe_modified_file",
                            format!("Нельзя безопасно создать backup: {}", file.path),
                        ));
                    }
                    let backup = safe_join(&backup_root, &file.path)?;
                    let bytes = fs::read(source)?;
                    write_secure_file(&backup, &bytes)?;
                }
            }
            backup_directory = Some(format!(
                "{CONTROL_DIRECTORY}/backups/{}",
                backup_root.file_name().unwrap().to_string_lossy()
            ));
        }

        for file in &self.bundle.metadata.files {
            if !replace_paths.contains(file.path.as_str()) {
                continue;
            }
            let source = safe_join(&self.bundle.root, &file.path)?;
            let prepared = safe_join(&prepared_root, &file.path)?;
            write_secure_file(&prepared, &fs::read(source)?)?;
            let (sha256, size) = sha256_file(&prepared)?;
            if sha256 != file.sha256 || size != file.size {
                return Err(ClientError::new(
                    "staging_validation_failed",
                    format!("Проверка staging не прошла: {}", file.path),
                ));
            }
            changed_files.push(file.path.clone());
            entries.push(self.transaction_entry(
                &transaction_root,
                &prepared,
                &previous_root.join(entries.len().to_string()),
                &file.path,
                &file.sha256,
            )?);
        }

        let installed_state = InstalledState {
            schema_version: STATE_SCHEMA_VERSION,
            installer_version: self.app_version.clone(),
            plugin_version: self.bundle.metadata.plugin_version.clone(),
            plugin_bundle_sha256: self.bundle.metadata.plugin_bundle_sha256.clone(),
            installed_at: Utc::now().to_rfc3339(),
            managed_files: self.bundle.metadata.files.clone(),
        };
        let managed_state = ManagedFilesState {
            schema_version: STATE_SCHEMA_VERSION,
            files: self.bundle.metadata.files.clone(),
        };
        let managed_prepared = prepared_root.join("managed-files.json");
        let installed_prepared = prepared_root.join("installed-state.json");
        write_secure_file(
            &managed_prepared,
            &serde_json::to_vec_pretty(&managed_state)?,
        )?;
        write_secure_file(
            &installed_prepared,
            &serde_json::to_vec_pretty(&installed_state)?,
        )?;
        let (managed_sha, _) = sha256_file(&managed_prepared)?;
        let (installed_sha, _) = sha256_file(&installed_prepared)?;
        entries.push(self.transaction_entry(
            &transaction_root,
            &managed_prepared,
            &previous_root.join(entries.len().to_string()),
            MANAGED_STATE,
            &managed_sha,
        )?);
        entries.push(self.transaction_entry(
            &transaction_root,
            &installed_prepared,
            &previous_root.join(entries.len().to_string()),
            INSTALLED_STATE,
            &installed_sha,
        )?);

        let transaction = PreparedTransaction {
            root: transaction_root,
            journal: TransactionJournal {
                schema_version: 1,
                target_bundle_sha256: self.bundle.metadata.plugin_bundle_sha256.clone(),
                entries,
            },
        };
        self.commit_transaction(transaction, fail_point)?;
        let final_status = self.classify()?.status;
        self.audit("prepare", "success", &changed_files)?;
        Ok(OperationOutcome {
            status: final_status,
            message: "Официальный плагин LidFly безопасно подготовлен. Теперь подтвердите установку в Codex.".to_owned(),
            changed_files,
            preserved_files: classification.status.unknown_files,
            backup_directory,
        })
    }

    fn transaction_entry(
        &self,
        transaction_root: &Path,
        prepared: &Path,
        previous: &Path,
        target_relative: &str,
        new_sha256: &str,
    ) -> Result<TransactionEntry, ClientError> {
        let target = safe_join(&self.layout.marketplace_root, target_relative)?;
        let existed = match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => true,
            Ok(_) => {
                return Err(ClientError::new(
                    "unsafe_target",
                    format!("Нельзя заменить небезопасный путь: {target_relative}"),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        Ok(TransactionEntry {
            target: target_relative.to_owned(),
            prepared: relative_slashes(prepared.strip_prefix(transaction_root).map_err(|_| {
                ClientError::new(
                    "unsafe_transaction",
                    "Prepared path вышел за transaction root.",
                )
            })?),
            previous: relative_slashes(previous.strip_prefix(transaction_root).map_err(|_| {
                ClientError::new(
                    "unsafe_transaction",
                    "Previous path вышел за transaction root.",
                )
            })?),
            existed,
            new_sha256: new_sha256.to_owned(),
        })
    }

    fn commit_transaction(
        &self,
        transaction: PreparedTransaction,
        fail_point: FailPoint,
    ) -> Result<(), ClientError> {
        let journal_path = transaction.root.join("journal.json");
        write_secure_file(
            &journal_path,
            &serde_json::to_vec_pretty(&transaction.journal)?,
        )?;
        let commit_result = (|| {
            for (index, entry) in transaction.journal.entries.iter().enumerate() {
                if fail_point == FailPoint::BeforeAuthoritativeState
                    && entry.target == INSTALLED_STATE
                {
                    return Err(ClientError::new(
                        "injected_failure",
                        "Имитирован сбой до записи authoritative state.",
                    ));
                }
                if fail_point == FailPoint::AfterFirstManagedFile && index == 1 {
                    return Err(ClientError::new(
                        "injected_failure",
                        "Имитирован сбой во время переключения файлов.",
                    ));
                }
                let target =
                    ensure_target_parent_safe(&self.layout.marketplace_root, &entry.target)?;
                let prepared = safe_join(&transaction.root, &entry.prepared)?;
                let previous = safe_join(&transaction.root, &entry.previous)?;
                if entry.existed {
                    if let Some(parent) = previous.parent() {
                        create_secure_dir(parent)?;
                    }
                    fs::rename(&target, &previous)?;
                }
                if let Err(error) = fs::rename(&prepared, &target) {
                    if entry.existed && previous.exists() {
                        let _ = fs::rename(&previous, &target);
                    }
                    return Err(error.into());
                }
            }
            Ok(())
        })();
        if let Err(error) = commit_result {
            self.rollback_transaction(&transaction.root, &transaction.journal)?;
            let _ = fs::remove_dir_all(&transaction.root);
            return Err(error);
        }
        fs::remove_dir_all(&transaction.root)?;
        Ok(())
    }

    fn rollback_transaction(
        &self,
        transaction_root: &Path,
        journal: &TransactionJournal,
    ) -> Result<(), ClientError> {
        for entry in journal.entries.iter().rev() {
            let target = safe_join(&self.layout.marketplace_root, &entry.target)?;
            let previous = safe_join(transaction_root, &entry.previous)?;
            if previous.exists() {
                if target.exists() {
                    let metadata = fs::symlink_metadata(&target)?;
                    if metadata.is_file() && !metadata.file_type().is_symlink() {
                        fs::remove_file(&target)?;
                    } else {
                        return Err(ClientError::new(
                            "rollback_unsafe_target",
                            format!("Rollback остановлен на небезопасном пути: {}", entry.target),
                        ));
                    }
                }
                ensure_target_parent_safe(&self.layout.marketplace_root, &entry.target)?;
                fs::rename(previous, target)?;
            } else if !entry.existed && target.exists() {
                let metadata = fs::symlink_metadata(&target)?;
                if metadata.is_file() && !metadata.file_type().is_symlink() {
                    let (current_sha256, _) = sha256_file(&target)?;
                    if current_sha256 == entry.new_sha256 {
                        fs::remove_file(target)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn recover_transactions(&self) -> Result<(), ClientError> {
        let transactions_root = self.layout.control_root.join("transactions");
        let entries = match fs::read_dir(&transactions_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let metadata = entry.file_type()?;
            if !metadata.is_dir() || metadata.is_symlink() {
                return Err(ClientError::new(
                    "unsafe_transaction",
                    "В каталоге транзакций найден неизвестный объект.",
                ));
            }
            let transaction_root = entry.path();
            let journal_path = transaction_root.join("journal.json");
            if !journal_path.exists() {
                fs::remove_dir_all(transaction_root)?;
                continue;
            }
            let journal: TransactionJournal = serde_json::from_slice(&fs::read(&journal_path)?)?;
            if journal.schema_version != 1 {
                return Err(ClientError::new(
                    "unsupported_transaction_schema",
                    "Нельзя безопасно восстановить неизвестную версию транзакции.",
                ));
            }
            let committed = read_state(&self.layout.installed_state)?
                .is_some_and(|state| state.plugin_bundle_sha256 == journal.target_bundle_sha256);
            if !committed {
                self.rollback_transaction(&transaction_root, &journal)?;
            }
            fs::remove_dir_all(transaction_root)?;
        }
        Ok(())
    }

    pub fn remove(&self) -> Result<OperationOutcome, ClientError> {
        let _lock = self.lock()?;
        self.recover_transactions()?;
        let classification = self.classify()?;
        let Some(state) = classification.state.as_ref() else {
            return Ok(OperationOutcome {
                status: classification.status,
                message: "Подготовленных файлов нет.".to_owned(),
                changed_files: Vec::new(),
                preserved_files: Vec::new(),
                backup_directory: None,
            });
        };
        let removal_root = self
            .layout
            .control_root
            .join("removals")
            .join(Uuid::new_v4().to_string());
        create_secure_dir(&removal_root)?;
        let mut removed = Vec::new();
        let mut preserved = Vec::new();
        let mut moved = Vec::new();
        let movement_result = (|| {
            for managed in &state.managed_files {
                let target = safe_join(&self.layout.marketplace_root, &managed.path)?;
                match fs::symlink_metadata(&target) {
                    Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                        let (actual, _) = sha256_file(&target)?;
                        if actual == managed.sha256 {
                            let holding = safe_join(&removal_root, &managed.path)?;
                            if let Some(parent) = holding.parent() {
                                create_secure_dir(parent)?;
                            }
                            fs::rename(&target, &holding)?;
                            moved.push((target, holding));
                            removed.push(managed.path.clone());
                        } else {
                            preserved.push(managed.path.clone());
                        }
                    }
                    Ok(_) => preserved.push(managed.path.clone()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            Ok::<(), ClientError>(())
        })();
        if let Err(error) = movement_result {
            self.restore_removal_files(&moved)?;
            let _ = fs::remove_dir_all(&removal_root);
            return Err(error);
        }

        let remaining: Vec<BundleFile> = state
            .managed_files
            .iter()
            .filter(|file| preserved.contains(&file.path))
            .cloned()
            .collect();
        let state_result = if remaining.is_empty() {
            self.move_state_for_removal(&removal_root, &mut moved)
        } else {
            let updated = InstalledState {
                managed_files: remaining.clone(),
                ..state.clone()
            };
            self.replace_state_files(&removal_root, &updated, &remaining, &mut moved)
        };
        if let Err(error) = state_result {
            self.restore_removal_files(&moved)?;
            return Err(error);
        }
        fs::remove_dir_all(&removal_root)?;
        self.remove_empty_managed_directories()?;
        let final_status = self.classify()?;
        self.audit("remove", "success", &removed)?;
        Ok(OperationOutcome {
            status: final_status.status,
            message: if preserved.is_empty() {
                "Подготовленные файлы удалены. Плагин и OAuth в Codex не изменялись.".to_owned()
            } else {
                "Неизменённые файлы удалены. Изменённые файлы сохранены.".to_owned()
            },
            changed_files: removed,
            preserved_files: preserved,
            backup_directory: None,
        })
    }

    fn restore_removal_files(&self, moved: &[(PathBuf, PathBuf)]) -> Result<(), ClientError> {
        for (target, holding) in moved.iter().rev() {
            if holding.exists() {
                if target.exists() {
                    let metadata = fs::symlink_metadata(target)?;
                    if metadata.is_file() && !metadata.file_type().is_symlink() {
                        fs::remove_file(target)?;
                    }
                }
                if let Some(parent) = target.parent() {
                    create_secure_dir(parent)?;
                }
                fs::rename(holding, target)?;
            }
        }
        Ok(())
    }

    fn move_state_for_removal(
        &self,
        removal_root: &Path,
        moved: &mut Vec<(PathBuf, PathBuf)>,
    ) -> Result<(), ClientError> {
        for (index, target) in [&self.layout.managed_state, &self.layout.installed_state]
            .into_iter()
            .enumerate()
        {
            if target.exists() {
                let holding = removal_root.join(format!("state-{index}"));
                fs::rename(target, &holding)?;
                moved.push((target.clone(), holding));
            }
        }
        Ok(())
    }

    fn replace_state_files(
        &self,
        removal_root: &Path,
        state: &InstalledState,
        remaining: &[BundleFile],
        moved: &mut Vec<(PathBuf, PathBuf)>,
    ) -> Result<(), ClientError> {
        let new_managed = removal_root.join("new-managed.json");
        let new_installed = removal_root.join("new-installed.json");
        write_secure_file(
            &new_managed,
            &serde_json::to_vec_pretty(&ManagedFilesState {
                schema_version: STATE_SCHEMA_VERSION,
                files: remaining.to_vec(),
            })?,
        )?;
        write_secure_file(&new_installed, &serde_json::to_vec_pretty(state)?)?;
        for (index, (target, prepared)) in [
            (&self.layout.managed_state, &new_managed),
            (&self.layout.installed_state, &new_installed),
        ]
        .into_iter()
        .enumerate()
        {
            let holding = removal_root.join(format!("old-state-{index}"));
            if target.exists() {
                fs::rename(target, &holding)?;
                moved.push((target.clone(), holding));
            }
            fs::rename(prepared, target)?;
        }
        Ok(())
    }

    fn remove_empty_managed_directories(&self) -> Result<(), ClientError> {
        const DIRECTORIES: [&str; 7] = [
            "plugins/lidfly/assets",
            "plugins/lidfly/.codex-plugin",
            "plugins/lidfly",
            "plugins",
            ".agents/plugins",
            ".agents",
            ".",
        ];
        for relative in DIRECTORIES {
            let directory = if relative == "." {
                self.layout.marketplace_root.clone()
            } else {
                safe_join(&self.layout.marketplace_root, relative)?
            };
            match fs::remove_dir(&directory) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                    ) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn audit(
        &self,
        operation: &str,
        result: &str,
        relative_paths: &[String],
    ) -> Result<(), ClientError> {
        create_secure_dir(&self.layout.logs_root)?;
        let log_path = self.layout.logs_root.join("installer.jsonl");
        let mut options = OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(log_path)?;
        let entry = serde_json::json!({
            "time": Utc::now().to_rfc3339(),
            "installer_version": self.app_version,
            "operation": operation,
            "result": result,
            "relative_paths": relative_paths,
        });
        writeln!(file, "{}", serde_json::to_string(&entry)?)?;
        Ok(())
    }

    pub fn logs_root(&self) -> Result<PathBuf, ClientError> {
        create_secure_dir(&self.layout.logs_root)?;
        Ok(self.layout.logs_root.clone())
    }

    pub fn state_consistent(&self) -> Result<bool, ClientError> {
        let _lock = self.lock()?;
        self.recover_transactions()?;
        Ok(self.classify()?.state_consistent)
    }
}
