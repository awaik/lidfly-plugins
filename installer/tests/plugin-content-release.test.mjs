import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import {
  publicKeyRawBase64,
  readOptionalSignedPair,
  validateRawPublicKeyBase64,
  verifyContentRelease,
} from "../../scripts/lib/plugin-content-contract.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "lidfly-plugin-content-test-"),
);
const privateKeyPath = path.join(temporaryRoot, "private.pem");
const publicKeyPath = path.join(temporaryRoot, "public.pem");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await writeFile(
  privateKeyPath,
  privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600 },
);
await writeFile(
  publicKeyPath,
  publicKey.export({ type: "spki", format: "pem" }),
);

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function build(output, extraArguments = []) {
  await mkdir(output);
  await execFileAsync(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts/build-plugin-content-release.mjs"),
      "--private-key",
      privateKeyPath,
      "--output",
      output,
      "--published-at",
      "2026-07-27T00:00:00.000Z",
      "--skip-repository-metadata",
      ...extraArguments,
    ],
    { cwd: repositoryRoot },
  );
  return JSON.parse(await readFile(path.join(output, "release.json"), "utf8"));
}

function readTarEntryNames(archive) {
  const tar = gunzipSync(archive);
  const names = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start, end) => {
      const field = header.subarray(start, end);
      const nul = field.indexOf(0);
      return field.subarray(0, nul < 0 ? field.length : nul).toString("utf8");
    };
    const name = readString(0, 100);
    const prefix = readString(345, 500);
    names.push(prefix ? `${prefix}/${name}` : name);
    const size = Number.parseInt(readString(124, 136).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("Invalid tar entry size in test archive");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe("plugin content release", () => {
  it("requires a canonical raw 32-byte content public key", () => {
    const encoded = publicKeyRawBase64(
      publicKey.export({ type: "spki", format: "pem" }),
    );
    expect(validateRawPublicKeyBase64(encoded)).toHaveLength(32);
    expect(() => validateRawPublicKeyBase64("")).toThrow(/is required/u);
    expect(() => validateRawPublicKeyBase64("not-base64")).toThrow(
      /exactly 32 bytes/u,
    );
    expect(() =>
      validateRawPublicKeyBase64(encoded.replace(/=$/u, "")),
    ).toThrow(/canonical base64/u);
  });

  it("rejects an incomplete latest manifest and signature pair", async () => {
    const directory = path.join(temporaryRoot, "incomplete-latest");
    const latestPath = path.join(directory, "latest.json");
    const signaturePath = `${latestPath}.sig`;
    await mkdir(directory);
    expect(await readOptionalSignedPair(latestPath, signaturePath)).toBeNull();
    await writeFile(latestPath, "{}\n");
    await expect(
      readOptionalSignedPair(latestPath, signaturePath),
    ).rejects.toThrow(/signed file pair is incomplete/u);
  });

  it("builds deterministic signed archives and verifies both signatures", async () => {
    const firstDirectory = path.join(temporaryRoot, "first");
    const secondDirectory = path.join(temporaryRoot, "second");
    const first = await build(firstDirectory);
    const second = await build(secondDirectory);
    expect(first).toEqual(second);
    expect(
      await readFile(path.join(firstDirectory, first.bundle.filename)),
    ).toEqual(
      await readFile(path.join(secondDirectory, second.bundle.filename)),
    );
    const archive = await readFile(
      path.join(firstDirectory, first.bundle.filename),
    );
    const longEntry =
      "plugin-bundle/claude-project/.openclaw/skills/video-article-writer/references/transcription-workflow.md";
    expect(Buffer.byteLength(longEntry)).toBeGreaterThan(100);
    expect(readTarEntryNames(archive)).toContain(longEntry);

    const verified = await verifyContentRelease({
      directory: firstDirectory,
      manifestPath: path.join(firstDirectory, "release.json"),
      publicKey: await readFile(publicKeyPath),
    });
    expect(verified.manifest.plugin.name).toBe("lidfly");
    expect(verified.manifest.min_installer_version).toBe("1.3.0");
  });

  it("rejects schema 3 content for installers without snapshot support", async () => {
    const directory = path.join(temporaryRoot, "old-installer-minimum");
    await expect(
      build(directory, ["--min-installer-version", "1.2.0"]),
    ).rejects.toThrow(/requires installer 1\.3\.0 or newer/u);
  });

  it("fails closed after immutable bundle tampering", async () => {
    const directory = path.join(temporaryRoot, "tampered");
    const release = await build(directory);
    await appendFile(path.join(directory, release.bundle.filename), "tamper");
    await expect(
      verifyContentRelease({
        directory,
        manifestPath: path.join(directory, "release.json"),
        publicKey: await readFile(publicKeyPath),
      }),
    ).rejects.toThrow(/size mismatch|SHA-256 mismatch/iu);
  });
});
