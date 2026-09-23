import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
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

const productionEnvironment = {
  NODE_ENV: "production",
  CORVIS_DEMO_MODE: "false",
  CORVIS_TRUSTED_AUTH_PROXY_SECRET: undefined,
  CORVIS_AUTH_ISSUER: "https://idp.request-context.example",
  CORVIS_AUTH_AUDIENCE: "corvis",
  CORVIS_AUTH_JWKS_URL: undefined,
  CORVIS_POSTGRES_DSN: "postgres://user:dummy@database.example.test/db",
  CORVIS_OBJECT_STORE_BUCKET: "bucket",
};
const tenantUuid = "11111111-1111-4111-8111-111111111111";
const workspaceUuid = "22222222-2222-4222-8222-222222222222";

async function withProductionEnv(fn: () => Promise<void>) {
  const env = process.env as Record<string, string | undefined>;
  const previous = Object.fromEntries(Object.keys(productionEnvironment).map((key) => [key, env[key]]));
  try {
    for (const [key, value] of Object.entries(productionEnvironment)) {
      if (value == null) delete env[key];
      else env[key] = value;
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete env[key];
      else env[key] = value;
    }
  }
}

test("production OIDC rejects non-UUID tenant/workspace selectors as authentication failures", { concurrency: false }, async () => {
  await withProductionEnv(async () => {
    for (const [tenant, workspace] of [["tenant-a", workspaceUuid], [tenantUuid, "workspace'; drop"], ["", workspaceUuid]]) {
      const request = new Request("https://corvis.example/api/v1/me", { headers: {
        authorization: "Bearer a.b.c", "x-corvis-tenant": tenant, "x-corvis-workspace": workspace,
      }});
      await assert.rejects(resolveRequestIdentity(request), AuthenticationError);
    }
  });
});

test("production OIDC verifies the caller token API Gateway forwards in X-Forwarded-Authorization", { concurrency: false }, async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const issuer = productionEnvironment.CORVIS_AUTH_ISSUER;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: "rc-key", typ: "JWT" });
  const claims = encode({ iss: issuer, aud: "corvis", sub: "user-gw", sid: "session-gw", iat: nowSeconds - 10, exp: nowSeconds + 300 });
  const userToken = `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url")}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${issuer}/.well-known/openid-configuration`) return new Response(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    if (url === `${issuer}/jwks`) return new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "rc-key", alg: "RS256", use: "sig" }] }));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    await withProductionEnv(async () => {
      const gatewayRequest = new Request("https://corvis.example/api/v1/me", { headers: {
        // API Gateway's own Google ID token for Cloud Run IAM; never a user identity.
        authorization: "Bearer gateway.service-account.token",
        "x-forwarded-authorization": `Bearer ${userToken}`,
        "x-corvis-tenant": tenantUuid,
        "x-corvis-workspace": workspaceUuid,
      }});
      const identity = await resolveRequestIdentity(gatewayRequest);
      assert.equal(identity.subject, "user-gw");
      assert.equal(identity.tenantId, tenantUuid);

      const direct = new Request("https://corvis.example/api/v1/me", { headers: {
        authorization: `Bearer ${userToken}`, "x-corvis-tenant": tenantUuid, "x-corvis-workspace": workspaceUuid,
      }});
      assert.equal((await resolveRequestIdentity(direct)).subject, "user-gw");

      // When X-Forwarded-Authorization is present it is the only user credential.
      const forgedForwarded = new Request("https://corvis.example/api/v1/me", { headers: {
        authorization: `Bearer ${userToken}`, "x-forwarded-authorization": "Bearer forged.token.value",
        "x-corvis-tenant": tenantUuid, "x-corvis-workspace": workspaceUuid,
      }});
      await assert.rejects(resolveRequestIdentity(forgedForwarded), AuthenticationError);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
