import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { describeConnection } from "../../domain/source-connection-health.ts";
import { DemoSourceConnectionStore } from "../../adapters/source-connection-store.ts";

// See src/modules/sources/server/connections/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
register(new URL("../../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
delete process.env.CORVIS_DATABASE_DSN;

// Demo mode must never reach a database: any outbound request fails the test that made it.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`unexpected network call in demo mode: ${url}${init?.method ? ` ${init.method}` : ""}`);
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });

const { GET: listGet } = await import("@/app/api/v1/source-connections/route");
const { GET: itemGet, PATCH: itemPatch } = await import("@/app/api/v1/source-connections/[sourceConnectionId]/route");
const { POST: reauthorizePost } = await import("@/app/api/v1/source-connections/[sourceConnectionId]/reauthorize/route");
const { GET: activityGet } = await import("@/app/api/v1/source-connections/activity/route");
const { overrideSourceConnectionService, postgresSourceConnectionService, demoSourceConnectionService, sourceConnectionService } = await import("./source-connection-service.ts");

const NOW = new Date("2026-10-02T12:00:00.000Z");
const ID = (slot: number) => `00000000-0000-4000-8000-${String(slot).padStart(12, "d")}`;
const HEALTHY = ID(1);
const STALE = ID(2);
const PAUSED = ID(3);
const REAUTH = ID(4);
const SUSPENDED = ID(5);
const TRANSIENT = ID(6);
const REVOKED = ID(7);

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "demo-user", tenantId: "tenant-store", workspaceId: "workspace-store", roles: ["admin"],
    entitlements: { workspaceIds: ["workspace-store"], sourceDocumentAccessAllowed: true }, authMethod: "demo", sessionId: "s",
    ...overrides,
  };
}

function store(): DemoSourceConnectionStore { return new DemoSourceConnectionStore(() => NOW); }
const refusal = (code: string) => (error: unknown) => error instanceof Error && error.message === code;

test("the demo store seeds a representative spread: healthy, stale, paused, reauthorization, suspended, transient and revoked", () => {
  const connections = store().list(identity());
  assert.equal(connections.length, 7);
  const severities = new Map(connections.map((connection) => [connection.sourceConnectionId, describeConnection(connection, NOW).severity]));
  assert.deepEqual(Object.fromEntries(severities), {
    [HEALTHY]: "healthy", [STALE]: "stale", [PAUSED]: "paused", [REAUTH]: "reauthorization",
    [SUSPENDED]: "suspended", [TRANSIENT]: "transient", [REVOKED]: "revoked",
  });
  const reauth = connections.find((connection) => connection.sourceConnectionId === REAUTH);
  assert.equal(reauth?.lastErrorClass, "auth");
  assert.equal(connections.find((connection) => connection.sourceConnectionId === SUSPENDED)?.lastErrorClass, "permission");
  assert.equal(connections.find((connection) => connection.sourceConnectionId === TRANSIENT)?.lastErrorClass, "network");
  assert.equal(connections.find((connection) => connection.sourceConnectionId === SUSPENDED)?.credentialType, "oauth_authorization_code", "one OAuth connection exercises the unavailable-reauthorize path");
  for (const connection of connections) {
    assert.equal(connection.secretReference, "redacted");
    assert.equal(connection.tenantId, "tenant-store");
    assert.equal(connection.workspaceId, "workspace-store");
  }
  assert.ok(connections.find((connection) => connection.sourceConnectionId === REVOKED)?.revokedAt);
});

test("demo transitions follow the shared rules and keep history and the credential type", () => {
  const demo = store();
  const who = identity();
  assert.equal(demo.transition(who, HEALTHY, "pause").status, "paused");
  assert.throws(() => demo.transition(who, HEALTHY, "pause"), refusal("invalid_transition_from_paused"));
  assert.equal(demo.get(who, HEALTHY).status, "paused", "a refused command changes nothing");
  assert.equal(demo.transition(who, HEALTHY, "resume").status, "active");
  assert.throws(() => demo.transition(who, HEALTHY, "resume"), refusal("invalid_transition_from_active"));
  assert.equal(demo.transition(who, REAUTH, "pause").status, "paused", "a connection that needs reauthorization can be paused");
  assert.throws(() => demo.transition(who, SUSPENDED, "pause"), refusal("invalid_transition_from_suspended"));
  assert.throws(() => demo.transition(who, REVOKED, "resume"), refusal("invalid_transition_from_revoked"));
  assert.equal(demo.activity(who).find((connection) => connection.sourceConnectionId === HEALTHY)?.runs.length, 2, "history is kept");
});

