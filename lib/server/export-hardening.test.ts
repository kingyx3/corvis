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
  renderCsv,
  renderExport,
  renderParquet,
  renderXlsx,
  type ExportRow,
} from "./export-renderer.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

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
  twosComplement.writeBigUInt64BE(BigInt.asUintN(128, unscaled) >> 64n, 0);
  twosComplement.writeBigUInt64BE(BigInt.asUintN(128, unscaled) & 0xffff_ffff_ffff_ffffn, 8);
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
