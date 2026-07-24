import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLE_SCHEMA_VERSION = 1;
export const GENERATED_SKILLS_MANIFEST_PATH =
  "plugins/lidfly/skills/.lidfly-generated-skills.json";
export const BUNDLE_BASE_PATHS = Object.freeze([
  ".agents/plugins/marketplace.json",
  "plugins/lidfly/.codex-plugin/plugin.json",
  "plugins/lidfly/.mcp.json",
  "plugins/lidfly/assets/icon.svg",
  "plugins/lidfly/assets/logo-dark.svg",
  "plugins/lidfly/assets/logo.svg",
  GENERATED_SKILLS_MANIFEST_PATH,
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_RESOURCE_ROOTS = new Set(["assets", "references", "scripts"]);
const FORBIDDEN_TEXT = [
  {
    label: "локальный macOS-путь",
    pattern: /\/(?:Users|private\/var\/folders)\//u,
  },
  {
    label: "локальный Windows-путь",
    pattern: /[A-Za-z]:\\(?:Users|Documents and Settings)\\/u,
  },
  {
    label: "development hostname",
    pattern: /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?/u,
  },
  {
    label: "секрет или токен",
    pattern:
      /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*["'][^"']+/iu,
  },
  {
    label: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  },
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function isSafeSkillRelativePath(relativePath) {
  if (!isSafeRelativePath(relativePath)) return false;
  if (relativePath === "SKILL.md" || relativePath === "agents/openai.yaml") {
    return true;
  }
  const parts = relativePath.split("/");
  return (
    parts.length >= 2 &&
    SKILL_RESOURCE_ROOTS.has(parts[0]) &&
    parts.slice(1).every((part) => part.length > 0 && !part.startsWith("."))
  );
}

export function isAllowedBundlePath(relativePath) {
  if (BUNDLE_BASE_PATHS.includes(relativePath)) return true;
  const prefix = "plugins/lidfly/skills/";
  if (!relativePath.startsWith(prefix)) return false;
  const remainder = relativePath.slice(prefix.length);
  const separator = remainder.indexOf("/");
  if (separator <= 0) return false;
  const skillName = remainder.slice(0, separator);
  const skillRelativePath = remainder.slice(separator + 1);
  return (
    SKILL_NAME_RE.test(skillName) &&
    skillName.length <= 64 &&
    isSafeSkillRelativePath(skillRelativePath)
  );
}

function parseGeneratedSkillsManifest(payload, label) {
  if (!isObject(payload)) throw new Error(`${label} must be an object`);
  assertExactKeys(payload, ["skills", "version"], label);
  if (payload.version !== 1) {
    throw new Error(`${label} must use version 1`);
  }
  if (!isObject(payload.skills) || Object.keys(payload.skills).length === 0) {
    throw new Error(`${label}.skills must be a non-empty object`);
  }

  const records = [];
  for (const skillName of Object.keys(payload.skills).sort()) {
    if (!SKILL_NAME_RE.test(skillName) || skillName.length > 64) {
      throw new Error(`${label} contains invalid skill name: ${skillName}`);
    }
    const files = payload.skills[skillName];
    if (!isObject(files) || Object.keys(files).length === 0) {
      throw new Error(`${label}.${skillName} must contain files`);
    }
    if (!Object.hasOwn(files, "SKILL.md")) {
      throw new Error(`${label}.${skillName} is missing SKILL.md`);
    }
    if (!Object.hasOwn(files, "agents/openai.yaml")) {
      throw new Error(`${label}.${skillName} is missing agents/openai.yaml`);
    }
    for (const relativePath of Object.keys(files).sort()) {
      if (!isSafeSkillRelativePath(relativePath)) {
        throw new Error(
          `${label}.${skillName} contains unsafe resource path: ${relativePath}`,
        );
      }
      const sha256 = files[relativePath];
      if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
        throw new Error(
          `${label}.${skillName}/${relativePath} has invalid SHA-256`,
        );
      }
      records.push({
        path: `plugins/lidfly/skills/${skillName}/${relativePath}`,
        sha256,
      });
    }
  }
  return { payload, records };
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const generatedSkills = parseGeneratedSkillsManifest(
  JSON.parse(
    readFileSync(
      path.join(repositoryRoot, GENERATED_SKILLS_MANIFEST_PATH),
      "utf8",
    ),
  ),
  GENERATED_SKILLS_MANIFEST_PATH,
);

export const BUNDLE_PATHS = Object.freeze([
  ...BUNDLE_BASE_PATHS,
  ...generatedSkills.records.map((record) => record.path),
]);

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function isSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0)
    return false;
  if (relativePath.includes("\\") || relativePath.includes("\0")) return false;
  if (path.posix.isAbsolute(relativePath)) return false;
  const normalized = path.posix.normalize(relativePath);
  return (
    normalized === relativePath &&
    !normalized.startsWith("../") &&
    normalized !== ".."
  );
}

export function bundleDigest(filesWithBytes) {
  const digest = createHash("sha256");
  for (const file of [...filesWithBytes].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    digest.update(file.path, "utf8");
    digest.update("\0");
    digest.update(String(file.bytes.byteLength), "ascii");
    digest.update("\0");
    digest.update(file.bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function validateBundleMetadata(metadata) {
  if (!metadata || typeof metadata !== "object")
    throw new Error("Bundle metadata must be an object");
  if (metadata.schema_version !== BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported plugin bundle schema: ${String(metadata.schema_version)}`,
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(metadata.plugin_version)) {
    throw new Error("Bundle plugin_version must use X.Y.Z");
  }
  if (!SHA256_RE.test(metadata.plugin_bundle_sha256)) {
    throw new Error("Bundle plugin_bundle_sha256 must be a lower-case SHA-256");
  }
  if (
    !Array.isArray(metadata.files) ||
    metadata.files.length !== BUNDLE_PATHS.length
  ) {
    throw new Error("Bundle metadata must contain the complete allowlist");
  }
  const actualPaths = metadata.files.map((file) => file.path);
  if (stableJson(actualPaths) !== stableJson(BUNDLE_PATHS)) {
    throw new Error(
      `Bundle paths differ from allowlist: ${actualPaths.join(", ")}`,
    );
  }
  for (const file of metadata.files) {
    if (!isSafeRelativePath(file.path))
      throw new Error(`Unsafe bundle path: ${String(file.path)}`);
    if (!Number.isSafeInteger(file.size) || file.size <= 0)
      throw new Error(`Invalid size for ${file.path}`);
    if (!SHA256_RE.test(file.sha256))
      throw new Error(`Invalid SHA-256 for ${file.path}`);
  }
}

function assertNoForbiddenText(relativePath, bytes) {
  const text = bytes.toString("utf8");
  for (const forbidden of FORBIDDEN_TEXT) {
    if (forbidden.pattern.test(text)) {
      throw new Error(`${relativePath} contains ${forbidden.label}`);
    }
  }
}

async function readAllowedFile(root, relativePath) {
  if (!isSafeRelativePath(relativePath))
    throw new Error(`Unsafe allowlist path: ${relativePath}`);
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  const rootReal = await realpath(root);
  const parentReal = await realpath(path.dirname(absolutePath));
  const relativeParent = path.relative(rootReal, parentReal);
  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new Error(
      `${relativePath} escapes the repository through its parent directory`,
    );
  }

  const fileLstat = await lstat(absolutePath);
  if (!fileLstat.isFile() || fileLstat.isSymbolicLink()) {
    throw new Error(`${relativePath} must be a regular file, not a symlink`);
  }
  if (fileLstat.nlink !== 1)
    throw new Error(`${relativePath} must not be a hardlink`);
  if (fileLstat.size <= 0) throw new Error(`${relativePath} is empty`);

  const fileReal = await realpath(absolutePath);
  const relativeReal = path.relative(rootReal, fileReal);
  if (relativeReal.startsWith("..") || path.isAbsolute(relativeReal)) {
    throw new Error(`${relativePath} escapes the repository root`);
  }

  const bytes = await readFile(absolutePath);
  assertNoForbiddenText(relativePath, bytes);
  return { absolutePath, bytes, path: relativePath };
}

function parseJson(bytes, relativePath) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateGeneratedSkills(files) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const manifestFile = byPath.get(GENERATED_SKILLS_MANIFEST_PATH);
  if (!manifestFile) {
    throw new Error(
      `Generated skills manifest is missing: ${GENERATED_SKILLS_MANIFEST_PATH}`,
    );
  }
  const bundledSkills = parseGeneratedSkillsManifest(
    parseJson(manifestFile.bytes, GENERATED_SKILLS_MANIFEST_PATH),
    GENERATED_SKILLS_MANIFEST_PATH,
  );
  if (
    stableJson(bundledSkills.records) !== stableJson(generatedSkills.records)
  ) {
    throw new Error("Generated skills manifest differs from source allowlist");
  }
  for (const expected of bundledSkills.records) {
    const file = byPath.get(expected.path);
    if (!file)
      throw new Error(`Generated skill file is missing: ${expected.path}`);
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    if (sha256 !== expected.sha256) {
      throw new Error(
        `Generated skill hash differs from manifest: ${expected.path}`,
      );
    }
  }
}

function validatePluginDocuments(files) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const marketplace = parseJson(
    byPath.get(BUNDLE_PATHS[0]).bytes,
    BUNDLE_PATHS[0],
  );
  const plugin = parseJson(byPath.get(BUNDLE_PATHS[1]).bytes, BUNDLE_PATHS[1]);
  const mcp = parseJson(byPath.get(BUNDLE_PATHS[2]).bytes, BUNDLE_PATHS[2]);

  if (
    marketplace.name !== "lidfly" ||
    marketplace.interface?.displayName !== "LidFly"
  ) {
    throw new Error("Marketplace identifiers must remain lidfly / LidFly");
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
    throw new Error("Marketplace must contain exactly the LidFly plugin entry");
  }
  const entry = marketplace.plugins[0];
  if (
    entry.name !== "lidfly" ||
    entry.source?.source !== "local" ||
    entry.source?.path !== "./plugins/lidfly"
  ) {
    throw new Error("Marketplace source must remain ./plugins/lidfly");
  }
  if (
    entry.policy?.installation !== "AVAILABLE" ||
    entry.policy?.authentication !== "ON_INSTALL"
  ) {
    throw new Error(
      "Marketplace install/authentication policy changed unexpectedly",
    );
  }
  if (plugin.name !== "lidfly" || !/^\d+\.\d+\.\d+$/.test(plugin.version)) {
    throw new Error("Plugin name/version is invalid");
  }
  if (plugin.mcpServers !== "./.mcp.json")
    throw new Error("Plugin must reference ./.mcp.json");
  if (plugin.skills !== "./skills/")
    throw new Error("Plugin must reference ./skills/");
  const assetFields = [
    plugin.interface?.composerIcon,
    plugin.interface?.logo,
    plugin.interface?.logoDark,
  ];
  for (const asset of assetFields) {
    if (typeof asset !== "string" || !asset.startsWith("./assets/")) {
      throw new Error(`Invalid plugin asset reference: ${String(asset)}`);
    }
    const bundlePath = `plugins/lidfly/${asset.slice(2)}`;
    if (!byPath.has(bundlePath))
      throw new Error(`Plugin asset is missing from allowlist: ${bundlePath}`);
  }
  const server = mcp.mcpServers?.lidfly;
  if (server?.type !== "http" || server?.url !== "https://lidfly.ru/mcp/v3") {
    throw new Error(
      "LidFly MCP must use the public Streamable HTTP endpoint https://lidfly.ru/mcp/v3",
    );
  }
  return { marketplace, plugin, mcp };
}

async function listSkillTree(directory, prefix) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlink found in plugin skills: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      paths.push(
        ...(await listSkillTree(
          path.join(directory, entry.name),
          relativePath,
        )),
      );
    } else if (entry.isFile()) {
      paths.push(relativePath);
    } else {
      throw new Error(
        `Unsupported file type in plugin skills: ${relativePath}`,
      );
    }
  }
  return paths.sort();
}

export async function inspectSourceBundle(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory())
    throw new Error(`Repository root is not a directory: ${root}`);
  const files = [];
  for (const relativePath of BUNDLE_PATHS)
    files.push(await readAllowedFile(root, relativePath));
  const actualSkillPaths = await listSkillTree(
    path.join(root, "plugins/lidfly/skills"),
    "plugins/lidfly/skills",
  );
  const expectedSkillPaths = BUNDLE_PATHS.filter((relativePath) =>
    relativePath.startsWith("plugins/lidfly/skills/"),
  ).sort();
  if (stableJson(actualSkillPaths) !== stableJson(expectedSkillPaths)) {
    throw new Error(
      `Plugin skills differ from generated allowlist: ${actualSkillPaths.join(", ")}`,
    );
  }
  validateGeneratedSkills(files);
  const documents = validatePluginDocuments(files);
  const records = files.map((file) => ({
    path: file.path,
    size: file.bytes.byteLength,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  }));
  const metadata = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    plugin_version: documents.plugin.version,
    plugin_bundle_sha256: bundleDigest(files),
    files: records,
  };
  validateBundleMetadata(metadata);
  return { documents, files, metadata, root };
}

export async function inspectBuiltBundle(bundleRoot, metadataPath) {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  validateBundleMetadata(metadata);
  const files = [];
  for (const relativePath of BUNDLE_PATHS)
    files.push(await readAllowedFile(bundleRoot, relativePath));
  const digest = bundleDigest(files);
  if (digest !== metadata.plugin_bundle_sha256) {
    throw new Error(
      `Plugin bundle SHA-256 mismatch: expected ${metadata.plugin_bundle_sha256}, got ${digest}`,
    );
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const expected = metadata.files[index];
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    if (file.bytes.byteLength !== expected.size || sha256 !== expected.sha256) {
      throw new Error(`Plugin bundle file mismatch: ${file.path}`);
    }
  }
  validateGeneratedSkills(files);
  validatePluginDocuments(files);
  return { files, metadata };
}
