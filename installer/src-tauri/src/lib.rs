pub mod bundle;
pub mod claude_uri;
pub mod codex_uri;
pub mod content_update;
pub mod models;
pub mod operations;
pub mod state;

use std::path::PathBuf;

use bundle::{verify_bundle, VerifiedBundle};
use claude_uri::build_claude_cowork_uri;
use codex_uri::build_codex_plugin_uri;
use content_update::ContentUpdateClient;
use models::{
    BundleSyncOutcome, ClaudeProjectStatusPayload, ClientError, InstallerStatus, OperationOutcome,
    PluginContentInstallOutcome, PluginContentUpdateStatus,
};
use operations::{FailPoint, InstallLayout, InstallerCore};

const CLAUDE_FOLDER_NAME: &str = "LidFly";
const LIDFLY_MCP_URL: &str = "https://lidfly.ru/mcp/v3";
const CLAUDE_DEFAULT_PROMPT: &str =
    "Прочитай файл CLAUDE.md в этой папке и помоги мне начать работу с LidFly.";
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

fn claude_root(app: &AppHandle) -> Result<PathBuf, ClientError> {
    let home = app.path().home_dir().map_err(|error| {
        ClientError::new(
            "home_dir_unavailable",
            format!("Не удалось определить домашнюю папку: {error}"),
        )
    })?;
    Ok(home.join(CLAUDE_FOLDER_NAME))
}

fn claude_core_from_bundle(
    app: &AppHandle,
    bundle: &VerifiedBundle,
) -> Result<InstallerCore, ClientError> {
    Ok(InstallerCore::new(
        InstallLayout::claude_project(&claude_root(app)?),
        bundle.claude_project_view()?,
        env!("CARGO_PKG_VERSION"),
    ))
}

fn claude_core(app: &AppHandle) -> Result<(InstallerCore, String), ClientError> {
    let bundle = content_client(app)?.select_bundle(embedded_bundle(app)?)?;
    let project_commit = bundle.metadata.claude_project.commit.clone();
    Ok((claude_core_from_bundle(app, &bundle)?, project_commit))
}

fn sync_claude_folder_if_initialized(
    core: &InstallerCore,
) -> (Option<OperationOutcome>, Option<ClientError>) {
    if !core.state_initialized() {
        return (None, None);
    }
    match core.prepare(false, false, FailPoint::None) {
        Ok(outcome) => (Some(outcome), None),
        Err(error) => (None, Some(error)),
    }
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
    let claude_core_for_sync = claude_core_from_bundle(&app, &bundle)?;
    let core = InstallerCore::new(
        InstallLayout::new(&app_data_dir(&app)?),
        bundle,
        env!("CARGO_PKG_VERSION"),
    );
    let operation = core.prepare(allow_modified, false, FailPoint::None)?;
    let (claude_operation, claude_sync_error) =
        sync_claude_folder_if_initialized(&claude_core_for_sync);
    let uri = build_codex_plugin_uri(&core.layout.marketplace_manifest)?;
    let codex_opened = app.opener().open_url(uri.as_str(), None::<&str>).is_ok();
    Ok(PluginContentInstallOutcome {
        release,
        operation,
        codex_opened,
        claude_operation,
        claude_sync_error,
    })
}

#[tauri::command]
fn sync_bundle_after_update(app: AppHandle) -> Result<BundleSyncOutcome, ClientError> {
    let core = installer_core(&app)?;
    let status = core.status()?;
    let marketplace = if status.installed_plugin_version.is_some()
        && status.update_required
        && !status.needs_repair
        && !status.downgrade_detected
    {
        Some(core.prepare(false, false, FailPoint::None)?)
    } else {
        None
    };
    let (claude_core_instance, _) = claude_core(&app)?;
    let (claude, claude_sync_error) = if claude_core_instance.state_initialized() {
        let claude_status = claude_core_instance.status()?;
        if claude_status.update_required
            && !claude_status.needs_repair
            && !claude_status.downgrade_detected
        {
            sync_claude_folder_if_initialized(&claude_core_instance)
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };
    Ok(BundleSyncOutcome {
        marketplace,
        claude,
        claude_sync_error,
    })
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
fn get_claude_status(app: AppHandle) -> Result<ClaudeProjectStatusPayload, ClientError> {
    let (core, project_commit) = claude_core(&app)?;
    let status = core.status_without_creating_root()?;
    Ok(ClaudeProjectStatusPayload {
        folder_path: core.root_path().to_string_lossy().into_owned(),
        project_commit,
        mcp_url: LIDFLY_MCP_URL.to_owned(),
        status,
    })
}

#[tauri::command]
fn prepare_claude_folder(
    app: AppHandle,
    allow_modified: bool,
    allow_downgrade: bool,
) -> Result<OperationOutcome, ClientError> {
    let (core, _) = claude_core(&app)?;
    core.prepare(allow_modified, allow_downgrade, FailPoint::None)
}

#[tauri::command]
fn open_in_claude(app: AppHandle) -> Result<String, ClientError> {
    let (core, _) = claude_core(&app)?;
    let status = core.status()?;
    if !status.can_open_codex {
        return Err(ClientError::new(
            "claude_folder_not_ready",
            "Сначала создайте и проверьте папку LidFly.",
        ));
    }
    let uri = build_claude_cowork_uri(core.root_path(), CLAUDE_DEFAULT_PROMPT)?;
    app.opener()
        .open_url(uri.as_str(), None::<&str>)
        .map_err(|error| {
            ClientError::new(
                "claude_handler_unavailable",
                format!("Claude Desktop не найден или не открыл ссылку: {error}"),
            )
        })?;
    Ok(uri.to_string())
}

#[tauri::command]
fn remove_claude_folder(app: AppHandle) -> Result<OperationOutcome, ClientError> {
    let (core, _) = claude_core(&app)?;
    core.remove()
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
            get_claude_status,
            prepare_claude_folder,
            open_in_claude,
            remove_claude_folder,
            open_logs
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LidFly Codex Plugin Installer");
}
