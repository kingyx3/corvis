import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { GoogleOidcVerifier } from "./gcp-oidc.ts";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(input: {
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
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
