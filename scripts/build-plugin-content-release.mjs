#!/usr/bin/env node
import { gzipSync } from "node:zlib";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIN_BUNDLE_SCHEMA_3_INSTALLER_VERSION,
  inspectSourceBundle,
  stableJson,
} from "./lib/plugin-bundle.mjs";
import {
  CONTENT_KEY_ID,
  pluginContentFilename,
  publicKeyRawBase64,
  sha256File,
  signDetached,
  validateContentManifest,
} from "./lib/plugin-content-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage:
  node scripts/build-plugin-content-release.mjs --private-key <ed25519.pem> [options]

Options:
  --output <directory>          Output directory (required).
  --published-at <ISO-8601>     Defaults to current time.
  --min-installer-version <v>   Defaults to ${MIN_BUNDLE_SCHEMA_3_INSTALLER_VERSION}.
  --key-id <id>                 Defaults to ${CONTENT_KEY_ID}.
  --skip-repository-metadata    Do not update plugin-releases/<version>.json.
`;
}

function parseArgs(argv) {
  const args = {
    keyId: CONTENT_KEY_ID,
    minInstallerVersion: MIN_BUNDLE_SCHEMA_3_INSTALLER_VERSION,
    output: null,
    privateKey: null,
    publishedAt: new Date().toISOString(),
    skipRepositoryMetadata: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === "--private-key") args.privateKey = next();
    else if (argument === "--output") args.output = next();
    else if (argument === "--published-at") args.publishedAt = next();
    else if (argument === "--min-installer-version")
      args.minInstallerVersion = next();
    else if (argument === "--key-id") args.keyId = next();
    else if (argument === "--skip-repository-metadata") {
      args.skipRepositoryMetadata = true;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!args.privateKey || !args.output)
    throw new Error(`--private-key and --output are required\n\n${usage()}`);
  return args;
}

function octal(value, length) {
  const encoded = value.toString(8);
  if (encoded.length > length - 1)
    throw new Error(`tar field overflow: ${value}`);
  return `${encoded.padStart(length - 1, "0")}\0`;
}

function compareSemver(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  if (
    leftParts.length !== 3 ||
    rightParts.length !== 3 ||
    [...leftParts, ...rightParts].some(
      (part) => !Number.isSafeInteger(part) || part < 0,
    )
  ) {
    throw new Error("--min-installer-version must use X.Y.Z");
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function splitTarPath(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  for (let index = 0; index < name.length; index += 1) {
    if (name[index] !== "/") continue;
    const prefix = name.slice(0, index);
    const suffix = name.slice(index + 1);
    if (
      Buffer.byteLength(prefix) <= 155 &&
      suffix.length > 0 &&
      Buffer.byteLength(suffix) <= 100
    ) {
      return { name: suffix, prefix };
    }
  }
  throw new Error(`tar path is too long: ${name}`);
}

function tarHeader(fullName, size) {
  const { name, prefix } = splitTarPath(fullName);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 4, "ascii");
  header.write("root", 297, 4, "ascii");
  header.write(prefix, 345, 155, "utf8");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function deterministicTar(entries) {
  const chunks = [];
  for (const entry of [...entries].sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    chunks.push(tarHeader(entry.name, entry.bytes.length), entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.keyId !== CONTENT_KEY_ID) {
    throw new Error(
      `This installer line supports only key id ${CONTENT_KEY_ID}`,
    );
  }
  if (Number.isNaN(Date.parse(args.publishedAt))) {
    throw new Error("--published-at must be ISO-8601");
  }
  const output = path.resolve(process.cwd(), args.output);
  const privateKey = await readFile(
    path.resolve(process.cwd(), args.privateKey),
  );
  const inspected = await inspectSourceBundle(root);
  if (
    inspected.metadata.schema_version >= 3 &&
    compareSemver(
      args.minInstallerVersion,
      MIN_BUNDLE_SCHEMA_3_INSTALLER_VERSION,
    ) < 0
  ) {
    throw new Error(
      `Bundle schema ${inspected.metadata.schema_version} requires installer ${MIN_BUNDLE_SCHEMA_3_INSTALLER_VERSION} or newer`,
    );
  }
  const metadataBytes = Buffer.from(stableJson(inspected.metadata));
  const entries = [
    { name: "plugin-bundle-files.json", bytes: metadataBytes },
    ...inspected.files.map((file) => ({
      name: `plugin-bundle/${file.path}`,
      bytes: file.bytes,
    })),
  ];
  const archive = gzipSync(deterministicTar(entries), {
    level: 9,
    mtime: 0,
  });
  await mkdir(output, { recursive: true });
  const temporaryArchive = path.join(
    output,
    `.plugin-content.${process.pid}.tmp`,
  );
  await writeFile(temporaryArchive, archive, { flag: "wx", mode: 0o600 });
  const archiveSha256 = await sha256File(temporaryArchive);
  const filename = pluginContentFilename(
    inspected.metadata.plugin_version,
    archiveSha256,
  );
  const bundlePath = path.join(output, filename);
  await rename(temporaryArchive, bundlePath);
  await writeFile(`${bundlePath}.sig`, signDetached(archive, privateKey), {
    flag: "wx",
    mode: 0o600,
  });

  const manifest = validateContentManifest({
    schema_version: 1,
    channel: "stable",
    published_at: new Date(args.publishedAt).toISOString(),
    min_installer_version: args.minInstallerVersion,
    plugin: { name: "lidfly", version: inspected.metadata.plugin_version },
    source: {
      repository: inspected.metadata.source.repository,
      commit: inspected.metadata.source.commit,
      skills_tree_sha256: inspected.metadata.source.skills_tree_sha256,
    },
    bundle: {
      filename,
      url: `https://lidfly.ru/codex-plugin-content/${filename}`,
      size: archive.length,
      sha256: archiveSha256,
      signature_filename: `${filename}.sig`,
    },
    key_id: args.keyId,
  });
  const manifestBytes = Buffer.from(stableJson(manifest));
  const releasePath = path.join(output, "release.json");
  await writeFile(releasePath, manifestBytes, { flag: "wx", mode: 0o600 });
  await writeFile(
    `${releasePath}.sig`,
    signDetached(manifestBytes, privateKey),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    path.join(output, "release-handoff.json"),
    stableJson({
      schema_version: 1,
      plugin_version: manifest.plugin.version,
      key_id: manifest.key_id,
      public_key_base64: publicKeyRawBase64(privateKey),
      files: ["release.json", "release.json.sig", filename, `${filename}.sig`],
    }),
    { flag: "wx", mode: 0o600 },
  );
  if (!args.skipRepositoryMetadata) {
    const versionedPath = path.join(
      root,
      `plugin-releases/${manifest.plugin.version}.json`,
    );
    let existing = null;
    try {
      existing = JSON.parse(await readFile(versionedPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (existing && existing.status !== "draft") {
      if (stableJson(existing) !== manifestBytes.toString("utf8")) {
        throw new Error(
          `Refusing to republish plugin ${manifest.plugin.version} with different metadata`,
        );
      }
    } else {
      if (
        existing &&
        (existing.plugin?.name !== manifest.plugin.name ||
          existing.plugin?.version !== manifest.plugin.version ||
          existing.source?.repository !== manifest.source.repository ||
          existing.source?.commit !== manifest.source.commit ||
          existing.source?.skills_tree_sha256 !==
            manifest.source.skills_tree_sha256)
      ) {
        throw new Error(
          `Draft metadata for plugin ${manifest.plugin.version} does not match this release`,
        );
      }
      const temporaryVersionedPath = `${versionedPath}.${process.pid}.tmp`;
      await writeFile(temporaryVersionedPath, manifestBytes, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryVersionedPath, versionedPath);
    }
  }
  process.stdout.write(
    `${JSON.stringify({ bundle: bundlePath, manifest: releasePath, sha256: archiveSha256 }, null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
