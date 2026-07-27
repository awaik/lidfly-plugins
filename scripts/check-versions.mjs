#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerBuild = process.argv.slice(2).includes("--installer-build");
const unexpectedArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--installer-build");
if (unexpectedArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unexpectedArguments.join(", ")}`);
}
const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
const semver = (value) => /^\d+\.\d+\.\d+$/.test(value ?? "");

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

const installerVersions = {
  package: packageJson.version,
  package_lock: packageLock.version,
  package_lock_root: packageLock.packages?.[""]?.version,
  tauri: tauri.version,
  cargo: cargoVersion,
  cargo_lock: cargoLockVersion,
};
if (
  Object.values(installerVersions).some((value) => !semver(value)) ||
  new Set(Object.values(installerVersions)).size !== 1
) {
  throw new Error(
    `Installer versions are not synchronized: ${JSON.stringify(installerVersions)}`,
  );
}
if (!semver(plugin.version)) {
  throw new Error(`Plugin version must use X.Y.Z: ${plugin.version}`);
}

const installerVersion = packageJson.version;
const installerMetadataPath = `releases/${installerVersion}.json`;
try {
  await access(path.join(root, installerMetadataPath));
  const metadata = await readJson(installerMetadataPath);
  if (
    metadata.schemaVersion !== 2 ||
    metadata.installer?.version !== installerVersion ||
    !semver(metadata.embeddedPlugin?.version)
  ) {
    throw new Error(
      `${installerMetadataPath} does not match installer ${installerVersion}`,
    );
  }
  if (installerBuild && metadata.embeddedPlugin.version !== plugin.version) {
    throw new Error(
      `Installer ${installerVersion} embeds plugin ${metadata.embeddedPlugin.version}, but the build snapshot is ${plugin.version}. Bump the installer release metadata before building.`,
    );
  }
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error(
      `Missing installer release metadata: ${installerMetadataPath}`,
    );
  }
  throw error;
}

const pluginMetadataPath = `plugin-releases/${plugin.version}.json`;
try {
  await access(path.join(root, pluginMetadataPath));
  const metadata = await readJson(pluginMetadataPath);
  if (
    metadata.schema_version !== 1 ||
    metadata.plugin?.name !== "lidfly" ||
    metadata.plugin?.version !== plugin.version
  ) {
    throw new Error(`${pluginMetadataPath} does not match plugin manifest`);
  }
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error(`Missing plugin content metadata: ${pluginMetadataPath}`);
  }
  throw error;
}

console.log(
  `Versions valid: installer ${installerVersion}, plugin ${plugin.version}`,
);
