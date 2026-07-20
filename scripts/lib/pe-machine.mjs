export const PE_MACHINE_AMD64 = 0x8664;

export function inspectPeMachine(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64) {
    throw new Error("Windows binary is too small to contain a PE header");
  }
  if (bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("Windows binary does not have an MZ header");
  }
  const peOffset = bytes.readInt32LE(0x3c);
  if (peOffset < 0 || peOffset > bytes.length - 6) {
    throw new Error("Windows binary has an invalid PE header offset");
  }
  if (bytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error("Windows binary does not have a PE signature");
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  return {
    machine,
    architecture: machine === PE_MACHINE_AMD64 ? "x86_64" : "unsupported",
  };
}

export function assertAmd64Pe(bytes) {
  const inspected = inspectPeMachine(bytes);
  if (inspected.machine !== PE_MACHINE_AMD64) {
    throw new Error(
      `Windows binary PE machine is 0x${inspected.machine.toString(16)}, expected AMD64 (0x8664)`,
    );
  }
  return inspected;
}

export function inspectPeAuthenticode(bytes) {
  inspectPeMachine(bytes);
  const peOffset = bytes.readInt32LE(0x3c);
  const coffHeaderOffset = peOffset + 4;
  const optionalHeaderOffset = coffHeaderOffset + 20;
  const optionalHeaderSize = bytes.readUInt16LE(coffHeaderOffset + 16);
  const optionalHeaderEnd = optionalHeaderOffset + optionalHeaderSize;
  if (optionalHeaderEnd > bytes.length) {
    throw new Error("Windows binary has a truncated PE optional header");
  }

  const magic = bytes.readUInt16LE(optionalHeaderOffset);
  const dataDirectoriesOffset =
    optionalHeaderOffset + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
  if (dataDirectoriesOffset < optionalHeaderOffset) {
    throw new Error("Windows binary has an unsupported PE optional header");
  }

  // IMAGE_DIRECTORY_ENTRY_SECURITY is data directory index 4. Unlike the
  // other entries, its first value is a file offset rather than an RVA.
  const securityDirectoryOffset = dataDirectoriesOffset + 4 * 8;
  if (securityDirectoryOffset + 8 > optionalHeaderEnd) {
    throw new Error("Windows binary has no complete PE security directory");
  }
  const certificateOffset = bytes.readUInt32LE(securityDirectoryOffset);
  const certificateSize = bytes.readUInt32LE(securityDirectoryOffset + 4);
  return {
    certificateOffset,
    certificateSize,
    status:
      certificateOffset === 0 && certificateSize === 0 ? "NotSigned" : "Signed",
  };
}

export function assertNoAuthenticode(bytes) {
  const inspected = inspectPeAuthenticode(bytes);
  if (inspected.status !== "NotSigned") {
    throw new Error(
      `Windows installer contains an Authenticode certificate table at ${inspected.certificateOffset} (${inspected.certificateSize} bytes)`,
    );
  }
  return inspected;
}
