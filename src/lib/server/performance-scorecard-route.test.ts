import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { ScorecardPage } from "../../core/performance-scorecard.ts";
import { SCORECARD_MAX_FACTS } from "./performance-scorecard.ts";

// Production-mode behaviour of GET /performance-scorecard against a faked SQL gateway
// (see src/lib/server/route-authorization.test.ts for the same injection technique).
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const DOCUMENT = "44444444-dddd-4ddd-8ddd-444444444444";
const GATEWAY_SECRET = "scorecard-route-gateway-secret";

process.env.CORVIS_DEMO_MODE = "";
process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = GATEWAY_SECRET;
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";
console.warn = () => undefined;
console.info = () => undefined;
console.error = () => undefined;

type Query = { sql: string; parameters: unknown[] };
const queries: Query[] = [];
let respond: (query: Query) => unknown[] = () => [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_POSTGRES_DSN) return originalFetch(input, init);
  const { sql, parameters } = JSON.parse(String(init?.body ?? "{}")) as Query;
  queries.push({ sql: sql.trim(), parameters });
  return new Response(JSON.stringify({ rows: respond({ sql: sql.trim(), parameters }) }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { GET } = await import("@/app/api/v1/performance-scorecard/route");

function request(options: { funds?: string[]; documents?: string[]; roles?: string; credentials?: boolean; query?: string } = {}): Request {
  const headers: Record<string, string> = { "x-correlation-id": "corr-scorecard-prod" };
  if (options.credentials !== false) {
    headers["x-corvis-gateway-secret"] = GATEWAY_SECRET;
    headers["x-corvis-auth-subject"] = "analyst-1";
    headers["x-corvis-auth-tenant"] = TENANT;
    headers["x-corvis-auth-workspace"] = WORKSPACE;
    headers["x-corvis-auth-roles"] = options.roles ?? "analyst";
    headers["x-corvis-entitled-funds"] = (options.funds ?? []).join(",");
    headers["x-corvis-entitled-documents"] = (options.documents ?? []).join(",");
    headers["x-corvis-source-access"] = "true";
    headers["x-corvis-redistribution"] = "true";
  }
  return new Request(`https://corvis.test/api/v1/performance-scorecard${options.query ?? ""}`, { headers });
}

test("an entitled analyst gets the scorecard built from published facts, scoped to their funds and documents", async () => {
  queries.length = 0;
  respond = (query) => query.sql.includes("corvis_identity.fund f")
    ? [{ fund_id: "fund-a", fund_name: "Alpha Fund" }, { fund_id: "fund-b", fund_name: "Beta Fund" }]
    : [{
      fact_id: "fact-1", snapshot_id: "snap-1", published_at: "2026-07-01T00:00:00.000Z", fund_id: "fund-a", level: "fund", metric_code: "tvpi",
      value_number: "1.6200000000", currency: null, unit: null, as_of: "2026-06-30", economic_period: "Q2 2026", actuality: "actual", scenario_type: "reported",
      is_restated: false, is_derived: false, document_id: DOCUMENT, source_reference_id: "55555555-eeee-4eee-8eee-555555555555", page_number: 7,
    }];
  const response = await GET(request({ funds: ["fund-a", "fund-b"], documents: [DOCUMENT] }));
  assert.equal(response.status, 200);
  const body = await response.json() as { data: ScorecardPage; nextCursor: null };
  assert.deepEqual(body.data.funds.map((fund) => fund.fund), ["Alpha Fund", "Beta Fund"]);
  const tvpi = body.data.funds[0]!.cells.find((cell) => cell.metric.code === "tvpi")!.figures[0]!;
  assert.deepEqual([tvpi.valueNumber, tvpi.status, tvpi.asOf, tvpi.source.documentId, tvpi.source.page], ["1.6200000000", "Final", "2026-06-30", DOCUMENT, 7]);
  assert.ok(body.data.funds[1]!.cells.every((cell) => cell.figures.length === 0), "an entitled fund with nothing published is Not reported, never 0");
  const facts = queries.find((query) => query.sql.includes("corvis_consolidated.fund_period_snapshot"));
  assert.deepEqual(facts?.parameters.slice(0, 3), [TENANT, JSON.stringify(["fund-a", "fund-b"]), JSON.stringify([DOCUMENT])]);
});

test("a caller with no fund or document entitlement sees an empty scorecard and the database is never queried", async () => {
  queries.length = 0;
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { data: ScorecardPage }).data, { funds: [], filters: {}, fundOptions: [], periodOptions: [] });
  assert.equal(queries.length, 0);
});

test("the route rejects a request with no credentials before any query", async () => {
  queries.length = 0;
  const response = await GET(request({ credentials: false }));
  assert.equal(response.status, 401);
  assert.equal(queries.length, 0);
});

test("a failing database is an error response, not an empty scorecard that reads as Not reported", async () => {
  queries.length = 0;
  respond = () => { throw new Error("database exploded"); };
  const response = await GET(request({ funds: ["fund-a"], documents: [DOCUMENT] }));
  assert.ok(response.status >= 500);
});

