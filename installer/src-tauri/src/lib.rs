pub mod bundle;
pub mod codex_uri;
pub mod models;
pub mod operations;
pub mod state;

use std::path::PathBuf;

use bundle::verify_bundle;
use codex_uri::build_codex_plugin_uri;
use models::{ClientError, InstallerStatus, OperationOutcome};
use operations::{FailPoint, InstallLayout, InstallerCore};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

fn installer_core(app: &AppHandle) -> Result<InstallerCore, ClientError> {
    let resource_root = app
        .path()
        .resolve("plugin-bundle", BaseDirectory::Resource)
        .map_err(|error| {
            ClientError::new(
                "resource_path_unavailable",
                format!("Не удалось найти встроенный bundle: {error}"),
            )
        })?;
    let metadata_path = app
        .path()
        .resolve("plugin-bundle-files.json", BaseDirectory::Resource)
        .map_err(|error| {
            ClientError::new(
                "resource_path_unavailable",
                format!("Не удалось найти manifest встроенного bundle: {error}"),
            )
        })?;
    let app_data_dir = app.path().app_data_dir().map_err(|error| {
        ClientError::new(
            "app_data_unavailable",
            format!("Не удалось определить каталог данных приложения: {error}"),
        )
    })?;
    let bundle = verify_bundle(resource_root, &metadata_path)?;
    Ok(InstallerCore::new(
        InstallLayout::new(&app_data_dir),
        bundle,
        env!("CARGO_PKG_VERSION"),
    ))
}

#[tauri::command]
fn get_status(app: AppHandle) -> Result<InstallerStatus, ClientError> {
    installer_core(&app)?.status()
}

#[tauri::command]
fn prepare_plugin(
    app: AppHandle,
    allow_modified: bool,
    allow_downgrade: bool,
) -> Result<OperationOutcome, ClientError> {
    installer_core(&app)?.prepare(allow_modified, allow_downgrade, FailPoint::None)
}

#[tauri::command]
fn sync_bundle_after_update(app: AppHandle) -> Result<Option<OperationOutcome>, ClientError> {
    let core = installer_core(&app)?;
    let status = core.status()?;
    if status.installed_plugin_version.is_some()
        && status.update_required
        && !status.needs_repair
        && !status.downgrade_detected
    {
        return core.prepare(false, false, FailPoint::None).map(Some);
    }
    Ok(None)
}

#[tauri::command]
fn remove_prepared_files(app: AppHandle) -> Result<OperationOutcome, ClientError> {
    installer_core(&app)?.remove()
}

#[tauri::command]
fn open_in_codex(app: AppHandle) -> Result<String, ClientError> {
    let core = installer_core(&app)?;
    let status = core.status()?;
    if !status.can_open_codex {
        return Err(ClientError::new(
            "plugin_not_ready",
            "Сначала подготовьте и проверьте файлы плагина.",
        ));
    }
    let uri = build_codex_plugin_uri(&core.layout.marketplace_manifest)?;
    app.opener()
        .open_url(uri.as_str(), None::<&str>)
        .map_err(|error| {
            ClientError::new(
                "codex_handler_unavailable",
                format!("Codex не найден или не открыл ссылку: {error}"),
            )
        })?;
    Ok(uri.to_string())
}

#[tauri::command]
fn open_logs(app: AppHandle) -> Result<PathBuf, ClientError> {
    let logs = installer_core(&app)?.logs_root()?;
    app.opener()
        .open_path(logs.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| {
            ClientError::new(
                "logs_open_failed",
                format!("Не удалось открыть каталог журнала: {error}"),
            )
        })?;
    Ok(logs)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_status,
            prepare_plugin,
            sync_bundle_after_update,
            remove_prepared_files,
            open_in_codex,
            open_logs
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LidFly Codex Plugin Installer");
}
