import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { resolveAuthorizedRequestIdentity, selectWorkspaceContext } from "./authorized-request.ts";
import { AuthenticationError, SessionEndedByPolicyError } from "./request-context.ts";
import type { MembershipAuthorizationRepository } from "../../modules/identity-access/server/authorization.ts";
import type { RequestIdentity } from "../../shared/domain/enterprise.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function assertion(): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1, sub: "idp|user", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["admin"], entitlements: { workspaceIds: [WORKSPACE] },
    authMethod: "oidc", sessionId: "session-1", iat: nowSeconds - 10, exp: nowSeconds + 230,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", "trusted-secret").update(encoded).digest("base64url")}`;
}

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, env[key]]));
  try {
    Object.assign(env, values);
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value == null) delete env[key]; else env[key] = value; }
  }
}

const baseEnv = { NODE_ENV: "test", CORVIS_DEMO_MODE: "false", CORVIS_TRUSTED_AUTH_PROXY_SECRET: "trusted-secret", CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE: "1000000" };

test("selecting the workspace the identity already has changes nothing", () => {
  const identity = { subject: "u", tenantId: TENANT, workspaceId: WORKSPACE, authMethod: "oidc" } as RequestIdentity;
  const same = new Request("https://corvis.example/api/v1/me", { headers: { "x-corvis-tenant": TENANT, "x-corvis-workspace": WORKSPACE } });
  assert.equal(selectWorkspaceContext(same, identity), identity);
  const other = new Request("https://corvis.example/api/v1/me", { headers: { "x-corvis-tenant": TENANT, "x-corvis-workspace": OTHER_WORKSPACE } });
  assert.equal(selectWorkspaceContext(other, identity).workspaceId, OTHER_WORKSPACE);
});

test("a workspace selection on a signed assertion is refused where authorization is not authoritative", async () => {
  await withEnv(baseEnv, async () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: {
      "x-corvis-identity-assertion": assertion(), "x-corvis-tenant": TENANT, "x-corvis-workspace": WORKSPACE,
    } });
    await assert.rejects(resolveAuthorizedRequestIdentity(request, { requireAuthoritative: false }), (error: unknown) =>
      error instanceof AuthenticationError && /Workspace selection requires authoritative authorization/.test(error.message));
  });
});

test("without an injected repository the shared Postgres repository is used, and a refusal or an ended session is an authentication failure", async (t) => {
  const originalFetch = globalThis.fetch;
  const statements: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== "https://fake-postgres.test/sql") return originalFetch(input, init);
    statements.push(String((JSON.parse(String(init?.body)) as { sql: string }).sql));
    return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  await withEnv({ ...baseEnv, CORVIS_DATABASE_DSN: "https://fake-postgres.test/sql" }, async () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: { "x-corvis-identity-assertion": assertion() } });
    await assert.rejects(resolveAuthorizedRequestIdentity(request, { requireAuthoritative: true }), AuthenticationError);
    assert.ok(statements.some((sql) => sql.includes("tenant_identity_provider")), "the shared repository ran the membership lookup, token binding included");

    const ended: MembershipAuthorizationRepository = { async resolve() { throw new SessionEndedByPolicyError("idle_timeout"); } };
    await assert.rejects(resolveAuthorizedRequestIdentity(request, { repository: ended, requireAuthoritative: true }), SessionEndedByPolicyError);
  });
});