test("revoke is terminal, stamps revokedAt once and is idempotent", () => {
  const demo = store();
  const who = identity();
  const revoked = demo.transition(who, PAUSED, "revoke");
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedAt, NOW.toISOString());
  const again = demo.transition(who, PAUSED, "revoke");
  assert.equal(again.revokedAt, NOW.toISOString());
  const seededRevoked = demo.transition(who, REVOKED, "revoke");
  assert.notEqual(seededRevoked.revokedAt, NOW.toISOString(), "an already-revoked connection keeps its original revocation time");
  assert.throws(() => demo.reauthorize(who, PAUSED), refusal("connection_revoked"));
  assert.throws(() => demo.transition(who, PAUSED, "pause"), refusal("invalid_transition_from_revoked"));
});

test("reauthorizing clears the failure streak and error, keeps a paused connection paused, and refuses a revoked one", () => {
  const demo = store();
  const who = identity();
  const renewed = demo.reauthorize(who, REAUTH);
  assert.equal(renewed.status, "active");
  assert.equal(renewed.consecutiveFailures, 0);
  assert.equal(renewed.lastErrorClass, undefined);
  assert.equal("secret" in renewed, false);
  assert.equal(demo.reauthorize(who, SUSPENDED).status, "active");
  assert.equal(demo.reauthorize(who, PAUSED).status, "paused");
  assert.throws(() => demo.reauthorize(who, REVOKED), refusal("connection_revoked"));
  assert.throws(() => demo.reauthorize(who, ID(99)), refusal("connection_not_found"));
});

test("each tenant and workspace gets its own independent copy", () => {
  const demo = store();
  demo.transition(identity({ tenantId: "tenant-a" }), HEALTHY, "revoke");
  assert.equal(demo.get(identity({ tenantId: "tenant-a" }), HEALTHY).status, "revoked");
  assert.equal(demo.get(identity({ tenantId: "tenant-b" }), HEALTHY).status, "active");
  assert.equal(demo.get(identity({ tenantId: "tenant-a", workspaceId: "other-workspace" }), HEALTHY).status, "active");
  assert.equal(demo.get(identity({ tenantId: "tenant-b" }), HEALTHY).tenantId, "tenant-b");
  assert.throws(() => demo.get(identity(), "not-a-connection"), refusal("connection_not_found"));
});

test("demo activity flags connections that need attention with the production wording and lists runs newest first", () => {
  const demo = store();
  const who = identity();
  const activity = demo.activity(who);
  const byId = new Map(activity.map((connection) => [connection.sourceConnectionId, connection]));
  assert.equal(byId.get(HEALTHY)?.needsAttention, false);
  assert.equal(byId.get(REAUTH)?.attentionReason, "Connection authorization must be renewed before acquisition can continue.");
  assert.equal(byId.get(SUSPENDED)?.attentionReason, "Connection is suspended and needs administrator attention.");
  assert.equal(byId.get(TRANSIENT)?.needsAttention, false, "two transient failures do not yet need attention");
  const runs = byId.get(HEALTHY)!.runs;
  assert.ok(Date.parse(runs[0]!.startedAt) > Date.parse(runs[1]!.startedAt));
  assert.equal(byId.get(HEALTHY)!.runs[0]!.acquisitions.length, 3);
  assert.equal(byId.get(REAUTH)!.runs[0]!.errorClass, "auth");
  assert.equal(byId.get(PAUSED)?.lastSuccessAt !== undefined, true);

  // Recovery is reflected: once reauthorized the attention flag clears (the in-app "notification" is derived, not stored).
  demo.reauthorize(who, REAUTH);
  assert.equal(demo.activity(who).find((connection) => connection.sourceConnectionId === REAUTH)?.needsAttention, false);
});

// ---------------------------------------------------------------------------
// Routes in demo mode (no Postgres)
// ---------------------------------------------------------------------------

function request(method: string, path: string, options: { tenant?: string; roles?: string; body?: unknown } = {}): Request {
  const headers = new Headers({
    "x-corvis-demo-tenant": options.tenant ?? "tenant-routes",
    "x-corvis-demo-workspace": "workspace-routes",
    "x-corvis-demo-subject": "demo-admin",
    "x-corvis-demo-roles": options.roles ?? "admin",
  });
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) { headers.set("content-type", "application/json"); init.body = JSON.stringify(options.body); }
  return new Request(`https://corvis.test${path}`, init);
}
function params(sourceConnectionId: string) { return { params: Promise.resolve({ sourceConnectionId }) } as const; }
type Connection = { sourceConnectionId: string; status: string; consecutiveFailures: number; lastErrorClass?: string };

test("demo mode serves the list without touching Postgres, redacts the secret reference and requires admin", async () => {
  const response = await listGet(request("GET", "/api/v1/source-connections"));
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: Array<Record<string, unknown>> };
  assert.equal(payload.data.length, 7);
  assert.ok(payload.data.every((connection) => !("secretReference" in connection)));
  assert.equal((await listGet(request("GET", "/api/v1/source-connections", { roles: "analyst" }))).status, 403);
  const one = await itemGet(request("GET", `/api/v1/source-connections/${HEALTHY}`), params(HEALTHY));
  assert.equal(one.status, 200);
  assert.equal((await itemGet(request("GET", `/api/v1/source-connections/${ID(98)}`), params(ID(98)))).status, 404);
});

