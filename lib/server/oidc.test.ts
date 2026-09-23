import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { OidcVerifier } from "./oidc.ts";

const issuer = "https://idp.example.com";
const audience = "corvis";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });
const kid = "test-key";

function token(overrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: issuer,
    aud: audience,
    sub: "user-1",
    sid: "session-1",
    iat: 1_800_000_000,
    exp: 1_800_000_300,
    ...overrides,
  })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

function fetchFixture(): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }), { status: 200 });
    }
    if (url === `${issuer}/jwks`) {
      return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }), {
        status: 200,
        headers: { "cache-control": "public, max-age=300" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

test("OIDC verifier validates issuer, audience, signature and stable session identity", async () => {
  const verifier = new OidcVerifier(fetchFixture());
  const identity = await verifier.verify({
    authorization: `Bearer ${token()}`,
    issuer,
    audience,
    now: new Date(1_800_000_100_000),
  });
  assert.deepEqual(identity, { subject: "user-1", sessionId: "session-1" });
});

test("OIDC verifier rejects wrong audience, expiry and signature tampering", async () => {
  const verifier = new OidcVerifier(fetchFixture());
  await assert.rejects(verifier.verify({
    authorization: `Bearer ${token({ aud: "other" })}`,
    issuer,
    audience,
    now: new Date(1_800_000_100_000),
  }), /audience/);
  await assert.rejects(verifier.verify({
    authorization: `Bearer ${token({ exp: 1_799_999_999 })}`,
    issuer,
    audience,
    now: new Date(1_800_000_100_000),
  }), /expired/);
  const valid = token();
  await assert.rejects(verifier.verify({
    authorization: `Bearer ${valid.slice(0, -2)}aa`,
    issuer,
    audience,
    now: new Date(1_800_000_100_000),
  }), /signature/);
});

test("OIDC verifier accepts an explicit HTTPS JWKS URL and derives a token-local session id when sid/jti are absent", async () => {
  const verifier = new OidcVerifier(fetchFixture());
  const identity = await verifier.verify({
    authorization: `Bearer ${token({ sid: undefined })}`,
    issuer,
    audience,
    jwksUrl: `${issuer}/jwks`,
    now: new Date(1_800_000_100_000),
  });
  assert.equal(identity.subject, "user-1");
  assert.match(identity.sessionId, /^token-[0-9a-f]{64}$/);
});

function tokenWithKid(tokenKid: string, nowSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: tokenKid, typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: "user-1", sid: "session-1", iat: nowSeconds - 10, exp: nowSeconds + 3_600 })).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url")}`;
}

function countingFixture(options: { failJwksAfter?: number } = {}) {
  const counts = { discovery: 0, jwks: 0 };
  const base = fetchFixture();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) counts.discovery += 1;
    if (url.endsWith("/jwks")) {
      counts.jwks += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (options.failJwksAfter !== undefined && counts.jwks > options.failJwksAfter) return new Response("unavailable", { status: 503 });
    }
    return base(input, init);
  };
  return { counts, fetchImpl };
}

test("OIDC unknown-kid JWKS refreshes are single-flight and rate limited", async () => {
  const { counts, fetchImpl } = countingFixture();
  const verifier = new OidcVerifier(fetchImpl);
  const t0 = 1_800_000_100;
  const verifyAt = (tokenKid: string, seconds: number) => verifier.verify({
    authorization: `Bearer ${tokenWithKid(tokenKid, t0)}`, issuer, audience, now: new Date(seconds * 1_000),
  });

  // Cold start: concurrent requests share one JWKS fetch.
  await Promise.all(Array.from({ length: 5 }, () => verifyAt(kid, t0)));
  assert.equal(counts.jwks, 1);

  // Forged tokens with an unknown kid inside the minimum interval never refetch.
  for (const result of await Promise.allSettled(Array.from({ length: 10 }, () => verifyAt("forged", t0 + 1)))) {
    assert.equal(result.status, "rejected");
  }
  assert.equal(counts.jwks, 1);

  // After the interval, a burst of unknown kids triggers exactly one refetch.
  await Promise.allSettled(Array.from({ length: 10 }, () => verifyAt("forged", t0 + 31)));
  assert.equal(counts.jwks, 2);
  await assert.rejects(verifyAt("forged", t0 + 32), /unknown/);
  assert.equal(counts.jwks, 2);
  assert.equal(counts.discovery, 1);

  // Known keys continue to verify throughout.
  assert.equal((await verifyAt(kid, t0 + 33)).subject, "user-1");
});

test("OIDC keeps previously fetched keys when a JWKS refresh fails", async () => {
  const { counts, fetchImpl } = countingFixture({ failJwksAfter: 1 });
  const verifier = new OidcVerifier(fetchImpl);
  const t0 = 1_800_000_100;
  const verifyAt = (seconds: number) => verifier.verify({
    authorization: `Bearer ${tokenWithKid(kid, t0)}`, issuer, audience, now: new Date(seconds * 1_000),
  });
  await verifyAt(t0);
  // Keys expired (max-age=300) and the IdP is failing: cached keys still serve.
  assert.equal((await verifyAt(t0 + 400)).subject, "user-1");
  assert.equal(counts.jwks, 2);
  // Retries against the failing IdP are throttled as well.
  await verifyAt(t0 + 401);
  assert.equal(counts.jwks, 2);
});

test("OIDC fails closed when no JWKS has ever been fetched", async () => {
  const { fetchImpl } = countingFixture({ failJwksAfter: 0 });
  const verifier = new OidcVerifier(fetchImpl);
  await assert.rejects(verifier.verify({
    authorization: `Bearer ${tokenWithKid(kid, 1_800_000_100)}`, issuer, audience, now: new Date(1_800_000_100_000),
  }), /status 503/);
});
