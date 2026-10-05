import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  BACKCHANNEL_LOGOUT_EVENT,
  LOGOUT_TOKEN_MAX_AGE_SECONDS,
  MAX_LOGOUT_TOKEN_LENGTH,
  normalizeOidcIssuer,
  OidcVerifier,
  unverifiedLogoutTokenIssuer,
} from "./oidc.ts";

const issuer = "https://idp.example.com";
const audience = "corvis";
const NOW = 1_800_000_000;
const now = new Date(NOW * 1000);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });
const kid = "logout-key";

function jwt(claims: Record<string, unknown>, options: { header?: Record<string, unknown>; key?: typeof privateKey } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "logout+jwt", ...options.header })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), options.key ?? privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

/** A well-formed back-channel logout token; every test varies one claim. */
function logoutClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    iss: issuer, aud: audience, iat: NOW - 5, exp: NOW + 120, jti: "jti-1", sid: "sid-1", sub: "user-1",
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, ...overrides,
  };
  for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
  return claims;
}

function fixtureFetch(calls: string[] = []): typeof fetch {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === `${issuer}/.well-known/openid-configuration`) return new Response(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }), { status: 200 });
    if (url === `${issuer}/jwks`) return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }), { status: 200, headers: { "cache-control": "public, max-age=300" } });
    return new Response("nope", { status: 404 });
  };
}

const verify = (token: string, overrides: Partial<Parameters<OidcVerifier["verifyLogoutToken"]>[0]> = {}, verifier = new OidcVerifier(fixtureFetch())) =>
  verifier.verifyLogoutToken({ token, issuer, audiences: [audience], now, ...overrides });
const refuses = (token: string, pattern: RegExp, overrides: Partial<Parameters<OidcVerifier["verifyLogoutToken"]>[0]> = {}) =>
  assert.rejects(verify(token, overrides), pattern);

test("a valid back-channel logout token is verified against the issuer's keys and returns who and which session it ends", async () => {
  assert.deepEqual(await verify(jwt(logoutClaims())), { issuer, audience, jti: "jti-1", subject: "user-1", sessionId: "sid-1" });
  assert.deepEqual(await verify(jwt(logoutClaims({ sid: undefined }))), { issuer, audience, jti: "jti-1", subject: "user-1" }, "a subject alone ends every session of that person");
  assert.deepEqual(await verify(jwt(logoutClaims({ sub: undefined }))), { issuer, audience, jti: "jti-1", sessionId: "sid-1" }, "a session alone is enough");
  // The audience that matched is returned, whichever of several accepted ones the token names, and an array `aud` is understood.
  const matched = await verify(jwt(logoutClaims({ aud: ["other", "corvis-b"] })), { audiences: ["corvis-a", "corvis-b"] });
  assert.equal(matched.audience, "corvis-b");
  // The issuer is compared in its normalised form.
  assert.equal((await verify(jwt(logoutClaims({ iss: `${issuer}/` })), { issuer: "https://IDP.example.com/" })).issuer, issuer);
});

test("a logout token is refused for every missing or wrong claim, with one answer to the caller", async () => {
  await refuses(jwt(logoutClaims({ iss: "https://evil.example.com" })), /invalid OIDC logout token issuer/);
  await refuses(jwt(logoutClaims({ iss: undefined })), /invalid OIDC logout token issuer/);
  await refuses(jwt(logoutClaims({ iss: 7 })), /invalid OIDC logout token issuer/);
  await refuses(jwt(logoutClaims({ aud: "someone-else" })), /invalid OIDC logout token audience/);
  await refuses(jwt(logoutClaims({ aud: undefined })), /invalid OIDC logout token audience/);
  await refuses(jwt(logoutClaims({ events: undefined })), /no logout event/);
  await refuses(jwt(logoutClaims({ events: [BACKCHANNEL_LOGOUT_EVENT] })), /no logout event/);
  await refuses(jwt(logoutClaims({ events: "x" })), /no logout event/);
  await refuses(jwt(logoutClaims({ events: { "http://schemas.openid.net/event/other": {} } })), /no logout event/);
  await refuses(jwt(logoutClaims({ events: { [BACKCHANNEL_LOGOUT_EVENT]: "yes" } })), /no logout event/);
  await refuses(jwt(logoutClaims({ events: { [BACKCHANNEL_LOGOUT_EVENT]: [] } })), /no logout event/);
  await refuses(jwt(logoutClaims({ nonce: "n-1" })), /must not carry a nonce/);
  await refuses(jwt(logoutClaims({ jti: undefined })), /no usable id/);
  await refuses(jwt(logoutClaims({ jti: "" })), /no usable id/);
  await refuses(jwt(logoutClaims({ jti: 5 })), /no usable id/);
  await refuses(jwt(logoutClaims({ jti: "j".repeat(257) })), /no usable id/);
  await refuses(jwt(logoutClaims({ sub: "" })), /invalid OIDC logout token subject/);
  await refuses(jwt(logoutClaims({ sub: 7 })), /invalid OIDC logout token subject/);
  await refuses(jwt(logoutClaims({ sub: "s".repeat(1025) })), /invalid OIDC logout token subject/);
  await refuses(jwt(logoutClaims({ sid: "" })), /invalid OIDC logout token session/);
  await refuses(jwt(logoutClaims({ sid: ["a"] })), /invalid OIDC logout token session/);
  await refuses(jwt(logoutClaims({ sid: "s".repeat(1025) })), /invalid OIDC logout token session/);
  await refuses(jwt(logoutClaims({ sub: undefined, sid: undefined })), /neither a subject nor a session/);
});

