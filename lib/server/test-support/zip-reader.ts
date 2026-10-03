import { crc32 } from "../export-renderer.ts";

/**
 * Reads a stored (uncompressed) zip the way `zipStored` writes it, verifying each entry's CRC-32 against its central
 * directory record. Test-only: it proves the archive a tenant export delivers is a well-formed zip a customer's tools
 * can open, not merely bytes with a plausible checksum.
 */
export function readStoredZip(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const endOffset = bytes.length - 22;
  if (bytes.readUInt32LE(endOffset) !== 0x06054b50) throw new Error("zip end-of-central-directory record not found");
  const count = bytes.readUInt16LE(endOffset + 10);
  let cursor = bytes.readUInt32LE(endOffset + 16);
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("zip central directory record not found");
    const checksum = bytes.readUInt32LE(cursor + 16);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("zip local header not found");
    const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const data = bytes.subarray(dataStart, dataStart + size);
    if (crc32(data) !== checksum) throw new Error(`zip entry ${name} fails its CRC-32`);
    entries.set(name, Buffer.from(data));
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  return entries;
}
