import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { ConnectionTestResult, ConnectorDriver, SecretPayload } from "../connectors/source-connectors.ts";
import type { SourceOAuthClient } from "../connectors/source-oauth.ts";
import { RateLimiter } from "../../../../platform/http/limits/rate-limit.ts";
import "../../../../test-support/http-sql-driver.ts";

// See src/modules/sources/server/connections/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
register(new URL("../../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
process.env.CORVIS_DATABASE_DSN = "https://fake-postgres.test/sql";
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";
delete process.env.CORVIS_PUBLIC_APP_URL;
delete process.env.CORVIS_GCP_PROJECT_ID;

// ---- A minimal fake Postgres HTTP backend for corvis_source.source_connection ----
// Mirrors the equivalent in-memory model in src/modules/sources/server/connectors/source-connectors.test.ts,
// dispatching on the same SQL fragments src/modules/sources/server/connectors/source-connectors.ts actually
// issues, so this exercises the real production code path (route -> library ->
// the HTTP SQL test double -> fetch) rather than a stand-in for the library itself.
type Row = Record<string, unknown>;
const rows = new Map<string, Row>();
let failSwap = false;
const audits: Array<{ action: string; targetType: string; targetId: string; outcome: string; metadata: Record<string, unknown> }> = [];
let idCounter = 0;
function rowKey(tenantId: string, id: string): string { return `${tenantId}:${id}`; }

function handleSql(sql: string, parameters: unknown[]): Row[] {
  const text = sql.trim();
  if (text.startsWith("insert into corvis_control.audit_event")) {
    audits.push({ action: String(parameters[5]), targetType: String(parameters[6]), targetId: String(parameters[7]), outcome: String(parameters[8]), metadata: JSON.parse(String(parameters[10])) as Record<string, unknown> });
    return [];
  }
  if (/^insert into corvis_source\.source_connection\s/.test(text)) {
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
    if (failSwap && text.includes("set secret_reference=$3, updated_at=now()")) throw new Error("database unavailable");
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
    else if (text.includes("set secret_reference=$3, updated_at=now()")) { row.secret_reference = parameters[2]; }
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
  if (url !== process.env.CORVIS_DATABASE_DSN) return originalFetch(input, init);
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
const { sourceConnectorDrivers, sourceConnectorSecretStore } = await import("../connectors/source-connector-runtime.ts");
const { overrideSourceConnectionService, postgresSourceConnectionService } = await import("./source-connection-service.ts");
const { registerApprovedSourceProvider, unregisterApprovedSourceProvider } = await import("../connectors/source-providers.ts");
const { runConnectionSync } = await import("../connectors/source-connector-sync.ts");
const { overrideSourceConnectLimiter } = await import("./source-connect-limits.ts");
const { POST: reauthorizePost } = await import("@/app/api/v1/source-connections/[sourceConnectionId]/reauthorize/route");

// Demo mode (set above for the demo identity headers) would otherwise serve these routes from the in-memory demo
// store; this file drives the real Postgres-backed path against the fake backend above.
overrideSourceConnectionService(postgresSourceConnectionService);
// Most cases here make many attempts as one administrator; the budget itself is exercised by its own test below.
const GENEROUS = new RateLimiter(1_000_000);
overrideSourceConnectLimiter(GENEROUS);
console.warn = () => undefined;
console.error = () => undefined;
console.info = () => undefined;

const noIngest = { ingest: async () => { throw new Error("nothing is discovered, so nothing may be ingested"); } };

const TENANT = "tenant-connect-pg";
const SECRET_TOKEN = "tok-SUPER-SECRET-9f2";

let nextTest: () => Promise<ConnectionTestResult> = async () => ({ ok: true });
/** The credential the driver was last tested with, so a case can see what a refresh handed it. */
let testedWith: SecretPayload | undefined;
function driver(providerKey: string): ConnectorDriver {
  return {
    providerKey, connectorVersion: "1.0.0",
    testConnection: (credential) => { testedWith = credential; return nextTest(); },
    discover: async () => [],
    download: async () => ({ bytes: Buffer.alloc(0), contentType: "application/pdf" }),
  };
}

const exchanged: Array<{ code: string; codeVerifier: string; redirectUri: string }> = [];
let failExchange = false;
let nextRefresh: (input: { refreshToken: string }) => Promise<SecretPayload> = async () => { throw new Error("refresh not expected"); };
let lastConsent: { state: string; codeChallenge: string; redirectUri: string } | undefined;
const oauthClient: SourceOAuthClient = {
  authorizationUrl(input) { lastConsent = input; return `https://provider.test/oauth?state=${encodeURIComponent(input.state)}&code_challenge=${input.codeChallenge}`; },
  async exchangeCode(input) {
    exchanged.push(input);
    if (failExchange) throw new Error(`provider said no, echoing ${input.code}`);
    return { accessToken: "oauth-access-SECRET", refreshToken: "oauth-refresh-SECRET" };
  },
  refresh: (input) => nextRefresh(input),
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

function request(method: string, path: string, options: { tenant?: string; roles?: string; body?: unknown; rawBody?: string; cookie?: string; subject?: string } = {}): Request {
  const headers = new Headers({
    "x-corvis-demo-tenant": options.tenant ?? TENANT,
    "x-corvis-demo-workspace": "workspace-1",
    "x-corvis-demo-subject": options.subject ?? "demo-admin",
    "x-corvis-demo-roles": options.roles ?? "admin",
  });
  if (options.cookie) headers.set("cookie", options.cookie);
  const init: RequestInit = { method, headers };
  if (options.body !== undefined || options.rawBody !== undefined) { headers.set("content-type", "application/json"); init.body = options.rawBody ?? JSON.stringify(options.body); }
  return new Request(`https://corvis.test${path}`, init);
}
const params = (sourceConnectionId: string) => ({ params: Promise.resolve({ sourceConnectionId }) }) as const;

/** Retires any live connection to the provider in a tenant, so a case that connects it again is not stopped by the duplicate guard (which has its own test). */
function freeProvider(tenant: string, providerKey: string): void {
  for (const row of rows.values()) if (row.tenant_id === tenant && row.provider_key === providerKey) row.status = "revoked";
}
const connect = (body: Record<string, unknown>, tenant = TENANT) => {
  freeProvider(tenant, String(body.providerKey ?? "acme-portal"));
  return connectPost(request("POST", "/api/v1/source-connections/connect", { tenant, body: { providerKey: "acme-portal", connectionLabel: "Acme portal", scopeConfirmed: true, secret: { token: SECRET_TOKEN }, ...body } }));
};
const rowFor = (id: string) => [...rows.values()].find((row) => row.source_connection_id === id)!;

test("the provider list is the approved registry (certified providers plus the labelled demo ones in demo mode), without server-only members", async () => {
  const response = await providersGet(request("GET", "/api/v1/source-connections/providers"));
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: Array<{ providerKey: string; demo: boolean }> };
  assert.deepEqual(payload.data.filter((provider) => !provider.demo).map((provider) => provider.providerKey), ["acme-portal", "acme-oauth", "acme-choice", "acme-choice-oauth"]);
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

  // Something that is not an Error at all (a rejected string) is handled the same way.
  nextTest = () => Promise.reject(SECRET_TOKEN);
  const odd = await (await connect({ connectionLabel: "Odd rejection" })).json() as Connected;
  assert.deepEqual(odd.data.test, { ok: false, errorClass: "network" });
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

const start = (body: Record<string, unknown> = {}, tenant = TENANT) => {
  freeProvider(tenant, "acme-oauth");
  return oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", { tenant, body: { providerKey: "acme-oauth", connectionLabel: "Acme room", scopeConfirmed: true, ...body } }));
};
const startRaw = (body: unknown, tenant = TENANT) => oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", { tenant, body }));
const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;
const complete = (body: unknown, cookie?: string, tenant = TENANT, subject?: string) => oauthCompletePost(request("POST", "/api/v1/source-connections/oauth/complete", { tenant, ...(cookie ? { cookie } : {}), ...(subject ? { subject } : {}), body }));

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

// ---------------------------------------------------------------------------------------------------------------
// B1b / B1d: duplicate guard, per-administrator attempt budget, audit of the sign-in, OAuth reauthorization, token lifecycle
// ---------------------------------------------------------------------------------------------------------------

type OAuthResult = { data: { outcome: string; connection: { sourceConnectionId: string; status: string }; test: { ok: boolean; errorClass?: string } } };
const asJson = async <T>(response: Response): Promise<T> => await response.json() as T;

async function connectViaOAuth(tenant: string): Promise<string> {
  nextTest = async () => ({ ok: true });
  const started = await start({}, tenant);
  assert.equal(started.status, 200);
  const done = await complete({ code: "first-code", state: lastConsent!.state }, cookieOf(started), tenant);
  assert.equal(done.status, 201);
  return (await asJson<OAuthResult>(done)).data.connection.sourceConnectionId;
}

/** An OAuth connection whose stored credential is exactly `secret`, so expiry and refresh can be exercised. */
async function oauthConnectionWith(tenant: string, secret: SecretPayload): Promise<{ id: string; reference: string }> {
  const id = await connectViaOAuth(tenant);
  const reference = await sourceConnectorSecretStore().write(tenant, "acme-oauth", secret);
  rowFor(id).secret_reference = reference;
  return { id, reference };
}

const readable = (reference: string) => sourceConnectorSecretStore().read(reference).then(() => true, () => false);
const testRoute = (id: string, tenant: string) => testPost(request("POST", `/api/v1/source-connections/${id}/test`, { tenant }), params(id));

test("a workspace already connected to a provider is refused a second connection, by credential or by sign-in, until it is revoked", async () => {
  const tenant = "tenant-dup";
  const connectBody = { providerKey: "acme-portal", connectionLabel: "Acme portal", scopeConfirmed: true, secret: { token: SECRET_TOKEN } };
  const attempt = () => connectPost(request("POST", "/api/v1/source-connections/connect", { tenant, body: connectBody }));
  nextTest = async () => ({ ok: true });
  assert.equal((await attempt()).status, 201);

  const before = rows.size;
  const refused = await attempt();
  assert.equal(refused.status, 409);
  assert.equal((await asJson<{ error: string }>(refused)).error, "source_connection_already_exists");
  assert.equal(rows.size, before, "nothing was created and no secret was written for the refused attempt");
  assert.equal((await connectPost(request("POST", "/api/v1/source-connections/connect", { tenant: "tenant-dup-other", body: connectBody }))).status, 201, "another organization is unaffected");

  // The same guard holds for a sign-in: refused at the start, and again at the finish if the other connection appeared meanwhile.
  const startOAuth = () => oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", { tenant, body: { providerKey: "acme-oauth", connectionLabel: "Acme room", scopeConfirmed: true } }));
  const first = await startOAuth();
  assert.equal(first.status, 200);
  const firstState = lastConsent!.state;
  const second = await startOAuth();
  assert.equal(second.status, 200, "nothing is connected yet, so a second start is allowed");
  const secondState = lastConsent!.state;
  assert.equal((await complete({ code: "c1", state: firstState }, cookieOf(first), tenant)).status, 201);
  const lost = await complete({ code: "c2", state: secondState }, cookieOf(second), tenant);
  assert.equal(lost.status, 409);
  assert.equal((await asJson<{ error: string }>(lost)).error, "source_connection_already_exists");
  const blocked = await startOAuth();
  assert.equal(blocked.status, 409);

  // A revoked connection never blocks a new one.
  for (const row of rows.values()) if (row.tenant_id === tenant && row.provider_key === "acme-portal") row.status = "revoked";
  assert.equal((await attempt()).status, 201);
});

test("each administrator has a small budget of connect attempts per window; finishing a sign-in and malformed requests do not spend it", async () => {
  overrideSourceConnectLimiter(new RateLimiter(3, 60_000));
  try {
    const tenant = "tenant-limit";
    assert.equal((await connectPost(request("POST", "/api/v1/source-connections/connect", { tenant, rawBody: "{not json" }))).status, 400, "a malformed request is refused before it counts");
    const started = await start({}, tenant);
    assert.equal(started.status, 200, "attempt 1: the sign-in start");
    const done = await complete({ code: "c", state: lastConsent!.state }, cookieOf(started), tenant);
    assert.equal(done.status, 201, "finishing it spends nothing");
    const id = (await asJson<OAuthResult>(done)).data.connection.sourceConnectionId;
    assert.equal((await connect({}, tenant)).status, 201, "attempt 2: a credential connect");
    assert.equal((await startRaw({ sourceConnectionId: id }, tenant)).status, 200, "attempt 3: the start of a reauthorization counts too");

    const limited = await connect({ connectionLabel: "One too many" }, tenant);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal((await asJson<{ error: string }>(limited)).error, "rate_limited");
    assert.equal((await start({}, tenant)).status, 429);
    assert.equal((await startRaw({ sourceConnectionId: id }, tenant)).status, 429);
    assert.equal((await start({}, "tenant-limit-other")).status, 200, "the budget is per administrator");
  } finally { overrideSourceConnectLimiter(GENEROUS); }
});

test("starting and declining a sign-in are audited with the provider and nothing secret; a decline that names no attempt of this administrator is not", async () => {
  const tenant = "tenant-audit";
  audits.length = 0;
  const started = await start({}, tenant);
  assert.deepEqual(audits.map((entry) => [entry.action, entry.targetType, entry.targetId, entry.outcome]), [["source_connection.oauth_start", "source_connection", "acme-oauth", "success"]]);
  assert.equal(audits[0]!.metadata.providerKey, "acme-oauth");
  const state = lastConsent!.state;

  // Another administrator in the same organization cannot have this attempt recorded as their own: it is destroyed, silently.
  assert.equal((await complete({ denied: true }, cookieOf(started), tenant, "other-admin")).status, 200);
  assert.equal(audits.length, 1);
  assert.equal((await complete({ code: "c", state }, cookieOf(started), tenant)).status, 400, "the attempt is gone");

  const second = await start({}, tenant);
  assert.equal((await complete({ denied: true }, cookieOf(second), tenant)).status, 200);
  assert.deepEqual(audits.map((entry) => [entry.action, entry.targetId]), [["source_connection.oauth_start", "acme-oauth"], ["source_connection.oauth_start", "acme-oauth"], ["source_connection.oauth_declined", "acme-oauth"]]);
  assert.equal((await complete({ denied: true }, cookieOf(second), tenant)).status, 200, "declining twice is harmless");
  assert.equal((await complete({ denied: true }, undefined, tenant)).status, 200, "so is declining with no attempt at all");
  assert.equal((await complete({ denied: true }, "corvis_source_oauth=projects%2Fp%2Fsecrets%2Fcorvis-src-someone-else-oauth-attempt-1", tenant)).status, 200, "or with another organization's pointer");
  assert.equal(audits.length, 3, "none of those recorded anything");
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(`${state}|verifier|SECRET|code_challenge`));
});

test("OAuth reauthorization: the card's sign-in rotates the secret, retires the old one, tests, and returns the connection to active", async () => {
  const tenant = "tenant-reauth";
  const id = await connectViaOAuth(tenant);
  const previous = String(rowFor(id).secret_reference);
  Object.assign(rowFor(id), { status: "reauthorization_required", last_error_class: "auth" });
  const connections = rows.size;
  audits.length = 0;
  exchanged.length = 0;

  const started = await startRaw({ sourceConnectionId: id }, tenant);
  assert.equal(started.status, 200);
  assert.match(started.headers.get("set-cookie")!, /HttpOnly/);
  const done = await complete({ code: "reauth-code", state: lastConsent!.state }, cookieOf(started), tenant);
  assert.equal(done.status, 200);
  assert.match(done.headers.get("set-cookie")!, /Max-Age=0/);
  const text = await done.text();
  assert.doesNotMatch(text, /oauth-access-SECRET|oauth-refresh-SECRET|reauth-code|secretReference|projects\//);
  const { data } = JSON.parse(text) as OAuthResult;
  assert.equal(data.outcome, "reauthorized");
  assert.equal(data.connection.sourceConnectionId, id);
  assert.deepEqual(data.test, { ok: true });
  assert.equal(data.connection.status, "active", "a passing test leaves the connection active again");
  assert.equal(rows.size, connections, "the connection was renewed, not duplicated");
  assert.equal(exchanged.length, 1);
  assert.equal(exchanged[0]!.code, "reauth-code");

  const current = String(rowFor(id).secret_reference);
  assert.notEqual(current, previous, "the secret was rotated");
  assert.equal(await readable(previous), false, "the previous credential is destroyed");
  assert.deepEqual(await sourceConnectorSecretStore().read(current), { accessToken: "oauth-access-SECRET", refreshToken: "oauth-refresh-SECRET" });
  assert.deepEqual(audits.map((entry) => [entry.action, entry.targetId]), [["source_connection.oauth_start", id], ["source_connection.reauthorize", id], ["source_connection.test", id]]);
  assert.equal((await complete({ code: "reauth-code", state: lastConsent!.state }, cookieOf(started), tenant)).status, 400, "single use");
});

test("OAuth reauthorization with a failing test is reported honestly: the credential is stored and the connection is not active", async () => {
  const tenant = "tenant-reauth-fails";
  const id = await connectViaOAuth(tenant);
  rowFor(id).status = "suspended";
  nextTest = async () => ({ ok: false, errorClass: "auth" });
  const started = await startRaw({ sourceConnectionId: id }, tenant);
  const done = await complete({ code: "c", state: lastConsent!.state }, cookieOf(started), tenant);
  assert.equal(done.status, 200);
  const { data } = await asJson<OAuthResult>(done);
  assert.deepEqual(data.test, { ok: false, errorClass: "auth" });
  assert.equal(data.connection.status, "reauthorization_required");

  // A driver that throws after the credential was saved is a failed test, not a failed request.
  rowFor(id).status = "suspended";
  nextTest = async () => { throw new Error("driver exploded"); };
  const again = await startRaw({ sourceConnectionId: id }, tenant);
  const crashed = await complete({ code: "c", state: lastConsent!.state }, cookieOf(again), tenant);
  assert.equal(crashed.status, 200);
  assert.deepEqual((await asJson<OAuthResult>(crashed)).data.test, { ok: false, errorClass: "network" });
});

test("OAuth reauthorization is refused for a revoked, unknown, foreign, non-OAuth or withdrawn connection, and a decline of one is audited against it", async () => {
  const tenant = "tenant-reauth-refused";
  const id = await connectViaOAuth(tenant);

  rowFor(id).status = "revoked";
  const revoked = await startRaw({ sourceConnectionId: id }, tenant);
  assert.equal(revoked.status, 409);
  assert.equal((await asJson<{ error: string }>(revoked)).error, "connection_revoked");
  rowFor(id).status = "active";

  assert.equal((await startRaw({ sourceConnectionId: "00000000-0000-4000-8000-000000000999" }, tenant)).status, 404);
  assert.equal((await startRaw({ sourceConnectionId: "not-a-uuid" }, tenant)).status, 404);
  assert.equal((await startRaw({ sourceConnectionId: 7 }, tenant)).status, 400);
  assert.equal((await startRaw({ sourceConnectionId: id }, "tenant-reauth-foreign")).status, 404, "another organization cannot renew it");
  assert.equal((await oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", { tenant, roles: "analyst", body: { sourceConnectionId: id } }))).status, 403);

  const token = await (await connect({ connectionLabel: "Token portal" }, tenant)).json() as Connected;
  const tokenId = token.data.connection.sourceConnectionId;
  assert.equal((await startRaw({ sourceConnectionId: tokenId }, tenant)).status, 400, "only an OAuth sign-in connection is renewed by signing in");

  // A decline of a renewal is audited against the connection, and leaves the connection and its secret alone.
  const reference = String(rowFor(id).secret_reference);
  const started = await startRaw({ sourceConnectionId: id }, tenant);
  audits.length = 0;
  assert.equal((await complete({ denied: true }, cookieOf(started), tenant)).status, 200);
  assert.deepEqual(audits.map((entry) => [entry.action, entry.targetId]), [["source_connection.oauth_declined", id]]);
  assert.equal(rowFor(id).secret_reference, reference);
  assert.equal(rowFor(id).status, "active");

  // A provider withdrawn between the start and the finish is refused, and so is one withdrawn before the start.
  const pending = await startRaw({ sourceConnectionId: id }, tenant);
  unregisterApprovedSourceProvider("acme-oauth");
  try {
    assert.equal((await complete({ code: "c", state: lastConsent!.state }, cookieOf(pending), tenant)).status, 422);
    assert.equal((await startRaw({ sourceConnectionId: id }, tenant)).status, 422);
  } finally { approve(); }
  assert.equal(rowFor(id).secret_reference, reference);
});

test("a connection that signs in with OAuth cannot have a pasted credential posted to it; token connections still can", async () => {
  const tenant = "tenant-reauth-direct";
  const id = await connectViaOAuth(tenant);
  const reference = String(rowFor(id).secret_reference);
  const post = (target: string, body: unknown) => reauthorizePost(request("POST", `/api/v1/source-connections/${target}/reauthorize`, { tenant, body }), params(target));
  const refused = await post(id, { secret: { token: "pasted" } });
  assert.equal(refused.status, 409);
  assert.equal((await asJson<{ error: string }>(refused)).error, "oauth_reauthorization_required");
  assert.equal(rowFor(id).secret_reference, reference);

  const tokenId = ((await (await connect({ connectionLabel: "Token portal" }, tenant)).json()) as Connected).data.connection.sourceConnectionId;
  assert.equal((await post(tokenId, { secret: { token: "rotated" } })).status, 200);
});

test("an expired OAuth credential is refreshed before it is used: the replacement is stored, audited, and the old secret destroyed", async () => {
  const tenant = "tenant-refresh";
  const { id, reference } = await oauthConnectionWith(tenant, { accessToken: "old-access", refreshToken: "refresh-1", expiresAt: Date.now() - 1_000 });
  const refreshed: string[] = [];
  nextRefresh = async ({ refreshToken }) => { refreshed.push(refreshToken); return { accessToken: "new-access", expiresAt: Date.now() + 3_600_000 }; };
  nextTest = async () => ({ ok: true });
  testedWith = undefined;
  audits.length = 0;

  const response = await testRoute(id, tenant);
  assert.equal(response.status, 200);
  assert.deepEqual((await asJson<{ data: unknown }>(response)).data, { ok: true });
  assert.deepEqual(refreshed, ["refresh-1"]);
  assert.equal(testedWith!.accessToken, "new-access", "the driver was tested with the refreshed credential");
  assert.equal(testedWith!.refreshToken, "refresh-1", "a provider that does not rotate the refresh token keeps the old one");
  const current = String(rowFor(id).secret_reference);
  assert.notEqual(current, reference);
  assert.equal(await readable(reference), false);
  assert.equal((await sourceConnectorSecretStore().read(current)).accessToken, "new-access");
  assert.deepEqual(audits.map((entry) => entry.action), ["source_connection.token_refresh", "source_connection.test"]);

  // A credential with plenty of life left is used as it is, with no call to the provider.
  refreshed.length = 0;
  assert.equal((await testRoute(id, tenant)).status, 200);
  assert.deepEqual(refreshed, []);
});

test("an expired OAuth credential that cannot be renewed fails the test with the class that sends the connection to reauthorization", async () => {
  const cases: Array<[string, SecretPayload, () => Promise<SecretPayload>]> = [
    ["the provider refuses the refresh token", { accessToken: "a", refreshToken: "dead", expiresAt: Date.now() - 1_000 }, async () => { throw new Error("invalid_grant"); }],
    ["there is no refresh token", { accessToken: "a", expiresAt: Date.now() - 1_000 }, async () => { throw new Error("not called"); }],
  ];
  for (const [index, [label, secret, refresh]] of cases.entries()) {
    const tenant = `tenant-expired-${index}`;
    const { id, reference } = await oauthConnectionWith(tenant, secret);
    nextRefresh = refresh;
    testedWith = undefined;
    const response = await testRoute(id, tenant);
    assert.deepEqual((await asJson<{ data: unknown }>(response)).data, { ok: false, errorClass: "reauthorization" }, label);
    assert.equal(rowFor(id).status, "reauthorization_required", label);
    assert.equal(testedWith, undefined, `${label}: the driver was never called with a dead credential`);
    assert.equal(rowFor(id).secret_reference, reference, label);
  }
});

test("a credential about to expire is used while it is still valid even if the provider refuses the refresh", async () => {
  const tenant = "tenant-expiring";
  const { id } = await oauthConnectionWith(tenant, { accessToken: "still-good", refreshToken: "dead", expiresAt: Date.now() + 30_000 });
  nextRefresh = async () => { throw new Error("invalid_grant"); };
  nextTest = async () => ({ ok: true });
  testedWith = undefined;
  assert.deepEqual((await asJson<{ data: unknown }>(await testRoute(id, tenant))).data, { ok: true });
  assert.equal(testedWith!.accessToken, "still-good");
  assert.equal(rowFor(id).status, "active");
});

test("a refresh that loses a race to another rotation, or cannot be saved, never leaves a live orphan secret", async () => {
  const store = sourceConnectorSecretStore();
  const revoked: string[] = [];
  const original = store.revoke.bind(store);
  store.revoke = async (reference) => { revoked.push(reference); return original(reference); };
  try {
    const tenant = "tenant-refresh-race";
    const { id, reference } = await oauthConnectionWith(tenant, { accessToken: "old", refreshToken: "r", expiresAt: Date.now() - 1_000 });
    nextTest = async () => ({ ok: true });
    // Someone else rotates the secret while the provider is answering.
    nextRefresh = async () => { rowFor(id).secret_reference = "rotated-by-someone-else"; return { accessToken: "mine", expiresAt: Date.now() + 3_600_000 }; };
    audits.length = 0;
    revoked.length = 0;
    testedWith = undefined;
    assert.equal((await testRoute(id, tenant)).status, 200);
    assert.equal(testedWith!.accessToken, "mine", "this call still uses the credential it just obtained");
    assert.equal(rowFor(id).secret_reference, "rotated-by-someone-else", "the other rotation stands");
    assert.equal(revoked.length, 1);
    assert.notEqual(revoked[0], reference, "the replacement made here was destroyed, not the current one");
    assert.ok(!audits.some((entry) => entry.action === "source_connection.token_refresh"));

    // The swap itself fails: the request fails, the old secret stays, and the new one is destroyed.
    const second = await oauthConnectionWith("tenant-refresh-fail", { accessToken: "old", refreshToken: "r", expiresAt: Date.now() - 1_000 });
    nextRefresh = async () => ({ accessToken: "new", expiresAt: Date.now() + 3_600_000 });
    failSwap = true;
    revoked.length = 0;
    try { assert.equal((await testRoute(second.id, "tenant-refresh-fail")).status, 500); } finally { failSwap = false; }
    assert.equal(rowFor(second.id).secret_reference, second.reference);
    assert.equal(revoked.length, 1);
    assert.notEqual(revoked[0], second.reference);
  } finally { store.revoke = original; }
});

test("only an OAuth credential is ever refreshed", async () => {
  const tenant = "tenant-refresh-token";
  const created = await (await connect({ connectionLabel: "Token with an expiry field" }, tenant)).json() as Connected;
  const id = created.data.connection.sourceConnectionId;
  rowFor(id).secret_reference = await sourceConnectorSecretStore().write(tenant, "acme-portal", { token: "t", expiresAt: Date.now() - 1_000, refreshToken: "r" });
  nextRefresh = async () => { throw new Error("must not be called for a token connection"); };
  nextTest = async () => ({ ok: true });
  assert.deepEqual((await asJson<{ data: unknown }>(await testRoute(id, tenant))).data, { ok: true });
});

// ---- Choosing which of a provider's folders to read (B1d) ----

const CHOICE_SCOPE = [{ id: "q", label: "Quarterly reports", path: "/Fund/Quarterly" }, { id: "c", label: "Capital accounts", path: "/Fund/Capital" }, { id: "s", label: "Side letters", path: "/Fund/Letters" }];
const scopesDiscovered: Array<Array<{ label: string; path?: string }>> = [];
function choiceDriver(providerKey: string): ConnectorDriver {
  return { ...driver(providerKey), discover: async (_credential, scope) => { scopesDiscovered.push(scope); return []; } };
}
function approveChoice(scope: typeof CHOICE_SCOPE | Array<{ label: string }> = CHOICE_SCOPE) {
  registerApprovedSourceProvider({
    providerKey: "acme-choice", displayName: "Acme choice portal", summary: "Reads folders you pick.", demo: false,
    connect: { method: "credential", credentialType: "scoped_api_token" }, scope,
    disclosure: { reads: ["Reports."], behaviour: ["Daily."], limits: ["Read only."] }, connectorVersion: "1.0.0",
  }, choiceDriver("acme-choice"));
  registerApprovedSourceProvider({
    providerKey: "acme-choice-oauth", displayName: "Acme choice room", summary: "Reads folders you pick after sign-in.", demo: false,
    connect: { method: "oauth" }, scope,
    disclosure: { reads: ["Reports."], behaviour: ["Daily."], limits: ["Read only."] }, connectorVersion: "2.0.0", oauth: oauthClient,
  }, choiceDriver("acme-choice-oauth"));
}
approveChoice();
test.after(() => { unregisterApprovedSourceProvider("acme-choice"); unregisterApprovedSourceProvider("acme-choice-oauth"); });
const storedScope = (id: string) => JSON.parse(String(rowFor(id).source_scope)) as unknown;

test("a connection can be narrowed to the folders the administrator kept; what is stored is exactly that, and sync reads only it", async () => {
  nextTest = async () => ({ ok: true });
  const listed = await (await providersGet(request("GET", "/api/v1/source-connections/providers"))).json() as { data: Array<{ providerKey: string; scope: unknown[] }> };
  assert.deepEqual(listed.data.find((provider) => provider.providerKey === "acme-choice")!.scope, CHOICE_SCOPE, "the descriptor carries the provider-declared folder ids");

  const response = await connect({ providerKey: "acme-choice", selectedScopeIds: ["s", "q"] });
  assert.equal(response.status, 201);
  const { data } = await response.json() as Connected;
  const expected = [{ label: "Quarterly reports", path: "/Fund/Quarterly" }, { label: "Side letters", path: "/Fund/Letters" }];
  assert.deepEqual(data.connection.sourceScope, expected, "in the provider's order, without the internal ids");
  assert.deepEqual(storedScope(data.connection.sourceConnectionId), expected);

  scopesDiscovered.length = 0;
  const sync = await runConnectionSync(TENANT, data.connection.sourceConnectionId, "scheduled", { secrets: sourceConnectorSecretStore(), drivers: sourceConnectorDrivers(), ingest: noIngest });
  assert.equal(sync.state, "succeeded");
  assert.deepEqual(scopesDiscovered, [expected], "the driver is only ever asked about the narrowed scope");

  const whole = await (await connect({ providerKey: "acme-choice" })).json() as Connected;
  assert.equal(whole.data.connection.sourceScope.length, 3, "no selection means everything the provider declares");
});

test("a selection is checked against the registry, never trusted: unknown, empty, duplicate and unoffered choices create nothing", async () => {
  const before = rows.size;
  for (const selectedScopeIds of [[], ["nope"], ["q", "q"], ["q", "/etc/passwd"], "q", [1], null]) {
    assert.equal((await connect({ providerKey: "acme-choice", selectedScopeIds })).status, 400, JSON.stringify(selectedScopeIds));
  }
  assert.equal((await connect({ providerKey: "acme-portal", selectedScopeIds: ["q"] })).status, 400, "a provider that declares no choice refuses any selection");
  assert.equal(rows.size, before);
});

test("OAuth: the chosen folders survive the redirect and are re-checked when the connection is created", async () => {
  nextTest = async () => ({ ok: true });
  freeProvider(TENANT, "acme-choice-oauth");
  const started = await oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", { body: { providerKey: "acme-choice-oauth", connectionLabel: "Room", scopeConfirmed: true, selectedScopeIds: ["c"] } }));
  assert.equal(started.status, 200);
  const completed = await complete({ code: "code", state: lastConsent!.state }, cookieOf(started));
  assert.equal(completed.status, 201);
  const { data } = await completed.json() as Connected;
  assert.deepEqual(data.connection.sourceScope, [{ label: "Capital accounts", path: "/Fund/Capital" }]);
  assert.deepEqual(storedScope(data.connection.sourceConnectionId), [{ label: "Capital accounts", path: "/Fund/Capital" }]);

  const before = rows.size;
  freeProvider(TENANT, "acme-choice-oauth");
  const bad = await oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", { body: { providerKey: "acme-choice-oauth", connectionLabel: "Room", scopeConfirmed: true, selectedScopeIds: ["nope"] } }));
  assert.equal(bad.status, 400, "refused before the administrator is sent anywhere");
  assert.equal(bad.headers.get("set-cookie"), null);

  // The provider changes what it offers between the redirect out and the redirect back: the old choice no longer stands.
  freeProvider(TENANT, "acme-choice-oauth");
  const second = await oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", { body: { providerKey: "acme-choice-oauth", connectionLabel: "Room", scopeConfirmed: true, selectedScopeIds: ["s"] } }));
  const state = lastConsent!.state;
  unregisterApprovedSourceProvider("acme-choice-oauth");
  approveChoice([{ label: "One folder only" }]);
  const stale = await complete({ code: "code", state }, cookieOf(second));
  assert.equal(stale.status, 400);
  assert.equal(rows.size, before, "no connection was created");
  unregisterApprovedSourceProvider("acme-choice");
  unregisterApprovedSourceProvider("acme-choice-oauth");
  approveChoice();
});