test("a logout token must be fresh and unexpired, not issued in the future, with integer timestamps", async () => {
  await refuses(jwt(logoutClaims({ iat: NOW - LOGOUT_TOKEN_MAX_AGE_SECONDS - 31, exp: NOW + 100 })), /not fresh/);
  await refuses(jwt(logoutClaims({ iat: NOW + 31 })), /not fresh/);
  await refuses(jwt(logoutClaims({ exp: NOW - 31 })), /expired OIDC logout token/);
  await refuses(jwt(logoutClaims({ iat: "now" })), /timestamps/);
  await refuses(jwt(logoutClaims({ exp: undefined })), /timestamps/);
  await refuses(jwt(logoutClaims({ exp: NOW + 1.5 })), /timestamps/);
  // The edges (within the skew and the maximum age) are accepted.
  assert.ok(await verify(jwt(logoutClaims({ iat: NOW - LOGOUT_TOKEN_MAX_AGE_SECONDS - 30, exp: NOW + 100 }))));
  assert.ok(await verify(jwt(logoutClaims({ iat: NOW + 30, exp: NOW + 200 }))));
  assert.ok(await verify(jwt(logoutClaims({ exp: NOW - 30 }))));
});

test("a forged logout token is refused: wrong key, tampered claims, wrong algorithm or key id, malformed", async () => {
  await refuses(jwt(logoutClaims(), { key: other.privateKey }), /invalid OIDC token signature/);
  const [header, , signature] = jwt(logoutClaims()).split(".");
  const swapped = Buffer.from(JSON.stringify(logoutClaims({ sub: "victim" }))).toString("base64url");
  await refuses(`${header}.${swapped}.${signature}`, /invalid OIDC token signature/);
  await refuses(jwt(logoutClaims(), { header: { alg: "HS256" } }), /unsupported OIDC signing header/);
  await refuses(jwt(logoutClaims(), { header: { alg: "none" } }), /unsupported OIDC signing header/);
  await refuses(jwt(logoutClaims(), { header: { kid: undefined } }), /unsupported OIDC signing header/);
  await refuses(jwt(logoutClaims(), { header: { kid: "unknown" } }), /signing key is unknown/);
  await refuses("not-a-jwt", /malformed OIDC logout token/);
  await refuses("a.b", /malformed OIDC logout token/);
  await refuses("a..c", /malformed OIDC logout token/);
  await refuses(`${"a".repeat(MAX_LOGOUT_TOKEN_LENGTH)}.b.c`, /malformed OIDC logout token/);
  await refuses("@@@.e30.c", /malformed OIDC header/);
  await refuses(`e30.@@@.c`, /malformed OIDC claims/);
});