function pagedResponder(perFund: number, periods: unknown[] = []) {
  const funds = [{ fund_id: "fund-a", fund_name: "Alpha Fund" }, { fund_id: "fund-b", fund_name: "Beta Fund" }, { fund_id: "fund-c", fund_name: "Gamma Fund" }];
  return (query: Query): unknown[] => {
    if (query.sql.includes("corvis_identity.fund f")) return funds;
    if (query.sql.includes("group by 1")) return periods;
    const requested = JSON.parse(String(query.parameters[1])) as string[];
    return requested.flatMap((fundId) => Array.from({ length: perFund }, (_, index) => ({
      fact_id: `${fundId}-${index}`, snapshot_id: "snap-1", published_at: "2026-07-01T00:00:00.000Z", fund_id: fundId, level: "fund", metric_code: "nav",
      value_number: "100", currency: "USD", as_of: "2026-06-30", economic_period: "Q2 2026", actuality: "actual", is_restated: false, is_derived: false,
      document_id: DOCUMENT, source_reference_id: "55555555-eeee-4eee-8eee-555555555555", page_number: 1,
    })));
  };
}

test("the scorecard is served by keyset pages of funds, with the filters echoed and the periods on the first page", async () => {
  queries.length = 0;
  respond = pagedResponder(1, [{ period: "Q2 2026", as_of: "2026-06-30" }, { period: "Q1 2026", as_of: "2026-03-31" }]);
  const entitled = { funds: ["fund-a", "fund-b", "fund-c"], documents: [DOCUMENT] };
  const first = await GET(request({ ...entitled, query: "?limit=2&period=Q2%202026" }));
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { data: ScorecardPage; nextCursor: string | null };
  assert.deepEqual(firstBody.data.funds.map((fund) => fund.fundId), ["fund-a", "fund-b"]);
  assert.deepEqual(firstBody.data.filters, { period: "Q2 2026" });
  assert.deepEqual(firstBody.data.fundOptions.map((fund) => fund.fundId), ["fund-a", "fund-b", "fund-c"]);
  assert.deepEqual(firstBody.data.periodOptions, ["Q2 2026", "Q1 2026"]);
  assert.ok(firstBody.nextCursor);
  const second = await GET(request({ ...entitled, query: `?limit=2&period=Q2%202026&cursor=${encodeURIComponent(firstBody.nextCursor!)}` }));
  const secondBody = await second.json() as { data: ScorecardPage; nextCursor: string | null };
  assert.deepEqual(secondBody.data.funds.map((fund) => fund.fundId), ["fund-c"]);
  assert.equal(secondBody.nextCursor, null);
  assert.deepEqual(secondBody.data.periodOptions, []);
  const facts = queries.filter((query) => query.sql.includes("from ranked_fact"));
  assert.deepEqual(facts.map((query) => JSON.parse(String(query.parameters[1]))), [["fund-a", "fund-b"], ["fund-c"]], "each page reads only its own funds");
  assert.ok(facts.every((query) => query.parameters[4] === "Q2 2026"));
});

test("a fund filter outside the entitlement is 403 and a malformed filter or cursor is 400, all before any figure is read", async () => {
  queries.length = 0;
  respond = pagedResponder(1);
  const entitled = { funds: ["fund-a"], documents: [DOCUMENT] };
  assert.equal((await GET(request({ ...entitled, query: "?fundId=fund-b" }))).status, 403);
  const malformed = await GET(request({ ...entitled, query: "?period=" }));
  assert.equal(malformed.status, 400);
  assert.equal(((await malformed.json()) as { error: string }).error, "invalid_scorecard_filter");
  assert.equal((await GET(request({ ...entitled, query: "?cursor=bogus" }))).status, 400);
  assert.equal(queries.some((query) => query.sql.includes("from ranked_fact")), false);
});

test("a tenant above the figure cap loads page by page, and only one fund above it is a 413 rather than a truncated scorecard", async () => {
  queries.length = 0;
  const bigFacts = pagedResponder(1);
  respond = (query) => {
    const base = bigFacts(query);
    if (query.sql.includes("corvis_identity.fund f") || query.sql.includes("group by 1")) return base;
    // Any read of more than one fund is over the cap; one fund is within it.
    return (JSON.parse(String(query.parameters[1])) as string[]).length > 1 ? Array.from({ length: SCORECARD_MAX_FACTS + 1 }, (_, index) => ({ fact_id: `x${index}` })) : base;
  };
  const response = await GET(request({ funds: ["fund-a", "fund-b", "fund-c"], documents: [DOCUMENT], query: "?limit=3" }));
  assert.equal(response.status, 200);
  const body = await response.json() as { data: ScorecardPage; nextCursor: string | null };
  assert.deepEqual(body.data.funds.map((fund) => fund.fundId), ["fund-a"], "the oversized page was halved down to what fits");
  assert.ok(body.nextCursor, "the other funds are reachable");
  respond = (query) => query.sql.includes("corvis_identity.fund f") ? [{ fund_id: "fund-a", fund_name: "Alpha Fund" }] : Array.from({ length: SCORECARD_MAX_FACTS + 1 }, (_, index) => ({ fact_id: `x${index}` }));
  const single = await GET(request({ funds: ["fund-a"], documents: [DOCUMENT] }));
  assert.equal(single.status, 413);
  assert.equal(((await single.json()) as { error: string }).error, "performance_scorecard_too_large");
});
