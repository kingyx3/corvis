import assert from "node:assert/strict";
import test from "node:test";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { crc32, decimalToUnscaled, POSITION_EXPORT_COLUMNS, renderCsv, renderParquet, renderXlsx, type ExportRow } from "./export-renderer.ts";

const row: ExportRow = {
  observation_id: "obs-1",
  fund_id: "fund-1",
  company_id: "company-1",
  holding_id: null,
  instrument_id: null,
  metric_code: "revenue",
  value_number: 12.5,
  value_string: "quoted, \"value\"",
  currency: "USD",
  economic_period: "2026-Q2",
  report_date: "2026-06-30",
  review_state: "approved",
  source_reference_id: "source-1",
  document_id: "document-1",
  version: 3,
  updated_at: "2026-09-22T00:00:00.000Z",
};

test("CSV renderer emits stable columns and RFC-style escaping", () => {
  const csv = renderCsv([row]).toString("utf8");
  assert.match(csv, /^observation_id,fund_id,/);
  assert.match(csv, /"quoted, ""value"""/);
  assert.ok(csv.endsWith("\r\n"));
});

test("XLSX renderer produces an Office Open XML zip with expected sheet content", () => {
  const xlsx = renderXlsx([row]);
  assert.equal(xlsx.subarray(0, 2).toString("ascii"), "PK");
  assert.match(xlsx.toString("utf8"), /xl\/worksheets\/sheet1\.xml/);
  assert.match(xlsx.toString("utf8"), /Observations/);
  assert.match(xlsx.toString("utf8"), /quoted, &quot;value&quot;/);
});

test("Parquet renderer emits a parquet buffer even for nullable fields", () => {
  const parquet = renderParquet([row]);
  assert.equal(parquet.subarray(0, 4).toString("ascii"), "PAR1");
  assert.equal(parquet.subarray(-4).toString("ascii"), "PAR1");
  assert.ok(parquet.length > 100);
});

test("all renderers support an empty authorized export", () => {
  assert.ok(renderCsv([]).length > 0);
  assert.ok(renderXlsx([]).length > 0);
  const parquet = renderParquet([]);
  assert.equal(parquet.subarray(0, 4).toString("ascii"), "PAR1");
});

