use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::models::ClientError;

pub const GENERATED_SKILLS_MANIFEST_PATH: &str =
    "plugins/lidfly/skills/.lidfly-generated-skills.json";
pub const BUNDLE_BASE_PATHS: [&str; 7] = [
    ".agents/plugins/marketplace.json",
    "plugins/lidfly/.codex-plugin/plugin.json",
    "plugins/lidfly/.mcp.json",
    "plugins/lidfly/assets/icon.svg",
    "plugins/lidfly/assets/logo-dark.svg",
    "plugins/lidfly/assets/logo.svg",
    GENERATED_SKILLS_MANIFEST_PATH,
];
const SKILLS_PATH_PREFIX: &str = "plugins/lidfly/skills/";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BundleFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleMetadata {
    pub schema_version: u32,
    pub plugin_version: String,
    pub plugin_bundle_sha256: String,
    pub files: Vec<BundleFile>,
}

#[derive(Debug, Clone)]
pub struct VerifiedBundle {
    pub root: PathBuf,
    pub metadata: BundleMetadata,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GeneratedSkillsManifest {
    version: u32,
    skills: BTreeMap<String, BTreeMap<String, String>>,
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_skill_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn is_skill_relative_path(value: &str) -> bool {
    if value == "SKILL.md" || value == "agents/openai.yaml" {
        return true;
    }
    let parts: Vec<&str> = value.split('/').collect();
    parts.len() >= 2
        && matches!(parts[0], "assets" | "references" | "scripts")
        && parts[1..]
            .iter()
            .all(|part| !part.is_empty() && !part.starts_with('.'))
}

pub fn is_allowed_bundle_path(value: &str) -> bool {
    if BUNDLE_BASE_PATHS.contains(&value) {
        return true;
    }
    let Some(remainder) = value.strip_prefix(SKILLS_PATH_PREFIX) else {
        return false;
    };
    let Some((skill_name, relative_path)) = remainder.split_once('/') else {
        return false;
    };
    is_skill_name(skill_name) && is_skill_relative_path(relative_path)
}

fn generated_bundle_contract(
    root: &Path,
) -> Result<(Vec<String>, BTreeMap<String, String>), ClientError> {
    let manifest_path = safe_join(root, GENERATED_SKILLS_MANIFEST_PATH)?;
    let manifest_metadata = fs::symlink_metadata(&manifest_path)?;
    if !manifest_metadata.is_file()
        || manifest_metadata.file_type().is_symlink()
        || manifest_metadata.len() == 0
    {
        return Err(ClientError::new(
            "invalid_skills_manifest",
            "Manifest встроенных skills не является обычным непустым файлом.",
        ));
    }
    let manifest: GeneratedSkillsManifest = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    if manifest.version != 1 || manifest.skills.is_empty() {
        return Err(ClientError::new(
            "invalid_skills_manifest",
            "Manifest встроенных skills должен использовать version 1 и содержать skills.",
        ));
    }

    let mut paths = BUNDLE_BASE_PATHS
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let mut hashes = BTreeMap::new();
    for (skill_name, files) in manifest.skills {
        if !is_skill_name(&skill_name)
            || !files.contains_key("SKILL.md")
            || !files.contains_key("agents/openai.yaml")
        {
            return Err(ClientError::new(
                "invalid_skills_manifest",
                format!("Некорректное описание skill: {skill_name}"),
            ));
        }
        for (relative_path, sha256) in files {
            if !is_skill_relative_path(&relative_path) || !is_sha256(&sha256) {
                return Err(ClientError::new(
                    "invalid_skills_manifest",
                    format!("Некорректный ресурс skill: {skill_name}/{relative_path}"),
                ));
            }
            let bundle_path = format!("{SKILLS_PATH_PREFIX}{skill_name}/{relative_path}");
            paths.push(bundle_path.clone());
            hashes.insert(bundle_path, sha256);
        }
    }
    Ok((paths, hashes))
}

pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, ClientError> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || relative.contains('\\')
        || relative.contains('\0')
    {
        return Err(ClientError::new(
            "unsafe_path",
            format!("Небезопасный относительный путь: {relative}"),
        ));
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(ClientError::new(
                "unsafe_path",
                format!("Небезопасный относительный путь: {relative}"),
            ));
        }
    }
    Ok(root.join(path))
}

pub fn sha256_file(path: &Path) -> Result<(String, u64), ClientError> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        digest.update(&buffer[..read]);
    }
    Ok((format!("{:x}", digest.finalize()), size))
}

fn verify_json_contract(root: &Path) -> Result<(), ClientError> {
    let marketplace: Value = serde_json::from_slice(&fs::read(safe_join(
        root,
        ".agents/plugins/marketplace.json",
    )?)?)?;
    let plugin: Value = serde_json::from_slice(&fs::read(safe_join(
        root,
        "plugins/lidfly/.codex-plugin/plugin.json",
    )?)?)?;
    let mcp: Value =
        serde_json::from_slice(&fs::read(safe_join(root, "plugins/lidfly/.mcp.json")?)?)?;

    let source = &marketplace["plugins"][0]["source"];
    if marketplace["name"] != "lidfly"
        || source["source"] != "local"
        || source["path"] != "./plugins/lidfly"
        || plugin["name"] != "lidfly"
        || plugin["skills"] != "./skills/"
        || plugin["mcpServers"] != "./.mcp.json"
        || mcp["mcpServers"]["lidfly"]["type"] != "http"
        || mcp["mcpServers"]["lidfly"]["url"] != "https://lidfly.ru/mcp/v3"
    {
        return Err(ClientError::new(
            "invalid_bundle_contract",
            "Встроенный marketplace не соответствует публичному контракту LidFly.",
        ));
    }
    Ok(())
}

