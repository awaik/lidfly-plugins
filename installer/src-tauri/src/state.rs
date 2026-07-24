use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bundle::{is_allowed_bundle_path, safe_join, BundleFile};
use crate::models::ClientError;

pub const STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstalledState {
    pub schema_version: u32,
    pub installer_version: String,
    pub plugin_version: String,
    pub plugin_bundle_sha256: String,
    pub installed_at: String,
    pub managed_files: Vec<BundleFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedFilesState {
    pub schema_version: u32,
    pub files: Vec<BundleFile>,
}

fn migrate_state(value: Value) -> Result<InstalledState, ClientError> {
    let schema = value
        .get("schema_version")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    match schema {
        1 => Ok(serde_json::from_value(value)?),
        0 => {
            let mut object = value.as_object().cloned().ok_or_else(|| {
                ClientError::new(
                    "invalid_state",
                    "Manifest установленного состояния повреждён.",
                )
            })?;
            object.insert(
                "schema_version".to_owned(),
                Value::from(STATE_SCHEMA_VERSION),
            );
            if !object.contains_key("installed_at") {
                object.insert(
                    "installed_at".to_owned(),
                    Value::String("unknown".to_owned()),
                );
            }
            Ok(serde_json::from_value(Value::Object(object))?)
        }
        other => Err(ClientError::new(
            "unsupported_state_schema",
            format!("Неподдерживаемая версия installed-state: {other}"),
        )),
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_state(state: &InstalledState) -> Result<(), ClientError> {
    if state.schema_version != STATE_SCHEMA_VERSION
        || Version::parse(&state.installer_version).is_err()
        || Version::parse(&state.plugin_version).is_err()
        || !is_sha256(&state.plugin_bundle_sha256)
        || state.installed_at.trim().is_empty()
    {
        return Err(ClientError::new(
            "invalid_state",
            "Manifest установленного состояния содержит некорректные поля.",
        ));
    }
    let mut seen = BTreeSet::new();
    for file in &state.managed_files {
        safe_join(Path::new("."), &file.path)?;
        if !is_allowed_bundle_path(&file.path)
            || !seen.insert(file.path.as_str())
            || file.size == 0
            || !is_sha256(&file.sha256)
        {
            return Err(ClientError::new(
                "invalid_state",
                "Manifest установленного состояния содержит небезопасный список файлов.",
            ));
        }
    }
    Ok(())
}

pub fn read_state(path: &Path) -> Result<Option<InstalledState>, ClientError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            let bytes = fs::read(path)?;
            let value: Value = serde_json::from_slice(&bytes)?;
            let state = migrate_state(value)?;
            validate_state(&state)?;
            Ok(Some(state))
        }
        Ok(_) => Err(ClientError::new(
            "unsafe_installed_state",
            "installed-state.json заменён ссылкой или каталогом.",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn validate_managed_mirror(path: &Path, state: &InstalledState) -> Result<(), ClientError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        ClientError::new(
            "missing_managed_state",
            format!("Не удалось проверить managed-files.json: {error}"),
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ClientError::new(
            "unsafe_managed_state",
            "managed-files.json заменён ссылкой или каталогом.",
        ));
    }
    let bytes = fs::read(path).map_err(|error| {
        ClientError::new(
            "missing_managed_state",
            format!("Не удалось прочитать managed-files.json: {error}"),
        )
    })?;
    let managed: ManagedFilesState = serde_json::from_slice(&bytes)?;
    if managed.schema_version != STATE_SCHEMA_VERSION || managed.files != state.managed_files {
        return Err(ClientError::new(
            "managed_state_mismatch",
            "managed-files.json не совпадает с authoritative installed-state.json.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{migrate_state, read_state, STATE_SCHEMA_VERSION};
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn migrates_legacy_state_without_schema_or_date() {
        let migrated = migrate_state(json!({
            "installer_version": "1.0.0",
            "plugin_version": "1.0.0",
            "plugin_bundle_sha256": "a".repeat(64),
            "managed_files": []
        }))
        .expect("legacy state should migrate");
        assert_eq!(migrated.schema_version, STATE_SCHEMA_VERSION);
        assert_eq!(migrated.installed_at, "unknown");
    }

    #[test]
    fn rejects_future_schema() {
        assert!(migrate_state(json!({"schema_version": 99})).is_err());
    }

    #[test]
    fn rejects_state_with_unmanaged_path() {
        let directory = tempdir().expect("temporary directory");
        let state_path = directory.path().join("installed-state.json");
        fs::write(
            &state_path,
            serde_json::to_vec(&json!({
                "schema_version": 1,
                "installer_version": "1.0.0",
                "plugin_version": "1.0.0",
                "plugin_bundle_sha256": "a".repeat(64),
                "installed_at": "2026-07-20T00:00:00Z",
                "managed_files": [{
                    "path": "plugins/lidfly/../../outside",
                    "size": 1,
                    "sha256": "b".repeat(64)
                }]
            }))
            .expect("serialize state"),
        )
        .expect("write state");

        let error = read_state(&state_path).expect_err("unsafe path must fail closed");
        assert!(matches!(
            error.code.as_str(),
            "unsafe_path" | "invalid_state"
        ));
    }

    #[test]
    fn rejects_state_with_invalid_hash() {
        let directory = tempdir().expect("temporary directory");
        let state_path = directory.path().join("installed-state.json");
        fs::write(
            &state_path,
            serde_json::to_vec(&json!({
                "schema_version": 1,
                "installer_version": "1.0.0",
                "plugin_version": "1.0.0",
                "plugin_bundle_sha256": "NOT-A-SHA256",
                "installed_at": "2026-07-20T00:00:00Z",
                "managed_files": []
            }))
            .expect("serialize state"),
        )
        .expect("write state");

        let error = read_state(&state_path).expect_err("invalid hash must fail closed");
        assert_eq!(error.code, "invalid_state");
    }

    #[test]
    fn accepts_state_with_generated_skill_path() {
        let directory = tempdir().expect("temporary directory");
        let state_path = directory.path().join("installed-state.json");
        fs::write(
            &state_path,
            serde_json::to_vec(&json!({
                "schema_version": 1,
                "installer_version": "1.1.0",
                "plugin_version": "1.1.0",
                "plugin_bundle_sha256": "a".repeat(64),
                "installed_at": "2026-07-24T00:00:00Z",
                "managed_files": [{
                    "path": "plugins/lidfly/skills/semantic-core/references/output-format.md",
                    "size": 1,
                    "sha256": "b".repeat(64)
                }]
            }))
            .expect("serialize state"),
        )
        .expect("write state");

        let state = read_state(&state_path).expect("skill path should be allowed");
        assert!(state.is_some());
    }
}
