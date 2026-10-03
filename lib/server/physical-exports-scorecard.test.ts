import assert from "node:assert/strict";
import test from "node:test";
import type { ExportScope } from "../../core/delivery.ts";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { createPhysicalExport, exportObjectKey, exportStatusFromJob, positionFinancialSnapshots, redeemPhysicalExportGrant } from "./physical-exports.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

class FakeDb implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  private readonly rowsFor: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[];
  constructor(rowsFor: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[]) { this.rowsFor = rowsFor; }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    return this.rowsFor(sql, parameters);
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.queries.push({ sql, parameters }); }
  async health(): Promise<boolean> { return true; }
}

const DOC = "22222222-2222-4222-8222-222222222222";
const identity: RequestIdentity = {
  subject: "user-1",
  tenantId: "tenant-1",
  workspaceId: "workspace-1",
  roles: ["analyst"],
  authMethod: "oidc",
  sessionId: "session-1",
  entitlements: { workspaceIds: ["workspace-1"], fundIds: ["fund-a", "fund-b"], documentIds: [DOC], sourceDocumentAccessAllowed: true, redistributionAllowed: true },
};

function scorecardFact(overrides: PostgresRow = {}): PostgresRow {
  return {
    fact_id: "fact-1", snapshot_id: "snap-a", published_at: "2026-07-01T00:00:00.000Z", fund_id: "fund-a", level: "fund", metric_code: "nav",
    value_number: "100", currency: "USD", as_of: "2026-06-30", economic_period: "Q2 2026", actuality: "actual", is_restated: false, is_derived: false,
    document_id: DOC, source_reference_id: "ref-1", page_number: 4, ...overrides,
  };
}

const AuthorizationFailure = (error: unknown) => error instanceof Error && error.name === "AuthorizationError";

test("a performance scorecard export persists its scope and label, counts its rows and pins the published snapshots behind the shown figures", async () => {
  const db = new FakeDb((sql, parameters) => {
    if (sql.includes("corvis_identity.fund f")) return [{ fund_id: "fund-a", fund_name: "Alpha" }, { fund_id: "fund-b", fund_name: "Beta" }];
    if (sql.includes("with current_snapshot")) return [scorecardFact()];
    if (sql.includes("from corvis_serving.fund_period_snapshots")) {
      assert.deepEqual(parameters, [identity.tenantId, JSON.stringify(["fund-a", "fund-b"]), JSON.stringify(["snap-a"])]);
      return [{ snapshot_id: "snap-a", fund_id: "fund-a", version: 2 }];
    }
    assert.doesNotMatch(sql, /corvis_serving\.observations/, "the observation row-count preview is not part of a scorecard export");
    return [];
  });
  const scope: ExportScope = { performanceScorecard: true };
  const manifest = await createPhysicalExport(identity, "csv", { scope, source: "delivery" }, db);
  const governed = manifest as typeof manifest & { scope?: ExportScope; scopeLabel?: string };
  assert.deepEqual(manifest.snapshotIds, ["snap-a"]);
  assert.deepEqual(manifest.rowCounts, { performanceScorecard: 12, snapshots: 1 });
  assert.deepEqual(governed.scope, scope);
  assert.equal(governed.scopeLabel, "Performance scorecard · all entitled funds");
  assert.equal(manifest.schemaVersion, "v1", "a snapshot row without versions falls back to v1");
  assert.deepEqual(manifest.snapshotState, [{ snapshotId: "snap-a", version: 2, openExceptionCount: 0 }]);
});

test("a scorecard export with nothing reported fails closed", async () => {
  const db = new FakeDb((sql) => sql.includes("corvis_identity.fund f") ? [{ fund_id: "fund-a", fund_name: "Alpha" }] : []);
  await assert.rejects(createPhysicalExport(identity, "csv", { scope: { performanceScorecard: true } }, db), AuthorizationFailure);
});

test("a Position Financials export attributed to a client portfolio carries the portfolio in its label and its snapshot lookup", async () => {
  let snapshotParameters: PostgresPrimitive[] = [];
  const db = new FakeDb((sql, parameters) => {
    if (sql.includes("select v.*") && sql.includes("position_financial_statement_values")) return [{ statement_id: "s", document_id: "doc-1", fund_id: "fund-a", holding_id: "holding-1", company_id: "company-1", value_id: "v", value_number: "1" }];
    if (sql.includes("select distinct ps.snapshot_id")) {
      snapshotParameters = parameters;
      assert.match(sql, /pa\.portfolio_id::text=\$8/);
      return [{ snapshot_id: "snap-a", schema_version: "v2", taxonomy_version: "v3", fund_id: "fund-a", version: 1 }];
    }
    return [];
  });
  const scope: ExportScope = { positionFinancials: { fundId: "fund-a", holdingId: "holding-1", companyId: "company-1", periodicity: "reported", portfolioId: "portfolio-9" } };
  const manifest = await createPhysicalExport(identity, "csv", { scope }, db) as { scopeLabel?: string; snapshotState?: Array<{ openExceptionCount: number }> };
  assert.match(manifest.scopeLabel ?? "", /reported · portfolio portfolio-9/);
  assert.equal(snapshotParameters[7], "portfolio-9");
  assert.equal(manifest.snapshotState?.[0]?.openExceptionCount, 0, "a snapshot row with no exception count reports none");
});

