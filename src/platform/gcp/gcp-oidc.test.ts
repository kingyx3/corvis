import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import { GoogleOidcVerifier } from "./gcp-oidc.ts";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(input: {
  privateKey: KeyObject;
  kid: string;
  audience: string;
  email: string;
  subject?: string;
  now: number;
}): string {
  const header = encode({ alg: "RS256", typ: "JWT", kid: input.kid });
  const claims = encode({
    iss: "https://accounts.google.com",
    aud: input.audience,
    sub: input.subject ?? "109876543210987654321",
    email: input.email,
    email_verified: true,
    iat: input.now - 10,
    exp: input.now + 600,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), input.privateKey).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

test("GoogleOidcVerifier validates signature, audience and approved worker email", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "worker-key";
  const jwk = publicKey.export({ format: "jwk" });
  let fetches = 0;
  const verifier = new GoogleOidcVerifier(async () => {
    fetches += 1;
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }), {
      status: 200,
      headers: { "cache-control": "public, max-age=3600" },
    });
  });
  const now = 1_800_000_000;
  const audience = "https://worker.example/api/internal/processing-stage";
  const email = "corvis-worker-prod@example.iam.gserviceaccount.com";
  const jwt = token({ privateKey, kid, audience, email, now });

  const identity = await verifier.verify({
    authorization: `Bearer ${jwt}`,
    audience,
    serviceAccountEmail: email,
    now: new Date(now * 1000),
  });
  assert.equal(identity.subject, "109876543210987654321");
  assert.equal(identity.email, email);

  await verifier.verify({
    authorization: `Bearer ${jwt}`,
    audience,
    serviceAccountEmail: email,
    now: new Date(now * 1000),
  });
  assert.equal(fetches, 1, "Google signing keys should be cached");
});

test("GoogleOidcVerifier rejects wrong audience, wrong service account and tampered signature", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "worker-key";
  const jwk = publicKey.export({ format: "jwk" });
  const verifier = new GoogleOidcVerifier(async () => new Response(JSON.stringify({
    keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }],
  }), { status: 200 }));
  const now = 1_800_000_000;
  const audience = "https://worker.example/api/internal/processing-stage";
  const email = "corvis-worker-prod@example.iam.gserviceaccount.com";
  const jwt = token({ privateKey, kid, audience, email, now });

  await assert.rejects(() => verifier.verify({
    authorization: `Bearer ${jwt}`,
    audience: `${audience}/wrong`,
    serviceAccountEmail: email,
    now: new Date(now * 1000),
  }), /audience/);

  await assert.rejects(() => verifier.verify({
    authorization: `Bearer ${jwt}`,
    audience,
    serviceAccountEmail: "other@example.iam.gserviceaccount.com",
    now: new Date(now * 1000),
  }), /not approved/);

  const [header, claims] = jwt.split(".");
  const tampered = `${header}.${claims}.AA`;
  await assert.rejects(() => verifier.verify({
    authorization: `Bearer ${tampered}`,
    audience,
    serviceAccountEmail: email,
    now: new Date(now * 1000),
  }), /signature/);
});

test("GoogleOidcVerifier unknown-kid refreshes are single-flight, rate limited and keep keys on failure", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "worker-key";
  const jwk = publicKey.export({ format: "jwk" });
  let fetches = 0;
  let failing = false;
  const verifier = new GoogleOidcVerifier(async () => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (failing) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }), {
      status: 200,
      headers: { "cache-control": "public, max-age=300" },
    });
  });
  const now = 1_800_000_000;
  const audience = "https://worker.example/api/internal/processing-stage";
  const email = "corvis-worker-prod@example.iam.gserviceaccount.com";
  const valid = token({ privateKey, kid, audience, email, now });
  const forged = token({ privateKey, kid: "forged", audience, email, now });
  const verifyAt = (jwt: string, seconds: number) => verifier.verify({
    authorization: `Bearer ${jwt}`, audience, serviceAccountEmail: email, now: new Date(seconds * 1000),
  });

  await Promise.all(Array.from({ length: 5 }, () => verifyAt(valid, now)));
  assert.equal(fetches, 1);
  await Promise.allSettled(Array.from({ length: 10 }, () => verifyAt(forged, now + 1)));
  assert.equal(fetches, 1);
  await Promise.allSettled(Array.from({ length: 10 }, () => verifyAt(forged, now + 31)));
  assert.equal(fetches, 2);

  // Unexpired keys survive a failed unknown-kid refresh (and a known kid never refetches).
  failing = true;
  assert.equal((await verifyAt(valid, now + 200)).email, email);
  assert.equal(fetches, 2);
  await assert.rejects(() => verifyAt(forged, now + 232), /unknown/);
  assert.equal(fetches, 3);
  assert.equal((await verifyAt(valid, now + 233)).email, email);
  assert.equal(fetches, 3);

  // Once the cache expires, an outage must not keep old signing keys trusted.
  await assert.rejects(() => verifyAt(valid, now + 400), /503/);
  assert.equal(fetches, 4);
  await assert.rejects(() => verifyAt(valid, now + 401), /expired/);
  assert.equal(fetches, 4);

  failing = false;
  assert.equal((await verifyAt(valid, now + 431)).email, email);
  assert.equal(fetches, 5);
});

