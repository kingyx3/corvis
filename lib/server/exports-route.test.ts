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
//
// The route's Idempotency-Key wiring (issue #11, lib/server/idempotency.ts)
// also queries Postgres directly -- corvis_control.idempotency_key -- even
// in demo mode, the same way the feature-flag gate above does. This fake
// backs that table with a real in-memory map keyed on its actual primary
// key (tenant_id, scope, idempotency_key) and honors the same
// "insert ... on conflict do nothing returning *" contract the module issues,
// so these tests exercise the real route -> lib/server/idempotency.ts ->
// PostgresHttpSqlApi -> fetch path rather than stubbing the module itself.
const idempotencyRows = new Map<string, { response_status: number; response_body: string }>();
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_POSTGRES_DSN) return originalFetch(input, init);
  const { sql, parameters } = JSON.parse(String(init?.body ?? "{}")) as { sql: string; parameters: unknown[] };
  const text = sql.trim();
  let rows: unknown[] = [];
  if (text.startsWith("select response_status")) {
    const [tenantId, scope, key] = parameters;
    const row = idempotencyRows.get(`${String(tenantId)}:${String(scope)}:${String(key)}`);
    rows = row ? [row] : [];
  } else if (text.startsWith("insert into corvis_control.idempotency_key")) {
    const [tenantId, scope, key, , status, body] = parameters;
    const rowKey = `${String(tenantId)}:${String(scope)}:${String(key)}`;
    if (!idempotencyRows.has(rowKey)) {
      const row = { response_status: status as number, response_body: body as string };
      idempotencyRows.set(rowKey, row);
      rows = [row];
    }
  }
  // Any other query (the feature-flag snapshot) gets no matching row, same
  // as before this idempotency wiring existed.
  return new Response(JSON.stringify({ rows }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { POST: exportsPost } = await import("@/app/api/v1/exports/route");

function request(format: unknown, options: { idempotencyKey?: string; tenant?: string } = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-corvis-demo-tenant": options.tenant ?? "tenant-alpha",
    "x-corvis-demo-workspace": "workspace-1",
    "x-corvis-demo-subject": "demo-user",
    "x-corvis-demo-roles": "admin",
  };
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  return new Request("https://corvis.test/api/v1/exports", {
    method: "POST",
    headers,
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

test("POST /exports replays the same export job for a retried Idempotency-Key instead of creating a second one", async () => {
  const first = await exportsPost(request("csv", { idempotencyKey: "retry-key-1", tenant: "tenant-idem-a" }));
  assert.equal(first.status, 202);
  const firstPayload = await first.json() as { data: { exportId: string; format: string } };

  const second = await exportsPost(request("csv", { idempotencyKey: "retry-key-1", tenant: "tenant-idem-a" }));
  assert.equal(second.status, 202);
  const secondPayload = await second.json() as { data: { exportId: string; format: string } };

  assert.equal(secondPayload.data.exportId, firstPayload.data.exportId, "a retried request with the same key must not enqueue a second export job");
  assert.deepEqual(secondPayload.data, firstPayload.data);
});

test("POST /exports treats an idempotencyKey sent in the body the same as the Idempotency-Key header", async () => {
  const tenant = "tenant-idem-body";
  const first = await exportsPost(new Request("https://corvis.test/api/v1/exports", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corvis-demo-tenant": tenant,
      "x-corvis-demo-workspace": "workspace-1",
      "x-corvis-demo-subject": "demo-user",
      "x-corvis-demo-roles": "admin",
    },
    body: JSON.stringify({ format: "csv", idempotencyKey: "body-key-1" }),
  }));
  assert.equal(first.status, 202);
  const firstPayload = await first.json() as { data: { exportId: string } };

  const second = await exportsPost(new Request("https://corvis.test/api/v1/exports", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corvis-demo-tenant": tenant,
      "x-corvis-demo-workspace": "workspace-1",
      "x-corvis-demo-subject": "demo-user",
      "x-corvis-demo-roles": "admin",
    },
    body: JSON.stringify({ format: "csv", idempotencyKey: "body-key-1" }),
  }));
  assert.equal(second.status, 202);
  const secondPayload = await second.json() as { data: { exportId: string } };
  assert.equal(secondPayload.data.exportId, firstPayload.data.exportId);
});

test("POST /exports with no idempotency key at all still creates a fresh export job every time (backward compatible)", async () => {
  const tenant = "tenant-idem-none";
  const first = await exportsPost(request("csv", { tenant }));
  const second = await exportsPost(request("csv", { tenant }));
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  const firstPayload = await first.json() as { data: { exportId: string } };
  const secondPayload = await second.json() as { data: { exportId: string } };
  assert.notEqual(secondPayload.data.exportId, firstPayload.data.exportId, "omitting the key must behave exactly as it did before idempotency existed");
});

test("POST /exports never lets one tenant's Idempotency-Key replay satisfy another tenant's request", async () => {
  const key = "shared-key-across-tenants";
  const tenantA = await exportsPost(request("csv", { idempotencyKey: key, tenant: "tenant-idem-x" }));
  const tenantB = await exportsPost(request("csv", { idempotencyKey: key, tenant: "tenant-idem-y" }));
  const tenantAPayload = await tenantA.json() as { data: { exportId: string } };
  const tenantBPayload = await tenantB.json() as { data: { exportId: string } };
  assert.notEqual(tenantBPayload.data.exportId, tenantAPayload.data.exportId);
});
