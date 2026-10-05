import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { ScorecardPage } from "../../core/performance-scorecard.ts";

// See src/lib/server/source-connections-routes.test.ts for why this loader is needed.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";

const { GET } = await import("@/app/api/v1/performance-scorecard/route");

function request(roles: string, query = ""): Request {
  return new Request(`https://corvis.test/api/v1/performance-scorecard${query}`, {
    headers: {
      "x-corvis-demo-tenant": "tenant-scorecard",
      "x-corvis-demo-workspace": "workspace-1",
      "x-corvis-demo-subject": `scorecard-${roles}`,
      "x-corvis-demo-roles": roles,
      "x-correlation-id": "corr-scorecard",
    },
  });
}

test("GET /performance-scorecard serves the demo scorecard: every entitled fund, latest reported figures, flags and sources", async () => {
  const response = await GET(request("read_only"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as { correlationId: string; nextCursor: null; data: ScorecardPage };
  assert.equal(body.correlationId, "corr-scorecard");
  assert.equal(body.nextCursor, null);
  assert.deepEqual(body.data.funds.map((fund) => fund.fund), ["Advent International GPE VIII", "EQT IX", "Hg Genesis 9", "Nordic Capital Fund V"]);
  const advent = body.data.funds[0]!;
  assert.deepEqual(advent.cells.map((cell) => cell.metric.code), ["nav", "tvpi", "dpi", "rvpi", "net_irr", "net_moic"]);
  const nav = advent.cells[0]!.figures[0]!;
  assert.deepEqual([nav.valueNumber, nav.currency, nav.asOf, nav.status, nav.source.documentId], ["1958000000.0000000000", "USD", "2026-06-30", "Final", "doc-adv-viii-q2"]);
  assert.deepEqual(advent.investments.map((row) => row.investment), ["ABC Corp", "Atlas Industrial", "Harbor Logistics", "Meridian Software"]);
  assert.ok(body.data.funds[3]!.cells.every((cell) => cell.figures.length === 0), "a fund with nothing published has no figures, not zeros");
});

type PageBody = { correlationId: string; nextCursor: string | null; data: ScorecardPage; error?: string };
const read = async (query: string) => { const response = await GET(request("read_only", query)); return { status: response.status, body: await response.json() as PageBody }; };

test("GET /performance-scorecard carries the filters, every fund and period option on the first page", async () => {
  const { status, body } = await read("");
  assert.equal(status, 200);
  assert.deepEqual(body.data.filters, {});
  assert.equal(body.data.fundOptions.length, 4);
  assert.deepEqual(body.data.periodOptions, ["Q2 2026", "Q1 2026"]);
});

test("GET /performance-scorecard narrows by fund and period, and pages by fund with a cursor", async () => {
  const filtered = await read("?fundId=fund-advent-viii&period=Q1%202026");
  assert.deepEqual(filtered.body.data.filters, { fundId: "fund-advent-viii", period: "Q1 2026" });
  assert.deepEqual(filtered.body.data.funds.map((fund) => fund.fundId), ["fund-advent-viii"]);
  assert.equal(filtered.body.data.fundOptions.length, 4, "the options are not narrowed");
  const first = await read("?limit=3");
  assert.equal(first.body.data.funds.length, 3);
  assert.ok(first.body.nextCursor);
  const second = await read(`?limit=3&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
  assert.deepEqual(second.body.data.funds.map((fund) => fund.fundId), ["fund-nordic-v"]);
  assert.equal(second.body.nextCursor, null);
  assert.deepEqual(second.body.data.periodOptions, [], "the periods came with the first page");
});

test("GET /performance-scorecard refuses a malformed filter, limit or cursor and a fund outside the entitlement", async () => {
  const bad = await read("?fundId=");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_scorecard_filter");
  assert.equal((await read(`?period=${"x".repeat(65)}`)).status, 400);
  assert.equal((await read("?limit=0")).status, 400);
  assert.equal((await read("?cursor=tampered")).status, 400);
  const elsewhere = await read("?fundId=fund-not-mine");
  assert.equal(elsewhere.status, 403);
});
