import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { register } from "node:module";
import test from "node:test";
import type { ServerConfig } from "./config.ts";
import type { OidcLogoutToken } from "./oidc.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

const { BACKCHANNEL_LOGOUT_EVENT, OidcVerifier } = await import("./oidc.ts");
const { RateLimiter } = await import("./rate-limit.ts");
const { handleBackchannelLogout, BACKCHANNEL_LOGOUT_REQUESTS_PER_MINUTE } = await import("./backchannel-logout.ts");
const route = await import("../../app/api/v1/auth/oidc/backchannel-logout/route.ts");

const NOW = 1_800_000_000;
const now = new Date(NOW * 1000);
const SHARED_ISSUER = "https://login.corvis.example";
const SHARED_AUDIENCE = "corvis-api";
const TENANT_ISSUER = "https://idp.acme.example/realms/acme";
const TENANT_AUDIENCE = "corvis-acme";
const config = { demoMode: false, authIssuer: SHARED_ISSUER, authAudience: SHARED_AUDIENCE, authJwksUrl: "https://login.corvis.example/keys", postgresDsn: "postgres://unused" } as unknown as ServerConfig;

type Call = { sql: string; parameters: PostgresPrimitive[] };
class RecordingDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  private readonly respond: (sql: string) => PostgresRow[];
  constructor(respond: (sql: string) => PostgresRow[]) { this.respond = respond; }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return this.respond(sql);
  }
  async execute(): Promise<void> {}
  async health() { return true; }
  applied(): Call | undefined { return this.calls.find((call) => /apply_backchannel_logout/.test(call.sql)); }
}

/** A database where the issuer has these recorded audiences and applying the token answers `result`. */
function database(recordedAudiences: string[], result: PostgresRow = { status: "ok", revoked_sessions: 2, tenants: 1 }): RecordingDb {
  return new RecordingDb((sql) => /from corvis_control\.tenant_identity_provider/.test(sql) ? recordedAudiences.map((audience) => ({ audience })) : /apply_backchannel_logout/.test(sql) ? [result] : []);
}

function form(token: string | undefined, init: RequestInit & { contentType?: string } = {}): Request {
  const { contentType, ...rest } = init;
  return new Request("https://corvis.test/api/v1/auth/oidc/backchannel-logout", {
    method: "POST",
    headers: { "content-type": contentType ?? "application/x-www-form-urlencoded", ...(rest.headers as Record<string, string> | undefined) },
    body: token === undefined ? "" : new URLSearchParams({ logout_token: token }).toString(),
    ...rest,
  });
}

