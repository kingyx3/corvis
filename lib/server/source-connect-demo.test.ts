import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { DemoSourceConnectionStore } from "../../adapters/demo/source-connection-store.ts";
import { DEMO_OAUTH_PROVIDER_KEY, DEMO_SOURCE_PROVIDERS, DEMO_TOKEN_PROVIDER_KEY, DEMO_TOKENS, demoTestOutcome } from "../../adapters/demo/source-providers.ts";

// See lib/server/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
delete process.env.CORVIS_POSTGRES_DSN;
delete process.env.CORVIS_PUBLIC_APP_URL;
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";

// Demo mode must never reach a database or any provider: any outbound request fails the test that made it.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call in demo mode: ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url}`);
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });
console.warn = () => undefined;

const { GET: providersGet } = await import("@/app/api/v1/source-connections/providers/route");
const { POST: connectPost } = await import("@/app/api/v1/source-connections/connect/route");
const { POST: oauthStartPost } = await import("@/app/api/v1/source-connections/oauth/start/route");
const { POST: oauthCompletePost } = await import("@/app/api/v1/source-connections/oauth/complete/route");
const { GET: consentGet } = await import("@/app/api/v1/source-connections/oauth/demo-consent/route");
const { GET: listGet } = await import("@/app/api/v1/source-connections/route");
const { POST: testPost } = await import("@/app/api/v1/source-connections/[sourceConnectionId]/test/route");

const ID = (slot: number) => `00000000-0000-4000-8000-${String(slot).padStart(12, "d")}`;
const HEALTHY = ID(1);
const REAUTH = ID(4);
const TRANSIENT = ID(6);
const REVOKED = ID(7);

function request(method: string, path: string, options: { tenant?: string; roles?: string; body?: unknown; cookie?: string } = {}): Request {
  const headers = new Headers({
    "x-corvis-demo-tenant": options.tenant ?? "tenant-connect",
    "x-corvis-demo-workspace": "workspace-1",
    "x-corvis-demo-subject": "demo-admin",
    "x-corvis-demo-roles": options.roles ?? "admin",
  });
  if (options.cookie) headers.set("cookie", options.cookie);
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) { headers.set("content-type", "application/json"); init.body = JSON.stringify(options.body); }
  return new Request(`https://corvis.test${path}`, init);
}
function params(sourceConnectionId: string) { return { params: Promise.resolve({ sourceConnectionId }) } as const; }

type Connection = { sourceConnectionId: string; providerKey: string; connectionLabel: string; credentialType: string; status: string; lastErrorClass?: string; sourceScope: Array<{ label: string }> };
type Connected = { data: { connection: Connection; test: { ok: boolean; errorClass?: string } } };

const connect = (tenant: string, token: string, extra: Record<string, unknown> = {}) => connectPost(request("POST", "/api/v1/source-connections/connect", {
  tenant, body: { providerKey: DEMO_TOKEN_PROVIDER_KEY, connectionLabel: "Our GP portal", scopeConfirmed: true, secret: { token }, ...extra },
}));
const listFor = async (tenant: string) => (await (await listGet(request("GET", "/api/v1/source-connections", { tenant }))).json() as { data: Connection[] }).data;

test("administrators see the demo providers with their plain-language access disclosure; nobody else does", async () => {
  const response = await providersGet(request("GET", "/api/v1/source-connections/providers"));
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: Array<Record<string, unknown> & { providerKey: string; demo: boolean; summary: string }> };
  assert.deepEqual(payload.data.map((provider) => provider.providerKey), [DEMO_OAUTH_PROVIDER_KEY, DEMO_TOKEN_PROVIDER_KEY]);
  assert.ok(payload.data.every((provider) => provider.demo && provider.summary.length > 20));
  assert.ok(payload.data.every((provider) => !("oauth" in provider) && !("connectorVersion" in provider)));
  assert.equal((await providersGet(request("GET", "/api/v1/source-connections/providers", { roles: "analyst" }))).status, 403);
});

