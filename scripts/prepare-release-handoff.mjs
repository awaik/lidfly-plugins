#!/usr/bin/env node
import { execFile } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { stableJson } from "./lib/plugin-bundle.mjs";
import { verifyReleaseArtifacts } from "./lib/release-contract.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function parseArgs(argv) {
  const args = { version: "", artifactsDir: "", evidencePath: "", tag: "" };
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
    } else if (argument === "--evidence") {
      args.evidencePath = path.resolve(next());
    } else if (argument === "--tag") args.tag = next();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!args.artifactsDir) throw new Error("--artifacts-dir is required");
  if (!args.evidencePath) throw new Error("--evidence is required");
  if (!args.tag) args.tag = `v${args.version}`;
  if (args.tag !== `v${args.version}`) {
    throw new Error("Git tag must be v<version>");
  }
  return args;
}

async function command(commandName, args) {
  const { stdout } = await execFileAsync(commandName, args, {
    cwd: repositoryRoot,
  });
  return stdout.trim();
}

async function atomicWrite(filePath, contents) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

const args = parseArgs(process.argv.slice(2));
const verified = await verifyReleaseArtifacts({
  version: args.version,
  artifactsDir: args.artifactsDir,
  pluginMetadataPath: path.join(args.artifactsDir, "plugin-bundle-files.json"),
  repositoryRoot,
  updaterPublicKey: process.env.TAURI_UPDATER_PUBLIC_KEY,
  evidencePath: args.evidencePath,
});
const gitCommit = await command("git", ["rev-parse", "HEAD"]);
const tagCommit = await command("git", ["rev-list", "-n", "1", args.tag]);
if (gitCommit !== tagCommit) {
  throw new Error(`${args.tag} does not point at the build commit`);
}
const status = await command("git", ["status", "--porcelain"]);
if (status) throw new Error("Release handoff requires a clean tagged commit");

const [tauriVersion, rustVersion, nodeVersion] = await Promise.all([
  command(path.join(repositoryRoot, "installer/node_modules/.bin/tauri"), [
    "--version",
  ]),
  command("rustc", ["--version"]),
  command("node", ["--version"]),
]);
const handoff = {
  schema_version: 1,
  release_version: args.version,
  git_commit: gitCommit,
  git_tag: args.tag,
  built_at: new Date().toISOString(),
  plugin_bundle_sha256: verified.pluginMetadata.plugin_bundle_sha256,
  plugin_bundle_files: verified.pluginMetadata.files,
  artifacts: verified.artifacts,
  signing_checks: verified.signing,
  ci: {
    workflow: process.env.GITHUB_WORKFLOW || "local",
    run_id: process.env.GITHUB_RUN_ID || "local",
  },
  toolchain: {
    tauri: tauriVersion,
    rust: rustVersion,
    node: nodeVersion,
  },
};
const checksums = `${verified.artifacts
  .map((artifact) => `${artifact.sha256}  ${artifact.filename}`)
  .join("\n")}\n`;
await atomicWrite(path.join(args.artifactsDir, "SHA256SUMS.txt"), checksums);
await atomicWrite(
  path.join(args.artifactsDir, "release-handoff.json"),
  stableJson(handoff),
);
console.log(
  `Release handoff prepared: ${path.join(args.artifactsDir, "release-handoff.json")}`,
);
