use std::fs;
use std::path::{Path, PathBuf};

use fs2::FileExt;
use lidfly_codex_plugin_installer_lib::bundle::{
    verify_bundle, BundleFile, BundleMetadata, BUNDLE_BASE_PATHS,
};
use lidfly_codex_plugin_installer_lib::models::{FileCondition, InstallerPhase};
use lidfly_codex_plugin_installer_lib::operations::{FailPoint, InstallLayout, InstallerCore};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    metadata: PathBuf,
}

const TEST_SKILL_PATHS: [&str; 2] = [
    "plugins/lidfly/skills/test-skill/SKILL.md",
    "plugins/lidfly/skills/test-skill/agents/openai.yaml",
];

fn fixture_bundle_paths() -> Vec<&'static str> {
    BUNDLE_BASE_PATHS
        .into_iter()
        .chain(TEST_SKILL_PATHS)
        .collect()
}

fn fixture(version: &str) -> Fixture {
    let temp = tempfile::tempdir().expect("create fixture directory");
    let root = temp.path().join("bundle");
    let skill_documents = [
        (
            TEST_SKILL_PATHS[0],
            "---\nname: test-skill\ndescription: \"Test skill\"\n---\n".to_owned(),
        ),
        (
            TEST_SKILL_PATHS[1],
            "interface:\n  display_name: \"Test\"\n  short_description: \"Test skill fixture description\"\n".to_owned(),
        ),
    ];
    let skill_hashes = skill_documents
        .iter()
        .map(|(path, content)| {
            (
                path.rsplit_once("test-skill/")
                    .expect("test skill relative path")
                    .1,
                format!("{:x}", Sha256::digest(content.as_bytes())),
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let skills_manifest = serde_json::to_string_pretty(&serde_json::json!({
        "version": 1,
        "skills": {
            "test-skill": skill_hashes
        }
    }))
    .expect("serialize skills manifest");
    let mut documents = vec![
        (
            BUNDLE_BASE_PATHS[0],
            r#"{"name":"lidfly","interface":{"displayName":"LidFly"},"plugins":[{"name":"lidfly","source":{"source":"local","path":"./plugins/lidfly"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Data & Analytics"}]}"#.to_owned(),
        ),
        (
            BUNDLE_BASE_PATHS[1],
            format!(r#"{{"name":"lidfly","version":"{version}","skills":"./skills/","mcpServers":"./.mcp.json"}}"#),
        ),
        (
            BUNDLE_BASE_PATHS[2],
            r#"{"mcpServers":{"lidfly":{"type":"http","url":"https://lidfly.ru/mcp/v3"}}}"#.to_owned(),
        ),
        (
            BUNDLE_BASE_PATHS[3],
            format!("<svg><title>icon-{version}</title></svg>"),
        ),
        (
            BUNDLE_BASE_PATHS[4],
            format!("<svg><title>dark-{version}</title></svg>"),
        ),
        (
            BUNDLE_BASE_PATHS[5],
            format!("<svg><title>logo-{version}</title></svg>"),
        ),
        (BUNDLE_BASE_PATHS[6], skills_manifest),
    ];
    documents.extend(skill_documents);
    let mut records = Vec::new();
    let mut bundle_digest = Sha256::new();
    for (relative, content) in documents {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("file parent")).expect("create fixture parent");
        fs::write(&path, content.as_bytes()).expect("write fixture file");
        let sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
        records.push(BundleFile {
            path: relative.to_owned(),
            size: content.len() as u64,
            sha256,
        });
        bundle_digest.update(relative.as_bytes());
        bundle_digest.update([0]);
        bundle_digest.update(content.len().to_string().as_bytes());
        bundle_digest.update([0]);
        bundle_digest.update(content.as_bytes());
        bundle_digest.update([0]);
    }
    let metadata = BundleMetadata {
        schema_version: 1,
        plugin_version: version.to_owned(),
        plugin_bundle_sha256: format!("{:x}", bundle_digest.finalize()),
        files: records,
    };
    let metadata_path = temp.path().join("plugin-bundle-files.json");
    fs::write(
        &metadata_path,
        serde_json::to_vec_pretty(&metadata).expect("serialize fixture metadata"),
    )
    .expect("write fixture metadata");
    Fixture {
        _temp: temp,
        root,
        metadata: metadata_path,
    }
}

fn core(fixture: &Fixture, app_data: &Path, version: &str) -> InstallerCore {
    InstallerCore::new(
        InstallLayout::new(app_data),
        verify_bundle(fixture.root.clone(), &fixture.metadata).expect("verify fixture bundle"),
        version,
    )
}

#[test]
fn full_install_verify_repair_remove_flow_is_safe_and_idempotent() {
    let app_data = tempfile::tempdir().expect("create app data");
    let fixture = fixture("1.0.0");
    let core = core(&fixture, app_data.path(), "1.0.0");

    let installed = core
        .prepare(false, false, FailPoint::None)
        .expect("install on empty directory");
    assert_eq!(installed.changed_files.len(), fixture_bundle_paths().len());
    assert!(installed.status.can_open_codex);
    assert_eq!(installed.status.phase, InstallerPhase::InstalledBundle);
    assert!(Path::new(&installed.status.marketplace_path).is_absolute());
    assert!(installed
        .status
        .marketplace_path
        .ends_with("marketplace/.agents/plugins/marketplace.json"));

    let repeated = core
        .prepare(false, false, FailPoint::None)
        .expect("idempotent install");
    assert!(repeated.changed_files.is_empty());

    let missing_path = app_data
        .path()
        .join("marketplace/plugins/lidfly/assets/icon.svg");
    fs::remove_file(&missing_path).expect("remove managed fixture file");
    assert_eq!(
        core.status()
            .expect("status after removal")
            .files
            .iter()
            .find(|file| file.path == BUNDLE_BASE_PATHS[3])
            .expect("icon status")
            .condition,
        FileCondition::Missing,
    );
    core.prepare(false, false, FailPoint::None)
        .expect("repair missing file without modified-file override");
    assert!(missing_path.is_file());

    let mcp_path = app_data.path().join("marketplace/plugins/lidfly/.mcp.json");
    fs::write(&mcp_path, b"user change").expect("modify managed file");
    let conflict = core
        .prepare(false, false, FailPoint::None)
        .expect_err("modified file must require confirmation");
    assert_eq!(conflict.code, "modified_files_confirmation_required");
    let repaired = core
        .prepare(true, false, FailPoint::None)
        .expect("explicit repair should succeed");
    assert!(repaired.backup_directory.is_some());
    assert!(core.status().expect("status after repair").can_open_codex);

    let unknown_path = app_data.path().join("marketplace/my-notes.txt");
    fs::write(&unknown_path, b"keep me").expect("write unknown file");
    fs::write(&mcp_path, b"keep this modified file").expect("modify managed file again");
    let removed = core.remove().expect("safe remove");
    assert!(unknown_path.is_file());
    assert!(mcp_path.is_file());
    assert!(removed
        .preserved_files
        .contains(&BUNDLE_BASE_PATHS[2].to_owned()));
    assert!(removed
        .status
        .unknown_files
        .contains(&"my-notes.txt".to_owned()));
}

#[test]
fn update_rolls_back_every_file_when_commit_fails() {
    let app_data = tempfile::tempdir().expect("create app data");
    let v1 = fixture("1.0.0");
    let v2 = fixture("1.1.0");
    let old = core(&v1, app_data.path(), "1.0.0");
    old.prepare(false, false, FailPoint::None)
        .expect("install v1");

    let update = core(&v2, app_data.path(), "1.1.0");
    let failure = update
        .prepare(false, false, FailPoint::AfterFirstManagedFile)
        .expect_err("injected update failure");
    assert_eq!(failure.code, "injected_failure");
    let old_status = old.status().expect("v1 remains consistent");
    assert!(old_status.can_open_codex);
    assert_eq!(
        old_status.installed_plugin_version.as_deref(),
        Some("1.0.0")
    );
}

#[test]
fn failure_before_authoritative_state_restores_previous_state() {
    let app_data = tempfile::tempdir().expect("create app data");
    let v1 = fixture("1.0.0");
    let v2 = fixture("1.1.0");
    let old = core(&v1, app_data.path(), "1.0.0");
    old.prepare(false, false, FailPoint::None)
        .expect("install v1");
    let update = core(&v2, app_data.path(), "1.1.0");
    update
        .prepare(false, false, FailPoint::BeforeAuthoritativeState)
        .expect_err("failure immediately before authoritative state");
    assert!(old.status().expect("old state is restored").can_open_codex);
}

#[test]
fn newer_bundle_classifies_previous_hashes_as_outdated_not_modified() {
    let app_data = tempfile::tempdir().expect("create app data");
    let v1 = fixture("1.0.0");
    let v2 = fixture("1.1.0");
    core(&v1, app_data.path(), "1.0.0")
        .prepare(false, false, FailPoint::None)
        .expect("install v1");

    let status = core(&v2, app_data.path(), "1.1.0")
        .status()
        .expect("classify v1 files for v2");
    assert!(status.update_required);
    assert!(status
        .files
        .iter()
        .any(|file| file.condition == FileCondition::Outdated));
    assert!(!status
        .files
        .iter()
        .any(|file| file.condition == FileCondition::Modified));
}

#[test]
fn remove_refuses_an_inconsistent_managed_manifest() {
    let app_data = tempfile::tempdir().expect("create app data");
    let fixture = fixture("1.0.0");
    let core = core(&fixture, app_data.path(), "1.0.0");
    core.prepare(false, false, FailPoint::None)
        .expect("install fixture");
    fs::remove_file(
        app_data
            .path()
            .join("marketplace/.lidfly-installer/managed-files.json"),
    )
    .expect("remove managed mirror");

    let error = core
        .remove()
        .expect_err("remove must fail closed without managed-files.json");
    assert_eq!(error.code, "managed_state_inconsistent");
    for relative in fixture_bundle_paths() {
        assert!(app_data.path().join("marketplace").join(relative).is_file());
    }
}

#[test]
fn tampered_transaction_journal_cannot_target_an_unknown_file() {
    let app_data = tempfile::tempdir().expect("create app data");
    let fixture = fixture("1.0.0");
    let core = core(&fixture, app_data.path(), "1.0.0");
    core.prepare(false, false, FailPoint::None)
        .expect("install fixture");
    let note = app_data.path().join("marketplace/my-notes.txt");
    fs::write(&note, b"preserve me").expect("write unknown file");
    let transaction = app_data
        .path()
        .join("marketplace/.lidfly-installer/transactions/tampered");
    fs::create_dir_all(transaction.join("prepared")).expect("create prepared directory");
    fs::create_dir_all(transaction.join("previous")).expect("create previous directory");
    fs::write(
        transaction.join("journal.json"),
        format!(
            r#"{{"schema_version":1,"target_bundle_sha256":"{}","entries":[{{"target":"my-notes.txt","prepared":"prepared/file","previous":"previous/file","existed":true,"previous_sha256":"{}","new_sha256":"{}"}}]}}"#,
            "a".repeat(64),
            "b".repeat(64),
            "c".repeat(64)
        ),
    )
    .expect("write tampered journal");

    let error = core
        .status()
        .expect_err("tampered transaction must fail closed");
    assert_eq!(error.code, "unsafe_transaction");
    assert_eq!(fs::read(note).expect("read unknown file"), b"preserve me");
}

#[cfg(unix)]
#[test]
fn symlinked_transactions_directory_is_rejected_without_touching_external_files() {
    use std::os::unix::fs::symlink;

    let app_data = tempfile::tempdir().expect("create app data");
    let outside = tempfile::tempdir().expect("create outside directory");
    let fixture = fixture("1.0.0");
    let core = core(&fixture, app_data.path(), "1.0.0");
    core.prepare(false, false, FailPoint::None)
        .expect("install fixture");

    let transactions = app_data
        .path()
        .join("marketplace/.lidfly-installer/transactions");
    fs::remove_dir(&transactions).expect("remove empty transactions directory");
    let outside_transaction = outside.path().join("outside-transaction");
    fs::create_dir_all(&outside_transaction).expect("create outside transaction");
    let outside_file = outside_transaction.join("sentinel");
    fs::write(&outside_file, b"do not touch").expect("write outside sentinel");
    symlink(outside.path(), &transactions).expect("symlink transactions directory");

    let error = core
        .status()
        .expect_err("symlinked transactions directory must fail closed");
    assert_eq!(error.code, "unsafe_transaction_root");
    assert_eq!(
        fs::read(outside_file).expect("read outside sentinel"),
        b"do not touch"
    );
}

#[test]
fn operation_lock_rejects_a_second_instance() {
    let app_data = tempfile::tempdir().expect("create app data");
    let fixture = fixture("1.0.0");
    let core = core(&fixture, app_data.path(), "1.0.0");
    let control = app_data.path().join("marketplace/.lidfly-installer");
    fs::create_dir_all(&control).expect("create control directory");
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(control.join("operation.lock"))
        .expect("open operation lock");
    lock.try_lock_exclusive().expect("hold operation lock");
    let error = core
        .status()
        .expect_err("second instance must not acquire lock");
    assert_eq!(error.code, "operation_in_progress");
    lock.unlock().expect("release operation lock");
}

#[test]
fn orphan_staging_without_a_journal_is_cleaned_without_changing_installation() {
    let app_data = tempfile::tempdir().expect("create app data");
    let fixture = fixture("1.0.0");
    let core = core(&fixture, app_data.path(), "1.0.0");
    core.prepare(false, false, FailPoint::None)
        .expect("install fixture");
    let orphan = app_data
        .path()
        .join("marketplace/.lidfly-installer/transactions/orphan/prepared");
    fs::create_dir_all(&orphan).expect("create orphan staging");
    fs::write(orphan.join("partial-file"), b"partial").expect("write orphan file");

    assert!(
        core.status()
            .expect("recover orphan staging")
            .can_open_codex
    );
    assert!(!orphan.exists());
}

#[cfg(unix)]
#[test]
fn symlink_target_is_rejected_without_touching_external_file() {
    use std::os::unix::fs::symlink;

    let app_data = tempfile::tempdir().expect("create app data");
    let outside = tempfile::tempdir().expect("create outside directory");
    let outside_file = outside.path().join("outside.json");
    fs::write(&outside_file, b"do not touch").expect("write outside file");
    let fixture = fixture("1.0.0");
    let core = core(&fixture, app_data.path(), "1.0.0");
    let target = app_data.path().join("marketplace/plugins/lidfly/.mcp.json");
    fs::create_dir_all(target.parent().expect("target parent")).expect("create target parent");
    symlink(&outside_file, &target).expect("create malicious symlink");

    let status = core.status().expect("classify symlink");
    assert_eq!(
        status
            .files
            .iter()
            .find(|file| file.path == BUNDLE_BASE_PATHS[2])
            .expect("mcp status")
            .condition,
        FileCondition::Unsafe,
    );
    assert!(core.prepare(true, false, FailPoint::None).is_err());
    assert_eq!(
        fs::read(&outside_file).expect("read outside file"),
        b"do not touch"
    );
}

#[cfg(unix)]
#[test]
fn symlinked_control_directory_is_rejected_without_touching_external_files() {
    use std::os::unix::fs::symlink;

    let app_data = tempfile::tempdir().expect("create app data");
    let outside = tempfile::tempdir().expect("create outside directory");
    let outside_file = outside.path().join("sentinel");
    fs::write(&outside_file, b"do not touch").expect("write outside sentinel");
    let marketplace = app_data.path().join("marketplace");
    fs::create_dir_all(&marketplace).expect("create marketplace root");
    symlink(outside.path(), marketplace.join(".lidfly-installer"))
        .expect("symlink control directory");
    let fixture = fixture("1.0.0");
    let core = core(&fixture, app_data.path(), "1.0.0");

    let error = core
        .status()
        .expect_err("symlinked control directory must be rejected");
    assert!(matches!(
        error.code.as_str(),
        "unsafe_parent" | "unsafe_directory"
    ));
    assert_eq!(
        fs::read(outside_file).expect("read outside sentinel"),
        b"do not touch"
    );
}

#[cfg(unix)]
#[test]
fn symlinked_installed_state_is_rejected_without_reading_external_json() {
    use std::os::unix::fs::symlink;

    let app_data = tempfile::tempdir().expect("create app data");
    let outside = tempfile::tempdir().expect("create outside directory");
    let fixture = fixture("1.0.0");
    let core = core(&fixture, app_data.path(), "1.0.0");
    core.prepare(false, false, FailPoint::None)
        .expect("install fixture");
    let installed_state = app_data
        .path()
        .join("marketplace/.lidfly-installer/installed-state.json");
    fs::remove_file(&installed_state).expect("remove installed state");
    let outside_state = outside.path().join("outside-state.json");
    fs::write(&outside_state, b"{}").expect("write outside state");
    symlink(&outside_state, &installed_state).expect("symlink installed state");

    let error = core
        .status()
        .expect_err("symlinked installed state must be rejected");
    assert_eq!(error.code, "unsafe_installed_state");
    assert_eq!(fs::read(outside_state).expect("read outside state"), b"{}");
}
