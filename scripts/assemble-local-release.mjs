#!/usr/bin/env node
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = { version: "", macosDir: "", windowsDir: "", outputDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    index += 1;
    if (name === "--version") args.version = value;
    else if (name === "--macos-dir") args.macosDir = path.resolve(value);
    else if (name === "--windows-dir") {
      args.windowsDir = path.resolve(value);
    } else if (name === "--output-dir") {
      args.outputDir = path.resolve(value);
    } else throw new Error(`Unknown argument: ${name}`);
  }
  if (!/^\d+\.\d+\.\d+$/u.test(args.version)) {
    throw new Error("--version must be X.Y.Z");
  }
  for (const name of ["macosDir", "windowsDir", "outputDir"]) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

const args = parseArgs(process.argv.slice(2));
await mkdir(args.outputDir, { recursive: true, mode: 0o700 });

const macosFiles = [
  `LidFly Codex Plugin Installer_${args.version}_universal.dmg`,
  `LidFly Codex Plugin Installer_${args.version}_universal.app.tar.gz`,
  `LidFly Codex Plugin Installer_${args.version}_universal.app.tar.gz.sig`,
];
const windowsFiles = [
  `LidFly Codex Plugin Installer_${args.version}_x64-setup.exe`,
  `LidFly Codex Plugin Installer_${args.version}_x64-setup.exe.sig`,
];

for (const [directory, files] of [
  [args.macosDir, macosFiles],
  [args.windowsDir, windowsFiles],
]) {
  for (const filename of files) {
    await copyFile(
      path.join(directory, filename),
      path.join(args.outputDir, filename),
      // Never replace an already assembled release by accident.
      constants.COPYFILE_EXCL,
    );
  }
}

const macosMetadata = await readFile(
  path.join(args.macosDir, "plugin-bundle-files.json"),
  "utf8",
);
const windowsMetadata = await readFile(
  path.join(args.windowsDir, "plugin-bundle-files.json"),
  "utf8",
);
if (macosMetadata !== windowsMetadata) {
  throw new Error("macOS and Windows were built with different plugin bundles");
}
await writeFile(
  path.join(args.outputDir, "plugin-bundle-files.json"),
  macosMetadata,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);

const appleEvidence = await readJson(
  path.join(args.macosDir, "apple-evidence.json"),
);
const windowsEvidence = await readJson(
  path.join(args.windowsDir, "windows-evidence.json"),
);
if (
  appleEvidence.schema_version !== 1 ||
  windowsEvidence.schema_version !== 1 ||
  appleEvidence.release_version !== args.version ||
  windowsEvidence.release_version !== args.version
) {
  throw new Error("Signing evidence schema/version mismatch");
}
await writeFile(
  path.join(args.outputDir, "signing-evidence.json"),
  `${JSON.stringify(
    {
      schema_version: 1,
      release_version: args.version,
      apple: appleEvidence.apple,
      windows: windowsEvidence.windows,
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);

console.log(`Local release assembled: ${args.outputDir}`);
