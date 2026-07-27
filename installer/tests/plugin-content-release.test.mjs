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

async function build(output) {
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
    ],
    { cwd: repositoryRoot },
  );
  return JSON.parse(await readFile(path.join(output, "release.json"), "utf8"));
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

    const verified = await verifyContentRelease({
      directory: firstDirectory,
      manifestPath: path.join(firstDirectory, "release.json"),
      publicKey: await readFile(publicKeyPath),
    });
    expect(verified.manifest.plugin.name).toBe("lidfly");
    expect(verified.manifest.min_installer_version).toBe("1.2.0");
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
