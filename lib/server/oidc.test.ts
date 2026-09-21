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
