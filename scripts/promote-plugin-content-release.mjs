#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  readOptionalSignedPair,
  stableJson,
  validateContentManifest,
  verifyDetached,
  verifyContentRelease,
} from "./lib/plugin-content-contract.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function compareSemver(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith("--")) throw new Error(`${flag} is required`);
  return value;
}

try {
  const directory = path.resolve(process.cwd(), valueAfter("--directory"));
  const publicKey = await readFile(
    path.resolve(process.cwd(), valueAfter("--public-key")),
  );
  const verified = await verifyContentRelease({
    directory,
    manifestPath: path.join(directory, "release.json"),
    publicKey,
  });
  const tag = `plugin-v${verified.manifest.plugin.version}`;
  const { stdout } = await execFileAsync("git", ["rev-list", "-n", "1", tag], {
    cwd: root,
    encoding: "utf8",
  });
  if (!/^[a-f0-9]{40}$/.test(stdout.trim())) {
    throw new Error(`${tag} does not resolve to a release commit`);
  }
  const versionedManifest = JSON.parse(
    await readFile(
      path.join(
        root,
        `plugin-releases/${verified.manifest.plugin.version}.json`,
      ),
      "utf8",
    ),
  );
  if (stableJson(versionedManifest) !== stableJson(verified.manifest)) {
    throw new Error(
      "Versioned plugin release metadata differs from signed release.json",
    );
  }
  const releaseDirectory = path.join(root, "plugin-releases");
  await mkdir(releaseDirectory, { recursive: true });
  const latestPath = path.join(releaseDirectory, "latest.json");
  const latestSignaturePath = `${latestPath}.sig`;
  const latestPair = await readOptionalSignedPair(
    latestPath,
    latestSignaturePath,
  );
  if (latestPair) {
    verifyDetached(latestPair.bytes, latestPair.signature, publicKey);
    const latest = validateContentManifest(
      JSON.parse(latestPair.bytes.toString("utf8")),
    );
    const comparison = compareSemver(
      verified.manifest.plugin.version,
      latest.plugin.version,
    );
    if (comparison < 0) {
      throw new Error("Plugin content downgrade promotion is forbidden");
    }
    if (
      comparison === 0 &&
      (stableJson(latest) !== stableJson(verified.manifest) ||
        latestPair.signature !==
          (await readFile(verified.manifestSignaturePath, "utf8")))
    ) {
      throw new Error(
        "The same plugin version cannot be promoted with different bytes",
      );
    }
  }
  const temporaryJson = `${latestPath}.${process.pid}.tmp`;
  const temporarySignature = `${latestSignaturePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryJson, stableJson(verified.manifest), "utf8");
    await writeFile(
      temporarySignature,
      await readFile(verified.manifestSignaturePath),
    );
    await rename(temporaryJson, latestPath);
    await rename(temporarySignature, latestSignaturePath);
  } catch (error) {
    await unlink(temporaryJson).catch(() => undefined);
    await unlink(temporarySignature).catch(() => undefined);
    throw error;
  }
  process.stdout.write(`Promoted ${tag} to plugin-releases/latest.json\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
