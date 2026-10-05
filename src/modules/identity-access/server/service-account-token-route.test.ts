import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { hashCredentialSecret, mintCredential } from "./service-account-credential.ts";
import { verifyGatewayIdentityAssertion } from "../../../platform/http/request-context.ts";

register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

const DATABASE_DSN = "https://service-account-route.test/sql";
const SIGNING_SECRET = "test-service-account-route-signing-secret";
const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const ACCOUNT = "44444444-dddd-4ddd-8ddd-444444444444";

Object.assign(process.env, {
  NODE_ENV: "test",
  CORVIS_DATABASE_DSN: DATABASE_DSN,
  CORVIS_TRUSTED_AUTH_PROXY_SECRET: SIGNING_SECRET,
});

const credential = mintCredential();
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== DATABASE_DSN) return originalFetch(input, init);

  const { sql, parameters } = JSON.parse(String(init?.body ?? "{}")) as { sql: string; parameters: unknown[] };
  let rows: unknown[] = [];
  if (sql.includes("from corvis_control.service_account_credential")) {
    const requestedCredentialId = String(parameters[0] ?? "");
    if (requestedCredentialId === credential.credentialId) {
      rows = [{
        tenant_id: TENANT,
        credential_id: credential.credentialId,
        service_account_id: ACCOUNT,
        secret_sha256: hashCredentialSecret(credential.secret),
        subject: `service-account:${ACCOUNT}`,
        workspace_id: WORKSPACE,
        role_name: "analyst",
        usable: true,
      }];
    }
  }
  return new Response(JSON.stringify({ rows }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const { POST: tokenPost } = await import("@/app/api/v1/auth/service-account/token/route");

function request(value?: string, forwarded = false): Request {
  const headers: Record<string, string> = {};
  if (value) headers[forwarded ? "x-forwarded-authorization" : "authorization"] = value;
  return new Request("https://corvis.test/api/v1/auth/service-account/token", { method: "POST", headers });
}

test("POST service-account token exchanges a valid credential for a verifiable short-lived assertion", async () => {
  const response = await tokenPost(request(`Bearer ${credential.secret}`, true));
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    data: { accessToken: string; tokenType: string; expiresIn: number };
  };
  assert.equal(payload.data.tokenType, "Corvis-Identity-Assertion");
  assert.equal(payload.data.expiresIn, 300);
  const identity = verifyGatewayIdentityAssertion(payload.data.accessToken, SIGNING_SECRET);
  assert.equal(identity.subject, `service-account:${ACCOUNT}`);
  assert.equal(identity.tenantId, TENANT);
  assert.equal(identity.workspaceId, WORKSPACE);
  assert.equal(identity.authMethod, "service_account");
});

test("POST service-account token rejects a missing or malformed bearer credential", async () => {
  for (const authorization of [undefined, "Basic abc123", "Bearer not-a-service-account"]) {
    const response = await tokenPost(request(authorization));
    assert.equal(response.status, 401, authorization ?? "missing");
  }
});

test("POST service-account token rejects an unknown credential without revealing why", async () => {
  const unknown = mintCredential().secret;
  const response = await tokenPost(request(`Bearer ${unknown}`));
  assert.equal(response.status, 401);
  const payload = await response.json() as { error: string };
  assert.equal(payload.error, "authentication_required");
});

test("POST service-account token fails closed when the assertion signing boundary is unavailable", async () => {
  const previous = process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET;
  delete process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET;
  try {
    const response = await tokenPost(request(`Bearer ${credential.secret}`));
    assert.equal(response.status, 401);
  } finally {
    process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = previous;
  }
});
