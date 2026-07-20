use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileCondition {
    Missing,
    Unchanged,
    Outdated,
    Modified,
    Unsafe,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    pub condition: FileCondition,
    pub expected_sha256: String,
    pub actual_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstallerPhase {
    NotPrepared,
    ReadyForCodex,
    InstalledBundle,
    ModifiedFiles,
    IncompleteState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerStatus {
    pub app_version: String,
    pub embedded_plugin_version: String,
    pub installed_plugin_version: Option<String>,
    pub plugin_bundle_sha256: String,
    pub marketplace_path: String,
    pub phase: InstallerPhase,
    pub files: Vec<FileStatus>,
    pub unknown_files: Vec<String>,
    pub can_open_codex: bool,
    pub needs_repair: bool,
    pub update_required: bool,
    pub downgrade_detected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationOutcome {
    pub status: InstallerStatus,
    pub message: String,
    pub changed_files: Vec<String>,
    pub preserved_files: Vec<String>,
    pub backup_directory: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientError {
    pub code: String,
    pub message: String,
    pub details: Vec<String>,
}

impl ClientError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Vec::new(),
        }
    }

    pub fn with_details(mut self, details: Vec<String>) -> Self {
        self.details = details;
        self
    }
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for ClientError {}

impl From<std::io::Error> for ClientError {
    fn from(error: std::io::Error) -> Self {
        Self::new("io_error", format!("Ошибка работы с файлами: {error}"))
    }
}

impl From<serde_json::Error> for ClientError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("invalid_json", format!("Некорректный JSON: {error}"))
    }
}
