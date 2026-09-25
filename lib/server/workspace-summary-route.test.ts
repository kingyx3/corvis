import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// See lib/server/source-connections-routes.test.ts for why this loader is needed.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";

const { GET } = await import("@/app/api/v1/workspace-summary/route");

function request(roles: string): Request {
  return new Request("https://corvis.test/api/v1/workspace-summary", {
    headers: {
      "x-corvis-demo-tenant": "tenant-summary",
      "x-corvis-demo-workspace": "workspace-1",
      "x-corvis-demo-subject": `summary-${roles}`,
      "x-corvis-demo-roles": roles,
      "x-correlation-id": "corr-summary",
    },
  });
}

test("GET /workspace-summary serves the published value rollup, exposure and attention", async () => {
  const response = await GET(request("read_only"));
  assert.equal(response.status, 200);
  const body = await response.json() as { correlationId: string; data: {
    currency: string | null;
    valueTrend: Array<{ period: string; value: number }>;
    exposure: { total: number; items: Array<{ value: number }>; byAssetType: Array<{ label: string; value: number }>; bySector: Array<{ label: string; value: number }> };
    attention: { counts: { total: number; unhealthy_source: number }; items: Array<{ count: number }> };
    freshness: { staleAfterDays: number };
  } };
  assert.equal(body.correlationId, "corr-summary");
  const { data } = body;
  assert.equal(data.currency, "USD");
  assert.ok(data.valueTrend.length >= 2, "demo history charts a real trend");
  assert.deepEqual(data.valueTrend.map((point) => point.period), ["Q3 2025", "Q4 2025", "Q1 2026", "Q2 2026"]);
  assert.equal(data.exposure.total, data.exposure.items.reduce((sum, item) => sum + item.value, 0));
  for (const rows of [data.exposure.byAssetType, data.exposure.bySector]) {
    assert.ok(rows.length > 0);
    assert.equal(Math.round(rows.reduce((sum, row) => sum + row.value, 0)), Math.round(data.exposure.total));
  }
  assert.ok(data.exposure.bySector.some((row) => row.label === "Healthcare"));
  assert.ok(data.exposure.byAssetType.some((row) => row.label === "Not attributed"));
  assert.equal(data.attention.counts.total, data.attention.items.reduce((sum, item) => sum + item.count, 0));
  assert.equal(data.attention.counts.unhealthy_source, 0);
  assert.ok(data.freshness.staleAfterDays > 0);
});