test("a valid demo token connects, tests straight away and is active; the credential is never echoed or listed", async () => {
  const tenant = "tenant-valid";
  const response = await connect(tenant, DEMO_TOKENS.valid);
  assert.equal(response.status, 201);
  const text = await response.text();
  assert.ok(!text.includes(DEMO_TOKENS.valid), "the credential is not in the response");
  assert.doesNotMatch(text, /secretReference|"secret"/);
  const { data } = JSON.parse(text) as Connected;
  assert.deepEqual(data.test, { ok: true });
  assert.equal(data.connection.status, "active");
  assert.equal(data.connection.credentialType, "scoped_api_token");
  assert.equal(data.connection.connectionLabel, "Our GP portal");
  assert.deepEqual(data.connection.sourceScope.map((item) => item.label), ["Quarterly reports", "Capital account statements"], "scope comes from the provider, not the caller");
  const listed = await listFor(tenant);
  assert.equal(listed.length, 8);
  assert.equal(listed[0]!.sourceConnectionId, data.connection.sourceConnectionId, "the new connection is listed first");
  assert.ok(!JSON.stringify(listed).includes(DEMO_TOKENS.valid));
});

test("a failed first test leaves the connection non-active, so scheduled sync stays blocked, with a plain error class", async () => {
  const cases: Array<[string, string, string]> = [
    [DEMO_TOKENS.invalid, "auth", "reauthorization_required"],
    ["some-mistyped-token", "auth", "reauthorization_required"],
    [DEMO_TOKENS.noAccess, "permission", "suspended"],
    [DEMO_TOKENS.unreachable, "network", "pending_authorization"],
  ];
  for (const [token, errorClass, status] of cases) {
    const tenant = `tenant-failed-${token}`;
    const response = await connect(tenant, token);
    assert.equal(response.status, 201, token);
    const { data } = await response.json() as Connected;
    assert.deepEqual(data.test, { ok: false, errorClass }, token);
    assert.equal(data.connection.status, status, token);
    assert.notEqual(data.connection.status, "active");
    assert.equal(data.connection.lastErrorClass, errorClass);
  }
});

test("a new connection can be tested again on demand and a seeded one reports its recorded state", async () => {
  const tenant = "tenant-ondemand";
  const created = await (await connect(tenant, DEMO_TOKENS.unreachable)).json() as Connected;
  const id = created.data.connection.sourceConnectionId;
  const again = await testPost(request("POST", `/api/v1/source-connections/${id}/test`, { tenant }), params(id));
  assert.equal(again.status, 200);
  assert.deepEqual((await again.json() as { data: unknown }).data, { ok: false, errorClass: "network" });

  const healthy = await testPost(request("POST", `/api/v1/source-connections/${HEALTHY}/test`, { tenant }), params(HEALTHY));
  assert.deepEqual((await healthy.json() as { data: unknown }).data, { ok: true });
  const reauth = await testPost(request("POST", `/api/v1/source-connections/${REAUTH}/test`, { tenant }), params(REAUTH));
  assert.deepEqual((await reauth.json() as { data: unknown }).data, { ok: false, errorClass: "auth" });
  const transient = await testPost(request("POST", `/api/v1/source-connections/${TRANSIENT}/test`, { tenant }), params(TRANSIENT));
  assert.deepEqual((await transient.json() as { data: unknown }).data, { ok: false, errorClass: "network" });
  assert.equal((await testPost(request("POST", `/api/v1/source-connections/${REVOKED}/test`, { tenant }), params(REVOKED))).status, 409);
  assert.equal((await testPost(request("POST", `/api/v1/source-connections/${ID(90)}/test`, { tenant }), params(ID(90)))).status, 404);
  assert.equal((await testPost(request("POST", `/api/v1/source-connections/${HEALTHY}/test`, { tenant, roles: "analyst" }), params(HEALTHY))).status, 403);
});

test("connect refuses a request that skips the confirmation, names an unapproved provider or carries no credential", async () => {
  const tenant = "tenant-refusals";
  const status = async (body: unknown) => (await connectPost(request("POST", "/api/v1/source-connections/connect", { tenant, body }))).status;
  const base = { providerKey: DEMO_TOKEN_PROVIDER_KEY, connectionLabel: "X", scopeConfirmed: true, secret: { token: "t" } };
  assert.equal(await status({ ...base, scopeConfirmed: false }), 400);
  assert.equal(await status({ ...base, scopeConfirmed: undefined }), 400);
  assert.equal(await status({ ...base, providerKey: "not-approved" }), 422);
  assert.equal(await status({ ...base, providerKey: DEMO_OAUTH_PROVIDER_KEY }), 422);
  assert.equal(await status({ ...base, secret: {} }), 400);
  assert.equal(await status({ ...base, connectionLabel: "  " }), 400);
  assert.equal(await status(null), 400);
  assert.equal((await connectPost(request("POST", "/api/v1/source-connections/connect", { tenant, roles: "analyst", body: base }))).status, 403);
  assert.equal((await listFor(tenant)).length, 7, "nothing was created by a refused request");
});

