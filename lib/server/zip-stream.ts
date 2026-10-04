import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";

/**
 * A streaming ZIP writer for archives whose size is not known up front (the full tenant export, F10b #322). Entries are
 * written stored (uncompressed) with a data descriptor after their bytes, so an entry's size and CRC-32 are discovered
 * while it streams and nothing is held back: memory is bounded by the chunk being written, never by the archive or by
 * any one file. The central directory at the end is the only thing kept per entry (a few dozen bytes).
 *
 * ZIP64 is used exactly where the format needs it: an entry declared larger than 4 GiB uses 64-bit descriptor sizes,
 * and an archive with 65,535 or more entries, or whose directory or offsets pass 4 GiB, gets the ZIP64 end records.
 * Every other archive is a plain classic zip that any tool opens. Names are validated so an entry can never be written
 * outside the archive root when someone unpacks it.
 */

export type ZipEntryResult = { name: string; sizeBytes: number; crc32: number; sha256: string };

const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
/** 1980-01-01, the zip epoch: entries carry no wall-clock time so the same input always produces the same bytes. */
const DOS_DATE = 0x0021;
const FLAG_DESCRIPTOR_AND_UTF8 = 0x0808;

/** The thresholds at which the format needs 64-bit fields. Tests lower them to exercise ZIP64 without writing 4 GiB. */
export type ZipLimits = { size: number; entries: number };
const FORMAT_LIMITS: ZipLimits = { size: UINT32_MAX, entries: UINT16_MAX };

type OpenEntry = { name: Buffer; offset: number; zip64: boolean; crc: number; size: number; hash: ReturnType<typeof createHash> };
type FinishedEntry = { name: Buffer; offset: number; zip64: boolean; crc: number; size: number };

export function assertSafeZipEntryName(name: string): void {
  const bytes = Buffer.byteLength(name, "utf8");
  if (name.length === 0 || bytes > UINT16_MAX || name.startsWith("/") || name.includes("\\") || name.includes("\0")
    || name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("zip entry name is not a safe relative path");
  }
}

function zip64Extra(...values: number[]): Buffer {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return extra;
}

export class ZipStreamWriter {
  private offset = 0;
  private open: OpenEntry | null = null;
  private readonly finished: FinishedEntry[] = [];
  private readonly limits: ZipLimits;

  constructor(limits: ZipLimits = FORMAT_LIMITS) { this.limits = limits; }

