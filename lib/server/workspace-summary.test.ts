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
  assert.match(sql, /left join corvis_serving\.company_sectors cs[\s\S]*cs\.company_id=case when pf\.subject_level='holding' and h\.target_type='company' then h\.target_company_id else held\.company_id end/);
  assert.match(sql, /alias\.alias_normalized=corvis_semantic\.normalize_sector_label\(pf\.breakdown_value\)/);
  assert.match(sql, /alias\.taxonomy_version='corvis_sector_v1'/);
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

test("the summary composes customer-safe source health and per-user personalization for non-admin callers", async () => {
  const calls: string[] = [];
  let sourceReads = 0;
  const sourceHealth = async () => {
    sourceReads += 1;
    return [{
      sourceConnectionId: "src",
      connectionLabel: "Room",
      status: "suspended",
      health: "action_required" as const,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      fundIds: ["fund-a"],
    }];
  };
  const personalization = async () => ({ pinnedFundIds: ["fund-a"], lastSeenAt: null });
  const allocator = await workspaceSummary(identity, { platform: fakePlatform(calls), sourceHealth, personalization, now: new Date("2026-09-25T00:00:00Z") });
  assert.equal(sourceReads, 1);
  assert.deepEqual(calls.sort(), ["dimensions", "documents", "observations", "snapshots", "values"]);
  assert.deepEqual(allocator.attention.counts, { blocking_exception: 1, needs_review: 1, stuck_document: 1, unhealthy_source: 1, total: 4 });
  assert.deepEqual(allocator.personalization, { pinnedFundIds: ["fund-a"] });
  assert.deepEqual(allocator.sourceHealth.map((row) => [row.connectionLabel, row.health]), [["Room", "action_required"]]);
  assert.deepEqual(allocator.digest, { since: null, items: [], newPublishes: 0, exceptionChanges: 0, valueDeltas: 0 });
});

test("Overview attention counts use the SQL aggregates when the platform offers them, not the capped lists", async () => {
  const seen: Array<{ includeDocuments: boolean }> = [];
  const platform = {
    listSnapshots: async () => [],
    listObservations: async () => [],
    listDocuments: async () => [],
    portfolioValueFacts: async () => [],
    exposureDimensionFacts: async () => [],
    attentionAggregates: async (_identity: RequestIdentity, options: { includeDocuments: boolean }) => {
      seen.push(options);
      return {
        needsReview: [{ fund: "Fund A", count: 7000, observationId: "o-oldest", company: "Old Co", metric: "Revenue" }],
        stuckDocuments: [],
        stuckDocumentTotal: 3,
      };
    },
  } as unknown as PlatformPort;
  const result = await workspaceSummary(identity, {
    platform, sourceHealth: async () => [], personalization: async () => ({ pinnedFundIds: [], lastSeenAt: null }), now: new Date("2026-09-25T00:00:00Z"),
  });
  assert.equal(result.attention.counts.needs_review, 7000, "beyond the 5000-row observation list cap");
  assert.equal(result.attention.counts.stuck_document, 3);
  assert.deepEqual(seen, [{ includeDocuments: true }], "document attention follows the caller documents:read permission");
});

test("the attention aggregate queries are entitlement-scoped, unbounded by list caps and mirror the isStuck rule", async () => {
  const calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  const db: PostgresSqlApi = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes("corvis_serving.observations")) {
        return [
          { fund_id: "fund-a", fund_name: "Fund A", review_count: "5001", observation_id: "o-1", company_id: "c-1", company_name: "Co", metric_code: "revenue" },
          { fund_id: "fund-b", fund_name: "Fund A", review_count: "2", observation_id: "o-2", company_id: "c-2", company_name: "Co2", metric_code: "ebitda" },
        ];
      }
      return [{ document_id: "d-1", display_name: "Old.pdf", status: "queued", processing_state: "failed", processing_updated_at: new Date("2026-01-01T00:00:00Z"), stuck_total: "51" }];
    },
    async execute() {},
    async health() { return true; },
  };
  const aggregates = await new PostgresProductionPlatform(db).attentionAggregates!(identity, { includeDocuments: true });
  assert.deepEqual(aggregates.needsReview, [{ fund: "Fund A", count: 5003, observationId: "o-1", company: "Co", metric: "revenue" }]);
  assert.equal(aggregates.stuckDocumentTotal, 51);
  assert.equal(aggregates.stuckDocuments[0]!.processingState, "failed");
  const [observationsCall, documentsCall] = calls;
  assert.doesNotMatch(observationsCall!.sql, /limit\s+\d+/i, "counts must not be capped");
  assert.match(observationsCall!.sql, /count\(\*\) over \(partition by o\.fund_id,o\.economic_period\)/);
  assert.match(observationsCall!.sql, /not in \('approved','rejected'\)/);
  assert.match(observationsCall!.sql, /o\.fund_id in \(select jsonb_array_elements_text\(\$2::jsonb\)\)/);
  assert.match(documentsCall!.sql, /count\(\*\) over \(\) as stuck_total/);
  assert.match(documentsCall!.sql, /in \('blocked','failed','dead_letter'\)/);
  assert.match(documentsCall!.sql, /d\.document_id in \(select entitled\.id::uuid from jsonb_array_elements_text\(\$2::jsonb\)/);

  calls.length = 0;
  const withoutDocuments = await new PostgresProductionPlatform(db).attentionAggregates!(identity, { includeDocuments: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(withoutDocuments.stuckDocuments, []);
  assert.equal(withoutDocuments.stuckDocumentTotal, 0);
});

test("the needs-review aggregate groups by fund-period so a fund with two review periods yields two items", async () => {
  const db: PostgresSqlApi = {
    async query(sql) {
      if (sql.includes("corvis_serving.observations")) {
        assert.match(sql, /count\(\*\) over \(partition by o\.fund_id,o\.economic_period\)/);
        assert.match(sql, /row_number\(\) over \(partition by o\.fund_id,o\.economic_period /);
        return [
          { fund_id: "fund-a", fund_name: "Fund A", economic_period: "Q1 2026", review_count: "1", observation_id: "o-q1", company_id: "c-1", company_name: "Co", metric_code: "revenue" },
          { fund_id: "fund-a", fund_name: "Fund A", economic_period: "Q2 2026", review_count: "2", observation_id: "o-q2", company_id: "c-1", company_name: "Co", metric_code: "revenue" },
        ];
      }
      return [];
    },
    async execute() {},
    async health() { return true; },
  };
  const aggregates = await new PostgresProductionPlatform(db).attentionAggregates!(identity, { includeDocuments: false });
  assert.deepEqual(aggregates.needsReview, [
    { fund: "Fund A", period: "Q1 2026", count: 1, observationId: "o-q1", company: "Co", metric: "revenue" },
    { fund: "Fund A", period: "Q2 2026", count: 2, observationId: "o-q2", company: "Co", metric: "revenue" },
  ]);
});
