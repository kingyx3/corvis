import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import { readStoredZip } from "../../../test-support/zip-reader.ts";
import { ZipStreamWriter, assertSafeZipEntryName, zipStream, type ZipEntryResult, type ZipSource } from "./zip-stream.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

test("a streamed archive is a well-formed zip: entries in order, sizes and checksums measured while streaming", async () => {
  const seen: ZipEntryResult[] = [];
  const sources = (): ZipSource[] => [
    { name: "a/one.txt", body: chunks("hello ", "", "world") },
    { name: "empty.txt", body: [] },
    { name: "b/two.bin", body: [Buffer.from([1, 2, 3]), new Uint8Array([4, 5])] },
  ];
  const bytes = await collect(zipStream(sources(), (result) => seen.push(result)));
  const entries = readStoredZip(bytes);
  assert.deepEqual([...entries.keys()], ["a/one.txt", "empty.txt", "b/two.bin"]);
  assert.equal(entries.get("a/one.txt")!.toString(), "hello world");
  assert.equal(entries.get("empty.txt")!.length, 0);
  assert.deepEqual([...entries.get("b/two.bin")!], [1, 2, 3, 4, 5]);
  assert.deepEqual(seen.map((result) => [result.name, result.sizeBytes, result.crc32, result.sha256]), [
    ["a/one.txt", 11, crc32(Buffer.from("hello world")), sha(Buffer.from("hello world"))],
    ["empty.txt", 0, 0, sha(Buffer.alloc(0))],
    ["b/two.bin", 5, crc32(Buffer.from([1, 2, 3, 4, 5])), sha(Buffer.from([1, 2, 3, 4, 5]))],
  ]);
  assert.deepEqual(await collect(zipStream(sources())), bytes, "the same input is the same archive, and onEntry is optional");
});

test("an archive with no entries is just the end record", async () => {
  const bytes = await collect(zipStream([]));
  assert.equal(bytes.length, 22);
  assert.equal(readStoredZip(bytes).size, 0);
});

test("a source is read only when the consumer pulls: nothing is read ahead of the stream", async () => {
  let produced = 0;
  async function* body(): AsyncGenerator<Uint8Array> { for (let index = 0; index < 100; index += 1) { produced += 1; yield new Uint8Array(1024); } }
  const stream = zipStream([{ name: "big.bin", body: body() }]);
  await stream.next(); // the local header
  await stream.next(); // the first chunk
  assert.ok(produced <= 2, `read ahead of the consumer (${produced} chunks)`);
  await stream.return(undefined);
});

test("an onEntry that throws aborts the archive before the next entry starts", async () => {
  let secondRead = false;
  const stream = zipStream([
    { name: "one.txt", body: chunks("x") },
    { name: "two.txt", body: (async function* () { secondRead = true; yield new Uint8Array(1); })() },
  ], () => { throw new Error("checksum mismatch"); });
  await assert.rejects(collect(stream), /checksum mismatch/);
  assert.equal(secondRead, false);
});

test("entry names that could escape the archive root are refused", () => {
  for (const name of ["", "/abs.txt", "../up.txt", "a/../b.txt", "a//b.txt", "a/./b.txt", "a\\b.txt", "a\0b", "x".repeat(70_000)]) {
    assert.throws(() => assertSafeZipEntryName(name), /safe relative path/, JSON.stringify(name.slice(0, 20)));
  }
  assertSafeZipEntryName("source-documents/files/1234/Q2 report (final).pdf");
});

test("the writer refuses calls out of order", () => {
  const writer = new ZipStreamWriter();
  assert.throws(() => writer.write(new Uint8Array(1)), /no zip entry is open/);
  assert.throws(() => writer.end(), /no zip entry is open/);
  writer.begin("a.txt");
  assert.throws(() => writer.begin("b.txt"), /already open/);
  assert.throws(() => writer.finish(), /still open/);
});

test("an entry that outgrows the size it was declared with fails instead of writing a corrupt archive", () => {
  const writer = new ZipStreamWriter({ size: 10, entries: 100 });
  writer.begin("small.bin", 5);
  writer.write(new Uint8Array(9));
  assert.throws(() => writer.write(new Uint8Array(1)), /larger than 4 GiB/);
});

test("ZIP64 is used for declared-large entries, big offsets and many entries, and readers still verify every file", async () => {
  // The thresholds are lowered so the same code paths run without writing 4 GiB.
  const limits = { size: 16, entries: 3 };
  const seen: ZipEntryResult[] = [];
  const bytes = await collect(zipStream([
    { name: "declared-large.bin", body: [Buffer.alloc(40, 7)], sizeHint: 40 },
    { name: "small-after-offset.bin", body: [Buffer.from("tiny")] },
    { name: "third.txt", body: [Buffer.from("three")] },
    { name: "fourth.txt", body: [Buffer.from("four")] },
  ], (result) => seen.push(result), limits));
  const entries = readStoredZip(bytes);
  assert.deepEqual([...entries.keys()], ["declared-large.bin", "small-after-offset.bin", "third.txt", "fourth.txt"]);
  assert.deepEqual([...entries.get("declared-large.bin")!], [...Buffer.alloc(40, 7)]);
  assert.equal(entries.get("fourth.txt")!.toString(), "four");
  assert.equal(seen[0]!.sizeBytes, 40);
  // Only the directory's ZIP64 end records exist when the count (or an offset) passes the threshold.
  assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), "zip64 end of central directory record");
  assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])), "zip64 end of central directory locator");
});

test("a small archive stays a classic zip with no ZIP64 records", async () => {
  const bytes = await collect(zipStream([{ name: "a.txt", body: [Buffer.from("a")] }]));
  assert.equal(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), false);
  assert.equal(bytes.readUInt16LE(bytes.length - 22 + 10), 1);
});

test("the archive opens in a standard unzip tool and its bytes match", async (t) => {
  const probe = spawnSync("python3", ["-c", "import zipfile"]);
  if (probe.status !== 0) { t.skip("python3 is not available"); return; }
  const directory = mkdtempSync(path.join(tmpdir(), "zip-stream-"));
  try {
    const file = path.join(directory, "out.zip");
    writeFileSync(file, await collect(zipStream([
      { name: "dir/a.txt", body: chunks("alpha", " beta") },
      { name: "big-declared.bin", body: [Buffer.alloc(100, 1)], sizeHint: 0xffffffff },
    ])));
    const script = "import zipfile,sys,hashlib\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nfor n in z.namelist(): print(n, hashlib.sha256(z.read(n)).hexdigest())";
    const run = spawnSync("python3", ["-c", script, file], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`dir/a\\.txt ${sha(Buffer.from("alpha beta"))}`));
    assert.match(run.stdout, new RegExp(`big-declared\\.bin ${sha(Buffer.alloc(100, 1))}`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
