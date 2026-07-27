#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { verifyReleaseArtifacts } from "./lib/release-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function parseArgs(argv) {
  const args = {
    version: "",
    artifactsDir: "",
    pluginMetadataPath: "",
    evidencePath: "",
    skipPlatformSignatures: false,
    skipUpdaterSignatures: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${argument}`);
      }
      index += 1;
      return value;
    };
    if (argument === "--version") args.version = next();
    else if (argument === "--artifacts-dir") {
      args.artifactsDir = path.resolve(next());
    } else if (argument === "--plugin-metadata") {
      args.pluginMetadataPath = path.resolve(next());
    } else if (argument === "--evidence") {
      args.evidencePath = path.resolve(next());
    } else if (argument === "--skip-platform-signatures") {
      args.skipPlatformSignatures = true;
    } else if (argument === "--skip-updater-signatures") {
      args.skipUpdaterSignatures = true;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(args.version)) {
    throw new Error("--version is required and must use X.Y.Z");
  }
  if (!args.artifactsDir) throw new Error("--artifacts-dir is required");
  if (!args.pluginMetadataPath) {
    args.pluginMetadataPath = path.join(
      args.artifactsDir,
      "plugin-bundle-files.json",
    );
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const releaseMetadata = JSON.parse(
  await readFile(
    path.join(repositoryRoot, `releases/${args.version}.json`),
    "utf8",
  ),
);
const embeddedPluginVersion =
  releaseMetadata.schemaVersion === 2 &&
  releaseMetadata.installer?.version === args.version
    ? releaseMetadata.embeddedPlugin?.version
    : releaseMetadata.schemaVersion === 1 &&
        releaseMetadata.plugin?.version === args.version
      ? releaseMetadata.plugin.version
      : null;
if (!/^\d+\.\d+\.\d+$/.test(embeddedPluginVersion ?? "")) {
  throw new Error(
    `releases/${args.version}.json does not define this installer build`,
  );
}
const result = await verifyReleaseArtifacts({
  ...args,
  embeddedPluginVersion,
  repositoryRoot,
  updaterPublicKey: process.env.TAURI_UPDATER_PUBLIC_KEY,
});
console.log(`Release artifacts verified: ${result.version}`);
console.log(
  `Plugin bundle SHA-256: ${result.pluginMetadata.plugin_bundle_sha256}`,
);
