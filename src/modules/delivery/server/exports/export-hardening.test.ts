import assert from "node:assert/strict";
import test from "node:test";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import {
  computeExportRetryDelayMs,
  EXPORT_RETRY_BASE_DELAY_MS,
  EXPORT_RETRY_MAX_DELAY_MS,
  processQueuedExports,
  settleDeliveryTasks,
} from "./delivery.ts";
import { deleteExportAttemptArtifacts, exportAttemptObjectKey } from "./export-delivery.ts";
import {
  decimalToUnscaled,
  EXPORT_MAX_ROWS,
  ExportRowLimitError,
  POSITION_EXPORT_COLUMNS,
  renderCsv,
  renderExport,
  renderParquet,
  renderXlsx,
  type ExportRow,
} from "./export-renderer.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";

const row: ExportRow = {
  observation_id: "obs-1", fund_id: "fund-1", company_id: "c-1", holding_id: null, instrument_id: null, metric_code: "revenue",
  value_number: "12345678901234567890.1234567891", value_string: null, currency: "USD", economic_period: "2026-Q2",
  report_date: "2026-06-30", review_state: "approved", source_reference_id: "s-1", document_id: "d-1", version: 3, updated_at: "2026-09-22T00:00:00.000Z",
};

test("numeric(38,10) values keep every digit in CSV, XLSX and Parquet", async () => {
  const big = "12345678901234567890.1234567891";
  const negative = "-0.0000000001";
  const rows = [row, { ...row, observation_id: "obs-2", value_number: negative }, { ...row, observation_id: "obs-3", value_number: "12.5000000000" }, { ...row, observation_id: "obs-4", value_number: null }];
  const csv = renderCsv(rows).toString("utf8").split("\r\n");
  assert.ok(csv[1]!.includes(`,${big},`));
  assert.ok(csv[2]!.includes(`,${negative},`), "a negative decimal is a number, not a formula to neutralize");
  const xlsx = renderXlsx(rows).toString("utf8");
  assert.ok(xlsx.includes(big), "a value beyond double precision is kept as exact text");
  assert.match(xlsx, /<v>12\.5000000000<\/v>/, "an exactly representable value stays numeric");
  assert.equal(decimalToUnscaled(big), BigInt("123456789012345678901234567891"));
  assert.equal(decimalToUnscaled(negative), BigInt(-1));
  assert.equal(decimalToUnscaled("NaN"), null);
  assert.equal(decimalToUnscaled(12.5), BigInt("125000000000"));
});

test("Parquet writes value_number as an exact DECIMAL(38,10) column, not a DOUBLE", async () => {
  const parquet = renderParquet([row, { ...row, value_number: "-0.0000000001" }, { ...row, value_number: null }]);
  const file = parquet.buffer.slice(parquet.byteOffset, parquet.byteOffset + parquet.byteLength) as ArrayBuffer;
  const element = parquetMetadata(file).schema.find((entry) => entry.name === "value_number")!;
  assert.equal(element.converted_type, "DECIMAL");
  assert.equal(element.scale, 10);
  assert.equal(element.precision, 38);
  assert.equal(element.type, "FIXED_LEN_BYTE_ARRAY");
  const read = await parquetReadObjects({ file });
  assert.equal(read.length, 3);
  assert.equal(read[1]!.value_number, -1e-10);
  assert.equal(read[2]!.value_number, null);
});

test("Parquet stores a value beyond double precision as the exact 16-byte unscaled integer", () => {
  const big = "12345678901234567890.1234567891";
  const parquet = renderParquet([{ ...row, value_number: big }]);
  const unscaled = decimalToUnscaled(big)!;
  const twosComplement = Buffer.alloc(16);
  twosComplement.writeBigUInt64BE(BigInt.asUintN(128, unscaled) >> BigInt(64), 0);
  twosComplement.writeBigUInt64BE(BigInt.asUintN(128, unscaled) & BigInt("0xffffffffffffffff"), 8);
  assert.ok(Buffer.from(parquet).includes(twosComplement), "the file must contain the exact big-endian decimal, not a rounded double");
});

test("exports over the documented row cap fail with a typed, non-retryable error before rendering", () => {
  const many = { length: EXPORT_MAX_ROWS + 1 } as unknown as ExportRow[];
  assert.throws(() => renderExport("csv", many), (error: unknown) =>
    error instanceof ExportRowLimitError && error.code === "export_row_limit_exceeded" && error.retryable === false && error.maxRows === EXPORT_MAX_ROWS);
  assert.ok(EXPORT_MAX_ROWS < 1_048_575, "the cap must sit below XLSX's hard sheet limit");
});

