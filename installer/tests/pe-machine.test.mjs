import { describe, expect, it } from "vitest";

import {
  assertAmd64Pe,
  assertNoAuthenticode,
  inspectPeAuthenticode,
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

function pe32PlusFixture({ certificateOffset = 0, certificateSize = 0 } = {}) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(PE_MACHINE_AMD64, 68);
  bytes.writeUInt16LE(240, 84);
  const optionalHeaderOffset = 88;
  bytes.writeUInt16LE(0x20b, optionalHeaderOffset);
  const securityDirectoryOffset = optionalHeaderOffset + 112 + 4 * 8;
  bytes.writeUInt32LE(certificateOffset, securityDirectoryOffset);
  bytes.writeUInt32LE(certificateSize, securityDirectoryOffset + 4);
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

describe("Windows Authenticode verification", () => {
  it("accepts an empty PE security directory as NotSigned", () => {
    expect(assertNoAuthenticode(pe32PlusFixture())).toEqual({
      certificateOffset: 0,
      certificateSize: 0,
      status: "NotSigned",
    });
  });

  it("rejects a populated Authenticode certificate table", () => {
    const signed = pe32PlusFixture({
      certificateOffset: 400,
      certificateSize: 112,
    });
    expect(inspectPeAuthenticode(signed).status).toBe("Signed");
    expect(() => assertNoAuthenticode(signed)).toThrow(
      /Authenticode certificate table/u,
    );
  });

  it("rejects truncated optional headers", () => {
    const truncated = pe32PlusFixture();
    truncated.writeUInt16LE(16, 84);
    expect(() => inspectPeAuthenticode(truncated)).toThrow(
      /security directory/u,
    );
  });
});
