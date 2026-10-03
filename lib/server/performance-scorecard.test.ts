import assert from "node:assert/strict";
import test from "node:test";
import { SCORECARD_METRIC_CODES } from "../../core/performance-scorecard.ts";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { performanceScorecard, PostgresPerformanceScorecardRepository, ScorecardTooLargeError, SCORECARD_MAX_FACTS } from "./performance-scorecard.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const DOCUMENT = "22222222-2222-4222-8222-222222222222";

function identity(overrides: Partial<RequestIdentity["entitlements"]> = {}): RequestIdentity {
  return {
    subject: "analyst@example.test",
    tenantId: TENANT,
    workspaceId: "workspace-a",
    roles: ["analyst"],
    entitlements: { workspaceIds: ["workspace-a"], fundIds: ["fund-a", "fund-b"], documentIds: [DOCUMENT], sourceDocumentAccessAllowed: true, ...overrides },
    authMethod: "oidc",
    sessionId: "session-a",
  };
}

type Captured = { sql: string; parameters: unknown[] };

function fakeDb(responses: { funds?: PostgresRow[]; facts?: PostgresRow[] }): { db: PostgresSqlApi; calls: Captured[] } {
  const calls: Captured[] = [];
  const db: PostgresSqlApi = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      return sql.includes("corvis_identity.fund f") ? responses.funds ?? [] : responses.facts ?? [];
    },
    async execute() {},
    async health() { return true; },
  };
  return { db, calls };
}

const FUND_ROWS: PostgresRow[] = [{ fund_id: "fund-a", fund_name: "Alpha Fund" }, { fund_id: "fund-b", fund_name: "fund-b" }];

const FACT_ROW: PostgresRow = {
  fact_id: "fact-1", snapshot_id: "snap-1", published_at: new Date("2026-07-01T00:00:00.000Z"), fund_id: "fund-a", level: "fund",
  investment_key: null, investment_name: null, holding_id: null, company_id: null, metric_code: "nav", value_number: "100.0000000000",
  value_string: null, value_raw: "USD 100m", currency: "USD", unit: "millions", as_of: "2026-06-30", economic_period: "Q2 2026",
  actuality: "actual", scenario_type: "reported", is_restated: false, is_derived: false, derivation_formula: null,
  document_id: DOCUMENT, source_reference_id: "33333333-3333-4333-8333-333333333333", page_number: "12", sheet_name: null, cell_range: null,
};

test("an identity without fund or document entitlements gets an empty scorecard and no query runs", async () => {
  const { db, calls } = fakeDb({});
  const repository = new PostgresPerformanceScorecardRepository(db);
  assert.deepEqual(await repository.load(identity({ fundIds: [] })), { funds: [], facts: [] });
  assert.deepEqual(await repository.load(identity({ documentIds: [] })), { funds: [], facts: [] });
  assert.deepEqual(await repository.load(identity({ fundIds: undefined, documentIds: undefined })), { funds: [], facts: [] });
  assert.equal(calls.length, 0, "fail closed before touching the database");
});

