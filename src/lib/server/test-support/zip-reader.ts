import { crc32 } from "node:zlib";

/**
 * Reads a stored (uncompressed) zip the way `zip-stream.ts` writes it, from the central directory, including the ZIP64
 * records, and verifies each entry's CRC-32 against it. Test-only: it proves the archive a tenant export delivers is a
 * well-formed zip a customer's tools can open, not merely bytes with a plausible checksum.
 */
export function readStoredZip(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const endOffset = bytes.length - 22;
  if (endOffset < 0 || bytes.readUInt32LE(endOffset) !== 0x06054b50) throw new Error("zip end-of-central-directory record not found");
  let count = bytes.readUInt16LE(endOffset + 10);
  let cursor = bytes.readUInt32LE(endOffset + 16);
  if (count === 0xffff || cursor === 0xffffffff || bytes.readUInt32LE(endOffset + 12) === 0xffffffff) {
    const locator = endOffset - 20;
    if (bytes.readUInt32LE(locator) !== 0x07064b50) throw new Error("zip64 end-of-central-directory locator not found");
    const end64 = Number(bytes.readBigUInt64LE(locator + 8));
    if (bytes.readUInt32LE(end64) !== 0x06064b50) throw new Error("zip64 end-of-central-directory record not found");
    count = Number(bytes.readBigUInt64LE(end64 + 32));
    cursor = Number(bytes.readBigUInt64LE(end64 + 48));
  }
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("zip central directory record not found");
    const checksum = bytes.readUInt32LE(cursor + 16);
    let compressed = bytes.readUInt32LE(cursor + 20);
    let size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    let localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const extraStart = cursor + 46 + nameLength;
    for (let at = extraStart; at < extraStart + extraLength;) {
      const id = bytes.readUInt16LE(at);
      const length = bytes.readUInt16LE(at + 2);
      if (id === 0x0001) {
        let value = at + 4;
        if (size === 0xffffffff) { size = Number(bytes.readBigUInt64LE(value)); value += 8; }
        if (compressed === 0xffffffff) { compressed = Number(bytes.readBigUInt64LE(value)); value += 8; }
        if (localOffset === 0xffffffff) localOffset = Number(bytes.readBigUInt64LE(value));
      }
      at += 4 + length;
    }
    if (compressed !== size) throw new Error(`zip entry ${name} is compressed`);
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("zip local header not found");
    const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const data = bytes.subarray(dataStart, dataStart + size);
    if (crc32(data) !== checksum) throw new Error(`zip entry ${name} fails its CRC-32`);
    // The data descriptor that follows must agree with the directory (it is how a streaming reader learns the size).
    const descriptor = dataStart + size;
    if (bytes.readUInt32LE(descriptor) !== 0x08074b50 || bytes.readUInt32LE(descriptor + 4) !== checksum) throw new Error(`zip entry ${name} has no matching data descriptor`);
    entries.set(name, Buffer.from(data));
    cursor += 46 + nameLength + extraLength + bytes.readUInt16LE(cursor + 32);
  }
  return entries;
}
