import assert from "node:assert/strict";
import test from "node:test";
import { SCORECARD_METRIC_CODES } from "../domain/performance-scorecard.ts";
import { AuthorizationError, type RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { InvalidCursorError, encodeCursor } from "../../../platform/http/api/pagination.ts";
import {
  fundsAfterCursor,
  nextFundCursor,
  performanceScorecard,
  PostgresPerformanceScorecardRepository,
  SCORECARD_DEFAULT_PAGE_FUNDS,
  SCORECARD_MAX_FACTS,
  SCORECARD_MAX_PAGE_FUNDS,
  scorecardPageSize,
  ScorecardTooLargeError,
} from "./performance-scorecard.ts";
import type { PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";

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
  const { db } = fakeDb({ funds: FUND_ROWS, facts: [{ ...FACT_ROW, level: "holding", metric_code: "cost" }] });
  const { facts } = await new PostgresPerformanceScorecardRepository(db).load(identity());
  assert.equal(facts[0]!.level, "investment");
  const empty = fakeDb({ funds: [], facts: [{ ...FACT_ROW }] });
  assert.deepEqual(await new PostgresPerformanceScorecardRepository(empty.db).load(identity()), { funds: [], facts: [] }, "no entitled fund row, no facts read");
});

test("a single fund above the figure cap fails instead of silently dropping figures", async () => {
  const rows = Array.from({ length: SCORECARD_MAX_FACTS + 1 }, (_, index) => ({ ...FACT_ROW, fact_id: `fact-${index}` }));
  const { db } = fakeDb({ funds: [FUND_ROWS[0]!], facts: rows });
  await assert.rejects(new PostgresPerformanceScorecardRepository(db).load(identity({ fundIds: ["fund-a"] })), (error) => {
    assert.ok(error instanceof ScorecardTooLargeError);
    assert.equal(error.code, "performance_scorecard_too_large");
    assert.match(error.message, /single fund .* more than 50000 reported figures/);
    return true;
  });
  const exactlyAtTheCap = fakeDb({ funds: [FUND_ROWS[0]!], facts: rows.slice(0, SCORECARD_MAX_FACTS) });
  assert.equal((await new PostgresPerformanceScorecardRepository(exactlyAtTheCap.db).load(identity({ fundIds: ["fund-a"] }))).facts.length, SCORECARD_MAX_FACTS);
});

test("performanceScorecard returns one repository per process", () => {
  const first = performanceScorecard("postgres://scorecard-test.invalid/db");
  assert.ok(first instanceof PostgresPerformanceScorecardRepository);
  assert.equal(performanceScorecard("postgres://other.invalid/db"), first);
});

// ---------------------------------------------------------------------------------------------
// F1c: keyset paging by fund, filters and the large-tenant guarantee
// ---------------------------------------------------------------------------------------------

const FOUR_FUNDS: PostgresRow[] = [
  { fund_id: "fund-d", fund_name: "Delta" }, { fund_id: "fund-a", fund_name: "Alpha" }, { fund_id: "fund-c", fund_name: "Charlie" }, { fund_id: "fund-b", fund_name: "Bravo" },
];

/** A database whose facts are generated per requested fund: `perFund` rows for each fund the query names. */
function perFundDb(perFund: number, funds: PostgresRow[] = FOUR_FUNDS, periods: PostgresRow[] = []): { db: PostgresSqlApi; calls: Captured[]; factCalls: () => Captured[] } {
  const calls: Captured[] = [];
  const db: PostgresSqlApi = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes("corvis_identity.fund f")) return funds;
      if (sql.includes("group by 1")) return periods;
      const requested = JSON.parse(String(parameters[1])) as string[];
      return requested.flatMap((fundId) => Array.from({ length: perFund }, (_, index) => ({ ...FACT_ROW, fact_id: `${fundId}-${index}`, fund_id: fundId })));
    },
    async execute() {},
    async health() { return true; },
  };
  return { db, calls, factCalls: () => calls.filter((call) => call.sql.includes("from ranked_fact")) };
}

const repositoryOf = (db: PostgresSqlApi) => new PostgresPerformanceScorecardRepository(db);
const fourFunds = () => identity({ fundIds: ["fund-a", "fund-b", "fund-c", "fund-d"] });