pub fn verify_bundle(root: PathBuf, metadata_path: &Path) -> Result<VerifiedBundle, ClientError> {
    let metadata_file = fs::symlink_metadata(metadata_path)?;
    if !metadata_file.is_file() || metadata_file.file_type().is_symlink() {
        return Err(ClientError::new(
            "invalid_bundle_metadata",
            "Manifest встроенного bundle не является обычным файлом.",
        ));
    }
    let metadata: BundleMetadata = serde_json::from_slice(&fs::read(metadata_path)?)?;
    if metadata.schema_version != 1 {
        return Err(ClientError::new(
            "unsupported_bundle_schema",
            format!(
                "Неподдерживаемая версия bundle schema: {}",
                metadata.schema_version
            ),
        ));
    }
    let root_metadata = fs::symlink_metadata(&root)?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(ClientError::new(
            "unsafe_bundle_root",
            "Каталог встроенного bundle небезопасен.",
        ));
    }
    let canonical_root = fs::canonicalize(&root)?;
    let (expected_paths, generated_hashes) = generated_bundle_contract(&root)?;
    let actual_paths: Vec<String> = metadata
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect();
    if actual_paths != expected_paths {
        return Err(ClientError::new(
            "bundle_allowlist_mismatch",
            "Список файлов встроенного bundle не совпадает с allowlist.",
        ));
    }

    let mut bundle_digest = Sha256::new();
    for expected in &metadata.files {
        if !is_allowed_bundle_path(&expected.path) {
            return Err(ClientError::new(
                "bundle_allowlist_mismatch",
                format!("Файл не разрешён контрактом bundle: {}", expected.path),
            ));
        }
        if let Some(generated_sha256) = generated_hashes.get(&expected.path) {
            if generated_sha256 != &expected.sha256 {
                return Err(ClientError::new(
                    "skills_manifest_mismatch",
                    format!(
                        "Контрольная сумма skill не совпадает с manifest: {}",
                        expected.path
                    ),
                ));
            }
        }
        let path = safe_join(&root, &expected.path)?;
        let file_metadata = fs::symlink_metadata(&path)?;
        if !file_metadata.is_file()
            || file_metadata.file_type().is_symlink()
            || file_metadata.len() == 0
        {
            return Err(ClientError::new(
                "invalid_bundle_file",
                format!("Небезопасный или пустой файл bundle: {}", expected.path),
            ));
        }
        let canonical = fs::canonicalize(&path)?;
        if !canonical.starts_with(&canonical_root) {
            return Err(ClientError::new(
                "bundle_path_escape",
                format!("Файл bundle выходит за пределы корня: {}", expected.path),
            ));
        }
        let bytes = fs::read(&path)?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        if bytes.len() as u64 != expected.size || sha256 != expected.sha256 {
            return Err(ClientError::new(
                "bundle_file_mismatch",
                format!(
                    "Контрольная сумма файла bundle не совпадает: {}",
                    expected.path
                ),
            ));
        }
        bundle_digest.update(expected.path.as_bytes());
        bundle_digest.update([0]);
        bundle_digest.update(bytes.len().to_string().as_bytes());
        bundle_digest.update([0]);
        bundle_digest.update(&bytes);
        bundle_digest.update([0]);
    }
    let actual_bundle_sha256 = format!("{:x}", bundle_digest.finalize());
    if actual_bundle_sha256 != metadata.plugin_bundle_sha256 {
        return Err(ClientError::new(
            "bundle_hash_mismatch",
            "Общая контрольная сумма встроенного bundle не совпадает.",
        ));
    }
    verify_json_contract(&root)?;
    Ok(VerifiedBundle { root, metadata })
}

impl VerifiedBundle {
    pub fn files_by_path(&self) -> BTreeMap<&str, &BundleFile> {
        self.metadata
            .files
            .iter()
            .map(|file| (file.path.as_str(), file))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_bundle_path, safe_join};
    use std::path::Path;

    #[test]
    fn safe_join_rejects_traversal_and_absolute_paths() {
        let root = Path::new("/tmp/root");
        assert!(safe_join(root, "plugins/lidfly/.mcp.json").is_ok());
        assert!(safe_join(root, "../secret").is_err());
        assert!(safe_join(root, "/tmp/secret").is_err());
        assert!(safe_join(root, "plugins\\lidfly").is_err());
    }

    #[test]
    fn bundle_path_policy_accepts_skill_resources_only() {
        assert!(is_allowed_bundle_path(
            "plugins/lidfly/skills/semantic-core/SKILL.md"
        ));
        assert!(is_allowed_bundle_path(
            "plugins/lidfly/skills/semantic-core/references/output-format.md"
        ));
        assert!(!is_allowed_bundle_path(
            "plugins/lidfly/skills/semantic-core/README.md"
        ));
        assert!(!is_allowed_bundle_path("plugins/lidfly/README.md"));
    }
}
