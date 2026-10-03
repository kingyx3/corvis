import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { Scorecard } from "../../core/performance-scorecard.ts";

// Production-mode behaviour of GET /performance-scorecard against a faked SQL gateway
// (see lib/server/route-authorization.test.ts for the same injection technique).
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

function request(options: { funds?: string[]; documents?: string[]; roles?: string; credentials?: boolean } = {}): Request {
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
  return new Request("https://corvis.test/api/v1/performance-scorecard", { headers });
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
  const body = await response.json() as { data: Scorecard; nextCursor: null };
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
  assert.deepEqual((await response.json() as { data: Scorecard }).data, { funds: [] });
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
