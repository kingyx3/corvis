import assert from "node:assert/strict";
import test from "node:test";
import { renderCsv, renderParquet, renderXlsx, type ExportRow } from "./export-renderer.ts";

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
