import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { AuthenticationError, resolveRequestIdentity, verifyGatewayIdentityAssertion, type GatewayIdentityAssertion } from "./request-context.ts";

const managedKeys = ["NODE_ENV","CORVIS_DEMO_MODE","CORVIS_TRUSTED_AUTH_PROXY_SECRET"] as const;

async function withEnv(values: Record<string,string|undefined>, fn: () => void | Promise<void>) {
  const env = process.env as Record<string, string | undefined>;
  const previous = Object.fromEntries(managedKeys.map((key) => [key, env[key]]));
  try {
    for (const [key,value] of Object.entries(values)) {
      if (value == null) delete env[key];
      else env[key] = value;
    }
    await fn();
  } finally {
    for (const key of managedKeys) {
      if (previous[key] == null) delete env[key];
      else env[key] = previous[key];
    }
  }
}

const trustedEnvironment = {
  NODE_ENV: "test",
  CORVIS_DEMO_MODE: "false",
  CORVIS_TRUSTED_AUTH_PROXY_SECRET: "trusted-secret",
};

function trustedHeaders(overrides: Record<string,string> = {}) {
  return {
    "x-corvis-gateway-secret": "trusted-secret",
    "x-corvis-auth-subject": "user-1",
    "x-corvis-auth-tenant": "tenant-a",
    "x-corvis-auth-workspace": "workspace-a",
    "x-corvis-auth-roles": "reviewer",
    "x-corvis-entitled-workspaces": "workspace-a",
    ...overrides,
  };
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

test("unsigned business identity headers fail closed without trusted gateway secret", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: {
      "x-corvis-auth-subject": "user-1", "x-corvis-auth-tenant": "tenant-a", "x-corvis-auth-workspace": "workspace-a", "x-corvis-auth-roles": "admin",
    }});
    await assert.rejects(resolveRequestIdentity(request), AuthenticationError);
  });
});

test("incorrect trusted gateway secret is rejected on the non-production compatibility path", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: trustedHeaders({ "x-corvis-gateway-secret": "wrong-secret" }) });
    await assert.rejects(resolveRequestIdentity(request), AuthenticationError);
  });
});

test("signed gateway assertion resolves tenant, roles and entitlements", () => {
  const identity = verifyGatewayIdentityAssertion(signedAssertion(), "trusted-secret", new Date(1_800_000_100_000));
  assert.equal(identity.subject, "user-1");
  assert.equal(identity.tenantId, "tenant-a");
  assert.equal(identity.workspaceId, "workspace-a");
  assert.deepEqual(identity.roles, ["reviewer"]);
  assert.deepEqual(identity.entitlements.documentIds, ["doc-a","doc-b"]);
  assert.equal(identity.entitlements.sourceDocumentAccessAllowed, true);
  assert.equal(identity.authMethod, "saml");
});

test("signed assertion rejects signature tampering and the wrong signing key", () => {
  const assertion = signedAssertion();
  const tampered = `${assertion.slice(0, -2)}aa`;
  assert.throws(() => verifyGatewayIdentityAssertion(tampered, "trusted-secret", new Date(1_800_000_100_000)), AuthenticationError);
  assert.throws(() => verifyGatewayIdentityAssertion(assertion, "wrong-secret", new Date(1_800_000_100_000)), AuthenticationError);
});

test("signed assertion rejects expired, future-issued and overlong authorization context", () => {
  assert.throws(() => verifyGatewayIdentityAssertion(
    signedAssertion({ iat: 1_799_999_000, exp: 1_799_999_200 }),
    "trusted-secret",
    new Date(1_800_000_100_000),
  ), AuthenticationError);
  assert.throws(() => verifyGatewayIdentityAssertion(
    signedAssertion({ iat: 1_800_000_200, exp: 1_800_000_240 }),
    "trusted-secret",
    new Date(1_800_000_100_000),
  ), AuthenticationError);
  assert.throws(() => verifyGatewayIdentityAssertion(
    signedAssertion({ iat: 1_800_000_000, exp: 1_800_000_900 }),
    "trusted-secret",
    new Date(1_800_000_100_000),
  ), AuthenticationError);
});

test("signed assertion rejects invalid roles and a workspace outside signed entitlements", () => {
  assert.throws(() => verifyGatewayIdentityAssertion(
    signedAssertion({ roles: ["root" as never] }),
    "trusted-secret",
    new Date(1_800_000_100_000),
  ), AuthenticationError);
  assert.throws(() => verifyGatewayIdentityAssertion(
    signedAssertion({ workspaceId: "workspace-b" }),
    "trusted-secret",
    new Date(1_800_000_100_000),
  ), AuthenticationError);
});

test("legacy trusted gateway compatibility remains non-production only", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: trustedHeaders({
      "x-corvis-auth-roles": "reviewer,unknown-role",
      "x-corvis-entitled-documents": "doc-a,doc-b",
      "x-corvis-source-access": "true",
      "x-corvis-auth-method": "saml",
    })});
    const identity = await resolveRequestIdentity(request);
    assert.equal(identity.tenantId, "tenant-a");
    assert.deepEqual(identity.roles, ["reviewer"]);
    assert.deepEqual(identity.entitlements.documentIds, ["doc-a","doc-b"]);
    assert.equal(identity.entitlements.sourceDocumentAccessAllowed, true);
    assert.equal(identity.authMethod, "saml");
  });
});

test("workspace context cannot be selected outside the entitled workspace set", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: trustedHeaders({
      "x-corvis-auth-workspace": "workspace-b",
      "x-corvis-entitled-workspaces": "workspace-a",
    })});
    await assert.rejects(resolveRequestIdentity(request), /Workspace context not entitled/);
  });
});

test("unknown or empty roles cannot create an authenticated request context", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    for (const roles of ["", "root,superuser"]) {
      const request = new Request("https://corvis.example/api/v1/me", { headers: trustedHeaders({ "x-corvis-auth-roles": roles }) });
      await assert.rejects(resolveRequestIdentity(request), /Missing authenticated request context/);
    }
  });
});

test("service-account authentication remains explicit and does not expand supplied roles", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: trustedHeaders({
      "x-corvis-auth-method": "service_account",
      "x-corvis-auth-roles": "api_client,admin-ish",
    })});
    const identity = await resolveRequestIdentity(request);
    assert.equal(identity.authMethod, "service_account");
    assert.deepEqual(identity.roles, ["api_client"]);
  });
});

test("demo identity is available only when explicitly enabled outside production", { concurrency: false }, async () => {
  await withEnv({ NODE_ENV: "test", CORVIS_DEMO_MODE: "true", CORVIS_TRUSTED_AUTH_PROXY_SECRET: undefined }, async () => {
    const identity = await resolveRequestIdentity(new Request("https://localhost/api/v1/me"));
    assert.equal(identity.authMethod, "demo");
    assert.equal(identity.tenantId, "tenant_demo");
  });
});