test("export object keys are deterministic per attempt and cleanup targets exactly those keys", async () => {
  const input = { tenantId: "t", exportId: "e", attempt: 2, scoped: false, extension: "csv" };
  assert.equal(exportAttemptObjectKey(input), exportAttemptObjectKey(input));
  assert.equal(exportAttemptObjectKey(input), "exports/t/e/attempt-2/observations.csv");
  assert.notEqual(exportAttemptObjectKey(input), exportAttemptObjectKey({ ...input, attempt: 3 }));
  const deleted: string[] = [];
  await deleteExportAttemptArtifacts({ tenant_id: "t", export_id: "e", format: "csv", manifest: {} }, [1, 2], { async deleteObject(key: string) { deleted.push(key); } });
  assert.deepEqual(deleted, ["exports/t/e/attempt-1/observations.csv", "exports/t/e/attempt-2/observations.csv"]);
});

test("export retry backoff doubles, is capped and jittered", () => {
  assert.equal(computeExportRetryDelayMs(1, () => 0.5), EXPORT_RETRY_BASE_DELAY_MS);
  assert.equal(computeExportRetryDelayMs(2, () => 0.5), EXPORT_RETRY_BASE_DELAY_MS * 2);
  assert.equal(computeExportRetryDelayMs(3, () => 0.5), EXPORT_RETRY_BASE_DELAY_MS * 4);
  assert.equal(computeExportRetryDelayMs(30, () => 0.5), EXPORT_RETRY_MAX_DELAY_MS);
  assert.ok(computeExportRetryDelayMs(2, () => 0) < computeExportRetryDelayMs(2, () => 1));
});

class ExportStore implements PostgresSqlApi {
  readonly statements: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  rows: PostgresRow[] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.statements.push({ sql, parameters });
    if (sql.includes("returning delivery_attempts")) return [{ delivery_attempts: Number(parameters[2]) + 1 }];
    if (sql.includes("select tenant_id,export_id")) return this.rows;
    return [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.statements.push({ sql, parameters }); }
  async health() { return true; }
}

function fakeObjects() {
  const deleted: string[] = [];
  return { deleted, bucket: "b", async putObject() {}, async deleteObject(key: string) { deleted.push(key); } };
}

test("a failed export attempt is scheduled with backoff and a redacted error; the queue skips rows that are not yet due", async () => {
  const store = new ExportStore();
  // Missing authorization context makes deliverExportArtifact fail deterministically.
  store.rows = [{ tenant_id: "t", export_id: "00000000-0000-4000-8000-000000000001", format: "csv", snapshot_ids: [], manifest: {}, delivery_attempts: 0 }];
  const objects = fakeObjects();
  const result = await processQueuedExports(5, store, () => 0.5, objects);
  assert.deepEqual(result, { processed: 0, failed: 1 });
  const select = store.statements.find((statement) => statement.sql.includes("select tenant_id,export_id"))!.sql;
  assert.match(select, /coalesce\(delivery_next_attempt_at,'-infinity'::timestamptz\) <= now\(\)/);
  const failure = store.statements.find((statement) => statement.sql.includes("delivery_next_attempt_at=$6"))!;
  assert.equal(failure.parameters[0], "retryable");
  const delayMs = Date.parse(String(failure.parameters[5])) - Date.now();
  assert.ok(Math.abs(delayMs - EXPORT_RETRY_BASE_DELAY_MS) < 5_000, `expected ~${EXPORT_RETRY_BASE_DELAY_MS}ms backoff, got ${delayMs}`);
  assert.match(String(failure.parameters[1]), /^Error: export_missing_auth_method/);
  assert.deepEqual(objects.deleted, ["exports/t/00000000-0000-4000-8000-000000000001/attempt-1/observations.csv"], "a failed attempt removes its own object");
});

test("a permanent export failure (row cap) is failed immediately, not retried", async () => {
  const store = new ExportStore();
  store.rows = [{ tenant_id: "t", export_id: "00000000-0000-4000-8000-000000000002", format: "csv", snapshot_ids: [], manifest: {}, delivery_attempts: 0,
    auth_method: "oidc", workspace_id: "w", requested_by: "u", session_id: "s" }];
  const rowLimit = new ExportRowLimitError(EXPORT_MAX_ROWS + 1);
  const original = store.query.bind(store);
  store.query = async (sql, parameters) => {
    if (sql.startsWith("update") || sql.includes("select tenant_id,export_id")) return original(sql, parameters);
    throw rowLimit; // identity/membership resolution stands in for the loader hitting the cap
  };
  await processQueuedExports(5, store, () => 0.5, fakeObjects());
  const failure = store.statements.find((statement) => statement.sql.includes("delivery_next_attempt_at=$6"))!;
  assert.equal(failure.parameters[0], "failed");
  assert.equal(failure.parameters[5], null);
  assert.match(String(failure.parameters[1]), /^export_row_limit_exceeded: /);
});

