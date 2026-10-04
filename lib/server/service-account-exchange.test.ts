import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresSqlApi } from "./postgres.ts";
import { hashCredentialSecret, mintCredential } from "./service-account-credential.ts";
import { exchangeServiceAccountCredential, serviceAccountBearer, SERVICE_ACCOUNT_ASSERTION_TTL_SECONDS } from "./service-account-exchange.ts";
import { verifyGatewayIdentityAssertion } from "./request-context.ts";

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const ACCOUNT = "44444444-dddd-4ddd-8ddd-444444444444";
const SIGNING_SECRET = "test-service-account-assertion-secret";

function dbFor(secret: string, usable = true): PostgresSqlApi {
  return {
    query: async () => [{
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