test("CSV renderer neutralizes spreadsheet formulas in text cells but leaves numbers typed", () => {
  const csv = renderCsv([
    { ...row, value_string: "=HYPERLINK(\"http://evil\",\"x\")", metric_code: "+cmd", currency: "@SUM(A1)", company_id: "-2+3", value_number: -12.5 },
  ]).toString("utf8");
  const dataLine = csv.split("\r\n")[1]!;
  assert.match(dataLine, /,'\+cmd,/);
  assert.match(dataLine, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)"/);
  assert.match(dataLine, /,'@SUM\(A1\),/);
  assert.match(dataLine, /,'-2\+3,/);
  assert.match(dataLine, /,-12\.5,/, "a negative number is a typed value, not a formula");
});

test("XLSX renderer drops characters that are illegal in XML so the workbook stays readable", () => {
  const xlsx = renderXlsx([{ ...row, value_string: "bad\u0000\u0001\u000Bvalue\uD800 ok😀" }]).toString("utf8");
  assert.match(xlsx, /badvalue ok😀/);
  assert.doesNotMatch(xlsx, /bad\u0000/);
});

/** The original bit-at-a-time implementation, kept as the oracle for the table-driven one. */
function bitwiseCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("crc32 matches the published CRC-32 check values", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  assert.equal(crc32(Buffer.from("a")), 0xe8b7be43);
  assert.equal(crc32(Buffer.from("The quick brown fox jumps over the lazy dog")), 0x414fa339);
  assert.equal(crc32(Buffer.alloc(32, 0)), 0x190a55ad);
  assert.equal(crc32(Buffer.alloc(32, 0xff)), 0xff6cab0b);
});

test("the table-driven crc32 agrees with the bitwise definition on arbitrary bytes", () => {
  let seed = 0x1234abcd;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (const length of [1, 2, 3, 255, 256, 257, 4096, 100_003]) {
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < length; index++) bytes[index] = next() >>> 24;
    assert.equal(crc32(bytes), bitwiseCrc32(bytes), `length ${length}`);
  }
  // Accepts any Uint8Array view, including a Buffer slice with a non-zero offset.
  const backing = Buffer.from("xx123456789yy");
  assert.equal(crc32(backing.subarray(2, 11)), 0xcbf43926);
});

test("every entry of an XLSX archive stores the CRC-32 of its bytes", () => {
  const xlsx = renderXlsx([row, { ...row, observation_id: "obs-2" }]);
  let offset = 0;
  let entries = 0;
  while (xlsx.readUInt32LE(offset) === 0x04034b50) {
    const checksum = xlsx.readUInt32LE(offset + 14);
    const size = xlsx.readUInt32LE(offset + 18);
    const dataStart = offset + 30 + xlsx.readUInt16LE(offset + 26) + xlsx.readUInt16LE(offset + 28);
    assert.equal(checksum, bitwiseCrc32(xlsx.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
    entries += 1;
  }
  assert.ok(entries >= 4, `expected the workbook parts, found ${entries}`);
});

const POSITION_ROW: ExportRow = {
  statement_id: "st-1", document_id: "d-1", fund_id: "f-1", holding_id: "h-1", company_id: "c-1", statement_type: "income_statement",
  report_period: "2026-Q2", source_label: "Revenue", metric_code: null, line_role: "line", display_order: 2, depth: 1,
  value_raw: "1", value_number: "1.0000000000", value_string: null, currency: "USD", unit: null, period_type: "quarter",
  period_start: null, period_end: null, as_of_date: null, fiscal_year: 2026, fiscal_quarter: 2, source_column_label: null,
  preliminary: true, is_restatement: false, is_derived: false, derivation_formula: null, source_reference_ids: "[]",
};

async function readParquet(bytes: Buffer): Promise<{ schema: Map<string, { type?: string; converted_type?: string }>; rows: Array<Record<string, unknown>> }> {
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const schema = new Map(parquetMetadata(file).schema.map((element) => [element.name, element]));
  return { schema, rows: await parquetReadObjects({ file }) };
}

test("Position Financials Parquet writes integer columns as INT32 and flags as BOOLEAN, sorting numerically", async () => {
  const rows = [10, 2, 1, 100].map((order, index) => ({ ...POSITION_ROW, statement_id: `st-${index}`, display_order: order, fiscal_year: 2020 + order }));
  const { schema, rows: read } = await readParquet(renderParquet(rows, POSITION_EXPORT_COLUMNS));
  for (const name of ["display_order", "depth", "fiscal_year", "fiscal_quarter"]) {
    assert.equal(schema.get(name)?.type, "INT32", `${name} is a typed integer`);
    assert.equal(schema.get(name)?.converted_type, undefined, `${name} is not a UTF8 string`);
  }
  for (const name of ["preliminary", "is_restatement", "is_derived"]) assert.equal(schema.get(name)?.type, "BOOLEAN", `${name} is a typed boolean`);
  // Text columns keep their UTF8 contract.
  assert.equal(schema.get("source_label")?.type, "BYTE_ARRAY");
  assert.equal(schema.get("source_label")?.converted_type, "UTF8");
  assert.equal(schema.get("source_reference_ids")?.converted_type, "UTF8");

  assert.deepEqual(read.map((entry) => entry.display_order), [10, 2, 1, 100]);
  assert.deepEqual(read.map((entry) => entry.display_order).sort((a, b) => Number(a) - Number(b)), [1, 2, 10, 100], "numeric order, not lexical");
  assert.equal(read[0]!.depth, 1);
  assert.equal(read[0]!.fiscal_quarter, 2);
  assert.equal(read[0]!.preliminary, true);
  assert.equal(read[0]!.is_restatement, false);
});

test("Position Financials Parquet keeps null integers and flags null, and reads numeric strings as integers", async () => {
  const { rows } = await readParquet(renderParquet([
    { ...POSITION_ROW, fiscal_year: null, fiscal_quarter: null, preliminary: null, is_restatement: null, is_derived: null },
    { ...POSITION_ROW, fiscal_year: "", display_order: "7", depth: 0, fiscal_quarter: 4 },
    { ...POSITION_ROW, fiscal_year: -2_147_483_648, display_order: 2_147_483_647 },
  ], POSITION_EXPORT_COLUMNS));
  assert.equal(rows[0]!.fiscal_year, null);
  assert.equal(rows[0]!.fiscal_quarter, null);
  assert.equal(rows[0]!.preliminary, null);
  assert.equal(rows[0]!.is_restatement, null);
  assert.equal(rows[0]!.is_derived, null);
  assert.equal(rows[1]!.fiscal_year, null, "an empty cell is null, not 0");
  assert.equal(rows[1]!.display_order, 7);
  assert.equal(rows[1]!.depth, 0, "zero is a value, not a null");
  assert.equal(rows[2]!.fiscal_year, -2_147_483_648);
  assert.equal(rows[2]!.display_order, 2_147_483_647);
});

test("Position Financials Parquet refuses values that cannot be typed instead of writing a wrong number or flag", () => {
  const render = (overrides: ExportRow) => () => renderParquet([{ ...POSITION_ROW, ...overrides }], POSITION_EXPORT_COLUMNS);
  assert.throws(render({ fiscal_year: 2026.5 }), /fiscal_year must hold a 32-bit integer/);
  assert.throws(render({ depth: "abc" }), /depth must hold a 32-bit integer/);
  assert.throws(render({ display_order: 2_147_483_648 }), /display_order must hold a 32-bit integer/);
  assert.throws(render({ fiscal_quarter: -2_147_483_649 }), /fiscal_quarter must hold a 32-bit integer/);
  assert.throws(render({ preliminary: "true" }), /preliminary must hold a boolean/);
  assert.throws(render({ is_derived: 1 }), /is_derived must hold a boolean/);
});

test("observation exports keep their column types: version stays DOUBLE and everything else text or decimal", async () => {
  const { schema, rows } = await readParquet(renderParquet([row, { ...row, version: null }, { ...row, version: "" }]));
  assert.equal(schema.get("version")?.type, "DOUBLE");
  assert.deepEqual(rows.map((entry) => entry.version), [3, null, null]);
  assert.equal(schema.get("observation_id")?.converted_type, "UTF8");
  assert.equal(schema.get("value_number")?.converted_type, "DECIMAL");
});

test("decimalToUnscaled yields null for non-finite numbers and values beyond DECIMAL(38,10)", () => {
  assert.equal(decimalToUnscaled(Number.NaN), null);
  assert.equal(decimalToUnscaled(Number.POSITIVE_INFINITY), null);
  assert.equal(decimalToUnscaled("1".repeat(29)), null, "29 whole digits plus 10 scale digits overflows precision 38");
  assert.equal(decimalToUnscaled("1".repeat(28)), BigInt(`${"1".repeat(28)}0000000000`));
  assert.equal(decimalToUnscaled(null), null);
  assert.equal(decimalToUnscaled(""), null);
});