test("the load is tenant-, fund- and document-scoped and reads only current published snapshots", async () => {
  const { db, calls } = fakeDb({ funds: FUND_ROWS, facts: [] });
  const payload = await new PostgresPerformanceScorecardRepository(db).load(identity());
  assert.deepEqual(payload, { funds: [{ fundId: "fund-a", fund: "Alpha Fund" }, { fundId: "fund-b", fund: "fund-b" }], facts: [] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.parameters, [JSON.stringify(["fund-a", "fund-b"])]);
  const { sql, parameters } = calls[1]!;
  assert.deepEqual(parameters, [TENANT, JSON.stringify(["fund-a", "fund-b"]), JSON.stringify([DOCUMENT]), JSON.stringify([...SCORECARD_METRIC_CODES])]);
  assert.match(sql, /order by s\.snapshot_id,s\.version desc/, "the current version of each snapshot");
  assert.match(sql, /cs\.status='published'/, "draft, blocked, withdrawn and superseded versions contribute nothing");
  assert.match(sql, /s\.tenant_id=\$1::uuid/);
  assert.match(sql, /s\.fund_id in \(select jsonb_array_elements_text\(\$2::jsonb\)\)/);
  assert.match(sql, /r\.document_id in \(select entitled\.id::uuid from jsonb_array_elements_text\(\$3::jsonb\)/, "a figure needs an entitled source document");
  assert.match(sql, /f\.metric_code in \(select jsonb_array_elements_text\(\$4::jsonb\)\)/);
  assert.match(sql, /<>'conflicting_alternative'/, "a conflicting alternative is not a reported figure");
  assert.match(sql, /breakdownCategory/);
  assert.match(sql, /lookthroughSource/);
  assert.match(sql, /latest_rank=1/);
  assert.doesNotMatch(sql, /snapshot_id::text in/, "no snapshot restriction unless an export pins one");
  assert.match(sql, new RegExp(`limit ${SCORECARD_MAX_FACTS + 1}`));
});

test("a governed export pins the snapshots it was requested for", async () => {
  const { db, calls } = fakeDb({ funds: FUND_ROWS });
  await new PostgresPerformanceScorecardRepository(db).load(identity(), { snapshotIds: ["snap-1", "snap-2"] });
  const { sql, parameters } = calls[1]!;
  assert.equal(parameters.length, 5);
  assert.equal(parameters[4], JSON.stringify(["snap-1", "snap-2"]));
  assert.match(sql, /s\.snapshot_id::text in \(select jsonb_array_elements_text\(\$5::jsonb\)\)/);
});

test("fact rows map to wire facts: exact decimal text, ISO as-of, source and flags", async () => {
  const investment: PostgresRow = {
    ...FACT_ROW, fact_id: "fact-2", level: "investment", investment_key: "company-1", investment_name: "Acme", holding_id: "holding-1", company_id: "company-1",
    metric_code: "ownership_pct", value_number: "12.5000000000", currency: null, unit: "percent", published_at: "2026-07-02T00:00:00Z",
    page_number: null, sheet_name: "SOI", cell_range: "B4:C4", is_restated: "true", is_derived: true, derivation_formula: "x / y",
    actuality: "preliminary", scenario_type: null, as_of: null, economic_period: "",
  };
  const { db } = fakeDb({ funds: FUND_ROWS, facts: [FACT_ROW, investment, { fact_id: "fact-3", level: "fund", published_at: null, page_number: "n/a", value_number: "" }] });
  const { facts } = await new PostgresPerformanceScorecardRepository(db).load(identity());
  assert.deepEqual(facts[0], {
    factId: "fact-1", snapshotId: "snap-1", publishedAt: "2026-07-01T00:00:00.000Z", fundId: "fund-a", level: "fund", investmentKey: null, investment: null,
    holdingId: null, companyId: null, metricCode: "nav", valueNumber: "100.0000000000", valueString: null, valueRaw: "USD 100m", currency: "USD", unit: "millions",
    asOf: "2026-06-30", period: "Q2 2026", actuality: "actual", scenarioType: "reported", isRestated: false, isDerived: false, derivationFormula: null,
    source: { documentId: DOCUMENT, sourceReferenceId: "33333333-3333-4333-8333-333333333333", page: 12, sheetName: null, cellRange: null },
  });
  assert.deepEqual(
    [facts[1]!.level, facts[1]!.investmentKey, facts[1]!.investment, facts[1]!.holdingId, facts[1]!.companyId, facts[1]!.publishedAt, facts[1]!.asOf, facts[1]!.period, facts[1]!.isRestated, facts[1]!.isDerived, facts[1]!.derivationFormula, facts[1]!.source],
    ["investment", "company-1", "Acme", "holding-1", "company-1", "2026-07-02T00:00:00Z", null, "", true, true, "x / y", { documentId: DOCUMENT, sourceReferenceId: "33333333-3333-4333-8333-333333333333", page: null, sheetName: "SOI", cellRange: "B4:C4" }],
  );
  assert.deepEqual([facts[2]!.publishedAt, facts[2]!.valueNumber, facts[2]!.source.page, facts[2]!.level], [null, null, null, "fund"]);
});

test("a level other than fund is an investment, and an empty result has no facts", async () => {
  const { db } = fakeDb({ funds: [], facts: [{ ...FACT_ROW, level: "holding", metric_code: "cost" }] });
  const { facts, funds } = await new PostgresPerformanceScorecardRepository(db).load(identity());
  assert.deepEqual(funds, []);
  assert.equal(facts[0]!.level, "investment");
});

test("a result larger than the supported size fails instead of silently dropping figures", async () => {
  const rows = Array.from({ length: SCORECARD_MAX_FACTS + 1 }, (_, index) => ({ ...FACT_ROW, fact_id: `fact-${index}` }));
  const { db } = fakeDb({ funds: FUND_ROWS, facts: rows });
  await assert.rejects(new PostgresPerformanceScorecardRepository(db).load(identity()), (error) => {
    assert.ok(error instanceof ScorecardTooLargeError);
    assert.equal(error.code, "performance_scorecard_too_large");
    assert.match(error.message, /more than 50000 reported figures/);
    return true;
  });
  const exactlyAtTheCap = fakeDb({ funds: FUND_ROWS, facts: rows.slice(0, SCORECARD_MAX_FACTS) });
  assert.equal((await new PostgresPerformanceScorecardRepository(exactlyAtTheCap.db).load(identity())).facts.length, SCORECARD_MAX_FACTS);
});

test("performanceScorecard returns one repository per process", () => {
  const first = performanceScorecard("postgres://scorecard-test.invalid/db");
  assert.ok(first instanceof PostgresPerformanceScorecardRepository);
  assert.equal(performanceScorecard("postgres://other.invalid/db"), first);
});
