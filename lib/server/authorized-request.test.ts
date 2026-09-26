import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AuthorizationPrincipal, MembershipAuthorizationRepository } from "./authorization.ts";
import { resolveAuthorizedRequestIdentity } from "./authorized-request.ts";
import { RateLimitError, RateLimiter } from "./rate-limit.ts";
import { AuthenticationError, type GatewayIdentityAssertion } from "./request-context.ts";

function signedAssertion(overrides: Partial<GatewayIdentityAssertion> = {}, secret = "trusted-secret"): string {
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
      sourceDocumentAccessAllowed: true,
      internalAnalyticsAllowed: true,
      modelTrainingAllowed: true,
      redistributionAllowed: true,
    },
    authMethod: "oidc",
    sessionId: "session-1",
    iat: nowSeconds - 10,
    exp: nowSeconds + 230,
    ...overrides,
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

test("authoritative Postgres roles, resource grants and data rights override signed claims", { concurrency: false }, async () => {
  let resolvedPrincipal: AuthorizationPrincipal | undefined;
  const repository: MembershipAuthorizationRepository = {
    async resolve(principal) {
      resolvedPrincipal = principal;
      return {
        roles: ["read_only"],
        workspaceIds: [
          "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        ],
        fundIds: ["fund-db"],
        documentIds: ["doc-db", "doc-no-source"],
        sourceDocumentIds: ["doc-db"],
        internalAnalyticsAllowed: false,
        modelTrainingAllowed: false,
        redistributionAllowed: false,
        isTenantAdmin: false,
        tenantDisplayName: "Meridian Capital Partners",
        workspaceDisplayName: "Primary Workspace",
        memberships: [
          { workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", workspaceDisplayName: "Primary Workspace", roles: ["read_only"] },
          { workspaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", workspaceDisplayName: "Secondary Workspace", roles: ["analyst"] },
        ],
      };
    },
  };

  await withEnv(async () => {
    const request = new Request("https://corvis.example/api/v1/me", {
      headers: { "x-corvis-identity-assertion": signedAssertion() },
    });
    const identity = await resolveAuthorizedRequestIdentity(request, { repository, requireAuthoritative: true });
    assert.deepEqual(identity.roles, ["read_only"]);
    assert.equal(identity.tenantDisplayName, "Meridian Capital Partners");
    assert.equal(identity.workspaceDisplayName, "Primary Workspace");
    assert.deepEqual(identity.entitlements.workspaceIds, [
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ]);
    assert.deepEqual(identity.entitlements.fundIds, ["fund-db"]);
    assert.deepEqual(identity.entitlements.documentIds, ["doc-db", "doc-no-source"]);
    assert.deepEqual(identity.entitlements.sourceDocumentIds, ["doc-db"]);
    assert.equal(identity.entitlements.sourceDocumentAccessAllowed, true);
    assert.equal(identity.entitlements.internalAnalyticsAllowed, false);
    assert.equal(identity.entitlements.modelTrainingAllowed, false);
    assert.equal(identity.entitlements.redistributionAllowed, false);
    assert.equal(resolvedPrincipal?.sessionId, "session-1");
    assert.deepEqual(identity.workspaceMemberships, [
      { workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", workspaceDisplayName: "Primary Workspace", roles: ["read_only"] },
      { workspaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", workspaceDisplayName: "Secondary Workspace", roles: ["analyst"] },
    ]);
  });
});

test("explicit empty Postgres resource/data-right grants do not fall back to signed claims", { concurrency: false }, async () => {
  const repository: MembershipAuthorizationRepository = {
    async resolve() {
      return {
        roles: ["analyst"],
        workspaceIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
        fundIds: [],
        documentIds: [],
        sourceDocumentIds: [],
        internalAnalyticsAllowed: false,
        modelTrainingAllowed: false,
        redistributionAllowed: false,
        isTenantAdmin: false,
        memberships: [{ workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", roles: ["analyst"] }],
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
    assert.deepEqual(identity.entitlements.sourceDocumentIds, []);
    assert.equal(identity.entitlements.sourceDocumentAccessAllowed, false);
    assert.equal(identity.entitlements.internalAnalyticsAllowed, false);
    assert.equal(identity.entitlements.modelTrainingAllowed, false);
    assert.equal(identity.entitlements.redistributionAllowed, false);
  });
});

test("requests under the per-tenant/service-account rate limit pass through untouched", { concurrency: false }, async () => {
  const rateLimiter = new RateLimiter(2, 60_000);
  await withEnv(async () => {
    const request = new Request("https://corvis.example/api/v1/me", {
      headers: { "x-corvis-identity-assertion": signedAssertion() },
    });
    const first = await resolveAuthorizedRequestIdentity(request, { rateLimiter, now: 1_000_000 });
    const second = await resolveAuthorizedRequestIdentity(request, { rateLimiter, now: 1_000_100 });
    assert.equal(first.tenantId, "11111111-1111-1111-1111-111111111111");
    assert.equal(second.tenantId, "11111111-1111-1111-1111-111111111111");
  });
});

test("a request over the rate limit is rejected with a RateLimitError carrying Retry-After seconds", { concurrency: false }, async () => {
  const rateLimiter = new RateLimiter(1, 60_000);
  await withEnv(async () => {
    const request = new Request("https://corvis.example/api/v1/me", {
      headers: { "x-corvis-identity-assertion": signedAssertion() },
    });
    await resolveAuthorizedRequestIdentity(request, { rateLimiter, now: 1_000_000 });
    await assert.rejects(
      resolveAuthorizedRequestIdentity(request, { rateLimiter, now: 1_000_000 + 5_000 }),
      (error: unknown) => error instanceof RateLimitError && error.retryAfterSeconds === 55,
    );
  });
});

test("the rate limit budget resets once the fixed window has elapsed", { concurrency: false }, async () => {
  const rateLimiter = new RateLimiter(1, 60_000);
  await withEnv(async () => {
    const request = new Request("https://corvis.example/api/v1/me", {
      headers: { "x-corvis-identity-assertion": signedAssertion() },
    });
    await resolveAuthorizedRequestIdentity(request, { rateLimiter, now: 1_000_000 });
    await assert.rejects(resolveAuthorizedRequestIdentity(request, { rateLimiter, now: 1_010_000 }), RateLimitError);
    const afterWindow = await resolveAuthorizedRequestIdentity(request, { rateLimiter, now: 1_000_000 + 60_000 });
    assert.equal(afterWindow.tenantId, "11111111-1111-1111-1111-111111111111");
  });
});

test("distinct tenant/service-account pairings do not share a rate limit budget", { concurrency: false }, async () => {
  const rateLimiter = new RateLimiter(1, 60_000);
  await withEnv(async () => {
    const requestForTenantA = new Request("https://corvis.example/api/v1/me", {
      headers: { "x-corvis-identity-assertion": signedAssertion() },
    });
    const requestForServiceAccountB = new Request("https://corvis.example/api/v1/me", {
      headers: { "x-corvis-identity-assertion": signedAssertion({ sub: "service-account|other" }) },
    });
    // Exhaust tenant A / subject "idp|user-123"'s single-request budget...
    await resolveAuthorizedRequestIdentity(requestForTenantA, { rateLimiter, now: 1_000_000 });
    await assert.rejects(resolveAuthorizedRequestIdentity(requestForTenantA, { rateLimiter, now: 1_000_000 }), RateLimitError);
    // ...a different service account under the same limiter still has budget.
    const identity = await resolveAuthorizedRequestIdentity(requestForServiceAccountB, { rateLimiter, now: 1_000_000 });
    assert.equal(identity.subject, "service-account|other");
  });
});

test("missing authoritative membership or revoked session fails closed after successful authentication", { concurrency: false }, async () => {
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

test("human workspace selectors re-resolve authoritative roles and reject unentitled targets", async () => {
  await withEnv(async () => {
    const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let selected: AuthorizationPrincipal | undefined;
    const repository: MembershipAuthorizationRepository = { async resolve(principal) { selected = principal; return null; } };
    const request = new Request("https://corvis.example/api/v1/me", { headers: {
      "x-corvis-identity-assertion": signedAssertion(), "x-corvis-tenant": "11111111-1111-1111-1111-111111111111", "x-corvis-workspace": workspaceId,
    } });
    await assert.rejects(resolveAuthorizedRequestIdentity(request, { repository, requireAuthoritative: true }), /No active authoritative/);
    assert.equal(selected?.workspaceId, workspaceId);
    assert.equal(selected?.subject, "idp|user-123");
    for (const headers of [
      { "x-corvis-tenant": "22222222-2222-4222-8222-222222222222", "x-corvis-workspace": workspaceId },
      { "x-corvis-tenant": "11111111-1111-1111-1111-111111111111", "x-corvis-workspace": "invalid" },
    ]) {
      selected = undefined;
      await assert.rejects(resolveAuthorizedRequestIdentity(new Request(request.url, { headers: { ...headers, "x-corvis-identity-assertion": signedAssertion() } }), { repository, requireAuthoritative: true }), AuthenticationError);
      assert.equal(selected, undefined);
    }
  });
});
