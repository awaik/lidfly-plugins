use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bundle::BundleFile;
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

pub fn read_state(path: &Path) -> Result<Option<InstalledState>, ClientError> {
    match fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes)?;
            Ok(Some(migrate_state(value)?))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn validate_managed_mirror(path: &Path, state: &InstalledState) -> Result<(), ClientError> {
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
    use super::{migrate_state, STATE_SCHEMA_VERSION};
    use serde_json::json;

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
}