test("pause, resume and revoke work over HTTP with the production status codes", async () => {
  const tenant = "tenant-lifecycle";
  const patch = (id: string, action: string) => itemPatch(request("PATCH", `/api/v1/source-connections/${id}`, { tenant, body: { action } }), params(id));
  const paused = await patch(HEALTHY, "pause");
  assert.equal(paused.status, 200);
  assert.equal((await paused.json() as { data: Connection }).data.status, "paused");
  const again = await patch(HEALTHY, "pause");
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { error: string }).error, "invalid_transition_from_paused");
  assert.equal((await (await patch(HEALTHY, "resume")).json() as { data: Connection }).data.status, "active");
  const revoked = await patch(HEALTHY, "revoke");
  assert.equal((await revoked.json() as { data: Connection }).data.status, "revoked");
  assert.equal((await patch(HEALTHY, "resume")).status, 409);
  assert.equal((await patch(HEALTHY, "explode")).status, 400);
  assert.equal((await patch("not-a-uuid", "pause")).status, 404);
  assert.equal((await itemPatch(request("PATCH", `/api/v1/source-connections/${PAUSED}`, { tenant, roles: "analyst", body: { action: "revoke" } }), params(PAUSED))).status, 403);
  const untouched = await itemGet(request("GET", `/api/v1/source-connections/${PAUSED}`, { tenant }), params(PAUSED));
  assert.equal((await untouched.json() as { data: Connection }).data.status, "paused", "a refused caller changes nothing");
  const otherTenant = await itemGet(request("GET", `/api/v1/source-connections/${HEALTHY}`, { tenant: "tenant-untouched" }), params(HEALTHY));
  assert.equal((await otherTenant.json() as { data: Connection }).data.status, "active");
});

test("reauthorize over HTTP never echoes the credential, clears the error and honours the revoked and missing-secret rules", async () => {
  const tenant = "tenant-reauthorize";
  const send = (id: string, body: unknown) => reauthorizePost(request("POST", `/api/v1/source-connections/${id}/reauthorize`, { tenant, body }), params(id));
  const secret = "tok-SUPER-SECRET-123";
  const ok = await send(REAUTH, { secret: { token: secret } });
  assert.equal(ok.status, 200);
  const text = await ok.text();
  assert.equal(text.includes(secret), false, "the response never contains the submitted credential");
  assert.doesNotMatch(text, /secretReference|"secret"|"token"/);
  const body = JSON.parse(text) as { data: Connection };
  assert.equal(body.data.status, "active");
  assert.equal(body.data.consecutiveFailures, 0);
  assert.equal(body.data.lastErrorClass, undefined);
  assert.equal((await send(REAUTH, {})).status, 400);
  assert.equal((await send(REVOKED, { secret: { token: "x" } })).status, 409);
  assert.equal((await send(ID(97), { secret: { token: "x" } })).status, 404);
  const paused = await send(PAUSED, { secret: { token: "x" } });
  assert.equal((await paused.json() as { data: Connection }).data.status, "paused");
});

test("the activity route answers from the demo store, and attention clears when the connection recovers", async () => {
  const tenant = "tenant-activity";
  const read = async () => (await (await activityGet(request("GET", "/api/v1/source-connections/activity", { tenant }))).json() as { data: Array<{ sourceConnectionId: string; needsAttention: boolean }> }).data;
  const before = await read();
  assert.equal(before.filter((connection) => connection.needsAttention).length, 2);
  await reauthorizePost(request("POST", `/api/v1/source-connections/${REAUTH}/reauthorize`, { tenant, body: { secret: { token: "t" } } }), params(REAUTH));
  const after = await read();
  assert.equal(after.filter((connection) => connection.needsAttention).length, 1);
  assert.equal((await activityGet(request("GET", "/api/v1/source-connections/activity", { tenant, roles: "analyst" }))).status, 403);
});

test("the service selects the demo store in demo mode, Postgres otherwise, and honours an override", () => {
  assert.equal(sourceConnectionService(), demoSourceConnectionService);
  process.env.CORVIS_DEMO_MODE = "";
  try {
    assert.equal(sourceConnectionService(), postgresSourceConnectionService);
  } finally {
    process.env.CORVIS_DEMO_MODE = "true";
  }
  overrideSourceConnectionService(postgresSourceConnectionService);
  assert.equal(sourceConnectionService(), postgresSourceConnectionService);
  overrideSourceConnectionService();
  assert.equal(sourceConnectionService(), demoSourceConnectionService);
});
