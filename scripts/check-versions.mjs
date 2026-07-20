#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
const cargoToml = await readFile(
  path.join(root, "installer/src-tauri/Cargo.toml"),
  "utf8",
);
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLock = await readFile(
  path.join(root, "installer/src-tauri/Cargo.lock"),
  "utf8",
);
const cargoLockVersion = cargoLock.match(
  /\[\[package\]\]\s+name = "lidfly-codex-plugin-installer"\s+version = "([^"]+)"/,
)?.[1];
const packageJson = await readJson("installer/package.json");
const packageLock = await readJson("installer/package-lock.json");
const tauri = await readJson("installer/src-tauri/tauri.conf.json");
const plugin = await readJson("plugins/lidfly/.codex-plugin/plugin.json");
const versions = {
  plugin: plugin.version,
  package: packageJson.version,
  package_lock: packageLock.version,
  package_lock_root: packageLock.packages?.[""]?.version,
  tauri: tauri.version,
  cargo: cargoVersion,
  cargo_lock: cargoLockVersion,
};
const releaseMetadataPath = path.join(root, `releases/${plugin.version}.json`);
try {
  await access(releaseMetadataPath);
  versions.release_metadata = (
    await readJson(`releases/${plugin.version}.json`)
  ).plugin?.version;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (
  Object.values(versions).some((value) => !/^\d+\.\d+\.\d+$/.test(value ?? ""))
) {
  throw new Error(
    `Every release version must use X.Y.Z: ${JSON.stringify(versions)}`,
  );
}
if (new Set(Object.values(versions)).size !== 1) {
  throw new Error(
    `Release versions are not synchronized: ${JSON.stringify(versions)}`,
  );
}
console.log(`Versions synchronized: ${plugin.version}`);