test("GoogleOidcVerifier throttles cold-start JWKS failures and shares the in-flight refresh", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "worker-key";
  const jwk = publicKey.export({ format: "jwk" });
  let fetches = 0;
  let failing = true;
  const verifier = new GoogleOidcVerifier(async () => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (failing) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }), {
      status: 200,
      headers: { "cache-control": "public, max-age=300" },
    });
  });
  const now = 1_800_000_000;
  const audience = "https://worker.example/api/internal/processing-stage";
  const email = "corvis-worker-prod@example.iam.gserviceaccount.com";
  const valid = token({ privateKey, kid, audience, email, now });
  const verifyAt = (seconds: number) => verifier.verify({
    authorization: `Bearer ${valid}`, audience, serviceAccountEmail: email, now: new Date(seconds * 1000),
  });

  await Promise.allSettled(Array.from({ length: 5 }, () => verifyAt(now)));
  assert.equal(fetches, 1);
  for (let i = 1; i <= 5; i += 1) await assert.rejects(() => verifyAt(now + i));
  assert.equal(fetches, 1);

  failing = false;
  await verifyAt(now + 31);
  assert.equal(fetches, 2);
});

const REJECT_NOW = 1_800_000_000;
const REJECT_AUDIENCE = "https://worker.example/api/internal/processing-stage";
const REJECT_EMAIL = "corvis-worker-prod@example.iam.gserviceaccount.com";

function unsignedToken(header: unknown, claims: Record<string, unknown>): string {
  const base = {
    iss: "https://accounts.google.com",
    aud: REJECT_AUDIENCE,
    sub: "109876543210987654321",
    email: REJECT_EMAIL,
    email_verified: true,
    iat: REJECT_NOW - 10,
    exp: REJECT_NOW + 600,
  };
  return `${encode(header)}.${encode({ ...base, ...claims })}.c2ln`;
}

test("GoogleOidcVerifier rejects malformed credentials and unapproved claims before any JWKS fetch", async () => {
  let fetches = 0;
  const verifier = new GoogleOidcVerifier(async () => {
    fetches += 1;
    throw new Error("JWKS must not be fetched for a token that fails claim validation");
  });
  const header = { alg: "RS256", typ: "JWT", kid: "k" };
  const cases: Array<[string, string | null, RegExp]> = [
    ["no header", null, /missing GCP OIDC bearer token/],
    ["non-bearer scheme", "Basic abc", /malformed GCP OIDC bearer token/],
    ["two segments", "Bearer a.b", /malformed GCP OIDC token/],
    ["empty segment", "Bearer a..c", /malformed GCP OIDC token/],
    ["non-JSON header", "Bearer !!!.e30.c2ln", /malformed GCP OIDC header/],
    ["non-JSON claims", `Bearer ${encode(header)}.!!!.c2ln`, /malformed GCP OIDC claims/],
    ["wrong alg", `Bearer ${unsignedToken({ ...header, alg: "HS256" }, {})}`, /unsupported GCP OIDC signing header/],
    ["missing kid", `Bearer ${unsignedToken({ alg: "RS256" }, {})}`, /unsupported GCP OIDC signing header/],
    ["non-numeric exp", `Bearer ${unsignedToken(header, { exp: "soon" })}`, /invalid GCP OIDC token timestamps/],
    ["string iat", `Bearer ${unsignedToken(header, { iat: "yesterday" })}`, /invalid GCP OIDC token timestamps/],
    ["fractional iat",`Bearer ${unsignedToken(header, { iat: 1.5 })}`, /invalid GCP OIDC token timestamps/],
    ["expired", `Bearer ${unsignedToken(header, { exp: REJECT_NOW - 60, iat: REJECT_NOW - 600 })}`, /expired GCP OIDC token/],
    ["issued in the future", `Bearer ${unsignedToken(header, { iat: REJECT_NOW + 120 })}`, /invalid GCP OIDC token lifetime/],
    ["exp not after iat", `Bearer ${unsignedToken(header, { iat: REJECT_NOW, exp: REJECT_NOW })}`, /invalid GCP OIDC token lifetime/],
    ["wrong issuer", `Bearer ${unsignedToken(header, { iss: "https://evil.example" })}`, /invalid GCP OIDC token issuer/],
    ["wrong audience", `Bearer ${unsignedToken(header, { aud: "https://other.example" })}`, /invalid GCP OIDC token audience/],
    ["empty subject", `Bearer ${unsignedToken(header, { sub: "" })}`, /no immutable subject/],
    ["other service account", `Bearer ${unsignedToken(header, { email: "other@example.iam.gserviceaccount.com" })}`, /service identity is not approved/],
    ["unverified email", `Bearer ${unsignedToken(header, { email_verified: false })}`, /service identity is not approved/],
  ];
  for (const [name, authorization, expected] of cases) {
    await assert.rejects(
      () => verifier.verify({ authorization, audience: REJECT_AUDIENCE, serviceAccountEmail: REJECT_EMAIL, now: new Date(REJECT_NOW * 1000) }),
      expected,
      name,
    );
  }
  assert.equal(fetches, 0);
});

