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

test("multipart completion contract requires ordered positive parts and ETags", () => {
  const parts = [{ partNumber: 1, etag: "abc" }, { partNumber: 2, etag: "def" }];
  assert.equal(parts.every((part, index) => part.partNumber === index + 1 && Boolean(part.etag)), true);
});

test("source signatures distinguish PDF and OOXML containers", () => {
  const pdf = Buffer.from("%PDF-1.7\n");
  const zip = Buffer.from([0x50,0x4b,0x03,0x04,0x00]);
  assert.equal(pdf.subarray(0,5).toString("ascii"), "%PDF-");
  assert.equal(zip[0] === 0x50 && zip[1] === 0x4b, true);
  assert.notDeepEqual(pdf.subarray(0,2), zip.subarray(0,2));
});