test("funds are paged by keyset in scorecard order, each fund whole, and the pages cover every fund exactly once", async () => {
  const { db, factCalls } = perFundDb(2);
  const first = await repositoryOf(db).loadPage(fourFunds(), {}, { limit: 3 });
  assert.deepEqual(first.payload.funds.map((fund) => fund.fundId), ["fund-a", "fund-b", "fund-c"], "name order, not entitlement order");
  assert.deepEqual(first.payload.facts.map((fact) => fact.fundId), ["fund-a", "fund-a", "fund-b", "fund-b", "fund-c", "fund-c"]);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.fundOptions.map((fund) => fund.fundId), ["fund-a", "fund-b", "fund-c", "fund-d"], "every entitled fund is offered whatever the page");
  assert.deepEqual(first.periodOptions, [], "periods only when asked for");
  const second = await repositoryOf(db).loadPage(fourFunds(), {}, { cursor: first.nextCursor, limit: 3 });
  assert.deepEqual(second.payload.funds.map((fund) => fund.fundId), ["fund-d"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(factCalls().map((call) => JSON.parse(String(call.parameters[1]))), [["fund-a", "fund-b", "fund-c"], ["fund-d"]], "a page reads only its own funds");
});

test("a tenant above the figure cap still loads: an oversized page is halved, never truncated, and every figure arrives", async () => {
  // 4 funds x 30,000 figures = 120,000 (above the 50,000 cap); any two funds together are 60,000 and do not fit one read.
  const { db, factCalls } = perFundDb(30_000);
  const page = await repositoryOf(db).loadPage(fourFunds(), {}, { limit: 4 });
  assert.deepEqual(page.payload.funds.map((fund) => fund.fundId), ["fund-a"], "four funds -> two -> one fund fits");
  assert.equal(page.payload.facts.length, 30_000);
  assert.ok(page.nextCursor, "the rest is reachable");
  assert.deepEqual(factCalls().map((call) => (JSON.parse(String(call.parameters[1])) as string[]).length), [4, 2, 1]);

  const everything = await repositoryOf(perFundDb(30_000).db).load(fourFunds());
  assert.equal(everything.facts.length, 120_000, "the whole tenant loads, page by page, with no figure dropped");
  assert.deepEqual(everything.funds.map((fund) => fund.fundId), ["fund-a", "fund-b", "fund-c", "fund-d"]);
});

test("one fund above the cap cannot be split and fails loudly (never a truncated, falsely 'Not reported' scorecard)", async () => {
  const { db } = perFundDb(SCORECARD_MAX_FACTS + 1);
  await assert.rejects(repositoryOf(db).loadPage(fourFunds(), {}, { limit: 4 }), ScorecardTooLargeError);
});

test("a fund filter narrows the page to that fund, and a fund the caller is not entitled to is refused before anything is read", async () => {
  const { db, calls, factCalls } = perFundDb(1);
  const page = await repositoryOf(db).loadPage(fourFunds(), { fundId: "fund-c" }, {});
  assert.deepEqual(page.payload.funds.map((fund) => fund.fundId), ["fund-c"]);
  assert.deepEqual(JSON.parse(String(factCalls()[0]!.parameters[1])), ["fund-c"]);
  assert.equal(page.fundOptions.length, 4, "the filter does not shrink the options");
  const before = calls.length;
  await assert.rejects(repositoryOf(db).loadPage(fourFunds(), { fundId: "fund-z" }, {}), (error) => error instanceof AuthorizationError && error.requiredPermission === "performance_scorecard:fund");
  await assert.rejects(repositoryOf(db).load(fourFunds(), { fundId: "fund-z" }), AuthorizationError);
  assert.equal(calls.length, before, "no query for a fund outside the entitlement");
});

test("a period filter is applied before the latest figure is chosen, as a parameter, never interpolated", async () => {
  const { db, factCalls } = perFundDb(1);
  await repositoryOf(db).loadPage(fourFunds(), { period: "Q1 2026; drop table x" }, {});
  const { sql, parameters } = factCalls()[0]!;
  assert.equal(parameters.length, 5);
  assert.equal(parameters[4], "Q1 2026; drop table x");
  assert.match(sql, /coalesce\(nullif\(f\.economic_period,''\),cs\.report_period\)=\$5/);
  assert.doesNotMatch(sql, /drop table/);
  assert.ok(sql.indexOf("=$5") < sql.indexOf("ranked_fact"), "the period narrows the candidates before row_number picks the latest");
  const both = perFundDb(1);
  await repositoryOf(both.db).load(fourFunds(), { period: "Q1 2026", snapshotIds: ["snap-1"] });
  const pinned = both.factCalls().at(-1)!;
  assert.deepEqual(pinned.parameters.slice(4), [JSON.stringify(["snap-1"]), "Q1 2026"], "snapshot pin, then period");
  assert.match(pinned.sql, /snapshot_id::text in \(select jsonb_array_elements_text\(\$5::jsonb\)\)/);
  assert.match(pinned.sql, /report_period\)=\$6/);
});

