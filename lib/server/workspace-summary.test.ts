import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { PostgresProductionPlatform, type PlatformPort } from "./platform.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { workspaceSummary } from "./workspace-summary.ts";

const identity: RequestIdentity = {
  subject: "oidc|allocator-1",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["read_only"],
  authMethod: "oidc",
  sessionId: "session-1",
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    fundIds: ["fund-a"],
    documentIds: ["00000000-0000-0000-0000-000000000101"],
    sourceDocumentIds: [],
    sourceDocumentAccessAllowed: false,
    redistributionAllowed: false,
  },
};

class RollupDb implements PostgresSqlApi {
  calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return [
      { snapshot_id: "s-1", fund_id: "fund-a", fund_name: "Fund A", report_period: "Q2 2026", published_at: new Date("2026-08-01T00:00:00Z"), metric_code: "nav", currency: "USD", total_value: "1250000.50", fact_count: 1 },
      { snapshot_id: "s-1", fund_id: "fund-a", fund_name: "Fund A", report_period: "Q2 2026", published_at: null, metric_code: "unexpected", currency: "USD", total_value: "1", fact_count: 1 },
      { snapshot_id: "s-1", fund_id: "fund-a", fund_name: "Fund A", report_period: "Q2 2026", published_at: null, metric_code: "fair_value", currency: "USD", total_value: "not-a-number", fact_count: 1 },
    ];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("the portfolio value rollup reads only current published versions of entitled funds", async () => {
  const db = new RollupDb();
  const facts = await new PostgresProductionPlatform(db).portfolioValueFacts(identity);
  assert.deepEqual(facts, [{
    snapshotId: "s-1", fundId: "fund-a", fund: "Fund A", period: "Q2 2026", publishedAt: "2026-08-01T00:00:00.000Z",
    metricCode: "nav", subjectLevel: null, currency: "USD", value: 1250000.5, factCount: 1,
  }]);
  const { sql, parameters } = db.calls[0]!;
  assert.deepEqual(parameters, [identity.tenantId, JSON.stringify(identity.entitlements.fundIds)]);
  assert.match(sql, /distinct on \(s\.snapshot_id\)[\s\S]*order by s\.snapshot_id, s\.version desc/);
  assert.match(sql, /cs\.status='published'/);
  assert.match(sql, /f\.metric_code in \('nav','fair_value'\)/);
  assert.match(sql, /conflicting_alternative/);
  assert.match(sql, /s\.fund_id in \(select jsonb_array_elements_text\(\$2::jsonb\)\)/);
  // Breakdown and look-through rows re-slice counted value; they never enter the total.
  assert.match(sql, /where pf\.breakdown_category is null and pf\.lookthrough_source is null/);
  assert.match(sql, /group by[^\n]*pf\.subject_level/);
});

class DimensionDb extends RollupDb {
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return [
      { snapshot_id: "s-1", fund_id: "fund-a", currency: "USD", dimension: "asset_type", subject_level: "holding", category: "common_equity", total_value: "900", fact_count: 3 },
      { snapshot_id: "s-1", fund_id: "fund-a", currency: "USD", dimension: "sector", subject_level: "fund", category: "Healthcare", total_value: "400", fact_count: 1 },
      { snapshot_id: "s-1", fund_id: "fund-a", currency: "USD", dimension: "asset_type", subject_level: "holding", category: null, total_value: "50", fact_count: 1 },
      { snapshot_id: "s-1", fund_id: "fund-a", currency: "USD", dimension: "geography", subject_level: "fund", category: "EU", total_value: "1", fact_count: 1 },
    ];
  }
}

test("the exposure-dimension rollup classifies published fair values by governed instrument type and GP sector", async () => {
  const db = new DimensionDb();
  const facts = await new PostgresProductionPlatform(db).exposureDimensionFacts(identity);
  assert.deepEqual(facts.map((fact) => [fact.dimension, fact.subjectLevel, fact.category, fact.value]), [
    ["asset_type", "holding", "common_equity", 900],
    ["sector", "fund", "Healthcare", 400],
    ["asset_type", "holding", null, 50],
  ]);
  const { sql, parameters } = db.calls[0]!;
  assert.deepEqual(parameters, [identity.tenantId, JSON.stringify(identity.entitlements.fundIds)]);
  assert.match(sql, /cs\.status='published'/);
  assert.match(sql, /from corvis_serving\.instruments i[\s\S]*i\.fund_id in \(select jsonb_array_elements_text\(\$2::jsonb\)\)/);
  assert.match(sql, /count\(distinct i\.instrument_type\)=1 then min\(i\.instrument_type\) else '__mixed__'/);
  assert.match(sql, /lower\(pf\.breakdown_category\) in \('sector','industry'\)/);
  assert.match(sql, /pf\.subject_level='fund'/);
  assert.equal((await new PostgresProductionPlatform(new DimensionDb()).exposureDimensionFacts({ ...identity, entitlements: { ...identity.entitlements, fundIds: [] } })).length, 0);
});

test("the rollup fails closed without a fund entitlement, before any query", async () => {
  const db = new RollupDb();
  const facts = await new PostgresProductionPlatform(db).portfolioValueFacts({ ...identity, entitlements: { ...identity.entitlements, fundIds: [] } });
  assert.deepEqual(facts, []);
  assert.equal(db.calls.length, 0);
});

function fakePlatform(calls: string[]): PlatformPort {
  const record = <T>(name: string, value: T) => async () => { calls.push(name); return value; };
  return {
    listSnapshots: record("snapshots", [{ id: "s-1", fund: "Fund A", period: "Q2 2026", status: "Review" as const, holdings: 1, facts: 1, changed: "now", blockingExceptions: 1 }]),
    listObservations: record("observations", [{ id: "o-1", fund: "Fund A", company: "Co", metric: "Revenue", value: "1", period: "Q2 2026", source: "p. 1", confidence: 90, state: "Needs review" as const, delta: "—" }]),
    listDocuments: record("documents", [{ id: "d-1", name: "R.pdf", fund: "Fund A", period: "Q2 2026", type: "Report", pages: 1, size: "1 KB", status: "Queued" as const, uploaded: "now", quality: "Pending" as const, observations: 0, processingState: "dead_letter" }]),
    portfolioValueFacts: record("values", []),
    exposureDimensionFacts: record("dimensions", []),
  } as unknown as PlatformPort;
}

test("the summary composes the same entitlement-scoped reads and gates sources on admin:manage", async () => {
  const calls: string[] = [];
  let sourceReads = 0;
  const sources = async () => { sourceReads += 1; return [{ sourceConnectionId: "src", connectionLabel: "Room", status: "suspended", consecutiveFailures: 0 }]; };
  const allocator = await workspaceSummary(identity, { platform: fakePlatform(calls), sources, now: new Date("2026-09-25T00:00:00Z") });
  assert.equal(sourceReads, 0);
  assert.deepEqual(calls.sort(), ["dimensions", "documents", "observations", "snapshots", "values"]);
  assert.deepEqual(allocator.attention.counts, { blocking_exception: 1, needs_review: 1, stuck_document: 1, unhealthy_source: 0, total: 3 });

  const admin = await workspaceSummary({ ...identity, roles: ["admin"] }, { platform: fakePlatform([]), sources, now: new Date("2026-09-25T00:00:00Z") });
  assert.equal(sourceReads, 1);
  assert.equal(admin.attention.counts.unhealthy_source, 1);
  assert.equal(admin.attention.counts.total, 4);
});
