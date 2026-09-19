import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Route modules live under app/api and use the Next.js "@/..." path alias
// (tsconfig.json), which Next's bundler resolves at build/serve time but
// which plain `node --test` does not understand on its own. Registering this
// loader lets this file import and directly exercise the real route handler
// functions, the same way Next.js would call them.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";

// ---- A minimal fake Postgres HTTP backend for corvis_source.source_connection ----
// Mirrors the equivalent in-memory model in lib/server/source-connectors.test.ts,
// dispatching on the same SQL fragments lib/server/source-connectors.ts actually
// issues, so this exercises the real production code path (route -> library ->
// PostgresHttpSqlApi -> fetch) rather than a stand-in for the library itself.
type Row = Record<string, unknown>;
const rows = new Map<string, Row>();
let idCounter = 0;
function rowKey(tenantId: string, id: string): string { return `${tenantId}:${id}`; }

function handleSql(sql: string, parameters: unknown[]): Row[] {
  const text = sql.trim();
  if (text.startsWith("insert into corvis_source.source_connection")) {
    const id = `00000000-0000-0000-0000-${String(++idCounter).padStart(12, "0")}`;
    const row: Row = {
      source_connection_id: id, tenant_id: parameters[0], workspace_id: parameters[1],
      provider_key: parameters[2], connection_label: parameters[3], credential_type: parameters[4],
      source_scope: parameters[5], scope_confirmed_by: parameters[6], scope_confirmed_at: new Date().toISOString(),
      secret_reference: parameters[7], connector_version: parameters[8], status: "pending_authorization",
      consecutive_failures: 0,
    };
    rows.set(rowKey(String(parameters[0]), id), row);
    return [row];
  }
  if (text.includes("from corvis_source.source_connection") && text.includes("source_connection_id=$2")) {
    const row = rows.get(rowKey(String(parameters[0]), String(parameters[1])));
    return row ? [row] : [];
  }
  if (text.includes("from corvis_source.source_connection") && text.includes("order by")) {
    return [...rows.values()].filter((row) => row.tenant_id === parameters[0]).map((row) => ({ ...row, secret_reference: "redacted" }));
  }
  if (text.startsWith("update corvis_source.source_connection")) {
    const tenantId = String(parameters[0]);
    const id = String(parameters[1]);
    const row = rows.get(rowKey(tenantId, id));
    if (row) {
      if (text.includes("set status=$3, updated_at=now(), revoked_at=now()")) { row.status = parameters[2]; row.revoked_at = new Date().toISOString(); }
      else if (text.includes("set status=$3, updated_at=now()")) { row.status = parameters[2]; }
      else if (text.includes("status='revoked', revoked_at=now()")) { row.status = "revoked"; row.revoked_at = new Date().toISOString(); }
      else if (text.includes("secret_reference=$3, status='active', consecutive_failures=0")) { row.secret_reference = parameters[2]; row.status = "active"; row.consecutive_failures = 0; row.last_error_class = null; }
      else if (text.includes("status='active', last_authorized_at=now()")) { row.status = "active"; }
      else if (text.includes("set status=$3, last_error_class=$4, updated_at=now()")) { row.status = parameters[2]; row.last_error_class = parameters[3]; }
    }
    return [];
  }
  return [];
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_POSTGRES_DSN) return originalFetch(input, init);
  const { sql, parameters } = JSON.parse(String(init?.body ?? "{}")) as { sql: string; parameters: unknown[] };
  const resultRows = handleSql(sql, parameters ?? []);
  return new Response(JSON.stringify({ rows: resultRows }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { GET: listGet, POST: createPost } = await import("@/app/api/v1/source-connections/route");
const { GET: itemGet, PATCH: itemPatch } = await import("@/app/api/v1/source-connections/[sourceConnectionId]/route");
const { POST: reauthorizePost } = await import("@/app/api/v1/source-connections/[sourceConnectionId]/reauthorize/route");
const { POST: testPost } = await import("@/app/api/v1/source-connections/[sourceConnectionId]/test/route");
const { sourceConnectorDrivers } = await import("./source-connector-runtime.ts");

const TENANT_A = "tenant-alpha";
const TENANT_B = "tenant-beta";

function request(method: string, path: string, options: { tenant?: string; roles?: string; body?: unknown } = {}): Request {
  const headers = new Headers({
    "x-corvis-demo-tenant": options.tenant ?? TENANT_A,
    "x-corvis-demo-workspace": "workspace-1",
    "x-corvis-demo-subject": "demo-admin",
    "x-corvis-demo-roles": options.roles ?? "admin",
  });
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) { headers.set("content-type", "application/json"); init.body = JSON.stringify(options.body); }
  return new Request(`https://corvis.test${path}`, init);
}

function params(sourceConnectionId: string) { return { params: Promise.resolve({ sourceConnectionId }) } as const; }

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    providerKey: "acme-portal", connectionLabel: "Acme investor portal", credentialType: "scoped_api_token",
    sourceScope: [{ label: "Quarterly reports" }], secret: { token: "shh" }, connectorVersion: "1.0.0",
    ...overrides,
  };
}

