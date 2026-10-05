import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { JWKS_MIN_REFRESH_INTERVAL_MS, OidcVerifier } from "./oidc.ts";

// Every way a bearer token or the identity provider's metadata can be wrong is refused with its own message. These are
// the verifier's fail-closed branches; the happy paths are in oidc.test.ts.
const issuer = "https://idp.validation.example";
const audience = "corvis";
const NOW = new Date(1_800_000_100_000);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = privateKey): string {
  const h = encode({ alg: "RS256", kid: "k1", typ: "JWT", ...header });
  const c = encode({ iss: issuer, aud: audience, sub: "user-1", sid: "session-1", iat: 1_800_000_000, exp: 1_800_000_300, ...claims });
  return `${h}.${c}.${sign("RSA-SHA256", Buffer.from(`${h}.${c}`), key).toString("base64url")}`;
}

type Fixture = { discovery?: unknown; jwks?: unknown; jwksHeaders?: Record<string, string>; discoveryStatus?: number; calls?: string[] };
function fetchFixture(fixture: Fixture = {}): typeof fetch {
  return async (input) => {
    const url = String(input);
    fixture.calls?.push(url);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify("discovery" in fixture ? fixture.discovery : { issuer, jwks_uri: `${issuer}/jwks` }), { status: fixture.discoveryStatus ?? 200 });
    }
    if (url === `${issuer}/jwks` || url === "https://keys.validation.example/jwks") {
      return new Response(JSON.stringify("jwks" in fixture ? fixture.jwks : { keys: [jwk] }), { status: 200, headers: fixture.jwksHeaders ?? { "cache-control": "max-age=300" } });
    }
    return new Response("not found", { status: 404 });
  };
}

async function verifies(authorization: string | null, options: { fixture?: Fixture; issuer?: string; audience?: string; jwksUrl?: string; verifier?: OidcVerifier } = {}) {
  const verifier = options.verifier ?? new OidcVerifier(fetchFixture(options.fixture));
  return verifier.verify({ authorization, issuer: options.issuer ?? issuer, audience: options.audience ?? audience, jwksUrl: options.jwksUrl, now: NOW });
}

async function refused(authorization: string | null, message: RegExp, options: Parameters<typeof verifies>[1] = {}) {
  await assert.rejects(verifies(authorization, options), message);
}

test("the bearer header must be present and shaped Bearer <token>", async () => {
  await refused(null, /missing OIDC bearer token/);
  await refused("", /missing OIDC bearer token/);
  await refused("Basic abc", /malformed OIDC bearer token/);
  await refused("Bearer", /malformed OIDC bearer token/);
  await refused("Bearer a b", /malformed OIDC bearer token/);
  assert.equal((await verifies(`bearer ${token()}`)).subject, "user-1", "the scheme is case-insensitive");
});

test("a token must be three non-empty segments with a decodable header and claims", async () => {
  await refused("Bearer a.b", /malformed OIDC token/);
  await refused("Bearer a.b.c.d", /malformed OIDC token/);
  await refused("Bearer .b.c", /malformed OIDC token/);
  await refused("Bearer a..c", /malformed OIDC token/);
  await refused("Bearer a.b.", /malformed OIDC token/);
  await refused(`Bearer ${Buffer.from("not json").toString("base64url")}.${encode({})}.sig`, /malformed OIDC header/);
  await refused(`Bearer ${encode({ alg: "RS256", kid: "k1" })}.${Buffer.from("nope").toString("base64url")}.sig`, /malformed OIDC claims/);
});

test("only RS256 with a key id is accepted", async () => {
  await refused(`Bearer ${token({}, { alg: "HS256" })}`, /unsupported OIDC signing header/);
  await refused(`Bearer ${token({}, { alg: "none" })}`, /unsupported OIDC signing header/);
  await refused(`Bearer ${token({}, { kid: undefined })}`, /unsupported OIDC signing header/);
  await refused(`Bearer ${token({}, { kid: 7 })}`, /unsupported OIDC signing header/);
  await refused(`Bearer ${token({}, { kid: "" })}`, /unsupported OIDC signing header/);
});

test("the configured issuer must be an https URL", async () => {
  await refused(`Bearer ${token()}`, /invalid OIDC issuer URL/, { issuer: "not a url" });
  await refused(`Bearer ${token()}`, /OIDC issuer must use HTTPS/, { issuer: "http://idp.validation.example" });
});

test("timestamps must be integers, current and consistent", async () => {
  await refused(`Bearer ${token({ exp: undefined })}`, /invalid OIDC token timestamps/);
  await refused(`Bearer ${token({ iat: undefined })}`, /invalid OIDC token timestamps/);
  await refused(`Bearer ${token({ exp: "1800000300" })}`, /invalid OIDC token timestamps/);
  await refused(`Bearer ${token({ exp: 1_800_000_300.5 })}`, /invalid OIDC token timestamps/);
  await refused(`Bearer ${token({ iat: 1_800_000_000.5 })}`, /invalid OIDC token timestamps/);
  await refused(`Bearer ${token({ exp: 1_800_000_000 - 100 })}`, /expired OIDC token/);
  await refused(`Bearer ${token({ iat: 1_800_000_400 })}`, /invalid OIDC token lifetime/);
  await refused(`Bearer ${token({ iat: 1_800_000_100, exp: 1_800_000_100 })}`, /invalid OIDC token lifetime/);
});

