import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const CONTENT_SCHEMA_VERSION = 1;
export const CONTENT_CHANNEL = "stable";
export const CONTENT_ORIGIN = "https://lidfly.ru";
export const CONTENT_ROUTE = "/codex-plugin-content/";
export const CONTENT_KEY_ID = "lidfly-plugin-content-2026-01";
export const MAX_CONTENT_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const SOURCE_REPOSITORY =
  "https://github.com/awaik/direct-mcp-ai-project";

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, label) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function exactKeys(value, keys, label) {
  object(value, label);
  assert(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${label} has unexpected fields`,
  );
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function pluginContentFilename(version, archiveSha256) {
  assert(SEMVER.test(version), "plugin version must use X.Y.Z");
  assert(SHA256.test(archiveSha256), "archive SHA-256 is invalid");
  return `LidFly_Codex_Plugin_${version}_${archiveSha256.slice(0, 12)}.tar.gz`;
}

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

export function publicKeyRawBase64(publicKeyInput) {
  const key = createPublicKey(publicKeyInput);
  const der = key.export({ format: "der", type: "spki" });
  assert(
    Buffer.isBuffer(der) &&
      der.length === 44 &&
      der.subarray(0, 12).toString("hex") === "302a300506032b6570032100",
    "content signing key must be Ed25519",
  );
  return der.subarray(12).toString("base64");
}

export function validateRawPublicKeyBase64(value) {
  assert(
    typeof value === "string" && value.length > 0,
    "LIDFLY_PLUGIN_CONTENT_PUBLIC_KEY_BASE64 is required",
  );
  const raw = Buffer.from(value, "base64");
  assert(
    raw.length === 32 && raw.toString("base64") === value,
    "LIDFLY_PLUGIN_CONTENT_PUBLIC_KEY_BASE64 must be canonical base64 for exactly 32 bytes",
  );
  return raw;
}

export function signDetached(bytes, privateKeyInput) {
  const key = createPrivateKey(privateKeyInput);
  assert(
    key.asymmetricKeyType === "ed25519",
    "content private key must be Ed25519",
  );
  return `${sign(null, bytes, key).toString("base64")}\n`;
}

export function verifyDetached(bytes, signatureText, publicKeyInput) {
  const signature = Buffer.from(signatureText.trim(), "base64");
  assert(signature.length === 64, "detached signature must be 64 bytes");
  assert(
    verify(null, bytes, createPublicKey(publicKeyInput), signature),
    "detached signature verification failed",
  );
}

export function validateContentManifest(manifest) {
  exactKeys(
    manifest,
    [
      "bundle",
      "channel",
      "key_id",
      "min_installer_version",
      "plugin",
      "published_at",
      "schema_version",
      "source",
    ],
    "plugin content manifest",
  );
  assert(
    manifest.schema_version === CONTENT_SCHEMA_VERSION,
    "unsupported content schema",
  );
  assert(
    manifest.channel === CONTENT_CHANNEL,
    "content channel must be stable",
  );
  assert(
    typeof manifest.published_at === "string" &&
      !Number.isNaN(Date.parse(manifest.published_at)),
    "published_at must be ISO-8601",
  );
  assert(
    SEMVER.test(manifest.min_installer_version),
    "invalid min_installer_version",
  );
  assert(
    manifest.key_id === CONTENT_KEY_ID,
    `key_id must be ${CONTENT_KEY_ID}`,
  );

  exactKeys(manifest.plugin, ["name", "version"], "plugin");
  assert(
    manifest.plugin.name === "lidfly" && SEMVER.test(manifest.plugin.version),
    "invalid plugin identity",
  );
  exactKeys(
    manifest.source,
    ["commit", "repository", "skills_tree_sha256"],
    "source",
  );
  assert(
    manifest.source.repository === SOURCE_REPOSITORY &&
      COMMIT.test(manifest.source.commit) &&
      SHA256.test(manifest.source.skills_tree_sha256),
    "invalid source provenance",
  );
  exactKeys(
    manifest.bundle,
    ["filename", "sha256", "signature_filename", "size", "url"],
    "bundle",
  );
  assert(SHA256.test(manifest.bundle.sha256), "invalid bundle SHA-256");
  assert(
    Number.isSafeInteger(manifest.bundle.size) &&
      manifest.bundle.size > 0 &&
      manifest.bundle.size <= MAX_CONTENT_ARCHIVE_BYTES,
    "invalid bundle size",
  );
  const expectedFilename = pluginContentFilename(
    manifest.plugin.version,
    manifest.bundle.sha256,
  );
  assert(
    manifest.bundle.filename === expectedFilename,
    "bundle filename policy mismatch",
  );
  assert(
    manifest.bundle.signature_filename === `${expectedFilename}.sig`,
    "bundle signature filename mismatch",
  );
  const url = new URL(manifest.bundle.url);
  assert(
    url.origin === CONTENT_ORIGIN &&
      url.pathname === `${CONTENT_ROUTE}${expectedFilename}` &&
      url.search === "" &&
      url.hash === "",
    "bundle URL must use the fixed LidFly content route",
  );
  return manifest;
}

export async function verifyContentRelease({
  directory,
  manifestPath,
  publicKey,
}) {
  const manifestBytes = await readFile(manifestPath);
  const manifest = validateContentManifest(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const manifestSignaturePath = `${manifestPath}.sig`;
  verifyDetached(
    manifestBytes,
    await readFile(manifestSignaturePath, "utf8"),
    publicKey,
  );
  const bundlePath = path.join(directory, manifest.bundle.filename);
  const bundleSignaturePath = path.join(
    directory,
    manifest.bundle.signature_filename,
  );
  const bundleStat = await stat(bundlePath);
  assert(
    bundleStat.isFile() && bundleStat.size === manifest.bundle.size,
    "bundle size mismatch",
  );
  assert(
    (await sha256File(bundlePath)) === manifest.bundle.sha256,
    "bundle SHA-256 mismatch",
  );
  const bundleBytes = await readFile(bundlePath);
  verifyDetached(
    bundleBytes,
    await readFile(bundleSignaturePath, "utf8"),
    publicKey,
  );
  return {
    bundlePath,
    bundleSignaturePath,
    manifest,
    manifestBytes,
    manifestSignaturePath,
  };
}

export async function readOptionalSignedPair(dataPath, signaturePath) {
  const [dataResult, signatureResult] = await Promise.allSettled([
    readFile(dataPath),
    readFile(signaturePath, "utf8"),
  ]);
  for (const result of [dataResult, signatureResult]) {
    if (result.status === "rejected" && result.reason?.code !== "ENOENT") {
      throw result.reason;
    }
  }
  const dataMissing = dataResult.status === "rejected";
  const signatureMissing = signatureResult.status === "rejected";
  if (dataMissing && signatureMissing) return null;
  assert(
    !dataMissing && !signatureMissing,
    `signed file pair is incomplete: ${path.basename(dataPath)} and ${path.basename(signaturePath)} must either both exist or both be absent`,
  );
  return {
    bytes: dataResult.value,
    signature: signatureResult.value,
  };
}
