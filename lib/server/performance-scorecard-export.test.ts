import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { SCORECARD_EXPORT_COLUMNS } from "../../core/performance-scorecard.ts";
import { EXPORT_MAX_ROWS, ExportRowLimitError } from "./export-renderer.ts";
import { loadScorecardExportRows, performanceScorecardScope, resolveScorecardExport, SCORECARD_EXPORT_LABEL } from "./performance-scorecard-export.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";

const identity: RequestIdentity = {
  subject: "analyst@example.test",
  tenantId: TENANT,
  workspaceId: "workspace-a",
  roles: ["analyst"],
  authMethod: "oidc",
  sessionId: "session-a",
  entitlements: { workspaceIds: ["workspace-a"], fundIds: ["fund-a", "fund-b"], documentIds: ["22222222-2222-4222-8222-222222222222"], sourceDocumentAccessAllowed: true, redistributionAllowed: true },
};

function factRow(overrides: PostgresRow = {}): PostgresRow {
  return {
    fact_id: "fact-1", snapshot_id: "snap-1", published_at: "2026-07-01T00:00:00.000Z", fund_id: "fund-a", level: "fund", metric_code: "nav",
    value_number: "100.0000000000", currency: "USD", unit: null, as_of: "2026-06-30", economic_period: "Q2 2026", actuality: "actual",
    is_restated: false, is_derived: false, document_id: "doc-1", source_reference_id: "ref-1", page_number: 4, ...overrides,
  };
}

function fakeDb(facts: PostgresRow[], snapshots: PostgresRow[] = []): { db: PostgresSqlApi; calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> } {
  const calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  const db: PostgresSqlApi = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes("corvis_identity.fund f")) return [{ fund_id: "fund-a", fund_name: "Alpha" }, { fund_id: "fund-b", fund_name: "Beta" }];
      if (sql.includes("fund_period_snapshots")) return snapshots;
      return facts;
    },
    async execute() {},
    async health() { return true; },
  };
  return { db, calls };
}

test("performanceScorecardScope accepts only the object `performanceScorecard: true`", () => {
  assert.deepEqual(performanceScorecardScope({ performanceScorecard: true }), { performanceScorecard: true });
  assert.deepEqual(performanceScorecardScope({ performanceScorecard: true, extra: 1 }), { performanceScorecard: true });
  for (const value of [undefined, null, "performanceScorecard", 7, [], {}, { performanceScorecard: false }, { performanceScorecard: "true" }, { performanceScorecard: 1 }, { snapshotId: "s" }]) {
    assert.equal(performanceScorecardScope(value), undefined, JSON.stringify(value));
  }
  assert.match(SCORECARD_EXPORT_LABEL, /^Performance scorecard/);
});

test("resolving a scorecard export pins it to the current published snapshots behind the shown figures", async () => {
  const { db, calls } = fakeDb(
    [factRow(), factRow({ fact_id: "fact-2", snapshot_id: "snap-2", metric_code: "tvpi", value_number: "1.5", currency: null }), factRow({ fact_id: "fact-3", snapshot_id: "snap-old", as_of: "2026-03-31" })],
    [{ snapshot_id: "snap-1", schema_version: "v2", taxonomy_version: "v3", fund_id: "fund-a", version: 3, blocking_exception_count: 0 }, { snapshot_id: "snap-2", fund_id: "fund-a", version: 1 }],
  );
  const resolved = await resolveScorecardExport(identity, db);
  assert.equal(resolved.snapshots.length, 2);
  // 2 funds x 6 fund metrics; Alpha reports NAV and TVPI, every other metric is an explicit Not reported row.
  assert.equal(resolved.rowCount, 12);
  const snapshotQuery = calls.find((call) => call.sql.includes("fund_period_snapshots"))!;
  assert.deepEqual(snapshotQuery.parameters, [TENANT, JSON.stringify(["fund-a", "fund-b"]), JSON.stringify(["snap-1", "snap-2"])]);
  assert.match(snapshotQuery.sql, /s\.status='published'/);
  assert.match(snapshotQuery.sql, /newer\.version>s\.version/, "only the current version of each snapshot");
  assert.match(snapshotQuery.sql, /s\.snapshot_id::text in \(select jsonb_array_elements_text\(\$3::jsonb\)\)/);
});

test("a scorecard with no reported figure resolves to nothing and is refused instead of exporting an empty file", async () => {
  const { db, calls } = fakeDb([]);
  await assert.rejects(resolveScorecardExport(identity, db), (error: unknown) => error instanceof Error && error.name === "AuthorizationError");
  assert.equal(calls.some((call) => call.sql.includes("fund_period_snapshots")), false, "no snapshot lookup once nothing is reported");
  const unentitled = fakeDb([factRow()]);
  await assert.rejects(resolveScorecardExport({ ...identity, entitlements: { ...identity.entitlements, fundIds: [] } }, unentitled.db), (error: unknown) => error instanceof Error && error.name === "AuthorizationError");
});

test("delivery rebuilds the scorecard from only the pinned snapshots and emits exactly the export columns", async () => {
  const { db, calls } = fakeDb([factRow(), factRow({ fact_id: "fact-2", snapshot_id: "snap-2", metric_code: "dpi", value_number: "0.4", currency: null })]);
  const rows = await loadScorecardExportRows(identity, ["snap-1", "snap-2"], db);
  assert.equal(rows.length, 12);
  for (const row of rows) assert.deepEqual(Object.keys(row), [...SCORECARD_EXPORT_COLUMNS]);
  const nav = rows.find((row) => row.fund_id === "fund-a" && row.metric_code === "nav")!;
  assert.deepEqual([nav.status, nav.value_number, nav.document_id, nav.source_reference_id, nav.source_page, nav.as_of_date], ["Final", "100.0000000000", "doc-1", "ref-1", 4, "2026-06-30"]);
  assert.equal(rows.find((row) => row.fund_id === "fund-b" && row.metric_code === "nav")!.status, "Not reported");
  const factsQuery = calls.find((call) => call.sql.includes("with current_snapshot"))!;
  assert.equal(factsQuery.parameters[4], JSON.stringify(["snap-1", "snap-2"]), "the snapshot pin reaches the query");
});

test("delivery fails when a pinned snapshot no longer contributes (withdrawn, superseded or no longer entitled)", async () => {
  const one = fakeDb([factRow()]);
  await assert.rejects(loadScorecardExportRows(identity, ["snap-1", "snap-2"], one.db), /export_snapshot_authorization_expired/);
  const none = fakeDb([]);
  await assert.rejects(loadScorecardExportRows(identity, ["snap-1"], none.db), /export_snapshot_authorization_expired/);
  await assert.rejects(loadScorecardExportRows(identity, [], one.db), /export_snapshot_authorization_expired/);
});

test("a scorecard larger than the export row cap fails with the typed row-limit error (each investment is one row per metric)", async () => {
  const facts = Array.from({ length: Math.ceil((EXPORT_MAX_ROWS + 1) / 5) }, (_, index) => factRow({
    fact_id: `fact-${index}`, level: "investment", investment_key: `co-${index}`, investment_name: `Co ${index}`, company_id: `co-${index}`, metric_code: "cost",
  }));
  const { db } = fakeDb(facts);
  await assert.rejects(loadScorecardExportRows(identity, ["snap-1"], db), (error: unknown) => error instanceof ExportRowLimitError);
});
