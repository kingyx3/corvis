import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { MembershipAuthorizationRepository } from "./authorization.ts";
import { resolveAuthorizedRequestIdentity } from "./authorized-request.ts";
import { AuthenticationError, type GatewayIdentityAssertion } from "./request-context.ts";

function signedAssertion(secret = "trusted-secret"): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: GatewayIdentityAssertion = {
    v: 1,
    sub: "idp|user-123",
    tenantId: "11111111-1111-1111-1111-111111111111",
    workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    roles: ["admin"],
    entitlements: {
      workspaceIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
      fundIds: ["fund-from-assertion"],
      documentIds: ["doc-from-assertion"],
      sourceDocumentAccessAllowed: false,
    },
    authMethod: "oidc",
    sessionId: "session-1",
    iat: nowSeconds - 10,
    exp: nowSeconds + 230,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = env.NODE_ENV;
  const previousDemoMode = env.CORVIS_DEMO_MODE;
  const previousSecret = env.CORVIS_TRUSTED_AUTH_PROXY_SECRET;
  try {
    env.NODE_ENV = "test";
    env.CORVIS_DEMO_MODE = "false";
    env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = "trusted-secret";
    return await fn();
  } finally {
    if (previousNodeEnv == null) delete env.NODE_ENV; else env.NODE_ENV = previousNodeEnv;
    if (previousDemoMode == null) delete env.CORVIS_DEMO_MODE; else env.CORVIS_DEMO_MODE = previousDemoMode;
    if (previousSecret == null) delete env.CORVIS_TRUSTED_AUTH_PROXY_SECRET; else env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = previousSecret;
  }
}

test("authoritative Postgres roles and implemented resource grants override signed claims", { concurrency: false }, async () => {
  const repository: MembershipAuthorizationRepository = {
    async resolve() {
      return {
        roles: ["read_only"],
        workspaceIds: [
          "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        ],
        fundIds: ["fund-db"],
        documentIds: ["doc-db"],
      };
    },
  };

  await withEnv(async () => {
    const request = new Request("https://corvis.example/api/v1/me", {
      headers: { "x-corvis-identity-assertion": signedAssertion() },
    });
    const identity = await resolveAuthorizedRequestIdentity(request, { repository, requireAuthoritative: true });
    assert.deepEqual(identity.roles, ["read_only"]);
    assert.deepEqual(identity.entitlements.workspaceIds, [
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ]);
    assert.deepEqual(identity.entitlements.fundIds, ["fund-db"]);
    assert.deepEqual(identity.entitlements.documentIds, ["doc-db"]);
  });
});

test("explicit empty Postgres resource grants do not fall back to signed claims", { concurrency: false }, async () => {
  const repository: MembershipAuthorizationRepository = {
    async resolve() {
      return {
        roles: ["analyst"],
        workspaceIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
        fundIds: [],
        documentIds: [],
      };
    },
  };
  await withEnv(async () => {
    const request = new Request("https://corvis.example/api/v1/me", {
      headers: { "x-corvis-identity-assertion": signedAssertion() },
    });
    const identity = await resolveAuthorizedRequestIdentity(request, { repository, requireAuthoritative: true });
    assert.deepEqual(identity.entitlements.fundIds, []);
    assert.deepEqual(identity.entitlements.documentIds, []);
  });
});

test("missing authoritative membership fails closed after successful authentication", { concurrency: false }, async () => {
  const repository: MembershipAuthorizationRepository = { async resolve() { return null; } };
  await withEnv(async () => {
    const request = new Request("https://corvis.example/api/v1/me", {
      headers: { "x-corvis-identity-assertion": signedAssertion() },
    });
    await assert.rejects(
      resolveAuthorizedRequestIdentity(request, { repository, requireAuthoritative: true }),
      (error: unknown) => error instanceof AuthenticationError && error.message === "No active authoritative authorization context",
    );
  });
});