test("period options come from every published figure the caller can see, ignoring the period filter, latest first", async () => {
  const { db, calls } = perFundDb(1, FOUR_FUNDS, [
    { period: "Q1 2026", as_of: "2026-03-31" }, { period: "Q2 2026", as_of: "2026-06-30" }, { period: "Q1 2026", as_of: null }, { period: "", as_of: "2026-09-30" },
  ]);
  const page = await repositoryOf(db).loadPage(fourFunds(), { period: "Q1 2026" }, { periods: true });
  assert.deepEqual(page.periodOptions, ["Q2 2026", "Q1 2026"]);
  const periodCall = calls.find((call) => call.sql.includes("group by 1"))!;
  assert.equal(periodCall.parameters.length, 4, "no period parameter: the options are the unfiltered list");
  assert.deepEqual(JSON.parse(String(periodCall.parameters[1])), ["fund-a", "fund-b", "fund-c", "fund-d"], "across every entitled fund, not just the page");
});

test("a tampered or foreign cursor is refused and a cursor whose fund has since gone resumes after its position", async () => {
  const { db } = perFundDb(1);
  for (const cursor of ["not-a-cursor", encodeCursor("not json"), encodeCursor(JSON.stringify("fund-a")), encodeCursor(JSON.stringify(["only-one"])), encodeCursor(JSON.stringify([1, 2])), encodeCursor(JSON.stringify(["a", "b", "c"]))]) {
    await assert.rejects(repositoryOf(db).loadPage(fourFunds(), {}, { cursor }), InvalidCursorError, cursor);
  }
  const first = await repositoryOf(db).loadPage(fourFunds(), {}, { limit: 1 });
  const remaining = perFundDb(1, FOUR_FUNDS.filter((row) => row.fund_id === "fund-c" || row.fund_id === "fund-d")).db;
  const resumed = await repositoryOf(remaining).loadPage(identity({ fundIds: ["fund-c", "fund-d"] }), {}, { cursor: first.nextCursor });
  assert.deepEqual(resumed.payload.funds.map((fund) => fund.fundId), ["fund-c", "fund-d"], "fund-a and fund-b are gone; paging continues after fund-a's position");
});

test("page size defaults, is clamped to 1..100, and a page walk ends exactly when the funds run out", () => {
  assert.equal(scorecardPageSize(undefined), SCORECARD_DEFAULT_PAGE_FUNDS);
  assert.equal(scorecardPageSize(0), 1);
  assert.equal(scorecardPageSize(-5), 1);
  assert.equal(scorecardPageSize(7.9), 7);
  assert.equal(scorecardPageSize(10_000), SCORECARD_MAX_PAGE_FUNDS);
  const funds = [{ fundId: "a", fund: "A" }, { fundId: "b", fund: "B" }];
  assert.deepEqual(fundsAfterCursor(funds, null), funds);
  assert.deepEqual(fundsAfterCursor(funds, ""), funds);
  assert.equal(nextFundCursor(funds, 2), null, "the page holds everything that remained");
  const cursor = nextFundCursor(funds.slice(0, 1), 2);
  assert.ok(cursor);
  assert.deepEqual(fundsAfterCursor(funds, cursor), [funds[1]]);
});

test("the whole-scorecard read (used by exports) walks 100 funds at a time and stops at the last page", async () => {
  const many = Array.from({ length: 205 }, (_, index) => ({ fund_id: `fund-${String(index).padStart(3, "0")}`, fund_name: `Fund ${String(index).padStart(3, "0")}` }));
  const { db, factCalls } = perFundDb(1, many);
  const everyFund = identity({ fundIds: many.map((row) => String(row.fund_id)) });
  const all = await repositoryOf(db).load(everyFund);
  assert.equal(all.funds.length, 205);
  assert.equal(all.facts.length, 205);
  assert.deepEqual(factCalls().map((call) => (JSON.parse(String(call.parameters[1])) as string[]).length), [100, 100, 5]);
  const pages: number[] = [];
  for await (const page of repositoryOf(perFundDb(1, many).db).pages(everyFund)) pages.push(page.funds.length);
  assert.deepEqual(pages, [100, 100, 5]);
  const noFacts = await repositoryOf(perFundDb(0, many).db).load(everyFund);
  assert.equal(noFacts.facts.length, 0);
  assert.equal(noFacts.funds.length, 205, "a fund with nothing published still has its row");
});
