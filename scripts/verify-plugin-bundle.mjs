#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUNDLE_PATHS, inspectBuiltBundle } from "./lib/plugin-bundle.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const resourcesRoot = path.resolve(
  repositoryRoot,
  "installer/src-tauri/resources",
);
const bundleRoot = path.resolve(
  process.argv[2] ?? path.join(resourcesRoot, "plugin-bundle"),
);
const metadataPath = path.resolve(
  process.argv[3] ?? path.join(resourcesRoot, "plugin-bundle-files.json"),
);

async function listFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Symlink found in built bundle: ${relativePath}`);
    if (entry.isDirectory())
      result.push(
        ...(await listFiles(path.join(directory, entry.name), relativePath)),
      );
    else if (entry.isFile()) result.push(relativePath);
    else
      throw new Error(`Unsupported file type in built bundle: ${relativePath}`);
  }
  return result.sort();
}

const actualPaths = await listFiles(bundleRoot);
if (JSON.stringify(actualPaths) !== JSON.stringify(BUNDLE_PATHS)) {
  throw new Error(
    `Built bundle differs from allowlist: ${actualPaths.join(", ")}`,
  );
}
const inspected = await inspectBuiltBundle(bundleRoot, metadataPath);
console.log(
  `Plugin bundle verified: ${inspected.metadata.plugin_bundle_sha256}`,
);
