#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertAmd64Pe } from "./lib/pe-machine.mjs";

const [fileArgument] = process.argv.slice(2);
if (!fileArgument) {
  throw new Error("Usage: verify-pe-machine.mjs <application.exe>");
}
const filePath = path.resolve(fileArgument);
const inspected = assertAmd64Pe(await readFile(filePath));
console.log(
  `Windows application PE machine verified: ${inspected.architecture} (${filePath})`,
);
