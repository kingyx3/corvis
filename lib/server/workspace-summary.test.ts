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
    metricCode: "nav", currency: "USD", value: 1250000.5, factCount: 1,
  }]);
  const { sql, parameters } = db.calls[0]!;
  assert.deepEqual(parameters, [identity.tenantId, JSON.stringify(identity.entitlements.fundIds)]);
  assert.match(sql, /distinct on \(s\.snapshot_id\)[\s\S]*order by s\.snapshot_id, s\.version desc/);
  assert.match(sql, /cs\.status='published'/);
  assert.match(sql, /f\.metric_code in \('nav','fair_value'\)/);
  assert.match(sql, /conflicting_alternative/);
  assert.match(sql, /s\.fund_id in \(select jsonb_array_elements_text\(\$2::jsonb\)\)/);
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
  } as unknown as PlatformPort;
}

test("the summary composes the same entitlement-scoped reads and gates sources on admin:manage", async () => {
  const calls: string[] = [];
  let sourceReads = 0;
  const sources = async () => { sourceReads += 1; return [{ sourceConnectionId: "src", connectionLabel: "Room", status: "suspended", consecutiveFailures: 0 }]; };
  const allocator = await workspaceSummary(identity, { platform: fakePlatform(calls), sources, now: new Date("2026-09-25T00:00:00Z") });
  assert.equal(sourceReads, 0);
  assert.deepEqual(calls.sort(), ["documents", "observations", "snapshots", "values"]);
  assert.deepEqual(allocator.attention.counts, { blocking_exception: 1, needs_review: 1, stuck_document: 1, unhealthy_source: 0, total: 3 });

  const admin = await workspaceSummary({ ...identity, roles: ["admin"] }, { platform: fakePlatform([]), sources, now: new Date("2026-09-25T00:00:00Z") });
  assert.equal(sourceReads, 1);
  assert.equal(admin.attention.counts.unhealthy_source, 1);
  assert.equal(admin.attention.counts.total, 4);
});
