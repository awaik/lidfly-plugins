#!/usr/bin/env node
import { validateRawPublicKeyBase64 } from "./lib/plugin-content-contract.mjs";

try {
  validateRawPublicKeyBase64(
    process.env.LIDFLY_PLUGIN_CONTENT_PUBLIC_KEY_BASE64,
  );
  process.stdout.write("Plugin content public key is valid.\n");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