/** Follows the demo provider's consent page for a started attempt and returns its two redirect links. */
async function consentLinks(authorizationUrl: string): Promise<{ approve: URL; deny: URL; html: string }> {
  const response = await consentGet(new Request(`https://corvis.test${authorizationUrl}`));
  assert.equal(response.status, 200);
  const html = await response.text();
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&").replaceAll("&#38;", "&"));
  return { approve: new URL(hrefs[0]!), deny: new URL(hrefs[1]!), html };
}

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie")!;
  return header.split(";")[0]!;
}

async function startOAuth(tenant: string, extra: Record<string, unknown> = {}) {
  const response = await oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", {
    tenant, body: { providerKey: DEMO_OAUTH_PROVIDER_KEY, connectionLabel: "Data room", scopeConfirmed: true, ...extra },
  }));
  return response;
}

test("the OAuth leg redirects through the provider's consent page and back, with state and PKCE kept server-side", async () => {
  const tenant = "tenant-oauth";
  const started = await startOAuth(tenant);
  assert.equal(started.status, 200);
  const cookie = started.headers.get("set-cookie")!;
  for (const part of ["HttpOnly", "SameSite=Lax", "Path=/api/v1/source-connections/oauth", "Max-Age=600", "Secure"]) assert.ok(cookie.includes(part), part);
  const { authorizationUrl } = (await started.json() as { data: { authorizationUrl: string } }).data;
  assert.match(authorizationUrl, /^\/api\/v1\/source-connections\/oauth\/demo-consent\?/);

  const { approve, html } = await consentLinks(authorizationUrl);
  assert.match(html, /Demonstration only/);
  assert.equal(approve.origin, "https://corvis.test", "the provider redirects back to the app");
  assert.equal(approve.searchParams.get("source_oauth"), "return");
  const code = approve.searchParams.get("code")!;
  const state = approve.searchParams.get("state")!;

  const completed = await oauthCompletePost(request("POST", "/api/v1/source-connections/oauth/complete", { tenant, cookie: cookieOf(started), body: { code, state } }));
  assert.equal(completed.status, 201);
  assert.match(completed.headers.get("set-cookie")!, /Max-Age=0/, "the pending-attempt cookie is cleared");
  const text = await completed.text();
  assert.ok(!text.includes("demo-oauth-access-token") && !text.includes(code), "no token or code in the response");
  const { data } = JSON.parse(text) as { data: { outcome: string; connection: Connection; test: { ok: boolean } } };
  assert.equal(data.outcome, "connected");
  assert.equal(data.connection.credentialType, "oauth_authorization_code");
  assert.equal(data.connection.connectionLabel, "Data room");
  assert.equal(data.connection.status, "active");
  assert.equal(data.test.ok, true);

  const replay = await oauthCompletePost(request("POST", "/api/v1/source-connections/oauth/complete", { tenant, cookie: cookieOf(started), body: { code, state } }));
  assert.equal(replay.status, 400, "a replayed redirect cannot create a second connection");
  assert.equal((await listFor(tenant)).length, 8);
});

test("declining at the provider destroys the attempt and creates nothing", async () => {
  const tenant = "tenant-oauth-denied";
  const started = await startOAuth(tenant);
  const { authorizationUrl } = (await started.json() as { data: { authorizationUrl: string } }).data;
  const { deny, approve } = await consentLinks(authorizationUrl);
  assert.equal(deny.searchParams.get("error"), "access_denied");
  const denied = await oauthCompletePost(request("POST", "/api/v1/source-connections/oauth/complete", { tenant, cookie: cookieOf(started), body: { denied: true } }));
  assert.equal(denied.status, 200);
  assert.deepEqual((await denied.json() as { data: unknown }).data, { outcome: "denied" });
  assert.equal((await listFor(tenant)).length, 7);
  const late = await oauthCompletePost(request("POST", "/api/v1/source-connections/oauth/complete", { tenant, cookie: cookieOf(started), body: { code: approve.searchParams.get("code"), state: approve.searchParams.get("state") } }));
  assert.equal(late.status, 400, "approving after declining finds no attempt");
});

