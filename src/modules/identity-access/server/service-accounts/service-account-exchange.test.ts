import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { hashCredentialSecret, mintCredential } from "./service-account-credential.ts";
import { enforceServiceAccountExchangeClientLimit, exchangeServiceAccountCredential, serviceAccountBearer, SERVICE_ACCOUNT_ASSERTION_TTL_SECONDS } from "./service-account-exchange.ts";
import { RateLimiter, RateLimitError } from "../../../../platform/http/limits/rate-limit.ts";
import { verifyGatewayIdentityAssertion } from "../request/request-context.ts";

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const ACCOUNT = "44444444-dddd-4ddd-8ddd-444444444444";
const SIGNING_SECRET = "test-service-account-assertion-secret";

function dbFor(secret: string, usable = true): PostgresSqlApi {
  return {
    query: async (sql) => sql.includes("consume_api_rate_limit") ? [{ allowed: true }] : [{
      tenant_id: TENANT,
      credential_id: "ignored",
      service_account_id: ACCOUNT,
      secret_sha256: hashCredentialSecret(secret),
      subject: `service-account:${ACCOUNT}`,
      workspace_id: WORKSPACE,
      role_name: "analyst",
      usable,
    }],
    execute: async () => undefined,
    health: async () => true,
};
}

test("service account bearer accepts forwarded gateway authorization", () => {
  const credential = mintCredential().secret;
  const request = new Request("https://corvis.test/api/v1/auth/service-account/token", {
    headers: { "x-forwarded-authorization": `Bearer ${credential}` },
  });
  assert.equal(serviceAccountBearer(request), credential);
});

test("service account bearer falls back to Authorization and rejects malformed credentials", () => {
  const credential = mintCredential().secret;
  assert.equal(serviceAccountBearer(new Request("https://corvis.test", {
    headers: { authorization: `bearer ${credential}` },
  })), credential);
  assert.equal(serviceAccountBearer(new Request("https://corvis.test", {
    headers: { authorization: "Basic abc123" },
  })), null);
  assert.equal(serviceAccountBearer(new Request("https://corvis.test", {
    headers: { authorization: "Bearer not-a-corvis-service-account" },
  })), null);
  assert.equal(serviceAccountBearer(new Request("https://corvis.test")), null);
});

test("credential exchange produces a short-lived verifiable service identity", async () => {
  const credential = mintCredential().secret;
  const now = new Date("2026-10-04T00:00:00Z");
  const exchanged = await exchangeServiceAccountCredential(credential, dbFor(credential), SIGNING_SECRET, now);
  assert.ok(exchanged);
  assert.equal(exchanged.expiresIn, SERVICE_ACCOUNT_ASSERTION_TTL_SECONDS);
  const identity = verifyGatewayIdentityAssertion(exchanged.assertion, SIGNING_SECRET, now);
  assert.equal(identity.subject, `service-account:${ACCOUNT}`);
  assert.equal(identity.tenantId, TENANT);
  assert.equal(identity.workspaceId, WORKSPACE);
  assert.equal(identity.authMethod, "service_account");
  assert.deepEqual(identity.roles, ["api_client"]);
  assert.deepEqual(identity.entitlements.workspaceIds, [WORKSPACE]);
});

test("credential exchange rejects invalid, revoked or expired credentials without minting an assertion", async () => {
  const credential = mintCredential().secret;
  const other = mintCredential().secret;
  assert.equal(await exchangeServiceAccountCredential(other, dbFor(credential), SIGNING_SECRET), null);
  assert.equal(await exchangeServiceAccountCredential(credential, dbFor(credential, false), SIGNING_SECRET), null);
});

test("credential exchange fails closed when assertion signing is not configured", async () => {
  const credential = mintCredential().secret;
  await assert.rejects(
    exchangeServiceAccountCredential(credential, dbFor(credential), ""),
    /assertion signing is not configured/,
  );
});

test("exchange client budget uses the edge address, forwarded fallback or bounded unknown key and resets after a minute", () => {
  const limiter = new RateLimiter(1);
  const request = (headers: Record<string, string>) => new Request("https://corvis.test", { headers });
  const edge = request({ "cf-connecting-ip": "192.0.2.1", "x-forwarded-for": "192.0.2.2, 192.0.2.3" });
  enforceServiceAccountExchangeClientLimit(edge, { limiter, now: 0 });
  assert.throws(() => enforceServiceAccountExchangeClientLimit(edge, { limiter, now: 1 }), RateLimitError);
  enforceServiceAccountExchangeClientLimit(request({ "x-forwarded-for": "192.0.2.2, 192.0.2.3" }), { limiter, now: 0 });
  enforceServiceAccountExchangeClientLimit(request({}), { limiter, now: 0 });
  assert.throws(() => enforceServiceAccountExchangeClientLimit(request({ "cf-connecting-ip": " ", "x-forwarded-for": " " }), { limiter, now: 1 }), RateLimitError);
  enforceServiceAccountExchangeClientLimit(edge, { limiter, now: 60_000 });
});

test("credential exchange consumes the identity's distributed budget and refuses to mint when it is exhausted or unavailable", async () => {
  const credential = mintCredential().secret;
  for (const failure of ["exhausted", "unavailable"] as const) {
    const db = dbFor(credential);
    const query = db.query;
    db.query = async (sql, parameters) => {
      if (!sql.includes("consume_api_rate_limit")) return query(sql, parameters);
      assert.deepEqual(parameters?.slice(0, 2), [TENANT, `service-account:${ACCOUNT}`]);
      if (failure === "unavailable") throw new Error("database unavailable");
      return [{ allowed: false, retry_after_seconds: 20 }];
    };
    await assert.rejects(exchangeServiceAccountCredential(credential, db, SIGNING_SECRET), failure === "exhausted" ? RateLimitError : /database unavailable/);
  }
});
