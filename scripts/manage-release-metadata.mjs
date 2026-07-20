#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "..");
const releasesDir = resolve(repositoryRoot, "releases");
const latestPath = resolve(releasesDir, "latest.json");

const expected = {
  catalogPath: "./.agents/plugins/marketplace.json",
  manifestPath: "./plugins/lidfly/.codex-plugin/plugin.json",
  mcpUrl: "https://lidfly.ru/mcp/v3",
  name: "lidfly",
  pluginPath: "./plugins/lidfly",
  repository: "https://github.com/awaik/lidfly-plugins",
};

const requiredInstallerPlatforms = new Set([
  "macos-universal",
  "windows-x86_64",
]);

function usage() {
  return `Usage:
  node scripts/manage-release-metadata.mjs --check [--file releases/X.Y.Z.json]
  node scripts/manage-release-metadata.mjs --promote [--file releases/X.Y.Z.json]

Options:
  --check       Validate current release metadata and releases/latest.json when present.
  --promote     Verify the published tag and installer downloads, then atomically write releases/latest.json.
  --file        Validate or promote a specific versioned metadata file. Defaults to the current manifest version.
  --help, -h    Show this help.
`;
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  assert(isObject(value), `${label} must be an object`);
}

function assertExactKeys(value, keys, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} must contain exactly: ${wanted.join(", ")}`,
  );
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    fail(
      `Cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    fail(
      `Invalid JSON in ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveInsideRepository(relativePath, label) {
  assert(
    typeof relativePath === "string" && relativePath.startsWith("./"),
    `${label} must start with ./`,
  );
  const absolutePath = resolve(repositoryRoot, relativePath);
  assert(
    absolutePath.startsWith(`${repositoryRoot}${sep}`),
    `${label} escapes the repository`,
  );
  return absolutePath;
}

function assertVersion(version, label) {
  assert(
    typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version),
    `${label} must use X.Y.Z format`,
  );
}

function assertIsoDate(value, label) {
  assert(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value),
    `${label} must be an ISO UTC timestamp`,
  );
  assert(!Number.isNaN(Date.parse(value)), `${label} must be a valid date`);
}

function validateArtifact(artifact, release) {
  assertExactKeys(
    artifact,
    ["filename", "platform", "sha256", "size", "url"],
    "installer artifact",
  );
  assert(
    requiredInstallerPlatforms.has(artifact.platform),
    `Unsupported installer platform: ${artifact.platform}`,
  );
  assert(
    typeof artifact.filename === "string" &&
      artifact.filename.length > 0 &&
      !artifact.filename.includes("/") &&
      !artifact.filename.includes("\\"),
    `Invalid installer filename for ${artifact.platform}`,
  );
  assert(
    Number.isSafeInteger(artifact.size) && artifact.size > 0,
    `Invalid installer size for ${artifact.platform}`,
  );
  assert(
    typeof artifact.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(artifact.sha256),
    `Invalid SHA-256 for ${artifact.platform}`,
  );

  let url;
  try {
    url = new URL(artifact.url);
  } catch {
    fail(`Invalid installer URL for ${artifact.platform}`);
  }

  assert(
    url.protocol === "https:",
    `Installer URL must use HTTPS for ${artifact.platform}`,
  );
  const expectedPrefix = `/awaik/lidfly-plugins/releases/download/${release.publication.tag}/`;
  assert(
    url.hostname === "github.com" && url.pathname.startsWith(expectedPrefix),
    `Installer URL must point to ${expected.repository} release ${release.publication.tag}`,
  );
  const urlFilename = decodeURIComponent(
    url.pathname.slice(expectedPrefix.length),
  );
  assert(
    urlFilename === artifact.filename,
    `Installer filename and URL differ for ${artifact.platform}`,
  );
}

function validateMetadata(metadata, sourcePath, { requireVersionFilename }) {
  assertExactKeys(
    metadata,
    ["installers", "marketplace", "plugin", "publication", "schemaVersion"],
    "release metadata",
  );
  assert(metadata.schemaVersion === 1, "schemaVersion must be 1");

  assertExactKeys(
    metadata.plugin,
    ["manifestPath", "mcpUrl", "name", "version"],
    "plugin metadata",
  );
  assert(
    metadata.plugin.name === expected.name,
    `plugin.name must remain ${expected.name}`,
  );
  assertVersion(metadata.plugin.version, "plugin.version");
  assert(
    metadata.plugin.manifestPath === expected.manifestPath,
    `plugin.manifestPath must remain ${expected.manifestPath}`,
  );
  assert(
    metadata.plugin.mcpUrl === expected.mcpUrl,
    `plugin.mcpUrl must remain ${expected.mcpUrl}`,
  );

  assertExactKeys(
    metadata.marketplace,
    ["catalogPath", "name", "pluginPath", "repository"],
    "marketplace metadata",
  );
  assert(
    metadata.marketplace.name === expected.name,
    `marketplace.name must remain ${expected.name}`,
  );
  assert(
    metadata.marketplace.repository === expected.repository,
    `marketplace.repository must remain ${expected.repository}`,
  );
  assert(
    metadata.marketplace.catalogPath === expected.catalogPath,
    `marketplace.catalogPath must remain ${expected.catalogPath}`,
  );
  assert(
    metadata.marketplace.pluginPath === expected.pluginPath,
    `marketplace.pluginPath must remain ${expected.pluginPath}`,
  );

  assertExactKeys(
    metadata.publication,
    ["commit", "publishedAt", "status", "tag"],
    "publication metadata",
  );
  assert(
    ["draft", "published"].includes(metadata.publication.status),
    "publication.status must be draft or published",
  );
  assert(
    metadata.publication.tag === `v${metadata.plugin.version}`,
    "publication.tag must be v<plugin.version>",
  );
  if (metadata.publication.status === "draft") {
    assert(
      metadata.publication.commit === null,
      "draft publication.commit must be null",
    );
    assert(
      metadata.publication.publishedAt === null,
      "draft publication.publishedAt must be null",
    );
  } else {
    assert(
      typeof metadata.publication.commit === "string" &&
        /^[a-f0-9]{40}$/.test(metadata.publication.commit),
      "published publication.commit must be a full lowercase Git commit SHA",
    );
    assertIsoDate(metadata.publication.publishedAt, "publication.publishedAt");
  }

  assertExactKeys(
    metadata.installers,
    ["artifacts", "status"],
    "installer metadata",
  );
  assert(
    ["unpublished", "published"].includes(metadata.installers.status),
    "installers.status must be unpublished or published",
  );
  assert(
    Array.isArray(metadata.installers.artifacts),
    "installers.artifacts must be an array",
  );
  if (metadata.installers.status === "unpublished") {
    assert(
      metadata.installers.artifacts.length === 0,
      "unpublished installers must not advertise artifacts",
    );
  } else {
    assert(
      metadata.publication.status === "published",
      "installers cannot be published before the plugin release",
    );
    const platforms = new Set();
    for (const artifact of metadata.installers.artifacts) {
      validateArtifact(artifact, metadata);
      assert(
        !platforms.has(artifact.platform),
        `Duplicate installer platform: ${artifact.platform}`,
      );
      platforms.add(artifact.platform);
    }
    for (const platform of requiredInstallerPlatforms) {
      assert(
        platforms.has(platform),
        `Missing required installer platform: ${platform}`,
      );
    }
    assert(
      platforms.size === requiredInstallerPlatforms.size,
      "Installer metadata contains unexpected platforms",
    );
  }

  if (requireVersionFilename) {
    assert(
      basename(sourcePath) === `${metadata.plugin.version}.json`,
      `Metadata filename must be ${metadata.plugin.version}.json`,
    );
  }
}

async function validateProject(metadata, { requireCurrentVersion }) {
  const manifestPath = resolveInsideRepository(
    metadata.plugin.manifestPath,
    "plugin.manifestPath",
  );
  const catalogPath = resolveInsideRepository(
    metadata.marketplace.catalogPath,
    "marketplace.catalogPath",
  );
  const pluginPath = resolveInsideRepository(
    metadata.marketplace.pluginPath,
    "marketplace.pluginPath",
  );
  assert(
    existsSync(pluginPath),
    `Marketplace plugin path does not exist: ${pluginPath}`,
  );

  const manifest = await readJson(manifestPath, "plugin manifest");
  const marketplace = await readJson(catalogPath, "marketplace catalog");
  const mcpPath = resolve(pluginPath, manifest.mcpServers);
  assert(
    mcpPath.startsWith(`${pluginPath}${sep}`),
    "Manifest MCP path escapes the plugin directory",
  );
  const mcp = await readJson(mcpPath, "MCP configuration");
  const entry = marketplace.plugins?.find(
    (plugin) => plugin.name === expected.name,
  );

  assert(
    manifest.name === expected.name,
    `Manifest name must remain ${expected.name}`,
  );
  assert(entry, `Marketplace entry ${expected.name} is missing`);
  assert(
    entry.source?.source === "local" &&
      entry.source.path === expected.pluginPath,
    "Marketplace source must point to ./plugins/lidfly",
  );
  assert(
    marketplace.name === expected.name,
    `Marketplace name must remain ${expected.name}`,
  );
  assert(
    manifest.interface?.displayName === marketplace.interface?.displayName,
    "Manifest and marketplace display names differ",
  );
  assert(
    manifest.interface?.category === entry.category,
    "Manifest and marketplace categories differ",
  );
  assert(
    mcp.mcpServers?.lidfly?.type === "http",
    "LidFly MCP transport must remain http",
  );
  assert(
    mcp.mcpServers?.lidfly?.url === metadata.plugin.mcpUrl,
    "Release metadata and MCP URL differ",
  );
  if (requireCurrentVersion) {
    assert(
      manifest.version === metadata.plugin.version,
      "Manifest version and current release metadata differ",
    );
  }
}

async function validateLatest() {
  if (!existsSync(latestPath)) return null;

  const latest = await readJson(latestPath, "latest release metadata");
  validateMetadata(latest, latestPath, { requireVersionFilename: false });
  assert(
    latest.publication.status === "published",
    "releases/latest.json cannot reference a draft release",
  );
  assert(
    latest.installers.status === "published",
    "releases/latest.json cannot reference unpublished installers",
  );

  const versionedPath = resolve(releasesDir, `${latest.plugin.version}.json`);
  const versioned = await readJson(
    versionedPath,
    "versioned release metadata for latest.json",
  );
  validateMetadata(versioned, versionedPath, { requireVersionFilename: true });
  assert(
    stableJson(latest) === stableJson(versioned),
    "releases/latest.json must exactly match its versioned metadata",
  );
  return latest;
}

async function currentMetadataPath() {
  const manifest = await readJson(
    resolve(repositoryRoot, expected.manifestPath),
    "plugin manifest",
  );
  assertVersion(manifest.version, "manifest.version");
  return resolve(releasesDir, `${manifest.version}.json`);
}

function parseArgs(argv) {
  let mode = "check";
  let modeWasSet = false;
  let file = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--promote") {
      assert(!modeWasSet, "Use only one of --check or --promote");
      mode = arg.slice(2);
      modeWasSet = true;
    } else if (arg === "--file") {
      const value = argv[index + 1];
      assert(value && !value.startsWith("--"), "--file requires a path");
      file = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  return { file, mode };
}

function resolveMetadataArgument(file) {
  const path = resolve(repositoryRoot, file);
  assert(
    path.startsWith(`${releasesDir}${sep}`),
    "--file must point inside releases/",
  );
  assert(
    path !== latestPath,
    "Promote or validate a versioned metadata file, not releases/latest.json",
  );
  return path;
}

async function verifyTag(metadata) {
  let commit;
  try {
    const result = await execFileAsync(
      "git",
      ["rev-list", "-n", "1", metadata.publication.tag],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
    commit = result.stdout.trim();
  } catch (error) {
    fail(
      `Cannot resolve local tag ${metadata.publication.tag}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(
    commit === metadata.publication.commit,
    `Tag ${metadata.publication.tag} does not resolve to publication.commit`,
  );
}