async function createConnection(tenant = TENANT_A): Promise<{ sourceConnectionId: string }> {
  const response = await createPost(request("POST", "/api/v1/source-connections", { tenant, body: validCreateBody() }));
  assert.equal(response.status, 201);
  const payload = await response.json() as { data: { sourceConnectionId: string } };
  return payload.data;
}

test("POST /source-connections creates a connection and never returns the secret reference", async () => {
  const response = await createPost(request("POST", "/api/v1/source-connections", { body: validCreateBody() }));
  assert.equal(response.status, 201);
  const payload = await response.json() as { data: Record<string, unknown> };
  assert.equal(payload.data.status, "pending_authorization");
  assert.equal("secretReference" in payload.data, false);
});

test("POST /source-connections rejects an empty source scope with 400", async () => {
  const response = await createPost(request("POST", "/api/v1/source-connections", { body: validCreateBody({ sourceScope: [] }) }));
  assert.equal(response.status, 400);
  const payload = await response.json() as { error: string };
  assert.equal(payload.error, "source_scope_confirmation_required");
});

test("POST /source-connections rejects a missing connection label with 400", async () => {
  const response = await createPost(request("POST", "/api/v1/source-connections", { body: validCreateBody({ connectionLabel: "" }) }));
  assert.equal(response.status, 400);
  const payload = await response.json() as { error: string };
  assert.equal(payload.error, "connection_label_required");
});

test("POST /source-connections rejects an invalid credential type with 400", async () => {
  const response = await createPost(request("POST", "/api/v1/source-connections", { body: validCreateBody({ credentialType: "password" }) }));
  assert.equal(response.status, 400);
  const payload = await response.json() as { error: string };
  assert.equal(payload.error, "invalid_credential_type");
});

test("a non-admin identity is denied with 403", async () => {
  const response = await createPost(request("POST", "/api/v1/source-connections", { roles: "analyst", body: validCreateBody() }));
  assert.equal(response.status, 403);
  const payload = await response.json() as { error: string };
  assert.equal(payload.error, "forbidden");
});

test("GET /source-connections lists only the caller's tenant connections", async () => {
  const own = await createConnection(TENANT_A);
  await createConnection(TENANT_B);

  const response = await listGet(request("GET", "/api/v1/source-connections", { tenant: TENANT_A }));
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: Array<{ sourceConnectionId: string }> };
  assert.ok(payload.data.some((connection) => connection.sourceConnectionId === own.sourceConnectionId));
  assert.ok(payload.data.every((connection) => !("secretReference" in connection)));
});

test("GET /source-connections/{id} 404s across tenants without leaking existence", async () => {
  const { sourceConnectionId } = await createConnection(TENANT_A);

  const ownRead = await itemGet(request("GET", `/api/v1/source-connections/${sourceConnectionId}`, { tenant: TENANT_A }), params(sourceConnectionId));
  assert.equal(ownRead.status, 200);

  const crossTenantRead = await itemGet(request("GET", `/api/v1/source-connections/${sourceConnectionId}`, { tenant: TENANT_B }), params(sourceConnectionId));
  assert.equal(crossTenantRead.status, 404);
  const payload = await crossTenantRead.json() as { error: string };
  assert.equal(payload.error, "connection_not_found");
});

test("PATCH pause/resume round-trips a connection and rejects a cross-tenant pause", async () => {
  const { sourceConnectionId } = await createConnection(TENANT_A);
  // testSourceConnection() (exercised in its own test below) is what moves a
  // brand-new connection out of pending_authorization; drive it directly here
  // via reauthorize instead, which also activates the connection.
  await reauthorizePost(request("POST", `/api/v1/source-connections/${sourceConnectionId}/reauthorize`, { tenant: TENANT_A, body: { secret: { token: "rotated" } } }), params(sourceConnectionId));

  const crossTenantPause = await itemPatch(request("PATCH", `/api/v1/source-connections/${sourceConnectionId}`, { tenant: TENANT_B, body: { action: "pause" } }), params(sourceConnectionId));
  assert.equal(crossTenantPause.status, 404);

  const pause = await itemPatch(request("PATCH", `/api/v1/source-connections/${sourceConnectionId}`, { tenant: TENANT_A, body: { action: "pause" } }), params(sourceConnectionId));
  assert.equal(pause.status, 200);
  const pausedPayload = await pause.json() as { data: { status: string } };
  assert.equal(pausedPayload.data.status, "paused");

  const pauseAgain = await itemPatch(request("PATCH", `/api/v1/source-connections/${sourceConnectionId}`, { tenant: TENANT_A, body: { action: "pause" } }), params(sourceConnectionId));
  assert.equal(pauseAgain.status, 409);
  const conflictPayload = await pauseAgain.json() as { error: string };
  assert.equal(conflictPayload.error, "invalid_transition_from_paused");

  const resume = await itemPatch(request("PATCH", `/api/v1/source-connections/${sourceConnectionId}`, { tenant: TENANT_A, body: { action: "resume" } }), params(sourceConnectionId));
  assert.equal(resume.status, 200);
  const resumedPayload = await resume.json() as { data: { status: string } };
  assert.equal(resumedPayload.data.status, "active");
});

