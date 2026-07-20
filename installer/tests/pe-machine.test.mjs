import { describe, expect, it } from "vitest";

import {
  assertAmd64Pe,
  inspectPeMachine,
  PE_MACHINE_AMD64,
} from "../../scripts/lib/pe-machine.mjs";

function peFixture(machine) {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

describe("Windows PE machine verification", () => {
  it("accepts an AMD64 PE header", () => {
    expect(assertAmd64Pe(peFixture(PE_MACHINE_AMD64))).toEqual({
      machine: PE_MACHINE_AMD64,
      architecture: "x86_64",
    });
  });

  it("rejects an x86 PE header", () => {
    expect(() => assertAmd64Pe(peFixture(0x014c))).toThrow(/expected AMD64/u);
  });

  it("rejects invalid signatures and out-of-range offsets", () => {
    const invalidSignature = peFixture(PE_MACHINE_AMD64);
    invalidSignature.writeUInt32LE(0, 64);
    expect(() => inspectPeMachine(invalidSignature)).toThrow(/PE signature/u);

    const invalidOffset = peFixture(PE_MACHINE_AMD64);
    invalidOffset.writeInt32LE(10_000, 0x3c);
    expect(() => inspectPeMachine(invalidOffset)).toThrow(/header offset/u);
  });
});