async function verifyArtifactDownload(artifact) {
  const response = await fetch(artifact.url, { redirect: "follow" });
  assert(
    response.ok && response.body,
    `Cannot download ${artifact.url}: HTTP ${response.status}`,
  );

  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.length;
  }

  assert(
    size === artifact.size,
    `Downloaded size differs for ${artifact.filename}: expected ${artifact.size}, got ${size}`,
  );
  assert(
    hash.digest("hex") === artifact.sha256,
    `Downloaded SHA-256 differs for ${artifact.filename}`,
  );
  process.stdout.write(`Verified ${artifact.platform}: ${artifact.filename}\n`);
}

async function promote(metadata, metadataPath) {
  assert(
    metadata.publication.status === "published",
    "Cannot promote a draft release",
  );
  assert(
    metadata.installers.status === "published",
    "Cannot promote unpublished installers",
  );
  await verifyTag(metadata);
  for (const artifact of metadata.installers.artifacts) {
    await verifyArtifactDownload(artifact);
  }

  const temporaryPath = resolve(releasesDir, `.latest.json.${process.pid}.tmp`);
  try {
    await writeFile(temporaryPath, stableJson(metadata), "utf8");
    await rename(temporaryPath, latestPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }

  process.stdout.write(`Promoted ${metadataPath} to ${latestPath}\n`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const explicitFile = args.file !== null;
  const metadataPath = explicitFile
    ? resolveMetadataArgument(args.file)
    : await currentMetadataPath();
  const metadata = await readJson(metadataPath, "versioned release metadata");
  validateMetadata(metadata, metadataPath, { requireVersionFilename: true });
  await validateProject(metadata, { requireCurrentVersion: !explicitFile });

  if (args.mode === "promote") {
    await promote(metadata, metadataPath);
    await validateLatest();
  } else {
    await validateLatest();
    process.stdout.write(`Release metadata is valid: ${metadataPath}\n`);
    if (existsSync(latestPath)) {
      process.stdout.write(
        `Latest installer metadata is valid: ${latestPath}\n`,
      );
    } else {
      process.stdout.write("No releases/latest.json is published.\n");
    }
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n\n${usage()}`,
  );
  process.exitCode = 1;
}
