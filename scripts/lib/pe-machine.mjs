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
