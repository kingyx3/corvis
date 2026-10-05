import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { trustedIdentityAssertion } from "../../../test-support/identity-assertion.ts";
import { AuthenticationError, classifyOidcFailure, resolveRequestIdentity, verifyGatewayIdentityAssertion, type GatewayIdentityAssertion } from "./request-context.ts";

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

test("business identity headers are not an identity source, even with the correct shared secret", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: {
      "x-corvis-gateway-secret": "trusted-secret", "x-corvis-auth-subject": "user-1", "x-corvis-auth-tenant": "tenant-a",
      "x-corvis-auth-workspace": "workspace-a", "x-corvis-auth-roles": "admin", "x-corvis-entitled-workspaces": "workspace-a",
    }});
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

const caller = { subject: "user-1", tenantId: "tenant-a", workspaceId: "workspace-a", roles: ["reviewer"] };
const assertionRequest = (assertion: string) => new Request("https://corvis.example/api/v1/me", { headers: { "x-corvis-identity-assertion": assertion } });

test("a signed assertion resolves identity through the request boundary outside production", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    const identity = await resolveRequestIdentity(assertionRequest(trustedIdentityAssertion("trusted-secret", {
      ...caller, documentIds: ["doc-a", "doc-b"], sourceDocumentAccess: true, authMethod: "saml",
    })));
    assert.equal(identity.tenantId, "tenant-a");
    assert.deepEqual(identity.roles, ["reviewer"]);
    assert.deepEqual(identity.entitlements.documentIds, ["doc-a", "doc-b"]);
    assert.equal(identity.entitlements.sourceDocumentAccessAllowed, true);
    assert.equal(identity.authMethod, "saml");
  });
});

test("an assertion signed with another secret is rejected", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    await assert.rejects(resolveRequestIdentity(assertionRequest(trustedIdentityAssertion("wrong-secret", caller))), /Invalid identity assertion signature/);
  });
});

test("workspace context cannot be selected outside the entitled workspace set", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    const assertion = trustedIdentityAssertion("trusted-secret", { ...caller, workspaceId: "workspace-b", workspaceIds: ["workspace-a"] });
    await assert.rejects(resolveRequestIdentity(assertionRequest(assertion)), /Workspace context not entitled/);
  });
});

test("unknown or empty roles cannot create an authenticated request context", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    await assert.rejects(resolveRequestIdentity(assertionRequest(trustedIdentityAssertion("trusted-secret", { ...caller, roles: "" }))), /no roles/);
    await assert.rejects(resolveRequestIdentity(assertionRequest(trustedIdentityAssertion("trusted-secret", { ...caller, roles: "root,superuser" }))), /invalid role/);
  });
});

test("service-account authentication is explicit and unknown roles are rejected rather than dropped", { concurrency: false }, async () => {
  await withEnv(trustedEnvironment, async () => {
    const identity = await resolveRequestIdentity(assertionRequest(trustedIdentityAssertion("trusted-secret", { ...caller, roles: "api_client", authMethod: "service_account" })));
    assert.equal(identity.authMethod, "service_account");
    assert.deepEqual(identity.roles, ["api_client"]);
    await assert.rejects(resolveRequestIdentity(assertionRequest(trustedIdentityAssertion("trusted-secret", { ...caller, roles: "api_client,admin-ish", authMethod: "service_account" }))), /invalid role/);
  });
});

test("demo identity is available only when explicitly enabled outside production", { concurrency: false }, async () => {
  await withEnv({ NODE_ENV: "test", CORVIS_DEMO_MODE: "true", CORVIS_TRUSTED_AUTH_PROXY_SECRET: undefined }, async () => {
    const identity = await resolveRequestIdentity(new Request("https://localhost/api/v1/me"));
    assert.equal(identity.authMethod, "demo");
    assert.equal(identity.tenantId, "tenant_demo");
    assert.equal(identity.tenantDisplayName, "Meridian Capital Partners");
    assert.equal(identity.workspaceDisplayName, "Primary Workspace");
  });
});

test("a demo caller can illustrate what a provider's amr would show, and nothing else sets it", { concurrency: false }, async () => {
  await withEnv({ NODE_ENV: "test", CORVIS_DEMO_MODE: "true", CORVIS_TRUSTED_AUTH_PROXY_SECRET: undefined }, async () => {
    const mfa = async (value: string | null) => (await resolveRequestIdentity(new Request("https://localhost/api/v1/me", { headers: value === null ? {} : { "x-corvis-demo-mfa": value } }))).mfaUsed;
    assert.equal(await mfa("true"), true);
    assert.equal(await mfa("false"), false);
    assert.equal(await mfa("maybe"), undefined, "anything else is not reported");
    assert.equal(await mfa(null), undefined);
  });
});

test("demo tenant/workspace display names can be overridden by header, e.g. for e2e coverage", { concurrency: false }, async () => {
  await withEnv({ NODE_ENV: "test", CORVIS_DEMO_MODE: "true", CORVIS_TRUSTED_AUTH_PROXY_SECRET: undefined }, async () => {
    const identity = await resolveRequestIdentity(new Request("https://localhost/api/v1/me", {
      headers: { "x-corvis-demo-tenant-name": "Acme Allocators", "x-corvis-demo-workspace-name": "EMEA Team" },
    }));
    assert.equal(identity.tenantDisplayName, "Acme Allocators");
    assert.equal(identity.workspaceDisplayName, "EMEA Team");
  });
});