test("a forged state, a missing cookie, another tenant's cookie or a code for another verifier are all refused", async () => {
  const tenant = "tenant-oauth-attacks";
  const complete = (cookie: string | undefined, body: unknown, who = tenant) => oauthCompletePost(request("POST", "/api/v1/source-connections/oauth/complete", { tenant: who, ...(cookie ? { cookie } : {}), body }));
  const fresh = async () => {
    const started = await startOAuth(tenant);
    const { approve } = await consentLinks((await started.json() as { data: { authorizationUrl: string } }).data.authorizationUrl);
    return { cookie: cookieOf(started), code: approve.searchParams.get("code")!, state: approve.searchParams.get("state")! };
  };

  let attempt = await fresh();
  assert.equal((await complete(attempt.cookie, { code: attempt.code, state: "forged-state-value-that-is-long" })).status, 400);
  attempt = await fresh();
  assert.equal((await complete(undefined, { code: attempt.code, state: attempt.state })).status, 400);
  assert.equal((await complete(attempt.cookie, { code: attempt.code, state: attempt.state }, "tenant-someone-else")).status, 400);
  assert.equal((await complete(attempt.cookie, { code: "", state: attempt.state })).status, 400);
  assert.equal((await complete(attempt.cookie, { code: attempt.code })).status, 400);
  assert.equal((await complete(attempt.cookie, null)).status, 400);
  attempt = await fresh();
  const other = await fresh();
  assert.equal((await complete(attempt.cookie, { code: other.code, state: attempt.state })).status, 400, "a code minted for a different PKCE verifier is rejected by the provider");
  assert.equal((await listFor(tenant)).length, 7, "none of these created a connection");
  assert.equal((await oauthCompletePost(request("POST", "/api/v1/source-connections/oauth/complete", { tenant, roles: "analyst", body: { denied: true } }))).status, 403);
});

