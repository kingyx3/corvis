import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// See lib/server/source-connections-routes.test.ts for why this loader is
// needed: route modules use the Next.js "@/..." path alias that plain
// `node --test` cannot resolve on its own.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";

// The resolve route's Idempotency-Key wiring (issue #11,
// lib/server/idempotency.ts) queries corvis_control.idempotency_key
// directly over Postgres even in demo mode (the resolution itself goes
// through the demo in-memory platform). This fake backs that table with a
// real in-memory map keyed on its actual primary key
// (tenant_id, scope, idempotency_key), honoring the same
// "insert ... on conflict do nothing returning *" contract the module
// issues, so these tests exercise the real
// route -> lib/server/idempotency.ts -> PostgresHttpSqlApi -> fetch path.
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
  return new Response(JSON.stringify({ rows }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { POST: resolvePost } = await import("@/app/api/v1/reconciliation-exceptions/resolve/route");

function request(options: { idempotencyKey?: string; tenant?: string; exceptionId?: string; expectedVersion?: number } = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-corvis-demo-tenant": options.tenant ?? "tenant-alpha",
    "x-corvis-demo-workspace": "workspace-1",
    "x-corvis-demo-subject": "demo-user",
    "x-corvis-demo-roles": "admin",
  };
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  return new Request("https://corvis.test/api/v1/reconciliation-exceptions/resolve", {
    method: "POST",
    headers,
    body: JSON.stringify({
      exceptionId: options.exceptionId ?? "exception-1",
      expectedVersion: options.expectedVersion ?? 1,
      action: "mark_immaterial",
      reasonCode: "not_material_to_nav",
    }),
  });
}

test("POST /reconciliation-exceptions/resolve replays the same resolution outcome for a retried Idempotency-Key", async () => {
  const first = await resolvePost(request({ idempotencyKey: "retry-key-1", tenant: "tenant-recon-a" }));
  assert.equal(first.status, 202);
  const firstPayload = await first.json() as { data: { resolutionEventId: string; newVersion: number } };

  const second = await resolvePost(request({ idempotencyKey: "retry-key-1", tenant: "tenant-recon-a" }));
  assert.equal(second.status, 202);
  const secondPayload = await second.json() as { data: { resolutionEventId: string; newVersion: number } };

  assert.equal(secondPayload.data.resolutionEventId, firstPayload.data.resolutionEventId, "a retried resolve request with the same key must not re-attempt the resolution");
  assert.deepEqual(secondPayload.data, firstPayload.data);
});

test("POST /reconciliation-exceptions/resolve with no idempotency key still resolves fresh every time (backward compatible)", async () => {
  const tenant = "tenant-recon-none";
  const first = await resolvePost(request({ tenant }));
  const second = await resolvePost(request({ tenant }));
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  const firstPayload = await first.json() as { data: { resolutionEventId: string } };
  const secondPayload = await second.json() as { data: { resolutionEventId: string } };
  assert.notEqual(secondPayload.data.resolutionEventId, firstPayload.data.resolutionEventId, "omitting the key must behave exactly as it did before idempotency existed");
});

test("POST /reconciliation-exceptions/resolve never lets one tenant's key replay satisfy another tenant's request", async () => {
  const key = "shared-key-across-tenants";
  const tenantA = await resolvePost(request({ idempotencyKey: key, tenant: "tenant-recon-x" }));
  const tenantB = await resolvePost(request({ idempotencyKey: key, tenant: "tenant-recon-y" }));
  const tenantAPayload = await tenantA.json() as { data: { resolutionEventId: string } };
  const tenantBPayload = await tenantB.json() as { data: { resolutionEventId: string } };
  assert.notEqual(tenantBPayload.data.resolutionEventId, tenantAPayload.data.resolutionEventId);
});

test("POST /reconciliation-exceptions/resolve still rejects an invalid command with 400 before touching idempotency storage", async () => {
  const response = await resolvePost(new Request("https://corvis.test/api/v1/reconciliation-exceptions/resolve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corvis-demo-tenant": "tenant-recon-invalid",
      "x-corvis-demo-workspace": "workspace-1",
      "x-corvis-demo-subject": "demo-user",
      "x-corvis-demo-roles": "admin",
      "idempotency-key": "irrelevant-key",
    },
    body: JSON.stringify({ exceptionId: "exception-1", expectedVersion: 0, action: "mark_immaterial", reasonCode: "x" }),
  }));
  assert.equal(response.status, 400);
  const payload = await response.json() as { error: string };
  assert.equal(payload.error, "invalid_reconciliation_resolution");
});

test("POST /reconciliation-exceptions/resolve answers 400 (not 500) for a null/array body, non-string fields or an out-of-range version", async () => {
  const bodies: unknown[] = [
    null,
    [],
    { exceptionId: "exception-1", expectedVersion: 1, action: "mark_immaterial", reasonCode: { code: "x" } },
    { exceptionId: 42, expectedVersion: 1, action: "mark_immaterial", reasonCode: "x" },
    { exceptionId: "exception-1", expectedVersion: 2 ** 31, action: "mark_immaterial", reasonCode: "x" },
    { exceptionId: "exception-1", expectedVersion: 1, action: "mark_immaterial", reasonCode: "x", note: { text: "n" } },
  ];
  for (const body of bodies) {
    const response = await resolvePost(new Request("https://corvis.test/api/v1/reconciliation-exceptions/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-corvis-demo-tenant": "tenant-recon-invalid",
        "x-corvis-demo-workspace": "workspace-1",
        "x-corvis-demo-subject": "demo-user",
        "x-corvis-demo-roles": "admin",
      },
      body: JSON.stringify(body),
    }));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json() as { error: string }).error, "invalid_reconciliation_resolution");
  }
});
