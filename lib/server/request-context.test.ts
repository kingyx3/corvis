import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { AuthenticationError, resolveRequestIdentity, verifyGatewayIdentityAssertion, type GatewayIdentityAssertion } from "./request-context.ts";

const managedKeys = ["NODE_ENV","CORVIS_DEMO_MODE","CORVIS_TRUSTED_AUTH_PROXY_SECRET"] as const;

function withEnv(values: Record<string,string|undefined>, fn: () => void) {
  const env = process.env as Record<string, string | undefined>;
  const previous = Object.fromEntries(managedKeys.map((key) => [key, env[key]]));
  try {
    for (const [key,value] of Object.entries(values)) {
      if (value == null) delete env[key];
      else env[key] = value;
    }
    fn();
  } finally {
    for (const key of managedKeys) {
      if (previous[key] == null) delete env[key];
      else env[key] = previous[key];
    }
  }
}

function signedAssertion(overrides: Partial<GatewayIdentityAssertion> = {}, secret = "trusted-secret"): string {
  const payload: GatewayIdentityAssertion = {
    v: 1,
    sub: "user-1",
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    roles: ["reviewer"],
    entitlements: {
      workspaceIds: ["workspace-a"],
      documentIds: ["doc-a","doc-b"],
      sourceDocumentAccessAllowed: true,
    },
    authMethod: "saml",
    sessionId: "session-1",
    iat: 1_800_000_000,
    exp: 1_800_000_240,
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

test("unsigned business identity headers fail closed without trusted gateway secret", { concurrency: false }, () => {
  withEnv({ NODE_ENV: "test", CORVIS_DEMO_MODE: "false", CORVIS_TRUSTED_AUTH_PROXY_SECRET: "trusted-secret" }, () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: {
      "x-corvis-auth-subject": "user-1", "x-corvis-auth-tenant": "tenant-a", "x-corvis-auth-workspace": "workspace-a", "x-corvis-auth-roles": "admin",
    }});
    assert.throws(() => resolveRequestIdentity(request), AuthenticationError);
  });
});

test("signed gateway assertion resolves tenant, roles and entitlements", { concurrency: false }, () => {
  const now = new Date(1_800_000_100_000);
  const identity = verifyGatewayIdentityAssertion(signedAssertion(), "trusted-secret", now);
  assert.equal(identity.subject, "user-1");
  assert.equal(identity.tenantId, "tenant-a");
  assert.equal(identity.workspaceId, "workspace-a");
  assert.deepEqual(identity.roles, ["reviewer"]);
  assert.deepEqual(identity.entitlements.documentIds, ["doc-a","doc-b"]);
  assert.equal(identity.entitlements.sourceDocumentAccessAllowed, true);
  assert.equal(identity.authMethod, "saml");
});

test("signed assertion rejects signature tampering", () => {
  const assertion = signedAssertion();
  const tampered = `${assertion.slice(0, -2)}aa`;
  assert.throws(() => verifyGatewayIdentityAssertion(tampered, "trusted-secret", new Date(1_800_000_100_000)), AuthenticationError);
});

test("signed assertion rejects expired or overlong authorization context", () => {
  assert.throws(() => verifyGatewayIdentityAssertion(
    signedAssertion({ iat: 1_799_999_000, exp: 1_799_999_200 }),
    "trusted-secret",
    new Date(1_800_000_100_000),
  ), AuthenticationError);
  assert.throws(() => verifyGatewayIdentityAssertion(
    signedAssertion({ iat: 1_800_000_000, exp: 1_800_000_900 }),
    "trusted-secret",
    new Date(1_800_000_100_000),
  ), AuthenticationError);
});

test("signed assertion rejects a workspace outside the signed entitlement set", () => {
  assert.throws(() => verifyGatewayIdentityAssertion(
    signedAssertion({ workspaceId: "workspace-b" }),
    "trusted-secret",
    new Date(1_800_000_100_000),
  ), AuthenticationError);
});

test("legacy trusted gateway compatibility remains non-production only", { concurrency: false }, () => {
  withEnv({ NODE_ENV: "test", CORVIS_DEMO_MODE: "false", CORVIS_TRUSTED_AUTH_PROXY_SECRET: "trusted-secret" }, () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: {
      "x-corvis-gateway-secret": "trusted-secret",
      "x-corvis-auth-subject": "user-1",
      "x-corvis-auth-tenant": "tenant-a",
      "x-corvis-auth-workspace": "workspace-a",
      "x-corvis-auth-roles": "reviewer,unknown-role",
      "x-corvis-entitled-workspaces": "workspace-a",
      "x-corvis-entitled-documents": "doc-a,doc-b",
      "x-corvis-source-access": "true",
      "x-corvis-auth-method": "saml",
    }});
    const identity = resolveRequestIdentity(request);
    assert.equal(identity.tenantId, "tenant-a");
    assert.deepEqual(identity.roles, ["reviewer"]);
    assert.deepEqual(identity.entitlements.documentIds, ["doc-a","doc-b"]);
  });
});

test("demo identity is available only when explicitly enabled outside production", { concurrency: false }, () => {
  withEnv({ NODE_ENV: "test", CORVIS_DEMO_MODE: "true", CORVIS_TRUSTED_AUTH_PROXY_SECRET: undefined }, () => {
    const identity = resolveRequestIdentity(new Request("https://localhost/api/v1/me"));
    assert.equal(identity.authMethod, "demo");
    assert.equal(identity.tenantId, "tenant_demo");
  });
});