test("the OAuth start refuses an unconfirmed request, a non-OAuth provider and a non-administrator", async () => {
  const tenant = "tenant-oauth-start";
  assert.equal((await startOAuth(tenant, { scopeConfirmed: false })).status, 400);
  assert.equal((await startOAuth(tenant, { providerKey: DEMO_TOKEN_PROVIDER_KEY })).status, 422);
  assert.equal((await oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", { tenant, roles: "analyst", body: {} }))).status, 403);
});

test("the demo consent page is demo-only, same-origin only and escapes what it echoes", async () => {
  const good = { state: "A".repeat(32), code_challenge: "B".repeat(43), redirect_uri: "https://corvis.test/?source_oauth=return" };
  const get = (overrides: Record<string, string> = {}) => consentGet(new Request(`https://corvis.test/api/v1/source-connections/oauth/demo-consent?${new URLSearchParams({ ...good, ...overrides })}`));
  assert.equal((await get()).status, 200);
  assert.equal((await get({ redirect_uri: "https://evil.example/?source_oauth=return" })).status, 400, "never an open redirect");
  assert.equal((await get({ redirect_uri: "not a url" })).status, 400);
  assert.equal((await get({ state: "<script>alert(1)</script>" })).status, 400);
  assert.equal((await get({ code_challenge: "short" })).status, 400);
  assert.equal((await consentGet(new Request("https://corvis.test/api/v1/source-connections/oauth/demo-consent"))).status, 400);
  const page = await (await get()).text();
  assert.doesNotMatch(page, /<script/i);
  process.env.CORVIS_DEMO_MODE = "";
  try { assert.equal((await get()).status, 404, "outside demo mode the page does not exist"); } finally { process.env.CORVIS_DEMO_MODE = "true"; }
});

test("with CORVIS_PUBLIC_APP_URL set, the consent page only redirects to that origin", async () => {
  process.env.CORVIS_PUBLIC_APP_URL = "https://app.corvis.example";
  try {
    const base = { state: "A".repeat(32), code_challenge: "B".repeat(43) };
    const get = (redirect: string) => consentGet(new Request(`https://internal:3000/api/v1/source-connections/oauth/demo-consent?${new URLSearchParams({ ...base, redirect_uri: redirect })}`));
    assert.equal((await get("https://app.corvis.example/?source_oauth=return")).status, 200);
    assert.equal((await get("https://internal:3000/?source_oauth=return")).status, 400);
  } finally { delete process.env.CORVIS_PUBLIC_APP_URL; }
});

// ---- the demo adapters themselves ----

function identity(): RequestIdentity {
  return { subject: "demo-user", tenantId: "tenant-store", workspaceId: "workspace-store", roles: ["admin"], entitlements: { workspaceIds: ["workspace-store"], sourceDocumentAccessAllowed: true }, authMethod: "demo", sessionId: "s" } as RequestIdentity;
}

test("the demo outcome is derived from the credential and nothing but the outcome is kept", () => {
  assert.deepEqual(demoTestOutcome(DEMO_TOKEN_PROVIDER_KEY, { token: DEMO_TOKENS.valid }), { ok: true });
  assert.deepEqual(demoTestOutcome(DEMO_TOKEN_PROVIDER_KEY, { token: DEMO_TOKENS.invalid }), { ok: false, errorClass: "auth" });
  assert.deepEqual(demoTestOutcome(DEMO_TOKEN_PROVIDER_KEY, { token: 5 }), { ok: false, errorClass: "auth" });
  assert.deepEqual(demoTestOutcome(DEMO_TOKEN_PROVIDER_KEY, { token: DEMO_TOKENS.noAccess }), { ok: false, errorClass: "permission" });
  assert.deepEqual(demoTestOutcome(DEMO_TOKEN_PROVIDER_KEY, { token: DEMO_TOKENS.unreachable }), { ok: false, errorClass: "network" });
  assert.deepEqual(demoTestOutcome(DEMO_OAUTH_PROVIDER_KEY, { accessToken: "demo-oauth-access-token" }), { ok: true });
  assert.deepEqual(demoTestOutcome(DEMO_OAUTH_PROVIDER_KEY, { accessToken: "other" }), { ok: false, errorClass: "auth" });
});

test("the demo OAuth client only exchanges a code minted for the matching PKCE verifier", async () => {
  const oauth = DEMO_SOURCE_PROVIDERS.find((provider) => provider.providerKey === DEMO_OAUTH_PROVIDER_KEY)!.oauth!;
  const { createHash } = await import("node:crypto");
  const verifier = "v".repeat(60);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  assert.deepEqual(await oauth.exchangeCode({ code: `demo-code.${challenge}`, codeVerifier: verifier, redirectUri: "x" }), { accessToken: "demo-oauth-access-token", tokenType: "bearer" });
  await assert.rejects(oauth.exchangeCode({ code: `demo-code.${challenge}`, codeVerifier: "w".repeat(60), redirectUri: "x" }), /invalid_grant/);
  await assert.rejects(oauth.exchangeCode({ code: "garbage", codeVerifier: verifier, redirectUri: "x" }), /invalid_grant/);
});

test("the demo store applies production's test rules: a pass activates pending, a failure never does, revoked is refused, reauthorize heals", () => {
  const NOW = new Date("2026-10-02T12:00:00.000Z");
  const store = new DemoSourceConnectionStore(() => NOW);
  const create = (testOutcome: Parameters<DemoSourceConnectionStore["create"]>[1]["testOutcome"]) => store.create(identity(), {
    providerKey: DEMO_TOKEN_PROVIDER_KEY, connectionLabel: "New", credentialType: "scoped_api_token", scope: [{ label: "Reports", path: "/r" }], connectorVersion: "demo-1", testOutcome,
  });

  const good = create({ ok: true });
  assert.equal(good.status, "pending_authorization");
  assert.equal(good.scopeConfirmedBy, "demo-user");
  assert.equal(good.scopeConfirmedAt, NOW.toISOString());
  assert.deepEqual(store.test(identity(), good.sourceConnectionId), { ok: true });
  assert.equal(store.get(identity(), good.sourceConnectionId).status, "active");
  assert.deepEqual(store.test(identity(), good.sourceConnectionId), { ok: true }, "a repeat pass leaves an active connection active");
  assert.equal(store.list(identity())[0]!.sourceConnectionId, good.sourceConnectionId);

  const bad = create({ ok: false, errorClass: "network" });
  assert.deepEqual(store.test(identity(), bad.sourceConnectionId), { ok: false, errorClass: "network" });
  assert.equal(store.get(identity(), bad.sourceConnectionId).status, "pending_authorization");
  store.reauthorize(identity(), bad.sourceConnectionId);
  assert.deepEqual(store.test(identity(), bad.sourceConnectionId), { ok: true }, "a replaced credential is assumed good until a test says otherwise");
  assert.equal(store.get(identity(), bad.sourceConnectionId).status, "active");

  store.transition(identity(), good.sourceConnectionId, "revoke");
  assert.throws(() => store.test(identity(), good.sourceConnectionId), /connection_revoked/);
  assert.throws(() => store.test(identity(), ID(80)), /connection_not_found/);
  const other = { ...identity(), workspaceId: "workspace-other" };
  assert.equal(store.list(other).length, 7, "another workspace has its own seeded set");
});
