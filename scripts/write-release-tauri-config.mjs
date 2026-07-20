#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [outputArgument] = process.argv.slice(2);
if (!outputArgument) {
  throw new Error("Usage: write-release-tauri-config.mjs <output.json>");
}
const outputPath = path.resolve(outputArgument);
const publicKey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
if (!publicKey) throw new Error("TAURI_UPDATER_PUBLIC_KEY is required");
let decodedPublicKey;
try {
  decodedPublicKey = Buffer.from(publicKey, "base64").toString("utf8");
} catch (error) {
  throw new Error(`TAURI_UPDATER_PUBLIC_KEY is not base64: ${error}`);
}
if (
  !decodedPublicKey.startsWith("untrusted comment:") ||
  decodedPublicKey.trim().split(/\r?\n/u).length !== 2
) {
  throw new Error(
    "TAURI_UPDATER_PUBLIC_KEY is not a Tauri minisign public key",
  );
}

const config = {
  plugins: {
    updater: {
      pubkey: publicKey,
      endpoints: ["https://lidfly.ru/codex-plugin-downloads/latest.json"],
    },
  },
};
if (process.env.LIDFLY_RELEASE_PLATFORM === "windows") {
  const certificateThumbprint =
    process.env.WINDOWS_CERTIFICATE_THUMBPRINT?.replace(/\s/gu, "");
  if (!/^[A-Fa-f0-9]{40,64}$/.test(certificateThumbprint ?? "")) {
    throw new Error("WINDOWS_CERTIFICATE_THUMBPRINT is invalid");
  }
  const timestampUrl = process.env.WINDOWS_TIMESTAMP_URL;
  const parsedTimestamp = new URL(timestampUrl ?? "invalid:");
  if (!["http:", "https:"].includes(parsedTimestamp.protocol)) {
    throw new Error("WINDOWS_TIMESTAMP_URL must use HTTP or HTTPS");
  }
  config.bundle = {
    windows: {
      certificateThumbprint,
      digestAlgorithm: "sha256",
      timestampUrl,
      nsis: { installMode: "currentUser" },
    },
  };
}
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(`Release Tauri config written: ${outputPath}`);