test("the position snapshot lookup refuses a fund or document the caller is not entitled to, even if reached directly", async () => {
  const db = new FakeDb(() => { throw new Error("must not query"); });
  const scope = { positionFinancials: { fundId: "fund-z", holdingId: "h", companyId: "c", periodicity: "annual" as const } };
  assert.deepEqual(await positionFinancialSnapshots(identity, scope, db), []);
  assert.deepEqual(await positionFinancialSnapshots({ ...identity, entitlements: { ...identity.entitlements, documentIds: [] } }, { positionFinancials: { ...scope.positionFinancials, fundId: "fund-a" } }, db), []);
  assert.deepEqual(await positionFinancialSnapshots({ ...identity, entitlements: { ...identity.entitlements, fundIds: undefined, documentIds: undefined } }, scope, db), []);
});

test("export status normalizes timestamps, falls back to the manifest's snapshots and omits an absent checksum", async () => {
  const db = new FakeDb(() => [{ snapshot_count: 1 }]);
  const manifest = { snapshotIds: ["snap-a"], artifact: { fundIds: ["fund-a"], documentIds: [DOC] } };
  const status = await exportStatusFromJob(identity, { export_id: "e", format: "csv", state: "complete", manifest, created_at: new Date("2026-09-01T00:00:00Z"), completed_at: new Date("2026-09-01T01:00:00Z"), expires_at: new Date(Date.now() + 3_600_000) }, db);
  assert.equal(status.createdAt, "2026-09-01T00:00:00.000Z");
  assert.equal(status.checksumSha256, undefined);
  assert.equal(status.downloadAvailable, true);
  assert.deepEqual(db.queries[0]!.parameters[1], JSON.stringify(["snap-a"]));
});

test("an artifact is not downloadable when the caller's current entitlements no longer cover its funds or documents", async () => {
  const db = new FakeDb(() => []);
  const row = (artifact: unknown): PostgresRow => ({ export_id: "e", format: "csv", state: "complete", snapshot_ids: [], manifest: { snapshotIds: [], artifact } });
  const none = { ...identity, entitlements: { ...identity.entitlements, fundIds: undefined } };
  await assert.rejects(exportStatusFromJob(none, row({ fundIds: ["fund-a"], documentIds: [] }), db), AuthorizationFailure);
  assert.equal((await exportStatusFromJob(none, row({ fundIds: [], documentIds: [] }), db)).exportId, "e");
});

test("an export without an artifact re-checks the caller's funds and snapshot currency", async () => {
  const row: PostgresRow = { export_id: "e", format: "csv", state: "queued", snapshot_ids: ["snap-a"], manifest: { snapshotIds: ["snap-a"] } };
  const noFunds = { ...identity, entitlements: { ...identity.entitlements, fundIds: undefined } };
  await assert.rejects(exportStatusFromJob(noFunds, row, new FakeDb(() => [])), AuthorizationFailure);
  await assert.rejects(exportStatusFromJob(identity, row, new FakeDb(() => [])), AuthorizationFailure, "an empty answer counts as no current snapshots");
  assert.equal((await exportStatusFromJob(identity, row, new FakeDb(() => [{ snapshot_count: 1 }]))).state, "queued");
});

test("redeeming a grant falls back to the manifest's snapshots when the job row carries none", async () => {
  const db = new FakeDb((sql) => sql.startsWith("update corvis_serving.export_download_grant")
    ? [{ object_uri: "gs://b/exports/t/e/attempt-1/observations.csv", format: "csv", checksum_sha256: "a".repeat(64), manifest: { snapshotIds: [], artifact: { fundIds: ["fund-a"], documentIds: [DOC] } } }]
    : []);
  assert.equal((await redeemPhysicalExportGrant(identity, "00000000-0000-4000-8000-000000000001", "token", db))?.checksumSha256, "a".repeat(64));
});

test("exportObjectKey accepts only keys under exports/ in the configured bucket", () => {
  const previous = process.env.CORVIS_OBJECT_STORE_BUCKET;
  try {
    delete process.env.CORVIS_OBJECT_STORE_BUCKET;
    assert.throws(() => exportObjectKey("gs:///exports/a.csv"), /invalid_export_object_uri/);
    process.env.CORVIS_OBJECT_STORE_BUCKET = "bucket";
    assert.equal(exportObjectKey("gs://bucket/exports/t/e/observations.csv"), "exports/t/e/observations.csv");
    for (const uri of ["gs://other/exports/a.csv", "gs://bucket/uploads/a.csv", "gs://bucket/exports/../secrets"]) assert.throws(() => exportObjectKey(uri), /invalid_export_object_uri/, uri);
  } finally {
    if (previous === undefined) delete process.env.CORVIS_OBJECT_STORE_BUCKET; else process.env.CORVIS_OBJECT_STORE_BUCKET = previous;
  }
});
