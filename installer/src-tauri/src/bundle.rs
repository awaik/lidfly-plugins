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
pub const SKILLS_SOURCE_LOCK_PATH: &str = "plugins/lidfly/skills-source.lock.json";
pub const CLAUDE_PROJECT_REPOSITORY: &str = "https://github.com/awaik/direct-mcp-ai-project";
pub const CLAUDE_PROJECT_PREFIX: &str = "claude-project/";
pub const CLAUDE_PROJECT_MANIFEST_PATH: &str = "claude-project/.lidfly-claude-project.json";
pub const CLAUDE_PROJECT_LOCK_PATH: &str = "claude-project-source.lock.json";
pub const BUNDLE_BASE_PATHS: [&str; 10] = [
    ".agents/plugins/marketplace.json",
    "plugins/lidfly/.codex-plugin/plugin.json",
    "plugins/lidfly/.mcp.json",
    "plugins/lidfly/assets/icon.svg",
    "plugins/lidfly/assets/logo-dark.svg",
    "plugins/lidfly/assets/logo.svg",
    SKILLS_SOURCE_LOCK_PATH,
    GENERATED_SKILLS_MANIFEST_PATH,
    CLAUDE_PROJECT_LOCK_PATH,
    CLAUDE_PROJECT_MANIFEST_PATH,
];
const SKILLS_PATH_PREFIX: &str = "plugins/lidfly/skills/";
type GeneratedBundleContract = (
    Vec<String>,
    BTreeMap<String, String>,
    SourceProvenance,
    ClaudeProjectProvenance,
);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BundleFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleMetadata {
    pub schema_version: u32,
    pub plugin_version: String,
    pub plugin_bundle_sha256: String,
    pub source: SourceProvenance,
    pub claude_project: ClaudeProjectProvenance,
    pub files: Vec<BundleFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ClaudeProjectProvenance {
    pub repository: String,
    pub commit: String,
    pub project_tree_sha256: String,
    pub file_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceProvenance {
    pub repository: String,
    pub commit: String,
    pub skills_tree_sha256: String,
    pub skill_count: u32,
    pub file_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BundleOrigin {
    Embedded,
    Remote,
}

#[derive(Debug, Clone)]
pub struct VerifiedBundle {
    pub root: PathBuf,
    pub metadata: BundleMetadata,
    pub origin: BundleOrigin,
    pub content_key_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GeneratedSkillsManifest {
    version: u32,
    skills: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillsSourceLock {
    schema_version: u32,
    source: SkillsSource,
    skills_tree_sha256: String,
    skill_count: u32,
    file_count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillsSource {
    repository: String,
    commit: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaudeProjectManifest {
    version: u32,
    files: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaudeProjectLock {
    schema_version: u32,
    source: SkillsSource,
    project_tree_sha256: String,
    file_count: u32,
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_commit(value: &str) -> bool {
    value.len() == 40
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

pub fn is_safe_claude_project_source_path(value: &str) -> bool {
    if value.is_empty()
        || !value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        || value.contains('\\')
    {
        return false;
    }
    if value == ".git" || value.starts_with(".git/") {
        return false;
    }
    if value == ".lidfly-claude-project.json"
        || value == ".lidfly-installer"
        || value.starts_with(".lidfly-installer/")
    {
        return false;
    }
    value
        .split('/')
        .all(|part| !part.is_empty() && part != "." && part != "..")
}

pub fn is_allowed_bundle_path(value: &str) -> bool {
    if BUNDLE_BASE_PATHS.contains(&value) {
        return true;
    }
    if let Some(remainder) = value.strip_prefix(CLAUDE_PROJECT_PREFIX) {
        return is_safe_claude_project_source_path(remainder);
    }
    let Some(remainder) = value.strip_prefix(SKILLS_PATH_PREFIX) else {
        return false;
    };
    let Some((skill_name, relative_path)) = remainder.split_once('/') else {
        return false;
    };
    is_skill_name(skill_name) && is_skill_relative_path(relative_path)
}

fn generated_bundle_contract(root: &Path) -> Result<GeneratedBundleContract, ClientError> {
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
    let mut tree_digest = Sha256::new();
    let skill_count = manifest.skills.len() as u32;
    let mut file_count = 0_u32;
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
            let size = fs::symlink_metadata(safe_join(root, &bundle_path)?)?.len();
            tree_digest.update(format!("{skill_name}/{relative_path}").as_bytes());
            tree_digest.update([0]);
            tree_digest.update(size.to_string().as_bytes());
            tree_digest.update([0]);
            tree_digest.update(sha256.as_bytes());
            tree_digest.update([0]);
            file_count += 1;
            paths.push(bundle_path.clone());
            hashes.insert(bundle_path, sha256);
        }
    }
    let source_lock: SkillsSourceLock =
        serde_json::from_slice(&fs::read(safe_join(root, SKILLS_SOURCE_LOCK_PATH)?)?)?;
    let actual_tree_sha256 = format!("{:x}", tree_digest.finalize());
    if source_lock.schema_version != 1
        || source_lock.source.repository != "https://github.com/awaik/direct-mcp-ai-project"
        || !is_commit(&source_lock.source.commit)
        || source_lock.skills_tree_sha256 != actual_tree_sha256
        || source_lock.skill_count != skill_count
        || source_lock.file_count != file_count
    {
        return Err(ClientError::new(
            "invalid_source_provenance",
            "Source provenance не совпадает с экспортированными skills.",
        ));
    }

    let claude_manifest_path = safe_join(root, CLAUDE_PROJECT_MANIFEST_PATH)?;
    let claude_manifest_metadata = fs::symlink_metadata(&claude_manifest_path)?;
    if !claude_manifest_metadata.is_file()
        || claude_manifest_metadata.file_type().is_symlink()
        || claude_manifest_metadata.len() == 0
    {
        return Err(ClientError::new(
            "invalid_claude_project_manifest",
            "Manifest встроенного Claude-проекта не является обычным непустым файлом.",
        ));
    }
    let claude_manifest: ClaudeProjectManifest =
        serde_json::from_slice(&fs::read(&claude_manifest_path)?)?;
    if claude_manifest.version != 1 || claude_manifest.files.is_empty() {
        return Err(ClientError::new(
            "invalid_claude_project_manifest",
            "Manifest Claude-проекта должен использовать version 1 и содержать files.",
        ));
    }
    let mut project_tree_digest = Sha256::new();
    let mut project_file_count = 0_u32;
    for (relative_path, sha256) in &claude_manifest.files {
        if !is_safe_claude_project_source_path(relative_path) || !is_sha256(sha256) {
            return Err(ClientError::new(
                "invalid_claude_project_manifest",
                format!("Некорректный файл Claude-проекта: {relative_path}"),
            ));
        }
        let bundle_path = format!("{CLAUDE_PROJECT_PREFIX}{relative_path}");
        let size = fs::symlink_metadata(safe_join(root, &bundle_path)?)?.len();
        project_tree_digest.update(relative_path.as_bytes());
        project_tree_digest.update([0]);
        project_tree_digest.update(size.to_string().as_bytes());
        project_tree_digest.update([0]);
        project_tree_digest.update(sha256.as_bytes());
        project_tree_digest.update([0]);
        project_file_count += 1;
        paths.push(bundle_path.clone());
        hashes.insert(bundle_path, sha256.clone());
    }
    let claude_lock: ClaudeProjectLock =
        serde_json::from_slice(&fs::read(safe_join(root, CLAUDE_PROJECT_LOCK_PATH)?)?)?;
    let actual_project_tree_sha256 = format!("{:x}", project_tree_digest.finalize());
    if claude_lock.schema_version != 1
        || claude_lock.source.repository != CLAUDE_PROJECT_REPOSITORY
        || !is_commit(&claude_lock.source.commit)
        || claude_lock.project_tree_sha256 != actual_project_tree_sha256
        || claude_lock.file_count != project_file_count
    {
        return Err(ClientError::new(
            "invalid_claude_project_provenance",
            "Provenance Claude-проекта не совпадает со снапшотом.",
        ));
    }

    paths.sort();
    Ok((
        paths,
        hashes,
        SourceProvenance {
            repository: source_lock.source.repository,
            commit: source_lock.source.commit,
            skills_tree_sha256: source_lock.skills_tree_sha256,
            skill_count,
            file_count,
        },
        ClaudeProjectProvenance {
            repository: claude_lock.source.repository,
            commit: claude_lock.source.commit,
            project_tree_sha256: claude_lock.project_tree_sha256,
            file_count: project_file_count,
        },
    ))
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
    if metadata.schema_version != 3 {
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
    let (expected_paths, generated_hashes, source, claude_project) =
        generated_bundle_contract(&root)?;
    if metadata.source != source {
        return Err(ClientError::new(
            "source_provenance_mismatch",
            "Source provenance в bundle metadata не совпадает с skills.",
        ));
    }
    if metadata.claude_project != claude_project {
        return Err(ClientError::new(
            "claude_project_provenance_mismatch",
            "Provenance Claude-проекта в bundle metadata не совпадает со снапшотом.",
        ));
    }
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
    Ok(VerifiedBundle {
        root,
        metadata,
        origin: BundleOrigin::Embedded,
        content_key_id: None,
    })
}

impl VerifiedBundle {
    pub fn as_remote(mut self, content_key_id: String) -> Self {
        self.origin = BundleOrigin::Remote;
        self.content_key_id = Some(content_key_id);
        self
    }

    /// Производный bundle из файлов `claude-project/**` со снятым префиксом:
    /// им управляет тот же транзакционный движок, но целевой каталог —
    /// пользовательская папка LidFly, а не marketplace.
    pub fn claude_project_view(&self) -> Result<VerifiedBundle, ClientError> {
        let mut files = Vec::new();
        let mut digest = Sha256::new();
        for file in &self.metadata.files {
            if file.path == CLAUDE_PROJECT_MANIFEST_PATH {
                continue;
            }
            let Some(relative) = file.path.strip_prefix(CLAUDE_PROJECT_PREFIX) else {
                continue;
            };
            let bytes = fs::read(safe_join(&self.root, &file.path)?)?;
            if bytes.len() as u64 != file.size
                || format!("{:x}", Sha256::digest(&bytes)) != file.sha256
            {
                return Err(ClientError::new(
                    "bundle_file_mismatch",
                    format!(
                        "Файл Claude-проекта изменился после проверки: {}",
                        file.path
                    ),
                ));
            }
            digest.update(relative.as_bytes());
            digest.update([0]);
            digest.update(bytes.len().to_string().as_bytes());
            digest.update([0]);
            digest.update(&bytes);
            digest.update([0]);
            files.push(BundleFile {
                path: relative.to_owned(),
                size: file.size,
                sha256: file.sha256.clone(),
            });
        }
        if files.is_empty() {
            return Err(ClientError::new(
                "claude_project_missing",
                "Bundle не содержит файлов Claude-проекта.",
            ));
        }
        Ok(VerifiedBundle {
            root: self.root.join("claude-project"),
            metadata: BundleMetadata {
                schema_version: self.metadata.schema_version,
                plugin_version: self.metadata.plugin_version.clone(),
                plugin_bundle_sha256: format!("{:x}", digest.finalize()),
                source: self.metadata.source.clone(),
                claude_project: self.metadata.claude_project.clone(),
                files,
            },
            origin: self.origin.clone(),
            content_key_id: self.content_key_id.clone(),
        })
    }

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

    #[test]
    fn claude_project_paths_allow_dotfiles_but_not_control_or_git() {
        assert!(is_allowed_bundle_path("claude-project/CLAUDE.md"));
        assert!(is_allowed_bundle_path(
            "claude-project/.claude/skills/semantic-core/SKILL.md"
        ));
        assert!(is_allowed_bundle_path("claude-project/.mcp.json"));
        assert!(!is_allowed_bundle_path("claude-project/.git/config"));
        assert!(!is_allowed_bundle_path(
            "claude-project/.lidfly-installer/installed-state.json"
        ));
        assert!(!is_allowed_bundle_path("claude-project/../escape.md"));
        assert!(!is_allowed_bundle_path("claude-project/пример.md"));
        assert!(!is_allowed_bundle_path("claude-project/a//b.md"));
        assert!(!is_allowed_bundle_path("claude-project/a/\u{1f}b.md"));
        assert!(!is_allowed_bundle_path("claude-project/a/\u{7f}b.md"));
    }
}