test("GoogleOidcVerifier validates the JWKS document, key selection, signature and cache lifetime", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  let body: unknown;
  let cacheControl: string | null = null;
  let fetches = 0;
  const verifier = new GoogleOidcVerifier(async () => {
    fetches += 1;
    const headers = cacheControl === null ? undefined : { "cache-control": cacheControl };
    return new Response(JSON.stringify(body), { status: 200, headers });
  });
  const kid = "worker-key";
  const verifyAt = (seconds: number, signer: { key?: typeof privateKey; kid?: string } = {}) => verifier.verify({
    authorization: `Bearer ${token({ privateKey: signer.key ?? privateKey, kid: signer.kid ?? kid, audience: REJECT_AUDIENCE, email: REJECT_EMAIL, now: seconds })}`,
    audience: REJECT_AUDIENCE,
    serviceAccountEmail: REJECT_EMAIL,
    now: new Date(seconds * 1000),
  });

  let at = REJECT_NOW;
  for (const invalid of [null, [], { keys: "nope" }]) {
    body = invalid;
    at += 100;
    await assert.rejects(() => verifyAt(at), /invalid Google JWKS response/);
  }

  body = {
    keys: [
      null,
      [],
      { kid, kty: "RSA", n: 1, e: "AQAB" },
      { ...jwk, kid, kty: "EC" },
      { ...jwk, kid, alg: "RS384" },
      { ...jwk, kid, use: "enc" },
    ],
  };
  at += 100;
  await assert.rejects(() => verifyAt(at), /contained no usable signing keys/);

  body = { keys: [{ ...jwk, kid }, { ...jwk, kid: "other-key", alg: "RS256", use: "sig" }] };
  cacheControl = "max-age=0";
  at += 100;
  const refreshedAt = at;
  assert.equal((await verifyAt(refreshedAt)).email, REJECT_EMAIL);
  const afterFirstRefresh = fetches;
  assert.equal((await verifyAt(refreshedAt + 299)).email, REJECT_EMAIL);
  assert.equal(fetches, afterFirstRefresh, "a non-positive max-age falls back to the 300 second default");

  await assert.rejects(() => verifyAt(refreshedAt + 100, { kid: "missing-key" }), /signing key is unknown/);

  await assert.rejects(() => verifyAt(refreshedAt + 100, { key: other.privateKey }), /invalid GCP OIDC token signature/);

  cacheControl = "max-age=999999999";
  at = refreshedAt + 400;
  assert.equal((await verifyAt(at)).email, REJECT_EMAIL);
  const afterLongRefresh = fetches;
  assert.equal((await verifyAt(at + 86_399)).email, REJECT_EMAIL);
  assert.equal(fetches, afterLongRefresh, "keys stay cached for the capped 24 hour lifetime");
});

test("GoogleOidcVerifier defaults to the current time and aborts a hung JWKS request after its timeout", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const kid = "worker-key";
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const authorization = `Bearer ${token({ privateKey, kid, audience: REJECT_AUDIENCE, email: REJECT_EMAIL, now: nowSeconds })}`;

  const working = new GoogleOidcVerifier(async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid }] }), { status: 200 }));
  const identity = await working.verify({ authorization, audience: REJECT_AUDIENCE, serviceAccountEmail: REJECT_EMAIL });
  assert.equal(identity.email, REJECT_EMAIL);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hung = new GoogleOidcVerifier((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted by JWKS timeout")));
  }));
  const pending = assert.rejects(
    () => hung.verify({ authorization, audience: REJECT_AUDIENCE, serviceAccountEmail: REJECT_EMAIL }),
    /aborted by JWKS timeout/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5_000);
  await pending;
});
