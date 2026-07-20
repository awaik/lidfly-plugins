#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { inspectSourceBundle } from "./lib/plugin-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const inspected = await inspectSourceBundle(root);
const tauriConfig = JSON.parse(
  await readFile(
    path.join(root, "installer/src-tauri/tauri.conf.json"),
    "utf8",
  ),
);
const marketplaceEntry = inspected.documents.marketplace.plugins[0];
const pluginRoot = path.resolve(root, marketplaceEntry.source.path);
const pluginRootReal = await realpath(pluginRoot);
const rootReal = await realpath(root);
if (!pluginRootReal.startsWith(`${rootReal}${path.sep}`)) {
  throw new Error("Marketplace plugin source escapes the repository");
}
if (!(await stat(pluginRootReal)).isDirectory()) {
  throw new Error("Marketplace plugin source is not a directory");
}

const manifestText = await readFile(
  path.join(root, "plugins/lidfly/.codex-plugin/plugin.json"),
  "utf8",
);
if (/\[TODO:[^\]]+\]/u.test(manifestText)) {
  throw new Error("Plugin manifest contains a TODO placeholder");
}
if (inspected.documents.plugin.interface?.displayName !== "LidFly") {
  throw new Error("Plugin displayName must remain LidFly");
}
if (
  inspected.documents.plugin.interface?.privacyPolicyURL !==
  "https://lidfly.ru/privacy"
) {
  throw new Error("Plugin privacy policy URL changed unexpectedly");
}
if (
  inspected.documents.plugin.interface?.termsOfServiceURL !==
  "https://lidfly.ru/offer"
) {
  throw new Error("Plugin terms URL changed unexpectedly");
}
if (
  tauriConfig.identifier !== "ru.lidfly.codex-plugin-installer" ||
  tauriConfig.productName !== "LidFly Codex Plugin Installer"
) {
  throw new Error("Tauri productName or identifier changed unexpectedly");
}
if (
  JSON.stringify(tauriConfig.plugins?.updater?.endpoints) !==
  JSON.stringify(["https://lidfly.ru/codex-plugin-downloads/latest.json"])
) {
  throw new Error("Tauri updater endpoint changed unexpectedly");
}
if (tauriConfig.plugins?.updater?.pubkey !== "") {
  throw new Error(
    "Base development config must not embed a production updater public key",
  );
}

const { stdout: cargoMetadataJson } = await execFileAsync(
  "cargo",
  [
    "metadata",
    "--manifest-path",
    path.join(root, "installer/src-tauri/Cargo.toml"),
    "--no-deps",
    "--format-version",
    "1",
  ],
  { cwd: root, encoding: "utf8" },
);
const cargoMetadata = JSON.parse(cargoMetadataJson);
const installerPackage = cargoMetadata.packages.find(
  (candidate) => candidate.name === "lidfly-codex-plugin-installer",
);
const productionBinaries = installerPackage?.targets
  .filter((target) => target.kind.includes("bin"))
  .map((target) => target.name);
if (
  JSON.stringify(productionBinaries) !==
  JSON.stringify([tauriConfig.mainBinaryName])
) {
  throw new Error(
    `Tauri package must expose only its main production binary: ${JSON.stringify(productionBinaries)}`,
  );
}

console.log(
  `Project manifests verified; plugin bundle SHA-256: ${inspected.metadata.plugin_bundle_sha256}`,
);
