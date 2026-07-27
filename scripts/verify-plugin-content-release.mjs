#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  publicKeyRawBase64,
  verifyContentRelease,
} from "./lib/plugin-content-contract.mjs";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

try {
  const directory = path.resolve(process.cwd(), valueAfter("--directory"));
  const publicKeyPath = path.resolve(process.cwd(), valueAfter("--public-key"));
  const publicKey = await readFile(publicKeyPath);
  const verified = await verifyContentRelease({
    directory,
    manifestPath: path.join(directory, "release.json"),
    publicKey,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        plugin_version: verified.manifest.plugin.version,
        bundle: verified.manifest.bundle.filename,
        public_key_base64: publicKeyRawBase64(publicKey),
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
