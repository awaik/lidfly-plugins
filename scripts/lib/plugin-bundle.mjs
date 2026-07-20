import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const BUNDLE_SCHEMA_VERSION = 1;
export const BUNDLE_PATHS = Object.freeze([
  ".agents/plugins/marketplace.json",
  "plugins/lidfly/.codex-plugin/plugin.json",
  "plugins/lidfly/.mcp.json",
  "plugins/lidfly/assets/icon.svg",
  "plugins/lidfly/assets/logo-dark.svg",
  "plugins/lidfly/assets/logo.svg",
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
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
  for (const file of [...filesWithBytes].sort((a, b) =>
    a.path.localeCompare(b.path, "en"),
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

export async function inspectSourceBundle(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory())
    throw new Error(`Repository root is not a directory: ${root}`);
  const files = [];
  for (const relativePath of BUNDLE_PATHS)
    files.push(await readAllowedFile(root, relativePath));
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
  validatePluginDocuments(files);
  return { files, metadata };
}