  /** Starts an entry and returns its local header. `sizeHint` of 4 GiB or more switches the entry to 64-bit sizes. */
  begin(name: string, sizeHint = 0): Buffer {
    if (this.open) throw new Error("zip entry is already open");
    assertSafeZipEntryName(name);
    const nameBytes = Buffer.from(name, "utf8");
    const zip64 = sizeHint >= this.limits.size;
    const extra = zip64 ? zip64Extra(0, 0) : Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(FLAG_DESCRIPTOR_AND_UTF8, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(zip64 ? UINT32_MAX : 0, 18);
    header.writeUInt32LE(zip64 ? UINT32_MAX : 0, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(extra.length, 28);
    this.open = { name: nameBytes, offset: this.offset, zip64, crc: 0, size: 0, hash: createHash("sha256") };
    const bytes = Buffer.concat([header, nameBytes, extra]);
    this.offset += bytes.length;
    return bytes;
  }

  /** Accounts for a chunk of the open entry. The chunk itself is the entry's bytes: the caller emits it as it is. */
  write(chunk: Uint8Array): void {
    const open = this.open;
    if (!open) throw new Error("no zip entry is open");
    open.size += chunk.length;
    if (!open.zip64 && open.size >= this.limits.size) throw new Error("zip entry is larger than 4 GiB and was not declared as such");
    open.crc = crc32(chunk, open.crc);
    open.hash.update(chunk);
    this.offset += chunk.length;
  }

  /** Closes the entry: its data descriptor, and the size, CRC-32 and SHA-256 that were measured while it streamed. */
  end(): { bytes: Buffer; result: ZipEntryResult } {
    const open = this.open;
    if (!open) throw new Error("no zip entry is open");
    this.open = null;
    const descriptor = Buffer.alloc(open.zip64 ? 24 : 16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(open.crc, 4);
    if (open.zip64) {
      descriptor.writeBigUInt64LE(BigInt(open.size), 8);
      descriptor.writeBigUInt64LE(BigInt(open.size), 16);
    } else {
      descriptor.writeUInt32LE(open.size, 8);
      descriptor.writeUInt32LE(open.size, 12);
    }
    this.offset += descriptor.length;
    this.finished.push({ name: open.name, offset: open.offset, zip64: open.zip64, crc: open.crc, size: open.size });
    return { bytes: descriptor, result: { name: open.name.toString("utf8"), sizeBytes: open.size, crc32: open.crc, sha256: open.hash.digest("hex") } };
  }

  /** The central directory and end records. The archive is complete once these are written. */
  finish(): Buffer {
    if (this.open) throw new Error("zip entry is still open");
    const directoryOffset = this.offset;
    const records: Buffer[] = [];
    for (const entry of this.finished) {
      const sizeOverflow = entry.size >= this.limits.size;
      const offsetOverflow = entry.offset >= this.limits.size;
      const extraValues = [...(sizeOverflow ? [entry.size, entry.size] : []), ...(offsetOverflow ? [entry.offset] : [])];
      const extra = extraValues.length > 0 ? zip64Extra(...extraValues) : Buffer.alloc(0);
      const record = Buffer.alloc(46);
      const version = extraValues.length > 0 ? 45 : 20;
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(version, 4);
      record.writeUInt16LE(version, 6);
      record.writeUInt16LE(FLAG_DESCRIPTOR_AND_UTF8, 8);
      record.writeUInt16LE(0, 10);
      record.writeUInt16LE(0, 12);
      record.writeUInt16LE(DOS_DATE, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(sizeOverflow ? UINT32_MAX : entry.size, 20);
      record.writeUInt32LE(sizeOverflow ? UINT32_MAX : entry.size, 24);
      record.writeUInt16LE(entry.name.length, 28);
      record.writeUInt16LE(extra.length, 30);
      record.writeUInt32LE(offsetOverflow ? UINT32_MAX : entry.offset, 42);
      records.push(record, entry.name, extra);
    }
    const directory = Buffer.concat(records);
    const count = this.finished.length;
    const tail: Buffer[] = [directory];
    const countOverflow = count >= this.limits.entries;
    const directoryOverflow = directory.length >= this.limits.size;
    const offsetOverflow = directoryOffset >= this.limits.size;
    const needs64 = countOverflow || directoryOverflow || offsetOverflow;
    if (needs64) {
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(0x06064b50, 0);
      end64.writeBigUInt64LE(44n, 4);
      end64.writeUInt16LE(45, 12);
      end64.writeUInt16LE(45, 14);
      end64.writeBigUInt64LE(BigInt(count), 24);
      end64.writeBigUInt64LE(BigInt(count), 32);
      end64.writeBigUInt64LE(BigInt(directory.length), 40);
      end64.writeBigUInt64LE(BigInt(directoryOffset), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(directoryOffset + directory.length), 8);
      locator.writeUInt32LE(1, 16);
      tail.push(end64, locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(countOverflow ? UINT16_MAX : count, 8);
    end.writeUInt16LE(countOverflow ? UINT16_MAX : count, 10);
    end.writeUInt32LE(directoryOverflow ? UINT32_MAX : directory.length, 12);
    end.writeUInt32LE(offsetOverflow ? UINT32_MAX : directoryOffset, 16);
    tail.push(end);
    return Buffer.concat(tail);
  }
}

export type ZipSource = { name: string; body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>; sizeHint?: number };

/**
 * Streams the archive for `sources` in order. A source is read only when the consumer asks for more, so a slow upload
 * slows the read of the next file and nothing piles up. `onEntry` sees each entry's measured size, CRC-32 and SHA-256
 * as soon as it ends (before the next entry starts), and may throw to abort the archive.
 */
export async function* zipStream(
  sources: AsyncIterable<ZipSource> | Iterable<ZipSource>,
  onEntry?: (result: ZipEntryResult) => void,
  limits?: ZipLimits,
): AsyncGenerator<Buffer> {
  const writer = new ZipStreamWriter(limits);
  for await (const source of sources) {
    yield writer.begin(source.name, source.sizeHint);
    for await (const chunk of source.body) {
      if (chunk.length === 0) continue;
      writer.write(chunk);
      yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    const { bytes, result } = writer.end();
    onEntry?.(result);
    yield bytes;
  }
  yield writer.finish();
}
