pub mod bundle;
pub mod codex_uri;
pub mod content_update;
pub mod models;
pub mod operations;
pub mod state;

use std::path::PathBuf;

use bundle::{verify_bundle, VerifiedBundle};
use codex_uri::build_codex_plugin_uri;
use content_update::ContentUpdateClient;
use models::{
    ClientError, InstallerStatus, OperationOutcome, PluginContentInstallOutcome,
    PluginContentUpdateStatus,
};
use operations::{FailPoint, InstallLayout, InstallerCore};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, ClientError> {
    app.path().app_data_dir().map_err(|error| {
        ClientError::new(
            "app_data_unavailable",
            format!("Не удалось определить каталог данных приложения: {error}"),
        )
    })
}

fn embedded_bundle(app: &AppHandle) -> Result<VerifiedBundle, ClientError> {
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
    verify_bundle(resource_root, &metadata_path)
}

fn content_client(app: &AppHandle) -> Result<ContentUpdateClient, ClientError> {
    ContentUpdateClient::production(app_data_dir(app)?, env!("CARGO_PKG_VERSION"))
}

fn installer_core(app: &AppHandle) -> Result<InstallerCore, ClientError> {
    let app_data_dir = app_data_dir(app)?;
    let bundle = content_client(app)?.select_bundle(embedded_bundle(app)?)?;
    Ok(InstallerCore::new(
        InstallLayout::new(&app_data_dir),
        bundle,
        env!("CARGO_PKG_VERSION"),
    ))
}

fn current_plugin_version(status: &InstallerStatus) -> String {
    let selected = semver::Version::parse(&status.embedded_plugin_version).ok();
    let installed = status
        .installed_plugin_version
        .as_deref()
        .and_then(|value| semver::Version::parse(value).ok());
    match (selected, installed) {
        (Some(selected), Some(installed)) if installed > selected => installed.to_string(),
        _ => status.embedded_plugin_version.clone(),
    }
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
async fn check_plugin_content_update(
    app: AppHandle,
) -> Result<PluginContentUpdateStatus, ClientError> {
    let status = installer_core(&app)?.status()?;
    content_client(&app)?
        .check(&current_plugin_version(&status))
        .await
}

#[tauri::command]
async fn retry_plugin_content_update(
    app: AppHandle,
) -> Result<PluginContentUpdateStatus, ClientError> {
    let client = content_client(&app)?;
    let embedded = embedded_bundle(&app)?;
    let embedded_version = embedded.metadata.plugin_version.clone();
    let (selected, repair_version) = match client.select_bundle(embedded.clone()) {
        Ok(bundle) => (bundle, None),
        Err(error) if error.code == "content_cache_corrupt" => {
            client.quarantine_active_pointer()?;
            (embedded, Some(embedded_version))
        }
        Err(error) => return Err(error),
    };
    let core = InstallerCore::new(
        InstallLayout::new(&app_data_dir(&app)?),
        selected,
        env!("CARGO_PKG_VERSION"),
    );
    let status = core.status()?;
    let check_version = repair_version.unwrap_or_else(|| current_plugin_version(&status));
    client.check(&check_version).await
}

#[tauri::command]
async fn install_plugin_content_update(
    app: AppHandle,
    allow_modified: bool,
) -> Result<PluginContentInstallOutcome, ClientError> {
    let client = content_client(&app)?;
    let existing = installer_core(&app)?.status()?;
    let allow_same_version_repair = !client.active_pointer_exists()?;
    let (bundle, release) = client
        .download_and_activate(
            &current_plugin_version(&existing),
            allow_same_version_repair,
        )
        .await?;
    let core = InstallerCore::new(
        InstallLayout::new(&app_data_dir(&app)?),
        bundle,
        env!("CARGO_PKG_VERSION"),
    );
    let operation = core.prepare(allow_modified, false, FailPoint::None)?;
    let uri = build_codex_plugin_uri(&core.layout.marketplace_manifest)?;
    let codex_opened = app.opener().open_url(uri.as_str(), None::<&str>).is_ok();
    Ok(PluginContentInstallOutcome {
        release,
        operation,
        codex_opened,
    })
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
            check_plugin_content_update,
            retry_plugin_content_update,
            install_plugin_content_update,
            sync_bundle_after_update,
            remove_prepared_files,
            open_in_codex,
            open_logs
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LidFly Codex Plugin Installer");
}
