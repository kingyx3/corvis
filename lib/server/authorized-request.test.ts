import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { MembershipAuthorizationRepository } from "./authorization.ts";
import { resolveAuthorizedRequestIdentity } from "./authorized-request.ts";
import { AuthenticationError, type GatewayIdentityAssertion } from "./request-context.ts";

function signedAssertion(secret = "trusted-secret"): string {
  const payload: GatewayIdentityAssertion = {
    v: 1,
    sub: "idp|user-123",
    tenantId: "11111111-1111-1111-1111-111111111111",
    workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    roles: ["admin"],
    entitlements: {
      workspaceIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
      documentIds: ["doc-a"],
      sourceDocumentAccessAllowed: false,
    },
    authMethod: "oidc",
    sessionId: "session-1",
    iat: 1_800_000_000,
    exp: 1_800_000_240,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = env.NODE_ENV;
  const previousSecret = env.CORVIS_TRUSTED_AUTH_PROXY_SECRET;
  try {
    env.NODE_ENV = "test";
    env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = "trusted-secret";
    return await fn();
  } finally {
    if (previousNodeEnv == null) delete env.NODE_ENV; else env.NODE_ENV = previousNodeEnv;
    if (previousSecret == null) delete env.CORVIS_TRUSTED_AUTH_PROXY_SECRET; else env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = previousSecret;
  }
}

test("authoritative Postgres roles override roles carried by the signed assertion", { concurrency: false }, async () => {
  const repository: MembershipAuthorizationRepository = {
    async resolve() {
      return {
        roles: ["read_only"],
        workspaceIds: [
          "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
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
    assert.deepEqual(identity.entitlements.workspaceIds, [
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ]);
    assert.deepEqual(identity.entitlements.documentIds, ["doc-a"]);
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
      AuthenticationError,
    );
  });
});