test("a token is not accepted before its nbf, and nbf must be an integer", async () => {
  await refused(`Bearer ${token({ nbf: "soon" })}`, /not yet valid/);
  await refused(`Bearer ${token({ nbf: 1.5 })}`, /not yet valid/);
  await refused(`Bearer ${token({ nbf: 1_800_000_500 })}`, /not yet valid/);
  assert.equal((await verifies(`Bearer ${token({ nbf: 1_800_000_000 })}`)).subject, "user-1");
});

test("issuer, audience and subject must match what is configured", async () => {
  await refused(`Bearer ${token({ iss: "https://other.example" })}`, /invalid OIDC token issuer/);
  await refused(`Bearer ${token({ iss: 42 })}`, /invalid OIDC token issuer/);
  await refused(`Bearer ${token({ iss: undefined })}`, /invalid OIDC token issuer/);
  await refused(`Bearer ${token({ iss: "not a url" })}`, /invalid OIDC issuer URL/);
  assert.equal((await verifies(`Bearer ${token({ iss: `${issuer}/` })}`)).issuer, issuer, "a trailing slash on the claim is normalised");
  await refused(`Bearer ${token({ aud: "someone-else" })}`, /invalid OIDC token audience/);
  await refused(`Bearer ${token({ aud: ["a", "b"] })}`, /invalid OIDC token audience/);
  await refused(`Bearer ${token({ aud: 7 })}`, /invalid OIDC token audience/);
  await refused(`Bearer ${token({ aud: undefined })}`, /invalid OIDC token audience/);
  assert.equal((await verifies(`Bearer ${token({ aud: ["other", audience] })}`)).audience, audience, "an audience list may contain it");
  await refused(`Bearer ${token({ sub: undefined })}`, /no immutable subject/);
  await refused(`Bearer ${token({ sub: "" })}`, /no immutable subject/);
  await refused(`Bearer ${token({ sub: 5 })}`, /no immutable subject/);
});

test("the signature must verify against the published key", async () => {
  await refused(`Bearer ${token({}, {}, otherKey.privateKey)}`, /invalid OIDC token signature/);
  await refused(`Bearer ${token({}, { kid: "unknown" })}`, /signing key is unknown/);
});

test("the session id is sid, then jti, then a per-token hash that cannot be measured", async () => {
  assert.equal((await verifies(`Bearer ${token({ sid: undefined, jti: "jti-1" })}`)).sessionId, "jti-1");
  assert.equal((await verifies(`Bearer ${token({ sid: "", jti: "jti-2" })}`)).sessionId, "jti-2");
  assert.equal((await verifies(`Bearer ${token({ sid: 5, jti: "jti-3" })}`)).sessionId, "jti-3");
  assert.match((await verifies(`Bearer ${token({ sid: undefined })}`)).sessionId, /^token-[0-9a-f]{64}$/);
  assert.match((await verifies(`Bearer ${token({ sid: undefined, jti: "" })}`)).sessionId, /^token-/);
  assert.match((await verifies(`Bearer ${token({ sid: undefined, jti: 9 })}`)).sessionId, /^token-/);
});

test("email claims must be well typed", async () => {
  await refused(`Bearer ${token({ email: 5 })}`, /invalid OIDC email claim/);
  await refused(`Bearer ${token({ email_verified: "yes" })}`, /invalid OIDC email verification claim/);
  await refused(`Bearer ${token({ email_verified: true, email: "   " })}`, /verified OIDC email is missing/);
  await refused(`Bearer ${token({ email_verified: true, email: 5 })}`, /invalid OIDC email claim/);
  assert.deepEqual(await verifies(`Bearer ${token({ email: "A@B.test" })}`), { subject: "user-1", sessionId: "session-1", issuer, audience, email: "a@b.test" });
});

test("a configured JWKS URL must be https and is used without discovery", async () => {
  await refused(`Bearer ${token()}`, /JWKS URL must use HTTPS/, { jwksUrl: "http://keys.validation.example/jwks" });
  const calls: string[] = [];
  assert.equal((await verifies(`Bearer ${token()}`, { fixture: { calls }, jwksUrl: "https://keys.validation.example/jwks" })).subject, "user-1");
  assert.deepEqual(calls, ["https://keys.validation.example/jwks"]);
});

