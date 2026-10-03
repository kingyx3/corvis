import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { ConnectionTestResult, ConnectorDriver, SecretPayload } from "./source-connectors.ts";
import type { SourceOAuthClient } from "./source-oauth.ts";

// See lib/server/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";
delete process.env.CORVIS_PUBLIC_APP_URL;
delete process.env.CORVIS_GCP_PROJECT_ID;

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
    if (!row) return [];
    return text.includes("'redacted' as secret_reference") ? [{ ...row, secret_reference: "redacted" }] : [row];
  }
  if (text.includes("from corvis_source.source_connection") && text.includes("order by")) {
    return [...rows.values()].filter((row) => row.tenant_id === parameters[0]).map((row) => ({ ...row, secret_reference: "redacted" }));
  }
  if (text.startsWith("update corvis_source.source_connection")) {
    const tenantId = String(parameters[0]);
    const id = String(parameters[1]);
    const row = rows.get(rowKey(tenantId, id));
    if (!row) return [];
    // Honor the compare-and-set predicates the module issues.
    if (text.includes("and status=$4") && row.status !== parameters[3]) return [];
    if (text.includes("and status=$5") && row.status !== parameters[4]) return [];
    if (text.includes("and status='pending_authorization'") && row.status !== "pending_authorization") return [];
    if (text.includes("status<>'revoked'") && row.status === "revoked") return [];
    if (text.includes("secret_reference=$4") && row.secret_reference !== parameters[3]) return [];
    if (text.includes("set status=$3, updated_at=now(), revoked_at=now()")) { row.status = parameters[2]; row.revoked_at = new Date().toISOString(); }
    else if (text.includes("set status=$3, updated_at=now()")) { row.status = parameters[2]; }
    else if (text.includes("status='revoked', revoked_at=now()")) { row.status = "revoked"; row.revoked_at = new Date().toISOString(); }
    else if (text.includes("secret_reference=$3, status=case when status='paused' then 'paused' else 'active' end")) { row.secret_reference = parameters[2]; row.status = row.status === "paused" ? "paused" : "active"; row.consecutive_failures = 0; row.last_error_class = null; }
    else if (text.includes("status='active', last_authorized_at=now()")) { row.status = "active"; }
    else if (text.includes("set status=$3, last_error_class=$4, updated_at=now()")) { row.status = parameters[2]; row.last_error_class = parameters[3]; }
    return [{ status: row.status }];
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

const { GET: providersGet } = await import("@/app/api/v1/source-connections/providers/route");
const { POST: connectPost } = await import("@/app/api/v1/source-connections/connect/route");
const { POST: oauthStartPost } = await import("@/app/api/v1/source-connections/oauth/start/route");
const { POST: oauthCompletePost } = await import("@/app/api/v1/source-connections/oauth/complete/route");
const { GET: itemGet } = await import("@/app/api/v1/source-connections/[sourceConnectionId]/route");
const { POST: testPost } = await import("@/app/api/v1/source-connections/[sourceConnectionId]/test/route");
const { sourceConnectorDrivers, sourceConnectorSecretStore } = await import("./source-connector-runtime.ts");
const { overrideSourceConnectionService, postgresSourceConnectionService } = await import("./source-connection-service.ts");
const { registerApprovedSourceProvider, unregisterApprovedSourceProvider } = await import("./source-providers.ts");
const { runConnectionSync } = await import("./source-connector-sync.ts");

// Demo mode (set above for the demo identity headers) would otherwise serve these routes from the in-memory demo
// store; this file drives the real Postgres-backed path against the fake backend above.
overrideSourceConnectionService(postgresSourceConnectionService);
console.warn = () => undefined;
console.error = () => undefined;
console.info = () => undefined;

const noIngest = { ingest: async () => { throw new Error("nothing is discovered, so nothing may be ingested"); } };

const TENANT = "tenant-connect-pg";
const SECRET_TOKEN = "tok-SUPER-SECRET-9f2";

let nextTest: () => Promise<ConnectionTestResult> = async () => ({ ok: true });
function driver(providerKey: string): ConnectorDriver {
  return {
    providerKey, connectorVersion: "1.0.0",
    testConnection: () => nextTest(),
    discover: async () => [],
    download: async () => ({ bytes: Buffer.alloc(0), contentType: "application/pdf" }),
  };
}

const exchanged: Array<{ code: string; codeVerifier: string; redirectUri: string }> = [];
let failExchange = false;
let lastConsent: { state: string; codeChallenge: string; redirectUri: string } | undefined;
const oauthClient: SourceOAuthClient = {
  authorizationUrl(input) { lastConsent = input; return `https://provider.test/oauth?state=${encodeURIComponent(input.state)}&code_challenge=${input.codeChallenge}`; },
  async exchangeCode(input) {
    exchanged.push(input);
    if (failExchange) throw new Error(`provider said no, echoing ${input.code}`);
    return { accessToken: "oauth-access-SECRET", refreshToken: "oauth-refresh-SECRET" };
  },
};

function approve() {
  registerApprovedSourceProvider({
    providerKey: "acme-portal", displayName: "Acme portal", summary: "Reads Acme quarterly reports.", demo: false,
    connect: { method: "credential", credentialType: "scoped_api_token" },
    scope: [{ label: "Quarterly reports", path: "/q" }], disclosure: { reads: ["Reports."], behaviour: ["Daily."], limits: ["Read only."] },
    connectorVersion: "1.0.0",
  }, driver("acme-portal"));
  registerApprovedSourceProvider({
    providerKey: "acme-oauth", displayName: "Acme data room", summary: "Reads the Acme data room.", demo: false,
    connect: { method: "oauth" },
    scope: [{ label: "Reports folder" }], disclosure: { reads: ["Reports."], behaviour: ["Daily."], limits: ["Read only."] },
    connectorVersion: "2.0.0", oauth: oauthClient,
  }, driver("acme-oauth"));
}
approve();
test.after(() => { unregisterApprovedSourceProvider("acme-portal"); unregisterApprovedSourceProvider("acme-oauth"); });

type Connected = { data: { connection: { sourceConnectionId: string; status: string; providerKey: string; credentialType: string; sourceScope: unknown[] }; test: { ok: boolean; errorClass?: string } } };

function request(method: string, path: string, options: { tenant?: string; roles?: string; body?: unknown; rawBody?: string; cookie?: string } = {}): Request {
  const headers = new Headers({
    "x-corvis-demo-tenant": options.tenant ?? TENANT,
    "x-corvis-demo-workspace": "workspace-1",
    "x-corvis-demo-subject": "demo-admin",
    "x-corvis-demo-roles": options.roles ?? "admin",
  });
  if (options.cookie) headers.set("cookie", options.cookie);
  const init: RequestInit = { method, headers };
  if (options.body !== undefined || options.rawBody !== undefined) { headers.set("content-type", "application/json"); init.body = options.rawBody ?? JSON.stringify(options.body); }
  return new Request(`https://corvis.test${path}`, init);
}
const params = (sourceConnectionId: string) => ({ params: Promise.resolve({ sourceConnectionId }) }) as const;

const connect = (body: Record<string, unknown>, tenant = TENANT) => connectPost(request("POST", "/api/v1/source-connections/connect", { tenant, body: { providerKey: "acme-portal", connectionLabel: "Acme portal", scopeConfirmed: true, secret: { token: SECRET_TOKEN }, ...body } }));
const rowFor = (id: string) => [...rows.values()].find((row) => row.source_connection_id === id)!;

test("the provider list is the approved registry (certified providers plus the labelled demo ones in demo mode), without server-only members", async () => {
  const response = await providersGet(request("GET", "/api/v1/source-connections/providers"));
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: Array<{ providerKey: string; demo: boolean }> };
  assert.deepEqual(payload.data.filter((provider) => !provider.demo).map((provider) => provider.providerKey), ["acme-portal", "acme-oauth"]);
  assert.ok(!JSON.stringify(payload).includes("connectorVersion"));
  assert.ok(!JSON.stringify(payload).includes("exchangeCode"));
});