test("the signing keys come from the issuer's published keys only; a configured JWKS URL is used without discovery", async () => {
  const calls: string[] = [];
  await verify(jwt(logoutClaims()), {}, new OidcVerifier(fixtureFetch(calls)));
  assert.deepEqual(calls, [`${issuer}/.well-known/openid-configuration`, `${issuer}/jwks`]);
  const direct: string[] = [];
  await verify(jwt(logoutClaims()), { jwksUrl: `${issuer}/jwks` }, new OidcVerifier(fixtureFetch(direct)));
  assert.deepEqual(direct, [`${issuer}/jwks`]);
  // An outage while fetching keys fails closed.
  await assert.rejects(verify(jwt(logoutClaims()), {}, new OidcVerifier(async () => new Response("down", { status: 503 }))), /metadata request failed/);
});

test("the claimed issuer is read without trusting the token, only to choose which provider to verify it against", () => {
  assert.equal(unverifiedLogoutTokenIssuer(jwt(logoutClaims({ iss: "https://IDP.example.com/" }))), issuer);
  assert.throws(() => unverifiedLogoutTokenIssuer("nope"), /malformed OIDC logout token/);
  assert.throws(() => unverifiedLogoutTokenIssuer(`a.${"b".repeat(MAX_LOGOUT_TOKEN_LENGTH)}.c`), /malformed OIDC logout token/);
  assert.throws(() => unverifiedLogoutTokenIssuer(jwt(logoutClaims({ iss: undefined }))), /invalid OIDC logout token issuer/);
  assert.throws(() => unverifiedLogoutTokenIssuer(jwt(logoutClaims({ iss: "" }))), /invalid OIDC logout token issuer/);
  assert.throws(() => unverifiedLogoutTokenIssuer(jwt(logoutClaims({ iss: "http://insecure.example.com" }))), /must use HTTPS/);
  assert.throws(() => unverifiedLogoutTokenIssuer(jwt(logoutClaims({ iss: "not a url" }))), /invalid OIDC issuer URL/);
  assert.equal(normalizeOidcIssuer("https://Idp.Example.com/?q=1#f"), issuer);
});

// ------------------------------------------------------------------ the bearer path
function bearerToken(overrides: Record<string, unknown> = {}): string {
  return jwt({ iss: issuer, aud: audience, sub: "user-1", sid: "session-1", iat: NOW - 5, exp: NOW + 300, ...overrides }, { header: { typ: "JWT" } });
}
const bearer = (token: string) => new OidcVerifier(fixtureFetch()).verify({ authorization: `Bearer ${token}`, issuer, audience, now });

test("a back-channel logout token can never be used as a bearer credential", async () => {
  await assert.rejects(bearer(bearerToken(logoutClaims())), /an OIDC logout token is not a bearer token/);
  await assert.rejects(bearer(bearerToken({ events: { [BACKCHANNEL_LOGOUT_EVENT]: {}, "x": {} } })), /not a bearer token/);
  // Other event claims, a null or non-object `events` do not make a token a logout token.
  assert.ok(await bearer(bearerToken({ events: { "https://example.com/other": {} } })));
  assert.ok(await bearer(bearerToken({ events: null })));
  assert.ok(await bearer(bearerToken({ events: "text" })));
});

test("F7a: the token's amr and acr claims are carried only when the provider sent them, validated and bounded", async () => {
  const none = await bearer(bearerToken());
  assert.deepEqual(none, { subject: "user-1", sessionId: "session-1", issuer, audience }, "no amr, no acr: nothing is claimed");
  const mfa = await bearer(bearerToken({ amr: ["pwd", "otp"], acr: "urn:example:mfa" }));
  assert.deepEqual([mfa.authMethods, mfa.mfaUsed, mfa.authContext], [["pwd", "otp"], true, "urn:example:mfa"]);
  const single = await bearer(bearerToken({ amr: ["pwd"] }));
  assert.deepEqual([single.authMethods, single.mfaUsed, single.authContext], [["pwd"], false, undefined]);
  // A malformed claim reports less and never rejects the sign-in.
  for (const amr of ["otp", { 0: "otp" }, [7, null], [], ["has space", "x".repeat(40)]]) {
    const odd = await bearer(bearerToken({ amr, acr: ["not", "a", "string"] }));
    assert.equal(odd.authMethods, undefined, JSON.stringify(amr));
    assert.equal(odd.mfaUsed, undefined);
    assert.equal(odd.authContext, undefined);
  }
  const bounded = await bearer(bearerToken({ amr: [...Array.from({ length: 30 }, (_, index) => `m${index}`)], acr: "x".repeat(300) }));
  assert.equal(bounded.authMethods!.length, 20);
  assert.equal(bounded.authContext, undefined);
});
