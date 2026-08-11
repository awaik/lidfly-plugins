#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { APP_NAME } from "./lib/release-contract.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releasesDir = path.join(root, "releases");
const latestPath = path.join(releasesDir, "latest.json");
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const REPOSITORY = "https://github.com/awaik/lidfly-plugins";
const LEGACY_APP_NAME = "LidFly Codex Plugin Installer";
const LAST_LEGACY_APP_NAME_VERSION = "1.3.0";

function usage() {
  return `Usage:
  node scripts/manage-release-metadata.mjs --check [--file releases/X.Y.Z.json]
  node scripts/manage-release-metadata.mjs --promote [--file releases/X.Y.Z.json]
`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  assert(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${label} has unexpected fields`,
  );
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compareSemver(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function releaseVersion(metadata) {
  return metadata.schemaVersion === 2
    ? metadata.installer?.version
    : metadata.plugin?.version;
}

function validatePublication(metadata, expectedTag) {
  exactKeys(
    metadata.publication,
    ["commit", "publishedAt", "status", "tag"],
    "publication",
  );
  assert(
    ["draft", "published"].includes(metadata.publication.status),
    "invalid publication.status",
  );
  assert(
    metadata.publication.tag === expectedTag,
    `publication.tag must be ${expectedTag}`,
  );
  if (metadata.publication.status === "draft") {
    assert(metadata.publication.commit === null, "draft commit must be null");
    assert(
      metadata.publication.publishedAt === null,
      "draft publishedAt must be null",
    );
  } else {
    assert(
      COMMIT.test(metadata.publication.commit),
      "published commit must be a full SHA",
    );
    assert(
      typeof metadata.publication.publishedAt === "string" &&
        !Number.isNaN(Date.parse(metadata.publication.publishedAt)),
      "publishedAt must be ISO-8601",
    );
  }
}

function validateArtifact(artifact, tag) {
  exactKeys(
    artifact,
    ["filename", "platform", "sha256", "size", "url"],
    "installer artifact",
  );
  assert(
    ["macos-universal", "windows-x86_64"].includes(artifact.platform),
    "invalid installer platform",
  );
  assert(
    typeof artifact.filename === "string" &&
      artifact.filename.length > 0 &&
      !artifact.filename.includes("/") &&
      !artifact.filename.includes("\\"),
    "invalid artifact filename",
  );
  assert(
    Number.isSafeInteger(artifact.size) && artifact.size > 0,
    "invalid artifact size",
  );
  assert(SHA256.test(artifact.sha256), "invalid artifact SHA-256");
  let url;
  try {
    url = new URL(artifact.url);
  } catch {
    throw new Error("artifact URL must be a valid absolute URL");
  }
  assert(
    url.protocol === "https:" && url.hostname === "github.com",
    "artifact URL must use GitHub HTTPS",
  );
  const expectedPrefix = `/awaik/lidfly-plugins/releases/download/${tag}/`;
  assert(
    url.pathname.startsWith(expectedPrefix),
    `artifact URL must point to ${tag}`,
  );
  assert(
    decodeURIComponent(url.pathname.slice(expectedPrefix.length)) ===
      artifact.filename,
    "artifact URL filename mismatch",
  );
}

function validateInstallers(metadata) {
  exactKeys(metadata.installers, ["artifacts", "status"], "installers");
  assert(
    ["unpublished", "published"].includes(metadata.installers.status),
    "invalid installers.status",
  );
  assert(
    Array.isArray(metadata.installers.artifacts),
    "installers.artifacts must be an array",
  );
  if (metadata.installers.status === "unpublished") {
    assert(
      metadata.installers.artifacts.length === 0,
      "unpublished installers must be empty",
    );
    return;
  }
  assert(
    metadata.publication.status === "published",
    "installers require a published release",
  );
  const platforms = new Set();
  for (const artifact of metadata.installers.artifacts) {
    validateArtifact(artifact, metadata.publication.tag);
    assert(
      !platforms.has(artifact.platform),
      `duplicate platform ${artifact.platform}`,
    );
    platforms.add(artifact.platform);
  }
  assert(
    platforms.has("macos-universal") &&
      platforms.has("windows-x86_64") &&
      platforms.size === 2,
    "published release must contain both installers",
  );
}

function validateMarketplace(marketplace) {
  exactKeys(
    marketplace,
    ["catalogPath", "name", "pluginPath", "repository"],
    "marketplace",
  );
  assert(
    marketplace.name === "lidfly" &&
      marketplace.repository === REPOSITORY &&
      marketplace.catalogPath === "./.agents/plugins/marketplace.json" &&
      marketplace.pluginPath === "./plugins/lidfly",
    "marketplace contract changed",
  );
}

function validateLegacy(metadata) {
  exactKeys(
    metadata,
    ["installers", "marketplace", "plugin", "publication", "schemaVersion"],
    "legacy release",
  );
  exactKeys(
    metadata.plugin,
    ["manifestPath", "mcpUrl", "name", "version"],
    "plugin",
  );
  assert(
    metadata.plugin.name === "lidfly" &&
      SEMVER.test(metadata.plugin.version) &&
      metadata.plugin.manifestPath ===
        "./plugins/lidfly/.codex-plugin/plugin.json" &&
      metadata.plugin.mcpUrl === "https://lidfly.ru/mcp/v3",
    "legacy plugin contract changed",
  );
  validateMarketplace(metadata.marketplace);
  validatePublication(metadata, `v${metadata.plugin.version}`);
  validateInstallers(metadata);
}

function validateIndependent(metadata) {
  exactKeys(
    metadata,
    [
      "embeddedPlugin",
      "installer",
      "installers",
      "marketplace",
      "publication",
      "schemaVersion",
    ],
    "installer release",
  );
  exactKeys(metadata.installer, ["name", "version"], "installer");
  exactKeys(
    metadata.embeddedPlugin,
    ["manifestPath", "mcpUrl", "name", "version"],
    "embeddedPlugin",
  );
  const installerVersion = metadata.installer.version;
  assert(SEMVER.test(installerVersion), "invalid installer metadata");
  const legacyNameAllowed =
    compareSemver(installerVersion, LAST_LEGACY_APP_NAME_VERSION) <= 0;
  assert(
    metadata.installer.name === APP_NAME ||
      (legacyNameAllowed && metadata.installer.name === LEGACY_APP_NAME),
    `installer.name must be ${APP_NAME}`,
  );
  assert(
    metadata.embeddedPlugin.name === "lidfly" &&
      SEMVER.test(metadata.embeddedPlugin.version) &&
      metadata.embeddedPlugin.manifestPath ===
        "./plugins/lidfly/.codex-plugin/plugin.json" &&
      metadata.embeddedPlugin.mcpUrl === "https://lidfly.ru/mcp/v3",
    "invalid embedded plugin metadata",
  );
  validateMarketplace(metadata.marketplace);
  validatePublication(metadata, `installer-v${metadata.installer.version}`);
  validateInstallers(metadata);
}

function validateMetadata(metadata, sourcePath, requireVersionFilename = true) {
  assert(
    [1, 2].includes(metadata.schemaVersion),
    "schemaVersion must be 1 or 2",
  );
  if (metadata.schemaVersion === 1) validateLegacy(metadata);
  else validateIndependent(metadata);
  const version = releaseVersion(metadata);
  if (requireVersionFilename) {
    assert(
      path.basename(sourcePath) === `${version}.json`,
      `metadata filename must be ${version}.json`,
    );
  }
}

function resolveInsideRepository(relativePath, label) {
  assert(
    typeof relativePath === "string" && relativePath.startsWith("./"),
    `${label} must start with ./`,
  );
  const resolved = path.resolve(root, relativePath);
  assert(
    resolved.startsWith(`${root}${path.sep}`),
    `${label} escapes the repository`,
  );
  return resolved;
}

function validateProject(metadata, current) {
  const embedded =
    metadata.schemaVersion === 2 ? metadata.embeddedPlugin : metadata.plugin;
  const manifestPath = resolveInsideRepository(
    embedded.manifestPath,
    "plugin manifestPath",
  );
  const catalogPath = resolveInsideRepository(
    metadata.marketplace.catalogPath,
    "marketplace catalogPath",
  );
  const pluginPath = resolveInsideRepository(
    metadata.marketplace.pluginPath,
    "marketplace pluginPath",
  );
  assert(existsSync(pluginPath), "marketplace plugin path does not exist");
  const plugin = JSON.parse(readFileSync(manifestPath, "utf8"));
  const marketplace = JSON.parse(readFileSync(catalogPath, "utf8"));
  const mcpPath = path.resolve(pluginPath, plugin.mcpServers);
  assert(
    mcpPath.startsWith(`${pluginPath}${path.sep}`),
    "plugin MCP path escapes the plugin directory",
  );
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  const entry = marketplace.plugins?.find(
    (candidate) => candidate.name === "lidfly",
  );
  assert(
    marketplace.name === "lidfly" &&
      plugin.name === "lidfly" &&
      entry?.source?.source === "local" &&
      entry.source.path === "./plugins/lidfly",
    "marketplace project mismatch",
  );
  assert(
    plugin.interface?.displayName === marketplace.interface?.displayName,
    "manifest and marketplace display names differ",
  );
  assert(
    plugin.interface?.category === entry.category,
    "manifest and marketplace categories differ",
  );
  assert(
    mcp.mcpServers?.lidfly?.type === "http" &&
      mcp.mcpServers.lidfly.url === embedded.mcpUrl,
    "release metadata and MCP configuration differ",
  );
  if (current && metadata.schemaVersion === 1) {
    assert(
      embedded.version === plugin.version,
      "legacy plugin version differs from manifest",
    );
  }
}

function parseArgs(argv) {
  let mode = "check";
  let modeWasSet = false;
  let file = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check" || argument === "--promote") {
      assert(!modeWasSet, "use only one of --check or --promote");
      mode = argument.slice(2);
      modeWasSet = true;
    } else if (argument === "--file") {
      const value = argv[++index];
      assert(value && !value.startsWith("--"), "--file requires a path");
      file = value;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { file, mode };
}

async function sha256Download(url) {
  const response = await fetch(url);
  assert(
    response.ok && response.body,
    `Cannot download ${url}: HTTP ${response.status}`,
  );
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    digest.update(chunk);
    size += chunk.length;
  }
  return { sha256: digest.digest("hex"), size };
}

async function promote(metadata, metadataPath) {
  assert(metadata.publication.status === "published", "cannot promote a draft");
  assert(
    metadata.installers.status === "published",
    "cannot promote unpublished installers",
  );
  if (existsSync(latestPath)) {
    const latest = JSON.parse(await readFile(latestPath, "utf8"));
    const currentParts = releaseVersion(latest).split(".").map(Number);
    const nextParts = releaseVersion(metadata).split(".").map(Number);
    const comparison = nextParts.findIndex(
      (value, index) => value !== currentParts[index],
    );
    assert(
      comparison < 0 || nextParts[comparison] > currentParts[comparison],
      "installer release downgrade is forbidden",
    );
  }
  const { stdout } = await execFileAsync(
    "git",
    ["rev-list", "-n", "1", metadata.publication.tag],
    { cwd: root, encoding: "utf8" },
  );
  assert(
    stdout.trim() === metadata.publication.commit,
    "release tag commit mismatch",
  );
  for (const artifact of metadata.installers.artifacts) {
    const actual = await sha256Download(artifact.url);
    assert(
      actual.size === artifact.size && actual.sha256 === artifact.sha256,
      `download mismatch: ${artifact.filename}`,
    );
  }
  const temporary = path.join(releasesDir, `.latest.json.${process.pid}.tmp`);
  try {
    await writeFile(temporary, stableJson(metadata), "utf8");
    await rename(temporary, latestPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  process.stdout.write(`Promoted ${metadataPath} to releases/latest.json\n`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const installerVersion = JSON.parse(
    await readFile(path.join(root, "installer/package.json"), "utf8"),
  ).version;
  const metadataPath = args.file
    ? path.resolve(root, args.file)
    : path.join(releasesDir, `${installerVersion}.json`);
  assert(
    metadataPath.startsWith(`${releasesDir}${path.sep}`),
    "--file must point inside releases/",
  );
  assert(
    metadataPath !== latestPath,
    "--file must not be releases/latest.json",
  );
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  validateMetadata(metadata, metadataPath);
  validateProject(metadata, !args.file);

  if (existsSync(latestPath)) {
    const latest = JSON.parse(await readFile(latestPath, "utf8"));
    validateMetadata(latest, latestPath, false);
    assert(
      latest.publication.status === "published",
      "latest must be published",
    );
    assert(
      latest.installers.status === "published",
      "latest installers must be published",
    );
    const versioned = JSON.parse(
      await readFile(
        path.join(releasesDir, `${releaseVersion(latest)}.json`),
        "utf8",
      ),
    );
    assert(
      stableJson(latest) === stableJson(versioned),
      "latest must match versioned metadata",
    );
  }

  if (args.mode === "promote") {
    await promote(metadata, metadataPath);
    const promoted = JSON.parse(await readFile(latestPath, "utf8"));
    validateMetadata(promoted, latestPath, false);
    assert(
      stableJson(promoted) === stableJson(metadata),
      "promoted latest metadata differs from versioned metadata",
    );
  } else {
    process.stdout.write(`Release metadata is valid: ${metadataPath}\n`);
    if (existsSync(latestPath)) {
      process.stdout.write(
        `Latest installer metadata is valid: ${latestPath}\n`,
      );
    }
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n\n${usage()}`,
  );
  process.exitCode = 1;
}