test("a credential is stored only as a Secret Manager reference: never in Postgres, never in the response, never listed", async () => {
  nextTest = async () => ({ ok: true });
  const response = await connect({});
  assert.equal(response.status, 201);
  const text = await response.text();
  assert.ok(!text.includes(SECRET_TOKEN), "not echoed");
  assert.doesNotMatch(text, /secretReference|projects\//);
  const { data } = JSON.parse(text) as Connected;
  assert.equal(data.connection.status, "active", "a passing first test activates the connection");
  const sync = await runConnectionSync(TENANT, data.connection.sourceConnectionId, "scheduled", { secrets: sourceConnectorSecretStore(), drivers: sourceConnectorDrivers(), ingest: noIngest });
  assert.notEqual(sync.state, "refused", "an active connection is allowed to sync");
  assert.deepEqual(data.test, { ok: true });
  assert.equal(data.connection.credentialType, "scoped_api_token");
  assert.deepEqual(data.connection.sourceScope, [{ label: "Quarterly reports", path: "/q" }], "scope comes from the approved provider");

  const row = rowFor(data.connection.sourceConnectionId);
  assert.match(String(row.secret_reference), /^projects\/[a-z0-9-]+\/secrets\/corvis-src-tenant-connect-pg-acme-portal-\d+$/);
  assert.equal(row.connector_version, "1.0.0");
  assert.ok(!JSON.stringify(row).includes(SECRET_TOKEN), "the database row holds only the reference");
  assert.deepEqual(await sourceConnectorSecretStore().read(String(row.secret_reference)), { token: SECRET_TOKEN }, "the secret store holds the credential");

  const read = await itemGet(request("GET", `/api/v1/source-connections/${data.connection.sourceConnectionId}`), params(data.connection.sourceConnectionId));
  assert.ok(!(await read.text()).includes(SECRET_TOKEN));
});

test("a failed first test blocks scheduled sync: the connection is never active and a sync run refuses it", async () => {
  const cases: Array<[string, ConnectionTestResult, string, string | undefined]> = [
    ["rejected credential", { ok: false, errorClass: "auth", detail: "401 from portal" }, "reauthorization_required", "auth"],
    ["no access", { ok: false, errorClass: "permission" }, "suspended", "permission"],
    ["unreachable", { ok: false, errorClass: "network" }, "pending_authorization", "network"],
    ["unclassified failure", { ok: false }, "pending_authorization", undefined],
  ];
  for (const [label, result, status, errorClass] of cases) {
    nextTest = async () => result;
    const response = await connect({ connectionLabel: label });
    assert.equal(response.status, 201, label);
    const text = await response.text();
    assert.ok(!text.includes("401 from portal"), "driver detail text never reaches the browser");
    const { data } = JSON.parse(text) as Connected;
    assert.equal(data.test.ok, false, label);
    assert.equal(data.test.errorClass, errorClass, label);
    assert.equal(data.connection.status, status, label);
    assert.notEqual(rowFor(data.connection.sourceConnectionId).status, "active", label);
    const sync = await runConnectionSync(TENANT, data.connection.sourceConnectionId, "scheduled", { secrets: sourceConnectorSecretStore(), drivers: sourceConnectorDrivers(), ingest: noIngest });
    assert.equal(sync.state, "refused", `${label}: scheduled sync refuses a connection that is not active`);
  }
});

test("a driver that throws is reported as a failed test, not a failed connect, and the connection stays pending", async () => {
  nextTest = async () => { throw new Error(`driver exploded with ${SECRET_TOKEN}`); };
  const response = await connect({ connectionLabel: "Exploding driver" });
  assert.equal(response.status, 201);
  const text = await response.text();
  assert.ok(!text.includes(SECRET_TOKEN));
  const { data } = JSON.parse(text) as Connected;
  assert.deepEqual(data.test, { ok: false, errorClass: "network" });
  assert.equal(data.connection.status, "pending_authorization");
});

test("a test run on demand returns only pass/fail and a class, and activates a pending connection once it passes", async () => {
  nextTest = async () => ({ ok: false, errorClass: "network", detail: "internal detail" });
  const created = await (await connect({ connectionLabel: "On demand" })).json() as Connected;
  const id = created.data.connection.sourceConnectionId;
  const failing = await testPost(request("POST", `/api/v1/source-connections/${id}/test`), params(id));
  assert.equal(failing.status, 200);
  const failingText = await failing.text();
  assert.ok(!failingText.includes("internal detail"));
  assert.deepEqual((JSON.parse(failingText) as { data: unknown }).data, { ok: false, errorClass: "network" });
  assert.equal(rowFor(id).status, "pending_authorization");

  nextTest = async () => ({ ok: true });
  const passing = await testPost(request("POST", `/api/v1/source-connections/${id}/test`), params(id));
  assert.deepEqual((await passing.json() as { data: unknown }).data, { ok: true });
  assert.equal(rowFor(id).status, "active");
});

test("connect refuses unconfirmed, unapproved, wrong-method, empty-credential and malformed requests, and creates nothing", async () => {
  const before = rows.size;
  assert.equal((await connect({ scopeConfirmed: false })).status, 400);
  assert.equal((await connect({ providerKey: "unknown-portal" })).status, 422);
  assert.equal((await connect({ providerKey: "acme-oauth" })).status, 422);
  assert.equal((await connect({ secret: {} })).status, 400);
  assert.equal((await connect({ secret: undefined })).status, 400);
  assert.equal((await connectPost(request("POST", "/api/v1/source-connections/connect", { rawBody: "{not json" }))).status, 400);
  assert.equal((await connectPost(request("POST", "/api/v1/source-connections/connect", { roles: "analyst", body: {} }))).status, 403);
  assert.equal(rows.size, before);
});

const start = (body: Record<string, unknown> = {}, tenant = TENANT) => oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", { tenant, body: { providerKey: "acme-oauth", connectionLabel: "Acme room", scopeConfirmed: true, ...body } }));
const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;
const complete = (body: unknown, cookie?: string, tenant = TENANT) => oauthCompletePost(request("POST", "/api/v1/source-connections/oauth/complete", { tenant, ...(cookie ? { cookie } : {}), body }));

test("OAuth: state and PKCE are generated server-side, the code is exchanged with the verifier, and only a reference is stored", async () => {
  nextTest = async () => ({ ok: true });
  exchanged.length = 0;
  const started = await start();
  assert.equal(started.status, 200);
  const { authorizationUrl } = (await started.json() as { data: { authorizationUrl: string } }).data;
  assert.match(authorizationUrl, /^https:\/\/provider\.test\/oauth\?state=/);
  assert.equal(lastConsent?.redirectUri, "https://corvis.test/?source_oauth=return");
  assert.match(started.headers.get("set-cookie")!, /HttpOnly/);
  assert.ok(!started.headers.get("set-cookie")!.includes(lastConsent!.state), "the cookie carries a pointer, not the state");

  const completed = await complete({ code: "one-time-code", state: lastConsent!.state }, cookieOf(started));
  assert.equal(completed.status, 201);
  assert.match(completed.headers.get("set-cookie")!, /Max-Age=0/);
  const text = await completed.text();
  assert.doesNotMatch(text, /oauth-access-SECRET|oauth-refresh-SECRET|one-time-code|secretReference/);
  const { data } = JSON.parse(text) as { data: Connected["data"] & { outcome: string } };
  assert.equal(data.outcome, "connected");
  assert.equal(data.connection.credentialType, "oauth_authorization_code");
  assert.equal(data.connection.status, "active");
  assert.equal(exchanged.length, 1);
  assert.equal(exchanged[0]!.code, "one-time-code");
  assert.equal(exchanged[0]!.redirectUri, "https://corvis.test/?source_oauth=return");
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(exchanged[0]!.codeVerifier).digest("base64url"), lastConsent!.codeChallenge, "the exchange proves the PKCE verifier");

  const row = rowFor(data.connection.sourceConnectionId);
  assert.equal(row.connector_version, "2.0.0");
  assert.ok(!JSON.stringify(row).includes("oauth-access-SECRET"));
  assert.deepEqual(await sourceConnectorSecretStore().read(String(row.secret_reference)) as SecretPayload, { accessToken: "oauth-access-SECRET", refreshToken: "oauth-refresh-SECRET" });

  assert.equal((await complete({ code: "one-time-code", state: lastConsent!.state }, cookieOf(started))).status, 400, "single use");
});

