#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const installerRoot = path.join(repositoryRoot, "installer");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

if (Number.parseInt(process.versions.node, 10) !== 22) {
  throw new Error(`Local CI requires Node 22; found ${process.version}`);
}

function run(command, args, cwd = repositoryRoot) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function output(command, args) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

run(npmCommand, ["ci"], installerRoot);

run(npmCommand, ["run", "bundle:plugin"], installerRoot);
const metadataPath = path.join(
  installerRoot,
  "src-tauri/resources/plugin-bundle-files.json",
);
const firstBundleMetadata = readFileSync(metadataPath, "utf8");
run(npmCommand, ["run", "bundle:plugin"], installerRoot);
const secondBundleMetadata = readFileSync(metadataPath, "utf8");
if (firstBundleMetadata !== secondBundleMetadata) {
  throw new Error("Plugin bundle is not deterministic");
}

run(npmCommand, ["run", "bundle:plugin:verify"], installerRoot);
run(npmCommand, ["run", "check"], installerRoot);
run(npmCommand, ["test"], installerRoot);
run(npxCommand, ["tauri", "build", "--no-bundle"], installerRoot);

const forbiddenTrackedArtifact =
  /^(?:AGENTS|CLAUDE)\.md$|(^|\/)\.DS_Store$|\.(dmg|app\.tar\.gz|exe|mp3|sig|p12|pfx|key)$/u;
// The guarded promotion script commits this signed metadata pointer as a pair.
const allowedTrackedArtifacts = new Set(["plugin-releases/latest.json.sig"]);
const trackedFiles = output("git", ["ls-files", "-z"])
  .split("\0")
  .filter(Boolean);
const trackedFileSet = new Set(trackedFiles);
const forbiddenFiles = trackedFiles.filter(
  (file) =>
    forbiddenTrackedArtifact.test(file) && !allowedTrackedArtifacts.has(file),
);
if (forbiddenFiles.length > 0) {
  throw new Error(
    `Forbidden local, binary, signature, or key artifact is tracked:\n${forbiddenFiles.join("\n")}`,
  );
}

const claudeProjectManifestPath = "claude-project/.lidfly-claude-project.json";
if (trackedFileSet.has(claudeProjectManifestPath)) {
  const manifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, claudeProjectManifestPath), "utf8"),
  );
  if (
    manifest?.version !== 1 ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  ) {
    throw new Error("Claude project snapshot manifest is invalid");
  }
  const expectedTrackedSnapshot = new Set([
    claudeProjectManifestPath,
    ...Object.keys(manifest.files).map((relativePath) =>
      path.posix.join("claude-project", relativePath),
    ),
  ]);
  const actualTrackedSnapshot = trackedFiles.filter((file) =>
    file.startsWith("claude-project/"),
  );
  const missingTrackedSnapshot = [...expectedTrackedSnapshot].filter(
    (file) => !trackedFileSet.has(file),
  );
  const unexpectedTrackedSnapshot = actualTrackedSnapshot.filter(
    (file) => !expectedTrackedSnapshot.has(file),
  );
  if (
    missingTrackedSnapshot.length > 0 ||
    unexpectedTrackedSnapshot.length > 0 ||
    !trackedFileSet.has("claude-project-source.lock.json")
  ) {
    throw new Error(
      [
        "Tracked Claude project snapshot differs from its manifest.",
        ...missingTrackedSnapshot.map((file) => `Missing: ${file}`),
        ...unexpectedTrackedSnapshot.map((file) => `Unexpected: ${file}`),
        ...(!trackedFileSet.has("claude-project-source.lock.json")
          ? ["Missing: claude-project-source.lock.json"]
          : []),
      ].join("\n"),
    );
  }
}

run("git", ["diff", "--check"]);
console.log("\nLocal CI passed.");
