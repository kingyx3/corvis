import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { Scorecard } from "../../core/performance-scorecard.ts";

// See lib/server/source-connections-routes.test.ts for why this loader is needed.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";

const { GET } = await import("@/app/api/v1/performance-scorecard/route");

function request(roles: string): Request {
  return new Request("https://corvis.test/api/v1/performance-scorecard", {
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
  const body = await response.json() as { correlationId: string; nextCursor: null; data: Scorecard };
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
