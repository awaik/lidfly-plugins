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
  /(^|\/)(\.DS_Store|AGENTS\.md|CLAUDE\.md)$|\.(dmg|app\.tar\.gz|exe|sig|p12|pfx|key)$/u;
const trackedFiles = output("git", ["ls-files", "-z"])
  .split("\0")
  .filter(Boolean);
const forbiddenFiles = trackedFiles.filter((file) =>
  forbiddenTrackedArtifact.test(file),
);
if (forbiddenFiles.length > 0) {
  throw new Error(
    `Forbidden local, binary, signature, or key artifact is tracked:\n${forbiddenFiles.join("\n")}`,
  );
}

run("git", ["diff", "--check"]);
console.log("\nLocal CI passed.");
