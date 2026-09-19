import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// See lib/server/source-connections-routes.test.ts for why this loader is
// needed: route modules use the Next.js "@/..." path alias that plain
// `node --test` cannot resolve on its own.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";

// The exports route's feature-flag gate (issue #10) calls
// assertFeatureEnabled -> loadFeatureFlagSnapshot, which queries Postgres
// directly rather than going through the demo in-memory platform. Fake just
// those two queries; no row for either matches the real, currently-true
// production state for every tenant, since nothing has ever written a
// corvis_control.feature_flag row for exports.parquet_delivery.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_POSTGRES_DSN) return originalFetch(input, init);
  return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { POST: exportsPost } = await import("@/app/api/v1/exports/route");

function request(format: unknown): Request {
  return new Request("https://corvis.test/api/v1/exports", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corvis-demo-tenant": "tenant-alpha",
      "x-corvis-demo-workspace": "workspace-1",
      "x-corvis-demo-subject": "demo-user",
      "x-corvis-demo-roles": "admin",
    },
    body: JSON.stringify({ format }),
  });
}

test("POST /exports blocks parquet delivery with 403 feature_disabled by default", async () => {
  // The demo identity used here (like every real caller until an operator
  // both grants the redistributionAllowed entitlement and enables the flag)
  // is denied on the flag's entitlement gate before rollout state is even
  // consulted -- proving the wiring enforces the real, registered gate
  // rather than defaulting open.
  const response = await exportsPost(request("parquet"));
  assert.equal(response.status, 403);
  const payload = await response.json() as { error: string; flagKey: string; reason: string };
  assert.equal(payload.error, "feature_disabled");
  assert.equal(payload.flagKey, "exports.parquet_delivery");
  assert.equal(payload.reason, "entitlement_denied");
});

test("POST /exports still creates csv exports normally: the parquet gate does not affect other formats", async () => {
  const response = await exportsPost(request("csv"));
  assert.equal(response.status, 202);
  const payload = await response.json() as { data: { format: string } };
  assert.equal(payload.data.format, "csv");
});

test("POST /exports still creates xlsx exports normally: the parquet gate does not affect other formats", async () => {
  const response = await exportsPost(request("xlsx"));
  assert.equal(response.status, 202);
  const payload = await response.json() as { data: { format: string } };
  assert.equal(payload.data.format, "xlsx");
});