test("PATCH with an unrecognized action returns 400", async () => {
  const { sourceConnectionId } = await createConnection(TENANT_A);
  const response = await itemPatch(request("PATCH", `/api/v1/source-connections/${sourceConnectionId}`, { tenant: TENANT_A, body: { action: "delete" } }), params(sourceConnectionId));
  assert.equal(response.status, 400);
  const payload = await response.json() as { error: string };
  assert.equal(payload.error, "invalid_request");
});

test("PATCH revoke is terminal and blocks a later reauthorize", async () => {
  const { sourceConnectionId } = await createConnection(TENANT_A);

  const revoke = await itemPatch(request("PATCH", `/api/v1/source-connections/${sourceConnectionId}`, { tenant: TENANT_A, body: { action: "revoke" } }), params(sourceConnectionId));
  assert.equal(revoke.status, 200);
  const revokedPayload = await revoke.json() as { data: { status: string } };
  assert.equal(revokedPayload.data.status, "revoked");

  const reauthorizeAfterRevoke = await reauthorizePost(request("POST", `/api/v1/source-connections/${sourceConnectionId}/reauthorize`, { tenant: TENANT_A, body: { secret: { token: "new" } } }), params(sourceConnectionId));
  assert.equal(reauthorizeAfterRevoke.status, 409);
  const payload = await reauthorizeAfterRevoke.json() as { error: string };
  assert.equal(payload.error, "connection_revoked");
});

test("POST reauthorize rejects a missing secret with 400", async () => {
  const { sourceConnectionId } = await createConnection(TENANT_A);
  const response = await reauthorizePost(request("POST", `/api/v1/source-connections/${sourceConnectionId}/reauthorize`, { tenant: TENANT_A, body: {} }), params(sourceConnectionId));
  assert.equal(response.status, 400);
  const payload = await response.json() as { error: string };
  assert.equal(payload.error, "secret_required");
});

test("POST reauthorize rotates the secret and reactivates the connection", async () => {
  const { sourceConnectionId } = await createConnection(TENANT_A);
  const response = await reauthorizePost(request("POST", `/api/v1/source-connections/${sourceConnectionId}/reauthorize`, { tenant: TENANT_A, body: { secret: { token: "rotated" } } }), params(sourceConnectionId));
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: { status: string; consecutiveFailures: number } };
  assert.equal(payload.data.status, "active");
  assert.equal(payload.data.consecutiveFailures, 0);
});

test("POST test fails closed for an unregistered provider", async () => {
  const { sourceConnectionId } = await createConnection(TENANT_A);
  const response = await testPost(request("POST", `/api/v1/source-connections/${sourceConnectionId}/test`, { tenant: TENANT_A }), params(sourceConnectionId));
  assert.equal(response.status, 422);
  const payload = await response.json() as { error: string };
  assert.equal(payload.error, "unregistered_provider");
});

test("POST test activates a pending connection once a driver is registered and reports success", async () => {
  const { sourceConnectionId } = await createConnection(TENANT_A);
  sourceConnectorDrivers().set("acme-portal", {
    providerKey: "acme-portal", connectorVersion: "1.0.0",
    testConnection: async () => ({ ok: true }),
    discover: async () => [],
    download: async () => ({ bytes: Buffer.from(""), contentType: "application/pdf" }),
  });

  const response = await testPost(request("POST", `/api/v1/source-connections/${sourceConnectionId}/test`, { tenant: TENANT_A }), params(sourceConnectionId));
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: { ok: boolean } };
  assert.equal(payload.data.ok, true);

  const statusResponse = await itemGet(request("GET", `/api/v1/source-connections/${sourceConnectionId}`, { tenant: TENANT_A }), params(sourceConnectionId));
  const statusPayload = await statusResponse.json() as { data: { status: string } };
  assert.equal(statusPayload.data.status, "active");
});