const productionEnvironment = {
  NODE_ENV: "production",
  CORVIS_DEMO_MODE: "false",
  CORVIS_TRUSTED_AUTH_PROXY_SECRET: undefined,
  CORVIS_AUTH_ISSUER: "https://idp.request-context.example",
  CORVIS_AUTH_AUDIENCE: "corvis",
  CORVIS_AUTH_JWKS_URL: undefined,
  CORVIS_DATABASE_DSN: "postgres://user:dummy@database.example.test/db",
  CORVIS_OBJECT_STORE_BUCKET: "bucket",
};
const tenantUuid = "11111111-1111-4111-8111-111111111111";
const workspaceUuid = "22222222-2222-4222-8222-222222222222";

async function withProductionEnv(fn: () => Promise<void>, overrides: Record<string, string> = {}) {
  const env = process.env as Record<string, string | undefined>;
  const previous = Object.fromEntries(Object.keys(productionEnvironment).map((key) => [key, env[key]]));
  try {
    for (const [key, value] of Object.entries({ ...productionEnvironment, ...overrides })) {
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
      // F7e: the issuer and audience the token was verified against travel with the identity, for a tenant's token binding.
      assert.equal(identity.tokenIssuer, issuer);
      assert.equal(identity.tokenAudience, "corvis");
      // F7a: a provider that sends no amr or acr has told Corvis nothing about how the person signed in.
      assert.equal(identity.mfaUsed, undefined);
      assert.equal(identity.authContext, undefined);
      // ... and one that does is carried as reported (validated and bounded by the verifier).
      const mfaClaims = encode({ iss: issuer, aud: "corvis", sub: "user-gw", sid: "session-gw", iat: nowSeconds - 10, exp: nowSeconds + 300, amr: ["pwd", "otp"], acr: "urn:mfa" });
      const mfaToken = `${header}.${mfaClaims}.${sign("RSA-SHA256", Buffer.from(`${header}.${mfaClaims}`), privateKey).toString("base64url")}`;
      const withMfa = await resolveRequestIdentity(new Request("https://corvis.example/api/v1/me", { headers: {
        authorization: `Bearer ${mfaToken}`, "x-corvis-tenant": tenantUuid, "x-corvis-workspace": workspaceUuid,
      }}));
      assert.deepEqual([withMfa.mfaUsed, withMfa.authContext], [true, "urn:mfa"]);

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

async function captureLogs(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = [];
  const originals = { error: console.error, warn: console.warn, info: console.info };
  const collect = (line: unknown) => { try { records.push(JSON.parse(String(line)) as Record<string, unknown>); } catch { /* not a structured log line */ } };
  console.error = collect; console.warn = collect; console.info = collect;
  try { await fn(); } finally { Object.assign(console, originals); }
  return records;
}

test("an IdP/JWKS outage is still a 401 for the caller but is logged as an outage, not bad credentials", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); }) as typeof fetch;
  try {
    await withProductionEnv(async () => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const nowSeconds = Math.floor(Date.now() / 1000);
      const shapedToken = `${encode({ alg: "RS256", kid: "k1" })}.${encode({ iss: "https://idp.outage.example", aud: "corvis", sub: "u", iat: nowSeconds - 5, exp: nowSeconds + 300 })}.c2ln`;
      const request = new Request("https://corvis.example/api/v1/me", { headers: {
        authorization: `Bearer ${shapedToken}`, "x-corvis-tenant": tenantUuid, "x-corvis-workspace": workspaceUuid, "x-correlation-id": "corr-outage",
      }});
      const logs = await captureLogs(async () => {
        await assert.rejects(resolveRequestIdentity(request), (error) => error instanceof AuthenticationError && error.message === "OIDC authentication failed");
      });
      const record = logs.find((entry) => entry.event === "auth.oidc_verification_failed");
      assert.ok(record, "the verification failure cause must be logged");
      assert.equal(record.reason, "idp_unavailable");
      assert.equal(record.level, "error");
      assert.equal(record.correlationId, "corr-outage");
      assert.ok(!JSON.stringify(record).includes(shapedToken), "the bearer token must never be logged");
    }, { CORVIS_AUTH_ISSUER: "https://idp.outage.example" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OIDC failures are classified as an IdP outage or a rejected token", () => {
  assert.equal(classifyOidcFailure(new Error("OIDC metadata request failed with status 503")), "idp_unavailable");
  assert.equal(classifyOidcFailure(Object.assign(new Error("aborted"), { name: "AbortError" })), "idp_unavailable");
  assert.equal(classifyOidcFailure(new Error("invalid OIDC JWKS response")), "idp_unavailable");
  assert.equal(classifyOidcFailure(new Error("OIDC signing keys expired; metadata refresh unavailable")), "idp_unavailable");
  assert.equal(classifyOidcFailure(new Error("malformed OIDC bearer token")), "token_rejected");
  assert.equal(classifyOidcFailure(new Error("OIDC token expired")), "token_rejected");
  assert.equal(classifyOidcFailure("not an error"), "token_rejected");
});
