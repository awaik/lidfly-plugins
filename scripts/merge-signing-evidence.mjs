#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [applePath, windowsPath, outputPath] = process.argv
  .slice(2)
  .map((value) => path.resolve(value));
if (!applePath || !windowsPath || !outputPath) {
  throw new Error(
    "Usage: merge-signing-evidence.mjs <apple.json> <windows.json> <output.json>",
  );
}
const appleEvidence = JSON.parse(await readFile(applePath, "utf8"));
const windowsEvidence = JSON.parse(await readFile(windowsPath, "utf8"));
if (
  appleEvidence.schema_version !== 1 ||
  windowsEvidence.schema_version !== 1 ||
  appleEvidence.release_version !== windowsEvidence.release_version
) {
  throw new Error("Signing evidence schema/version mismatch");
}
const combined = {
  schema_version: 1,
  release_version: appleEvidence.release_version,
  apple: appleEvidence.apple,
  windows: windowsEvidence.windows,
};
await writeFile(outputPath, `${JSON.stringify(combined, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(`Signing evidence merged: ${outputPath}`);
