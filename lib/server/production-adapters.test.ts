import test from "node:test";
import assert from "node:assert/strict";
import { parseMultipartParts } from "./s3.ts";
import { mapSnowflakeRows } from "./snowflake.ts";
import { validateSourceMagic } from "./uploads.ts";

test("Snowflake SQL API rows are mapped to lowercase field names", () => {
  const rows = mapSnowflakeRows({ resultSetMetaData: { rowType: [{ name: "DOCUMENT_ID" }, { name: "SIZE_BYTES" }] }, data: [["doc-1", 42]] });
  assert.deepEqual(rows, [{ document_id: "doc-1", size_bytes: 42 }]);
});

test("S3 multipart response parsing preserves ordered part metadata", () => {
  const parts = parseMultipartParts(`<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>\"abc\"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>\"def\"</ETag></Part></ListPartsResult>`);
  assert.deepEqual(parts, [{ partNumber: 1, etag: "abc" }, { partNumber: 2, etag: "def" }]);
});

test("source magic validation rejects extension/content mismatches", () => {
  assert.equal(validateSourceMagic("report.pdf", Buffer.from("%PDF-1.7\n")), true);
  assert.equal(validateSourceMagic("report.pdf", Buffer.from("PK\x03\x04fake")), false);
  assert.equal(validateSourceMagic("model.xlsx", Buffer.from([0x50,0x4b,0x03,0x04,0x00])), true);
  assert.equal(validateSourceMagic("legacy.xls", Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])), true);
  assert.equal(validateSourceMagic("data.csv", Buffer.from("fund,metric,value\nA,Revenue,1\n")), true);
  assert.equal(validateSourceMagic("data.csv", Buffer.from([0x41,0x00,0x42])), false);
});