function logoutJwt(claims: Record<string, unknown> = {}, key = privateKey, iss = SHARED_ISSUER): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "logout+jwt" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss, aud: SHARED_AUDIENCE, iat: NOW - 5, exp: NOW + 60, jti: "jti-1", sid: "SECRET-SID", sub: "SECRET-SUBJECT", events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, ...claims })).toString("base64url");
  return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), key).toString("base64url")}`;
}
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] };

function realVerifier(fetched: string[] = []): InstanceType<typeof OidcVerifier> {
  return new OidcVerifier(async (input) => {
    const url = String(input);
    fetched.push(url);
    if (url === config.authJwksUrl || url === `${TENANT_ISSUER}/jwks`) return new Response(JSON.stringify(jwks), { status: 200 });
    if (url === `${TENANT_ISSUER}/.well-known/openid-configuration`) return new Response(JSON.stringify({ issuer: TENANT_ISSUER, jwks_uri: `${TENANT_ISSUER}/jwks` }), { status: 200 });
    return new Response("nope", { status: 404 });
  });
}

const lines: Array<Record<string, unknown>> = [];
function capture(t: test.TestContext): void {
  lines.length = 0;
  for (const level of ["info", "warn", "error"] as const) t.mock.method(console, level, (line: unknown) => { lines.push(JSON.parse(String(line)) as Record<string, unknown>); });
}
function assertSecretSafe(): void {
  const text = JSON.stringify(lines);
  for (const secret of ["SECRET-SID", "SECRET-SUBJECT", "logout_token", "eyJ"]) assert.ok(!text.includes(secret), `logs never contain ${secret}`);
}
const body = async (response: Response) => await response.text();

test("a valid logout token from the shared provider ends the session immediately, answers 200 with nothing in the body, and is applied once", async (t) => {
  capture(t);
  const db = database([]);
  const fetched: string[] = [];
  const response = await handleBackchannelLogout(form(logoutJwt()), { config, db, verifier: realVerifier(fetched), now, limiter: new RateLimiter(10), correlationId: "corr-1" });
  assert.equal(response.status, 200);
  assert.equal(await body(response), "");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(db.applied()!.parameters, [SHARED_ISSUER, SHARED_AUDIENCE, "jti-1", "SECRET-SUBJECT", "SECRET-SID", true, "corr-1"]);
  assert.deepEqual(fetched, [config.authJwksUrl], "the shared provider's configured key URL is used");
  assert.equal(lines.some((line) => line.event === "auth.backchannel_logout_applied" && line.revokedSessions === 2 && line.scope === "session"), true);
  assertSecretSafe();
});

test("a tenant's recorded OIDC provider is trusted for its own audience, with keys found by discovery and the logout marked as not the shared provider's", async (t) => {
  capture(t);
  const db = database([TENANT_AUDIENCE]);
  const fetched: string[] = [];
  const token = logoutJwt({ aud: TENANT_AUDIENCE, sid: undefined }, privateKey, TENANT_ISSUER);
  const response = await handleBackchannelLogout(form(token), { config, db, verifier: realVerifier(fetched), now, limiter: new RateLimiter(10) });
  assert.equal(response.status, 200);
  assert.deepEqual(db.applied()!.parameters.slice(0, 6), [TENANT_ISSUER, TENANT_AUDIENCE, "jti-1", "SECRET-SUBJECT", null, false]);
  assert.match(String(db.applied()!.parameters[6]), /^[0-9a-f-]{36}$/, "a correlation id is generated when none is supplied");
  assert.deepEqual(fetched, [`${TENANT_ISSUER}/.well-known/openid-configuration`, `${TENANT_ISSUER}/jwks`]);
  assert.equal(lines.some((line) => line.event === "auth.backchannel_logout_applied" && line.scope === "subject"), true);
  // The recorded audience is looked up for this issuer only.
  assert.deepEqual(db.calls[0]!.parameters, [TENANT_ISSUER]);
  // A token for the shared audience from a tenant's issuer is not accepted (the audience must be one recorded for that issuer).
  const wrongAudience = await handleBackchannelLogout(form(logoutJwt({ aud: SHARED_AUDIENCE }, privateKey, TENANT_ISSUER)), { config, db: database([TENANT_AUDIENCE]), verifier: realVerifier(), now, limiter: new RateLimiter(10) });
  assert.equal(wrongAudience.status, 400);
});

test("an issuer that is both the shared provider and a tenant's recorded one accepts either recorded audience", async () => {
  const verifier = { verifyLogoutToken: async (input: { audiences: string[]; jwksUrl?: string }): Promise<OidcLogoutToken> => {
    assert.deepEqual(input.audiences, [SHARED_AUDIENCE, TENANT_AUDIENCE]);
    assert.equal(input.jwksUrl, config.authJwksUrl);
    return { issuer: SHARED_ISSUER, audience: TENANT_AUDIENCE, jti: "j", subject: "s" };
  } };
  const response = await handleBackchannelLogout(form(logoutJwt()), { config, db: database([TENANT_AUDIENCE, SHARED_AUDIENCE]), verifier, now, limiter: new RateLimiter(10) });
  assert.equal(response.status, 200);
  // The shared flag follows the audience that matched, not the issuer alone.
  const applied = database([TENANT_AUDIENCE]);
  await handleBackchannelLogout(form(logoutJwt()), { config, db: applied, verifier, now, limiter: new RateLimiter(10) });
  assert.equal(applied.applied()!.parameters[5], false);
});

test("everything invalid gets the same 400 and nothing about why: forged, expired, wrong audience, unknown issuer, malformed, replayed", async (t) => {
  capture(t);
  const verifier = realVerifier();
  const answer = async (request: Request, db = database([])) => handleBackchannelLogout(request, { config, db, verifier, now, limiter: new RateLimiter(10), correlationId: "c" });
  const refusals: Array<[string, Request]> = [
    ["forged signature", form(logoutJwt({}, attacker.privateKey))],
    ["expired", form(logoutJwt({ exp: NOW - 100, iat: NOW - 200 }))],
    ["stale", form(logoutJwt({ iat: NOW - 4000, exp: NOW + 100 }))],
    ["wrong audience", form(logoutJwt({ aud: "someone-else" }))],
    ["a nonce", form(logoutJwt({ nonce: "n" }))],
    ["no logout event", form(logoutJwt({ events: {} }))],
    ["no sub and no sid", form(logoutJwt({ sub: undefined, sid: undefined }))],
    ["malformed token", form("not.a.jwt")],
    ["no token", form(undefined)],
    ["wrong content type", form(logoutJwt(), { contentType: "application/json" })],
    ["no content type at all", new Request("https://corvis.test/x", { method: "POST" })],
    ["a plain-text content type", new Request("https://corvis.test/x", { method: "POST", body: new URLSearchParams({ logout_token: logoutJwt() }) , headers: { "content-type": "text/plain" } })],
    ["two tokens", new Request("https://corvis.test/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `logout_token=${logoutJwt()}&logout_token=${logoutJwt()}` })],
    ["an oversized body", new Request("https://corvis.test/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `logout_token=${"a".repeat(20_000)}` })],
  ];
  for (const [label, request] of refusals) {
    const response = await answer(request);
    assert.equal(response.status, 400, label);
    assert.deepEqual(await response.json(), { error: "invalid_request", correlationId: "c" }, label);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  // An issuer Corvis does not know is refused before any key is fetched or any keys looked at.
  const fetched: string[] = [];
  const unknown = await handleBackchannelLogout(form(logoutJwt({}, privateKey, "https://evil.example")), { config, db: database([]), verifier: realVerifier(fetched), now, limiter: new RateLimiter(10) });
  assert.equal(unknown.status, 400);
  assert.deepEqual(fetched, [], "no outbound request is made for an unknown issuer");
  assert.equal(lines.some((line) => line.reason === "unknown_issuer"), true);
  // A malformed issuer claim is refused the same way.
  assert.equal((await answer(form(logoutJwt({ iss: "http://insecure.example" })))).status, 400);
  assertSecretSafe();
});

test("a replayed logout token is refused, and the refusal does not say it was a replay", async (t) => {
  capture(t);
  const replay = await handleBackchannelLogout(form(logoutJwt()), { config, db: database([], { status: "replay" }), verifier: realVerifier(), now, limiter: new RateLimiter(10), correlationId: "c" });
  assert.equal(replay.status, 400);
  assert.deepEqual(await replay.json(), { error: "invalid_request", correlationId: "c" });
  assert.equal(lines.some((line) => line.reason === "replay"), true, "only the operator log says why");
  assertSecretSafe();
});

test("a flood is bounded: a process-wide limit before any work, and a per-issuer limit in SQL; both say 429 with a retry hint", async (t) => {
  capture(t);
  const limiter = new RateLimiter(1);
  const first = await handleBackchannelLogout(form(logoutJwt()), { config, db: database([]), verifier: realVerifier(), now, limiter, correlationId: "c" });
  assert.equal(first.status, 200);
  const db = database([]);
  const limited = await handleBackchannelLogout(form(logoutJwt()), { config, db, verifier: realVerifier(), now, limiter, correlationId: "c" });
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
  assert.equal(db.calls.length, 0, "a limited request costs no database call and no key fetch");
  const sql = await handleBackchannelLogout(form(logoutJwt()), { config, db: database([], { status: "rate_limited" }), verifier: realVerifier(), now, limiter: new RateLimiter(10) });
  assert.equal(sql.status, 429);
  assert.equal(sql.headers.get("retry-after"), "60");
  assert.ok(BACKCHANNEL_LOGOUT_REQUESTS_PER_MINUTE >= 60);
  // The default limiter is process-wide and allows a normal burst.
  const burst = await handleBackchannelLogout(form(logoutJwt()), { config, db: database([]), verifier: realVerifier(), now });
  assert.equal(burst.status, 200);
});

test("an identity provider that cannot be reached is told to retry (503), anything else about the database is an ordinary server error", async (t) => {
  capture(t);
  const down = new OidcVerifier(async () => { throw new TypeError("fetch failed"); });
  const unavailable = await handleBackchannelLogout(form(logoutJwt()), { config, db: database([]), verifier: down, now, limiter: new RateLimiter(10), correlationId: "c" });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("retry-after"), "30");
  assert.deepEqual(await unavailable.json(), { error: "temporarily_unavailable", correlationId: "c" });
  const broken = new RecordingDb(() => { throw new Error("database exploded"); });
  const failed = await handleBackchannelLogout(form(logoutJwt()), { config, db: broken, verifier: realVerifier(), now, limiter: new RateLimiter(10) });
  assert.equal(failed.status, 500);
  // An answer from SQL that is neither success nor a known refusal is never reported as success.
  const odd = await handleBackchannelLogout(form(logoutJwt()), { config, db: database([], { status: "mystery" }), verifier: realVerifier(), now, limiter: new RateLimiter(10) });
  assert.equal(odd.status, 500);
  const none = await handleBackchannelLogout(form(logoutJwt()), { config, db: new RecordingDb((sql) => /tenant_identity_provider/.test(sql) ? [] : []), verifier: { verifyLogoutToken: async () => ({ issuer: SHARED_ISSUER, audience: SHARED_AUDIENCE, jti: "j", subject: "s" }) }, now, limiter: new RateLimiter(10) });
  assert.equal(none.status, 500, "no row at all is not success either");
  assertSecretSafe();
});

test("with no shared provider configured, or one that cannot be used, only recorded providers are trusted; demo mode has no provider at all", async () => {
  const noShared = { ...config, authIssuer: undefined } as unknown as ServerConfig;
  assert.equal((await handleBackchannelLogout(form(logoutJwt()), { config: noShared, db: database([]), verifier: realVerifier(), now, limiter: new RateLimiter(10) })).status, 400);
  const badShared = { ...config, authIssuer: "http://insecure.example" } as unknown as ServerConfig;
  assert.equal((await handleBackchannelLogout(form(logoutJwt()), { config: badShared, db: database([]), verifier: realVerifier(), now, limiter: new RateLimiter(10) })).status, 400);
  const noAudience = { ...config, authAudience: undefined } as unknown as ServerConfig;
  assert.equal((await handleBackchannelLogout(form(logoutJwt()), { config: noAudience, db: database([]), verifier: realVerifier(), now, limiter: new RateLimiter(10) })).status, 400);
  const demo = new RecordingDb(() => []);
  const demoResponse = await handleBackchannelLogout(form(logoutJwt()), { config: { ...config, demoMode: true } as unknown as ServerConfig, db: demo, verifier: realVerifier(), now, limiter: new RateLimiter(10) });
  assert.equal(demoResponse.status, 400);
  assert.equal(demo.calls.length, 0, "demo mode never touches the database");
});

test("the route is POST-only, reads the correlation id from the request and uses the process configuration", async (t) => {
  capture(t);
  assert.deepEqual(Object.keys(route).filter((name) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(name)), ["POST"]);
  // Demo mode (the test environment) has no provider: the route answers like any refusal, without a database.
  process.env.CORVIS_DEMO_MODE = "true";
  const response = await route.POST(form("anything", { headers: { "x-correlation-id": "route-corr-1" } }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_request", correlationId: "route-corr-1" });
});

test("a logout that names only a session, a verifier that fails with something that is not an Error, and the default dependencies", async (t) => {
  capture(t);
  // Session-only token: the subject is passed as null, so SQL finds the owner from the session record.
  const sessionOnly = database([]);
  const ok = await handleBackchannelLogout(form(logoutJwt({ sub: undefined })), { config, db: sessionOnly, verifier: realVerifier(), now, limiter: new RateLimiter(10) });
  assert.equal(ok.status, 200);
  assert.deepEqual(sessionOnly.applied()!.parameters.slice(3, 5), [null, "SECRET-SID"]);
  // A refusal that is not an Error is still one plain refusal.
  const odd = await handleBackchannelLogout(form(logoutJwt()), { config, db: database([]), verifier: { verifyLogoutToken: async () => { throw "boom"; } }, now, limiter: new RateLimiter(10) });
  assert.equal(odd.status, 400);
  assert.equal(lines.some((line) => line.reason === "token_rejected" && line.message === "unknown"), true);

  // Default dependencies: the process database (an HTTP SQL endpoint here), the process verifier, the process limiter and the real clock.
  const dsn = "https://backchannel-default.test/sql";
  const originalFetch = globalThis.fetch;
  const statements: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === config.authJwksUrl) return new Response(JSON.stringify(jwks), { status: 200 });
    if (url !== dsn) return originalFetch(input, init);
    const { sql } = JSON.parse(String(init?.body ?? "{}")) as { sql: string };
    statements.push(sql);
    const rows = /apply_backchannel_logout/.test(sql) ? [{ status: "ok", revoked_sessions: 1, tenants: 1 }] : [];
    return new Response(JSON.stringify({ rows }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const seconds = Math.floor(Date.now() / 1000);
    const live = await handleBackchannelLogout(form(logoutJwt({ iat: seconds, exp: seconds + 60 })), { config: { ...config, postgresDsn: dsn } as unknown as ServerConfig });
    assert.equal(live.status, 200);
    assert.equal(statements.length, 2, "the recorded providers are read, then the token is applied");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