test("OAuth: a failed exchange, forged state, missing cookie, foreign tenant or malformed body create nothing", async () => {
  const before = rows.size;
  let started = await start();
  assert.equal((await complete({ code: "c", state: "forged" }, cookieOf(started))).status, 400);

  started = await start();
  assert.equal((await complete({ code: "c", state: lastConsent!.state })).status, 400, "no cookie");
  assert.equal((await complete({ code: "c", state: lastConsent!.state }, cookieOf(started), "tenant-other")).status, 400, "another tenant's session");
  assert.equal((await complete({ code: "", state: lastConsent!.state }, cookieOf(started))).status, 400);
  assert.equal((await complete(null, cookieOf(started))).status, 400);
  assert.equal((await complete([], cookieOf(started))).status, 400);

  started = await start();
  failExchange = true;
  const refused = await complete({ code: "bad-code", state: lastConsent!.state }, cookieOf(started));
  failExchange = false;
  assert.equal(refused.status, 400);
  assert.ok(!(await refused.text()).includes("bad-code"));
  assert.equal(rows.size, before);
});

test("OAuth: declining destroys the attempt; a provider withdrawn mid-flow is refused", async () => {
  const before = rows.size;
  let started = await start();
  const declinedState = lastConsent!.state;
  const denied = await complete({ denied: true }, cookieOf(started));
  assert.equal(denied.status, 200);
  assert.deepEqual((await denied.json() as { data: unknown }).data, { outcome: "denied" });
  assert.equal((await complete({ code: "c", state: declinedState }, cookieOf(started))).status, 400);

  started = await start();
  unregisterApprovedSourceProvider("acme-oauth");
  const withdrawn = await complete({ code: "c", state: lastConsent!.state }, cookieOf(started));
  assert.equal(withdrawn.status, 422);
  approve();
  assert.equal(rows.size, before);
});

test("OAuth start refuses unconfirmed, wrong-method and non-administrator callers", async () => {
  assert.equal((await start({ scopeConfirmed: false })).status, 400);
  assert.equal((await start({ providerKey: "acme-portal" })).status, 422);
  assert.equal((await oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", { roles: "analyst", body: {} }))).status, 403);
});
