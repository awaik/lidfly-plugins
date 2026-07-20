#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertNoAuthenticode } from "./lib/pe-machine.mjs";

const [fileArgument] = process.argv.slice(2);
if (!fileArgument) {
  throw new Error("Usage: verify-pe-authenticode.mjs <installer.exe>");
}
const filePath = path.resolve(fileArgument);
const inspected = assertNoAuthenticode(await readFile(filePath));
console.log(`Windows Authenticode status: ${inspected.status} (${filePath})`);
