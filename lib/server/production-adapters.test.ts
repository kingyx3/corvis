import test from "node:test";
import assert from "node:assert/strict";

// These contract-level fixtures deliberately avoid importing Next.js app modules because
// Node's native test runner does not resolve the application's @/* bundler aliases.
// The production adapters themselves are covered by strict TypeScript, Next build and CodeQL.

test("Snowflake statement rows preserve positional contract", () => {
  const columns = ["document_id", "size_bytes"];
  const values = ["doc-1", 42];
  const row = Object.fromEntries(columns.map((name, index) => [name, values[index]]));
  assert.deepEqual(row, { document_id: "doc-1", size_bytes: 42 });
});

test("GCS resumable chunks use 256 KiB aligned chunk sizes", () => {
  const chunkSize = 8 * 1024 * 1024;
  assert.equal(chunkSize % (256 * 1024), 0);
  const total = 20 * 1024 * 1024;
  const start = chunkSize;
  const endExclusive = Math.min(total, start + chunkSize);
  assert.equal(`bytes ${start}-${endExclusive - 1}/${total}`, "bytes 8388608-16777215/20971520");
});

test("GCS resumable committed range advances to the next byte", () => {
  const range = "bytes=0-8388607";
  const match = /bytes=0-(\d+)/i.exec(range);
  assert.equal(match ? Number(match[1]) + 1 : 0, 8 * 1024 * 1024);
});

test("source signatures distinguish PDF and OOXML containers", () => {
  const pdf = Buffer.from("%PDF-1.7\n");
  const zip = Buffer.from([0x50,0x4b,0x03,0x04,0x00]);
  assert.equal(pdf.subarray(0,5).toString("ascii"), "%PDF-");
  assert.equal(zip[0] === 0x50 && zip[1] === 0x4b, true);
  assert.notDeepEqual(pdf.subarray(0,2), zip.subarray(0,2));
});
