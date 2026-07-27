use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::EntryType;
use url::Url;
use uuid::Uuid;

use crate::bundle::{safe_join, verify_bundle, VerifiedBundle, SKILLS_SOURCE_LOCK_PATH};
use crate::models::{
    ClientError, PluginContentReleaseSummary, PluginContentUpdateState, PluginContentUpdateStatus,
};

pub const CONTENT_FEED_URL: &str = "https://lidfly.ru/codex-plugin-content/latest.json";
pub const CONTENT_KEY_ID: &str = "lidfly-plugin-content-2026-01";
const CONTENT_ORIGIN: &str = "https://lidfly.ru";
const CONTENT_ROUTE_PREFIX: &str = "/codex-plugin-content/";
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_SIGNATURE_BYTES: usize = 1024;
const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginContentRelease {
    pub schema_version: u32,
    pub channel: String,
    pub published_at: String,
    pub min_installer_version: String,
    pub plugin: ReleasePlugin,
    pub source: ReleaseSource,
    pub bundle: ReleaseBundle,
    pub key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleasePlugin {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseSource {
    pub repository: String,
    pub commit: String,
    pub skills_tree_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseBundle {
    pub filename: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub signature_filename: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActiveCache {
    schema_version: u32,
    plugin_version: String,
    archive_sha256: String,
    directory: String,
}

#[derive(Debug)]
struct FetchedRelease {
    release: PluginContentRelease,
    manifest_bytes: Vec<u8>,
    manifest_signature: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ContentUpdateClient {
    app_data_dir: PathBuf,
    installer_version: Version,
    public_key_base64: String,
    feed_url: Url,
    content_origin: String,
    content_route_prefix: String,
    http: reqwest::Client,
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn release_summary(release: &PluginContentRelease) -> PluginContentReleaseSummary {
    PluginContentReleaseSummary {
        plugin_version: release.plugin.version.clone(),
        min_installer_version: release.min_installer_version.clone(),
        published_at: release.published_at.clone(),
        source_commit: release.source.commit.clone(),
        bundle_size: release.bundle.size,
    }
}

fn expected_bundle_filename(version: &str, sha256: &str) -> String {
    format!("LidFly_Codex_Plugin_{}_{}.tar.gz", version, &sha256[..12])
}

impl ContentUpdateClient {
    pub fn production(app_data_dir: PathBuf, installer_version: &str) -> Result<Self, ClientError> {
        Self::new(
            app_data_dir,
            installer_version,
            option_env!("LIDFLY_PLUGIN_CONTENT_PUBLIC_KEY_BASE64").unwrap_or(""),
            CONTENT_FEED_URL,
        )
    }

    pub fn new(
        app_data_dir: PathBuf,
        installer_version: &str,
        public_key_base64: &str,
        feed_url: &str,
    ) -> Result<Self, ClientError> {
        Self::new_with_policy(
            app_data_dir,
            installer_version,
            public_key_base64,
            feed_url,
            CONTENT_ORIGIN,
            CONTENT_ROUTE_PREFIX,
        )
    }

    fn new_with_policy(
        app_data_dir: PathBuf,
        installer_version: &str,
        public_key_base64: &str,
        feed_url: &str,
        content_origin: &str,
        content_route_prefix: &str,
    ) -> Result<Self, ClientError> {
        let installer_version = Version::parse(installer_version).map_err(|_| {
            ClientError::new(
                "invalid_installer_version",
                "Версия установщика не соответствует SemVer.",
            )
        })?;
        let feed_url = Url::parse(feed_url).map_err(|_| {
            ClientError::new("invalid_content_feed", "Content feed URL некорректен.")
        })?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!(
                "LidFly-Codex-Plugin-Installer/{}",
                installer_version
            ))
            .build()
            .map_err(|error| {
                ClientError::new(
                    "content_http_client_failed",
                    format!("Не удалось подготовить HTTPS client: {error}"),
                )
            })?;
        Ok(Self {
            app_data_dir,
            installer_version,
            public_key_base64: public_key_base64.to_owned(),
            feed_url,
            content_origin: content_origin.to_owned(),
            content_route_prefix: content_route_prefix.to_owned(),
            http,
        })
    }

    pub async fn check(
        &self,
        current_plugin_version: &str,
    ) -> Result<PluginContentUpdateStatus, ClientError> {
        let current = Version::parse(current_plugin_version).map_err(|_| {
            ClientError::new(
                "invalid_plugin_version",
                "Локальная версия плагина не соответствует SemVer.",
            )
        })?;
        let fetched = self.fetch_release().await?;
        let remote = Version::parse(&fetched.release.plugin.version).map_err(|_| {
            ClientError::new(
                "invalid_content_manifest",
                "Версия плагина в content manifest некорректна.",
            )
        })?;
        let minimum = Version::parse(&fetched.release.min_installer_version).map_err(|_| {
            ClientError::new(
                "invalid_content_manifest",
                "min_installer_version в content manifest некорректна.",
            )
        })?;
        let state = if remote <= current {
            PluginContentUpdateState::UpToDate
        } else if minimum > self.installer_version {
            PluginContentUpdateState::RequiresInstallerUpdate
        } else {
            PluginContentUpdateState::Available
        };
        Ok(PluginContentUpdateStatus {
            state,
            installer_version: self.installer_version.to_string(),
            current_plugin_version: current.to_string(),
            release: Some(release_summary(&fetched.release)),
        })
    }

    pub async fn download_and_activate(
        &self,
        current_plugin_version: &str,
        allow_same_version_repair: bool,
    ) -> Result<(VerifiedBundle, PluginContentReleaseSummary), ClientError> {
        let current = Version::parse(current_plugin_version).map_err(|_| {
            ClientError::new(
                "invalid_plugin_version",
                "Локальная версия плагина некорректна.",
            )
        })?;
        let fetched = self.fetch_release().await?;
        let remote = Version::parse(&fetched.release.plugin.version).map_err(|_| {
            ClientError::new(
                "invalid_content_manifest",
                "Remote plugin version некорректна.",
            )
        })?;
        let minimum = Version::parse(&fetched.release.min_installer_version).map_err(|_| {
            ClientError::new(
                "invalid_content_manifest",
                "min_installer_version некорректна.",
            )
        })?;
        if remote < current {
            return Err(ClientError::new(
                "content_downgrade_blocked",
                "Удалённый bundle старее проверенной локальной версии.",
            ));
        }
        if minimum > self.installer_version {
            return Err(ClientError::new(
                "installer_update_required",
                "Для этого плагина сначала обновите установщик.",
            ));
        }
        if let Some(cached) = self.cached_bundle_for_release(&fetched.release)? {
            return Ok((cached, release_summary(&fetched.release)));
        }
        if remote == current && !allow_same_version_repair {
            return Err(ClientError::new(
                "content_downgrade_blocked",
                "Удалённый bundle не новее локальной версии и не является проверенным cache.",
            ));
        }
        let bundle_url = Url::parse(&fetched.release.bundle.url)
            .map_err(|_| ClientError::new("invalid_content_manifest", "Bundle URL некорректен."))?;
        let signature_url =
            Url::parse(&format!("{}.sig", fetched.release.bundle.url)).map_err(|_| {
                ClientError::new(
                    "invalid_content_manifest",
                    "Bundle signature URL некорректен.",
                )
            })?;
        let archive = self
            .download_limited(&bundle_url, MAX_ARCHIVE_BYTES as usize)
            .await?;
        if archive.len() as u64 != fetched.release.bundle.size {
            return Err(ClientError::new(
                "content_size_mismatch",
                "Размер content bundle не совпадает с подписанным manifest.",
            ));
        }
        let actual_sha256 = format!("{:x}", Sha256::digest(&archive));
        if actual_sha256 != fetched.release.bundle.sha256 {
            return Err(ClientError::new(
                "content_hash_mismatch",
                "SHA-256 content bundle не совпадает с подписанным manifest.",
            ));
        }
        let bundle_signature = self
            .download_limited(&signature_url, MAX_SIGNATURE_BYTES)
            .await?;
        self.verify_signature(&archive, &bundle_signature)?;
        let verified = self.activate_cache(&fetched, &archive, &bundle_signature)?;
        Ok((verified, release_summary(&fetched.release)))
    }

    pub fn select_bundle(&self, embedded: VerifiedBundle) -> Result<VerifiedBundle, ClientError> {
        let Some(active) = self.read_active_cache()? else {
            return Ok(embedded);
        };
        let cached = self
            .verify_cached_directory(&active)
            .map_err(content_cache_error)?;
        let cached_version = Version::parse(&cached.metadata.plugin_version).map_err(|_| {
            ClientError::new(
                "content_cache_corrupt",
                "Cached plugin version некорректна.",
            )
        })?;
        let embedded_version = Version::parse(&embedded.metadata.plugin_version).map_err(|_| {
            ClientError::new(
                "invalid_plugin_version",
                "Embedded plugin version некорректна.",
            )
        })?;
        if cached_version < embedded_version {
            return Ok(embedded);
        }
        Ok(cached)
    }

    fn cache_root(&self) -> PathBuf {
        self.app_data_dir.join("content-cache")
    }

    async fn fetch_release(&self) -> Result<FetchedRelease, ClientError> {
        if self.public_key_base64.trim().is_empty() {
            return Err(ClientError::new(
                "content_key_not_configured",
                "Этот build установщика не содержит public key для обновлений плагина.",
            ));
        }
        let signature_url = Url::parse(&format!("{}.sig", self.feed_url)).map_err(|_| {
            ClientError::new("invalid_content_feed", "Content signature URL некорректен.")
        })?;
        let (manifest_bytes, manifest_signature) = futures_util::try_join!(
            self.download_limited(&self.feed_url, MAX_MANIFEST_BYTES),
            self.download_limited(&signature_url, MAX_SIGNATURE_BYTES)
        )?;
        self.verify_signature(&manifest_bytes, &manifest_signature)?;
        let release: PluginContentRelease = serde_json::from_slice(&manifest_bytes)?;
        self.validate_release(&release)?;
        Ok(FetchedRelease {
            release,
            manifest_bytes,
            manifest_signature,
        })
    }

    async fn download_limited(&self, url: &Url, limit: usize) -> Result<Vec<u8>, ClientError> {
        let response = self.http.get(url.clone()).send().await.map_err(|error| {
            ClientError::new(
                "content_network_error",
                format!("Не удалось получить обновление плагина: {error}"),
            )
        })?;
        if !response.status().is_success() {
            return Err(ClientError::new(
                "content_http_error",
                format!("Content server вернул HTTP {}.", response.status()),
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(ClientError::new(
                "content_download_too_large",
                "Ответ content server превышает допустимый размер.",
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                ClientError::new(
                    "content_network_error",
                    format!("Загрузка обновления прервана: {error}"),
                )
            })?;
            if bytes.len().saturating_add(chunk.len()) > limit {
                return Err(ClientError::new(
                    "content_download_too_large",
                    "Ответ content server превышает допустимый размер.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    fn verify_signature(&self, bytes: &[u8], signature_text: &[u8]) -> Result<(), ClientError> {
        let public_key = BASE64.decode(self.public_key_base64.trim()).map_err(|_| {
            ClientError::new(
                "invalid_content_public_key",
                "Public key обновлений плагина повреждён.",
            )
        })?;
        let public_key: [u8; 32] = public_key.try_into().map_err(|_| {
            ClientError::new(
                "invalid_content_public_key",
                "Public key обновлений плагина имеет неверную длину.",
            )
        })?;
        let signature_text = std::str::from_utf8(signature_text).map_err(|_| {
            ClientError::new(
                "invalid_content_signature",
                "Подпись обновления не является UTF-8.",
            )
        })?;
        let signature = BASE64.decode(signature_text.trim()).map_err(|_| {
            ClientError::new(
                "invalid_content_signature",
                "Подпись обновления имеет неверный формат.",
            )
        })?;
        let signature = Signature::from_slice(&signature).map_err(|_| {
            ClientError::new(
                "invalid_content_signature",
                "Подпись обновления имеет неверную длину.",
            )
        })?;
        let key = VerifyingKey::from_bytes(&public_key).map_err(|_| {
            ClientError::new(
                "invalid_content_public_key",
                "Public key обновлений плагина некорректен.",
            )
        })?;
        key.verify(bytes, &signature).map_err(|_| {
            ClientError::new(
                "content_signature_mismatch",
                "Подпись обновления плагина не прошла проверку. Обновление не применено.",
            )
        })
    }

    fn validate_release(&self, release: &PluginContentRelease) -> Result<(), ClientError> {
        let version = Version::parse(&release.plugin.version).map_err(|_| {
            ClientError::new("invalid_content_manifest", "Plugin version некорректна.")
        })?;
        Version::parse(&release.min_installer_version).map_err(|_| {
            ClientError::new(
                "invalid_content_manifest",
                "min_installer_version некорректна.",
            )
        })?;
        if release.schema_version != 1
            || release.channel != "stable"
            || chrono::DateTime::parse_from_rfc3339(&release.published_at).is_err()
            || release.plugin.name != "lidfly"
            || release.source.repository != "https://github.com/awaik/direct-mcp-ai-project"
            || !is_lower_hex(&release.source.commit, 40)
            || !is_lower_hex(&release.source.skills_tree_sha256, 64)
            || !is_lower_hex(&release.bundle.sha256, 64)
            || release.bundle.size == 0
            || release.bundle.size > MAX_ARCHIVE_BYTES
            || release.key_id != CONTENT_KEY_ID
        {
            return Err(ClientError::new(
                "invalid_content_manifest",
                "Подписанный content manifest не соответствует контракту LidFly.",
            ));
        }
        let expected = expected_bundle_filename(&version.to_string(), &release.bundle.sha256);
        let url = Url::parse(&release.bundle.url)
            .map_err(|_| ClientError::new("invalid_content_manifest", "Bundle URL некорректен."))?;
        if release.bundle.filename != expected
            || release.bundle.signature_filename != format!("{expected}.sig")
            || url.origin().ascii_serialization() != self.content_origin
            || url.path() != format!("{}{expected}", self.content_route_prefix)
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ClientError::new(
                "invalid_content_manifest",
                "Bundle filename или URL не соответствует безопасной policy.",
            ));
        }
        Ok(())
    }

    fn activate_cache(
        &self,
        fetched: &FetchedRelease,
        archive: &[u8],
        bundle_signature: &[u8],
    ) -> Result<VerifiedBundle, ClientError> {
        let cache_root = self.cache_root();
        create_secure_directory(&cache_root)?;
        let directory_name = format!(
            "{}-{}",
            fetched.release.plugin.version, fetched.release.bundle.sha256
        );
        let final_directory = cache_root.join(&directory_name);
        if final_directory.exists() {
            let active = ActiveCache {
                schema_version: 1,
                plugin_version: fetched.release.plugin.version.clone(),
                archive_sha256: fetched.release.bundle.sha256.clone(),
                directory: directory_name.clone(),
            };
            match self.verify_cached_directory(&active) {
                Ok(verified) => {
                    atomic_write(
                        &cache_root.join("active.json"),
                        &serde_json::to_vec_pretty(&active)?,
                    )?;
                    return Ok(verified);
                }
                Err(_) => {
                    let quarantined =
                        cache_root.join(format!(".invalid-{}-{}", directory_name, Uuid::new_v4()));
                    fs::rename(&final_directory, quarantined)?;
                }
            }
        }
        let staging = cache_root.join(format!(".staging-{}", Uuid::new_v4()));
        create_secure_directory(&staging)?;
        let result = (|| {
            write_new(&staging.join("bundle.tar.gz"), archive)?;
            write_new(&staging.join("bundle.tar.gz.sig"), bundle_signature)?;
            write_new(&staging.join("release.json"), &fetched.manifest_bytes)?;
            write_new(
                &staging.join("release.json.sig"),
                &fetched.manifest_signature,
            )?;
            extract_archive(archive, &staging)?;
            let verified = verify_bundle(
                staging.join("plugin-bundle"),
                &staging.join("plugin-bundle-files.json"),
            )?;
            verify_release_matches_bundle(&fetched.release, &verified)?;
            fs::rename(&staging, &final_directory)?;
            let active = ActiveCache {
                schema_version: 1,
                plugin_version: fetched.release.plugin.version.clone(),
                archive_sha256: fetched.release.bundle.sha256.clone(),
                directory: directory_name,
            };
            atomic_write(
                &cache_root.join("active.json"),
                &serde_json::to_vec_pretty(&active)?,
            )?;
            Ok(verified
                .as_remote(fetched.release.key_id.clone())
                .with_root(final_directory.join("plugin-bundle")))
        })();
        if result.is_err() && staging.exists() {
            let _ = fs::remove_dir_all(staging);
        }
        result
    }

    fn verify_cached_directory(&self, active: &ActiveCache) -> Result<VerifiedBundle, ClientError> {
        let directory = safe_join(&self.cache_root(), &active.directory)?;
        let release_bytes =
            read_regular_limited(&directory.join("release.json"), MAX_MANIFEST_BYTES)?;
        let release_signature =
            read_regular_limited(&directory.join("release.json.sig"), MAX_SIGNATURE_BYTES)?;
        self.verify_signature(&release_bytes, &release_signature)?;
        let release: PluginContentRelease = serde_json::from_slice(&release_bytes)?;
        self.validate_release(&release)?;
        if release.plugin.version != active.plugin_version
            || release.bundle.sha256 != active.archive_sha256
        {
            return Err(ClientError::new(
                "content_cache_corrupt",
                "Active cache pointer не совпадает с подписанным manifest.",
            ));
        }
        let archive =
            read_regular_limited(&directory.join("bundle.tar.gz"), MAX_ARCHIVE_BYTES as usize)?;
        let archive_signature =
            read_regular_limited(&directory.join("bundle.tar.gz.sig"), MAX_SIGNATURE_BYTES)?;
        if archive.len() as u64 != release.bundle.size
            || format!("{:x}", Sha256::digest(&archive)) != release.bundle.sha256
        {
            return Err(ClientError::new(
                "content_cache_corrupt",
                "Cached content bundle повреждён.",
            ));
        }
        self.verify_signature(&archive, &archive_signature)?;
        let verified = verify_bundle(
            directory.join("plugin-bundle"),
            &directory.join("plugin-bundle-files.json"),
        )?
        .as_remote(release.key_id.clone());
        verify_release_matches_bundle(&release, &verified)?;
        Ok(verified)
    }

    fn cached_bundle_for_release(
        &self,
        release: &PluginContentRelease,
    ) -> Result<Option<VerifiedBundle>, ClientError> {
        let Some(active) = self.read_active_cache()? else {
            return Ok(None);
        };
        if active.plugin_version != release.plugin.version
            || active.archive_sha256 != release.bundle.sha256
        {
            return Ok(None);
        }
        self.verify_cached_directory(&active)
            .map(Some)
            .map_err(content_cache_error)
    }

    fn read_active_cache(&self) -> Result<Option<ActiveCache>, ClientError> {
        let active_path = self.cache_root().join("active.json");
        recover_atomic_write(&active_path)?;
        let metadata = match fs::symlink_metadata(&active_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ClientError::new(
                "content_cache_corrupt",
                "Active cache pointer имеет небезопасный тип.",
            ));
        }
        let active: ActiveCache =
            serde_json::from_slice(&fs::read(active_path)?).map_err(|_| {
                ClientError::new(
                    "content_cache_corrupt",
                    "Active cache pointer содержит некорректный JSON.",
                )
            })?;
        if active.schema_version != 1
            || Version::parse(&active.plugin_version).is_err()
            || !is_lower_hex(&active.archive_sha256, 64)
            || active.directory != format!("{}-{}", active.plugin_version, active.archive_sha256)
        {
            return Err(ClientError::new(
                "content_cache_corrupt",
                "Active content cache повреждён. Повторите загрузку.",
            ));
        }
        Ok(Some(active))
    }

    pub fn quarantine_active_pointer(&self) -> Result<Option<PathBuf>, ClientError> {
        let active = self.cache_root().join("active.json");
        match fs::symlink_metadata(&active) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                let quarantine = self
                    .cache_root()
                    .join(format!("active.invalid-{}.json", Uuid::new_v4()));
                fs::rename(active, &quarantine)?;
                Ok(Some(quarantine))
            }
            Ok(_) => Err(ClientError::new(
                "content_cache_corrupt",
                "Active cache pointer имеет небезопасный тип.",
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn active_pointer_exists(&self) -> Result<bool, ClientError> {
        let active = self.cache_root().join("active.json");
        recover_atomic_write(&active)?;
        match fs::symlink_metadata(active) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(true),
            Ok(_) => Err(ClientError::new(
                "content_cache_corrupt",
                "Active cache pointer имеет небезопасный тип.",
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

fn content_cache_error(error: ClientError) -> ClientError {
    ClientError::new(
        "content_cache_corrupt",
        format!("Active content cache не прошёл проверку: {}", error.message),
    )
}

trait VerifiedBundleRoot {
    fn with_root(self, root: PathBuf) -> Self;
}

impl VerifiedBundleRoot for VerifiedBundle {
    fn with_root(mut self, root: PathBuf) -> Self {
        self.root = root;
        self
    }
}

fn verify_release_matches_bundle(
    release: &PluginContentRelease,
    bundle: &VerifiedBundle,
) -> Result<(), ClientError> {
    if release.plugin.version != bundle.metadata.plugin_version
        || release.source.repository != bundle.metadata.source.repository
        || release.source.commit != bundle.metadata.source.commit
        || release.source.skills_tree_sha256 != bundle.metadata.source.skills_tree_sha256
    {
        return Err(ClientError::new(
            "content_provenance_mismatch",
            "Подписанный manifest не совпадает с provenance plugin bundle.",
        ));
    }
    let lock = safe_join(&bundle.root, SKILLS_SOURCE_LOCK_PATH)?;
    if !fs::symlink_metadata(lock)?.is_file() {
        return Err(ClientError::new(
            "content_provenance_mismatch",
            "Plugin bundle не содержит source provenance.",
        ));
    }
    Ok(())
}

fn create_secure_directory(path: &Path) -> Result<(), ClientError> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ClientError::new(
            "unsafe_content_cache",
            "Content cache заменён ссылкой или файлом.",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), ClientError> {
    if let Some(parent) = path.parent() {
        create_secure_directory(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
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

fn read_regular_limited(path: &Path, limit: usize) -> Result<Vec<u8>, ClientError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > limit as u64
    {
        return Err(ClientError::new(
            "unsafe_content_cache",
            "Файл content cache имеет небезопасный тип или размер.",
        ));
    }
    Ok(fs::read(path)?)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ClientError> {
    if let Some(parent) = path.parent() {
        create_secure_directory(parent)?;
    }
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    write_new(&temporary, bytes)?;
    let result = replace_file(&temporary, path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), ClientError> {
    fs::rename(source, destination)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), ClientError> {
    let backup = destination.with_extension("previous");
    recover_atomic_write(destination)?;
    if destination.exists() {
        fs::rename(destination, &backup)?;
    }
    match fs::rename(source, destination) {
        Ok(()) => {
            if backup.exists() {
                fs::remove_file(backup)?;
            }
            Ok(())
        }
        Err(error) => {
            if backup.exists() && !destination.exists() {
                let _ = fs::rename(&backup, destination);
            }
            Err(error.into())
        }
    }
}

#[cfg(not(windows))]
fn recover_atomic_write(_destination: &Path) -> Result<(), ClientError> {
    Ok(())
}

#[cfg(windows)]
fn recover_atomic_write(destination: &Path) -> Result<(), ClientError> {
    let backup = destination.with_extension("previous");
    match (destination.exists(), backup.exists()) {
        (false, true) => fs::rename(backup, destination).map_err(Into::into),
        (true, true) => fs::remove_file(backup).map_err(Into::into),
        _ => Ok(()),
    }
}

fn safe_archive_path(path: &Path) -> Result<String, ClientError> {
    let text = path.to_str().ok_or_else(|| {
        ClientError::new("unsafe_content_archive", "Archive path не является UTF-8.")
    })?;
    if text.is_empty()
        || text.contains('\\')
        || text.contains('\0')
        || path.is_absolute()
        || text.starts_with("//")
        || text.as_bytes().get(1) == Some(&b':')
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ClientError::new(
            "unsafe_content_archive",
            format!("Небезопасный путь в content archive: {text}"),
        ));
    }
    Ok(text.to_owned())
}

fn extract_archive(archive_bytes: &[u8], destination: &Path) -> Result<(), ClientError> {
    let decoder = GzDecoder::new(archive_bytes);
    let mut archive = tar::Archive::new(decoder);
    let mut seen = BTreeSet::new();
    let mut total_size = 0_u64;
    let mut count = 0_usize;
    for entry in archive.entries().map_err(|error| {
        ClientError::new(
            "invalid_content_archive",
            format!("Не удалось прочитать content archive: {error}"),
        )
    })? {
        let mut entry = entry.map_err(|error| {
            ClientError::new(
                "invalid_content_archive",
                format!("Повреждённая archive entry: {error}"),
            )
        })?;
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err(ClientError::new(
                "content_archive_limit",
                "В content archive слишком много файлов.",
            ));
        }
        let relative =
            safe_archive_path(&entry.path().map_err(|_| {
                ClientError::new("unsafe_content_archive", "Archive path повреждён.")
            })?)?;
        if !seen.insert(relative.clone()) {
            return Err(ClientError::new(
                "unsafe_content_archive",
                format!("Duplicate archive entry: {relative}"),
            ));
        }
        let entry_type = entry.header().entry_type();
        if entry_type == EntryType::Directory {
            create_secure_directory(&safe_join(destination, &relative)?)?;
            continue;
        }
        if entry_type != EntryType::Regular {
            return Err(ClientError::new(
                "unsafe_content_archive",
                format!("Archive содержит ссылку или special file: {relative}"),
            ));
        }
        if relative != "plugin-bundle-files.json" && !relative.starts_with("plugin-bundle/") {
            return Err(ClientError::new(
                "unsafe_content_archive",
                format!("Archive entry не разрешён bundle contract: {relative}"),
            ));
        }
        let size = entry.size();
        total_size = total_size.saturating_add(size);
        if size == 0 || size > MAX_FILE_BYTES || total_size > MAX_EXTRACTED_BYTES {
            return Err(ClientError::new(
                "content_archive_limit",
                "Content archive превышает безопасные лимиты распаковки.",
            ));
        }
        let target = safe_join(destination, &relative)?;
        if let Some(parent) = target.parent() {
            create_secure_directory(parent)?;
        }
        let mut bytes = Vec::with_capacity(size as usize);
        entry.read_to_end(&mut bytes)?;
        if bytes.len() as u64 != size {
            return Err(ClientError::new(
                "invalid_content_archive",
                format!("Размер archive entry не совпадает: {relative}"),
            ));
        }
        write_new(&target, &bytes)?;
    }
    if !seen.contains("plugin-bundle-files.json") {
        return Err(ClientError::new(
            "invalid_content_archive",
            "Content archive не содержит plugin-bundle-files.json.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        extract_archive, safe_archive_path, ContentUpdateClient, PluginContentRelease,
        MAX_FILE_BYTES,
    };
    use crate::bundle::{verify_bundle, BundleMetadata, BundleOrigin};
    use crate::models::PluginContentUpdateState;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::thread;
    use tar::{Builder, EntryType, Header};
    use tempfile::tempdir;

    fn archive_with_duplicate_or_link(duplicate: bool, symlink: bool) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::best());
        let mut builder = Builder::new(encoder);
        let mut header = Header::new_gnu();
        header.set_size(2);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "plugin-bundle-files.json", &b"{}"[..])
            .expect("append metadata");
        if duplicate {
            let mut duplicate_header = Header::new_gnu();
            duplicate_header.set_size(2);
            duplicate_header.set_mode(0o644);
            duplicate_header.set_cksum();
            builder
                .append_data(
                    &mut duplicate_header,
                    "plugin-bundle-files.json",
                    &b"{}"[..],
                )
                .expect("append duplicate");
        }
        if symlink {
            let mut link = Header::new_gnu();
            link.set_entry_type(EntryType::Symlink);
            link.set_size(0);
            link.set_mode(0o777);
            link.set_link_name("../../outside").expect("link name");
            link.set_cksum();
            builder
                .append_data(&mut link, "plugin-bundle/link", std::io::empty())
                .expect("append symlink");
        }
        let encoder = builder.into_inner().expect("finish tar");
        encoder.finish().expect("finish gzip")
    }

    fn fixture_archive(resources: &Path) -> (Vec<u8>, BundleMetadata) {
        let metadata_bytes =
            fs::read(resources.join("plugin-bundle-files.json")).expect("bundle metadata");
        let metadata: BundleMetadata =
            serde_json::from_slice(&metadata_bytes).expect("parse bundle metadata");
        let encoder = GzEncoder::new(Vec::new(), Compression::best());
        let mut builder = Builder::new(encoder);
        let mut metadata_header = Header::new_ustar();
        metadata_header.set_size(metadata_bytes.len() as u64);
        metadata_header.set_mode(0o644);
        metadata_header.set_cksum();
        builder
            .append_data(
                &mut metadata_header,
                "plugin-bundle-files.json",
                metadata_bytes.as_slice(),
            )
            .expect("append bundle metadata");
        for file in &metadata.files {
            let bytes =
                fs::read(resources.join("plugin-bundle").join(&file.path)).expect("bundle file");
            let mut header = Header::new_ustar();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    format!("plugin-bundle/{}", file.path),
                    bytes.as_slice(),
                )
                .expect("append bundle file");
        }
        let encoder = builder.into_inner().expect("finish fixture tar");
        (encoder.finish().expect("finish fixture gzip"), metadata)
    }

    fn serve_fixture(
        listener: TcpListener,
        routes: BTreeMap<String, Vec<u8>>,
        requests: usize,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            for _ in 0..requests {
                let (mut stream, _) = listener.accept().expect("fixture accept");
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).expect("fixture request");
                let first_line = String::from_utf8_lossy(&request[..read])
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                let path = first_line.split_whitespace().nth(1).unwrap_or("/");
                let (status, body) = routes
                    .get(path)
                    .map(|body| ("200 OK", body.as_slice()))
                    .unwrap_or(("404 Not Found", &[]));
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .expect("fixture response headers");
                stream.write_all(body).expect("fixture response body");
            }
        })
    }

    #[test]
    fn archive_path_policy_rejects_traversal_and_windows_paths() {
        assert!(safe_archive_path(Path::new("plugin-bundle/file")).is_ok());
        assert!(safe_archive_path(Path::new("../file")).is_err());
        assert!(safe_archive_path(Path::new("/absolute")).is_err());
        assert!(safe_archive_path(Path::new("C:\\file")).is_err());
        assert!(safe_archive_path(Path::new("\\\\server\\share")).is_err());
    }

    #[test]
    fn manifest_parser_rejects_unknown_fields() {
        let value = serde_json::json!({
            "schema_version": 1,
            "channel": "stable",
            "published_at": "2026-07-27T00:00:00Z",
            "min_installer_version": "1.2.0",
            "plugin": {"name": "lidfly", "version": "1.1.1"},
            "source": {
                "repository": "https://github.com/awaik/direct-mcp-ai-project",
                "commit": "a".repeat(40),
                "skills_tree_sha256": "b".repeat(64)
            },
            "bundle": {
                "filename": "bundle.tar.gz",
                "url": "https://lidfly.ru/codex-plugin-content/bundle.tar.gz",
                "size": 1,
                "sha256": "c".repeat(64),
                "signature_filename": "bundle.tar.gz.sig"
            },
            "key_id": "lidfly-plugin-content-2026-01",
            "unexpected": true
        });
        assert!(serde_json::from_value::<PluginContentRelease>(value).is_err());
    }

    #[test]
    fn ed25519_verifier_rejects_changed_bytes() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
        let client = ContentUpdateClient::new(
            tempdir().expect("temp").path().to_path_buf(),
            "1.2.0",
            &public_key,
            "https://lidfly.ru/codex-plugin-content/latest.json",
        )
        .expect("content client");
        let signature = BASE64.encode(signing_key.sign(b"signed").to_bytes());
        assert!(client
            .verify_signature(b"signed", signature.as_bytes())
            .is_ok());
        assert!(client
            .verify_signature(b"changed", signature.as_bytes())
            .is_err());
    }

    #[test]
    fn local_http_fixture_checks_downloads_activates_and_selects_cache() {
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let (archive, metadata) = fixture_archive(&resources);
        let archive_sha256 = format!("{:x}", Sha256::digest(&archive));
        let filename = format!(
            "LidFly_Codex_Plugin_{}_{}.tar.gz",
            metadata.plugin_version,
            &archive_sha256[..12]
        );
        let listener = TcpListener::bind("127.0.0.1:0").expect("fixture listener");
        let origin = format!("http://{}", listener.local_addr().expect("fixture address"));
        let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
        let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
        let mut manifest = serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "channel": "stable",
            "published_at": "2026-07-27T00:00:00Z",
            "min_installer_version": "1.2.0",
            "plugin": {"name": "lidfly", "version": metadata.plugin_version},
            "source": {
                "repository": metadata.source.repository,
                "commit": metadata.source.commit,
                "skills_tree_sha256": metadata.source.skills_tree_sha256
            },
            "bundle": {
                "filename": filename,
                "url": format!("{origin}/codex-plugin-content/{filename}"),
                "size": archive.len(),
                "sha256": archive_sha256,
                "signature_filename": format!("{filename}.sig")
            },
            "key_id": "lidfly-plugin-content-2026-01"
        }))
        .expect("fixture manifest");
        manifest.push(b'\n');
        let manifest_signature = BASE64.encode(signing_key.sign(&manifest).to_bytes());
        let archive_signature = BASE64.encode(signing_key.sign(&archive).to_bytes());
        let routes = BTreeMap::from([
            ("/codex-plugin-content/latest.json".to_owned(), manifest),
            (
                "/codex-plugin-content/latest.json.sig".to_owned(),
                manifest_signature.into_bytes(),
            ),
            (format!("/codex-plugin-content/{filename}"), archive),
            (
                format!("/codex-plugin-content/{filename}.sig"),
                archive_signature.into_bytes(),
            ),
        ]);
        let server = serve_fixture(listener, routes, 12);
        let app_data = tempdir().expect("fixture app data");
        let client = ContentUpdateClient::new_with_policy(
            app_data.path().to_path_buf(),
            "1.2.0",
            &public_key,
            &format!("{origin}/codex-plugin-content/latest.json"),
            &origin,
            "/codex-plugin-content/",
        )
        .expect("fixture client");
        let status =
            tauri::async_runtime::block_on(client.check("1.1.0")).expect("check fixture feed");
        assert_eq!(status.state, PluginContentUpdateState::Available);
        let (downloaded, _) =
            tauri::async_runtime::block_on(client.download_and_activate("1.1.0", false))
                .expect("download fixture bundle");
        assert_eq!(downloaded.origin, BundleOrigin::Remote);
        assert!(client.active_pointer_exists().expect("active pointer"));
        let (reused, _) = tauri::async_runtime::block_on(
            client.download_and_activate(&metadata.plugin_version, false),
        )
        .expect("reuse signed cached bundle");
        assert_eq!(reused.origin, BundleOrigin::Remote);
        let embedded = verify_bundle(
            resources.join("plugin-bundle"),
            &resources.join("plugin-bundle-files.json"),
        )
        .expect("embedded bundle");
        fs::write(
            downloaded.root.join(&metadata.files[0].path),
            b"tampered cache",
        )
        .expect("tamper fixture cache");
        assert_eq!(
            client
                .select_bundle(embedded.clone())
                .expect_err("tampered cache must fail closed")
                .code,
            "content_cache_corrupt"
        );
        client
            .quarantine_active_pointer()
            .expect("quarantine active pointer");
        let (repaired, _) = tauri::async_runtime::block_on(
            client.download_and_activate(&metadata.plugin_version, true),
        )
        .expect("repair corrupted cache");
        assert_eq!(repaired.origin, BundleOrigin::Remote);
        let selected = client
            .select_bundle(embedded)
            .expect("select repaired cache");
        assert_eq!(selected.origin, BundleOrigin::Remote);
        assert_eq!(selected.metadata.plugin_version, metadata.plugin_version);
        server.join().expect("fixture server");
    }

    #[test]
    fn extractor_rejects_duplicate_entries_and_symlinks() {
        let duplicate_destination = tempdir().expect("duplicate destination");
        assert!(extract_archive(
            &archive_with_duplicate_or_link(true, false),
            duplicate_destination.path(),
        )
        .is_err());
        let link_destination = tempdir().expect("link destination");
        assert!(extract_archive(
            &archive_with_duplicate_or_link(false, true),
            link_destination.path(),
        )
        .is_err());
    }

    #[test]
    fn extractor_rejects_single_file_over_limit() {
        let encoder = GzEncoder::new(Vec::new(), Compression::fast());
        let mut builder = Builder::new(encoder);
        let body = vec![b'x'; MAX_FILE_BYTES as usize + 1];
        let mut header = Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "plugin-bundle/too-large", body.as_slice())
            .expect("append large file");
        let mut encoder = builder.into_inner().expect("finish tar");
        encoder.flush().expect("flush gzip");
        let archive = encoder.finish().expect("finish gzip");
        let destination = tempdir().expect("destination");
        assert!(extract_archive(&archive, destination.path()).is_err());
    }
}