test("the discovery document must be an object naming the same issuer and an https JWKS URI", async () => {
  await refused(`Bearer ${token()}`, /invalid OIDC discovery document/, { fixture: { discovery: [] } });
  await refused(`Bearer ${token()}`, /invalid OIDC discovery document/, { fixture: { discovery: null } });
  await refused(`Bearer ${token()}`, /discovery issuer mismatch/, { fixture: { discovery: { issuer: "https://other.example", jwks_uri: `${issuer}/jwks` } } });
  await refused(`Bearer ${token()}`, /discovery issuer mismatch/, { fixture: { discovery: { jwks_uri: `${issuer}/jwks` } } });
  await refused(`Bearer ${token()}`, /no JWKS URI/, { fixture: { discovery: { issuer } } });
  await refused(`Bearer ${token()}`, /JWKS URL must use HTTPS/, { fixture: { discovery: { issuer, jwks_uri: "http://keys.validation.example/jwks" } } });
  await refused(`Bearer ${token()}`, /metadata request failed with status 503/, { fixture: { discoveryStatus: 503 } });
});

test("the JWKS must be an object with usable RSA signing keys; unusable entries are skipped", async () => {
  await refused(`Bearer ${token()}`, /invalid OIDC JWKS response/, { fixture: { jwks: [] } });
  await refused(`Bearer ${token()}`, /invalid OIDC JWKS response/, { fixture: { jwks: null } });
  await refused(`Bearer ${token()}`, /invalid OIDC JWKS response/, { fixture: { jwks: { keys: "no" } } });
  const unusable = [null, [], "x", { kid: "k1" }, { ...jwk, kty: "EC" }, { ...jwk, alg: "ES256" }, { ...jwk, use: "enc" }, { ...jwk, kid: 1 }, { ...jwk, n: 1 }, { ...jwk, e: 1 }];
  await refused(`Bearer ${token()}`, /contained no usable signing keys/, { fixture: { jwks: { keys: unusable } } });
  // A key that omits alg and use is accepted, next to the unusable ones.
  const bare = { kty: jwk.kty, n: jwk.n, e: jwk.e, kid: "k1" };
  assert.equal((await verifies(`Bearer ${token()}`, { fixture: { jwks: { keys: [...unusable, bare] } } })).subject, "user-1");
});

test("a bad Cache-Control max-age falls back to the default key lifetime, and keys are cached between requests", async () => {
  for (const headers of [{ "cache-control": "max-age=0" }, { "cache-control": "no-store" }, { "cache-control": "max-age=999999999" }]) {
    const calls: string[] = [];
    const verifier = new OidcVerifier(fetchFixture({ calls, jwksHeaders: headers }));
    await verifies(`Bearer ${token()}`, { verifier });
    await verifies(`Bearer ${token({ sid: "second" })}`, { verifier });
    assert.equal(calls.filter((url) => url.endsWith("/jwks")).length, 1, `one JWKS fetch for ${JSON.stringify(headers)}`);
    assert.equal(calls.filter((url) => url.endsWith("openid-configuration")).length, 1);
  }
});

test("an unknown key id cannot make the verifier refetch keys more than once per interval", async () => {
  const calls: string[] = [];
  const verifier = new OidcVerifier(fetchFixture({ calls }));
  await assert.rejects(verifies(`Bearer ${token({}, { kid: "nope" })}`, { verifier }), /signing key is unknown/);
  await assert.rejects(verifies(`Bearer ${token({}, { kid: "nope" })}`, { verifier }), /signing key is unknown/);
  assert.equal(calls.filter((url) => url.endsWith("/jwks")).length, 1);
  assert.ok(JWKS_MIN_REFRESH_INTERVAL_MS > 0);
});

test("keys fetched for one issuer are never used for another that finishes while the first was in flight", async () => {
  const other = "https://idp.other.example";
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === `${issuer}/.well-known/openid-configuration`) { await gate; return new Response(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` })); }
    if (url === `${issuer}/jwks`) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "cache-control": "max-age=300" } });
    if (url === `${other}/.well-known/openid-configuration`) return new Response(JSON.stringify({ issuer: other, jwks_uri: `${other}/jwks` }));
    if (url === `${other}/jwks`) return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "other-key" }] }), { headers: { "cache-control": "max-age=300" } });
    return new Response("nope", { status: 404 });
  };
  const verifier = new OidcVerifier(fetchImpl);
  const first = verifier.verify({ authorization: `Bearer ${token()}`, issuer, audience, now: NOW });
  const second = verifier.verify({ authorization: `Bearer ${token({ iss: other }, { kid: "other-key" })}`, issuer: other, audience, now: NOW });
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  assert.equal((await second).issuer, other);
  await assert.rejects(first, /signing keys expired|signing key is unknown/, "the first issuer's keys were not stored over the second's");
});

test("a metadata request that never answers is aborted after the timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const pending = verifies(`Bearer ${token()}`, { verifier: new OidcVerifier(fetchImpl) });
  const settled = assert.rejects(pending, /aborted/);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5_000);
  await settled;
});

test("with no Cache-Control header the default key lifetime applies, and the clock defaults to now", async () => {
  const verifier = new OidcVerifier(fetchFixture({ jwksHeaders: {} }));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const identity = await verifier.verify({ authorization: `Bearer ${token({ iat: nowSeconds - 10, exp: nowSeconds + 300 })}`, issuer, audience });
  assert.equal(identity.subject, "user-1");
});