test("one rejected delivery task no longer hides the others", async () => {
  const { results, failed } = await settleDeliveryTasks({
    exports: async () => ({ processed: 2 }),
    webhooks: async () => { throw Object.assign(new Error("boom Bearer ya29.abcdefghijklmnop"), { code: "ECONNRESET" }); },
    uploadRelease: async () => ({ released: 1 }),
  });
  assert.deepEqual(failed, ["webhooks"]);
  assert.deepEqual(results.exports, { processed: 2 });
  assert.deepEqual(results.uploadRelease, { released: 1 });
  const failure = results.webhooks as { error: string; message: string };
  assert.equal(failure.error, "ECONNRESET");
  assert.equal(failure.message.includes("ya29"), false);
});

test("a Position Financials export renders its own columns instead of the observation columns", async () => {
  const position: ExportRow = {
    statement_id: "st-1", document_id: "d-1", fund_id: "fund-1", holding_id: "h-1", company_id: "c-1", statement_type: "income_statement",
    report_period: "2026-Q2", source_label: "Revenue, net", metric_code: null, line_role: "line", display_order: 1, depth: 0,
    value_raw: "1,000", value_number: "1000.0000000000", value_string: null, currency: "USD", unit: "thousands", period_type: "quarter",
    period_start: "2026-04-01", period_end: "2026-06-30", as_of_date: null, fiscal_year: 2026, fiscal_quarter: 2, source_column_label: "Q2 2026",
    preliminary: false, is_restatement: false, is_derived: true, derivation_formula: "a+b", source_reference_ids: "[\"s-1\"]",
  };
  const csv = renderExport("csv", [position], POSITION_EXPORT_COLUMNS).bytes.toString("utf8").split("\r\n");
  assert.equal(csv[0], POSITION_EXPORT_COLUMNS.join(","));
  assert.ok(csv[1]!.includes('"Revenue, net"') && csv[1]!.includes("2026-Q2") && csv[1]!.includes("a+b"), "line label, period and derivation survive");
  assert.ok(csv[1]!.includes(",1000.0000000000,"), "value_number stays an exact decimal");
  const xlsx = renderExport("xlsx", [position], POSITION_EXPORT_COLUMNS).bytes.toString("utf8");
  assert.ok(xlsx.includes("source_label") && xlsx.includes("Revenue, net"));
  const parquet = renderExport("parquet", [position], POSITION_EXPORT_COLUMNS).bytes;
  const file = parquet.buffer.slice(parquet.byteOffset, parquet.byteOffset + parquet.byteLength) as ArrayBuffer;
  const [read] = await parquetReadObjects({ file });
  assert.equal(read!.source_label, "Revenue, net");
  assert.equal(read!.report_period, "2026-Q2");
  // Typed like CSV/XLSX: integers and flags are not stringified (a string fiscal_year sorted "10" before "2").
  assert.equal(read!.fiscal_year, 2026);
  assert.equal(read!.fiscal_quarter, 2);
  assert.equal(read!.display_order, 1);
  assert.equal(read!.depth, 0);
  assert.equal(read!.preliminary, false);
  assert.equal(read!.is_restatement, false);
  assert.equal(read!.is_derived, true);
  assert.equal(Object.keys(read!).length, POSITION_EXPORT_COLUMNS.length);
});

test("the default column set is unchanged for observation exports", () => {
  const csv = renderExport("csv", [row]).bytes.toString("utf8").split("\r\n");
  assert.ok(csv[0]!.startsWith("observation_id,fund_id,company_id"));
  assert.equal(csv[0]!.split(",").length, 16);
});

test("POSITION_EXPORT_COLUMNS lists exactly the keys the position loader emits (no silently dropped or blank columns)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./export-delivery.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("return rows.map((position) => ({"));
  const emitted = [...block.slice(0, block.indexOf("}));")).matchAll(/^\s{4}([a-z_]+):/gm)].map((match) => match[1]);
  assert.deepEqual(emitted, [...POSITION_EXPORT_COLUMNS]);
});
