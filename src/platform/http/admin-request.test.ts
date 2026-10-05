import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AuthorizationError, type RequestIdentity, type Role } from "../../shared/domain/enterprise.ts";
import { assertTenantAdminIdentity, readJsonObject, resolveAdminRequestIdentity } from "./admin-request.ts";
import type { MembershipAuthorization, MembershipAuthorizationRepository } from "../../modules/identity-access/server/authorization.ts";
import { RateLimiter } from "./rate-limit.ts";

function post(body: string): Request {
  return new Request("https://corvis.test/api/v1/admin/x", { method: "POST", headers: { "content-type": "application/json" }, body });
}

test("readJsonObject accepts only a JSON object command body", async () => {
  assert.deepEqual(await readJsonObject(post(JSON.stringify({ key: "ui.delivery_workspace" }))), { key: "ui.delivery_workspace" });
  for (const body of ["null", "[]", "[{\"key\":\"x\"}]", "42", "\"text\"", "true", "{not json", ""]) {
    assert.equal(await readJsonObject(post(body)), undefined, `body ${JSON.stringify(body)} must be rejected`);
  }
});

async function routeFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await routeFiles(full));
    else if (entry.name === "route.ts") found.push(full.replaceAll("\\", "/"));
  }
  return found;
}

test("every admin command route rejects a null/array/primitive body with 400 before reading fields", async () => {
  const files = (await routeFiles("src/app/api/v1/admin")).filter((file) => !file.includes("/admin/webhooks/"));
  let commandRoutes = 0;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.equal(/request\.json\(\)/.test(source), false, `${file} must read its body through readJsonObject`);
    if (!source.includes("readJsonObject(request)")) continue;
    commandRoutes += 1;
    assert.match(source, /if \(!body\) return json\(\{ error: "invalid_request", correlationId: id \}, \{ status: 400 \}\);/, file);
  }
  assert.ok(commandRoutes >= 10, `expected every admin command route to be guarded, saw ${commandRoutes}`);
});

const ROLES: Role[] = ["admin", "reviewer", "analyst", "api_client", "read_only"];

function identityWith(roles: Role[], isTenantAdmin: boolean | undefined): RequestIdentity {
  return {
    subject: "idp|user",
    tenantId: "11111111-1111-1111-1111-111111111111",
    workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    roles,
    entitlements: { workspaceIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"], sourceDocumentAccessAllowed: false },
    authMethod: "oidc",
    sessionId: "session-1",
    isTenantAdmin,
  };
}

test("assertTenantAdminIdentity admits only a literal tenant-admin flag, whatever the application roles", () => {
  assert.doesNotThrow(() => assertTenantAdminIdentity(identityWith(["admin"], true)));
  for (const roles of [["admin"], ...ROLES.map((role) => [role])] as Role[][]) {
    for (const flag of [false, undefined, "true" as unknown as boolean, 1 as unknown as boolean]) {
      assert.throws(
        () => assertTenantAdminIdentity(identityWith(roles, flag)),
        (error: unknown) => error instanceof AuthorizationError && error.requiredPermission === "admin:tenant_manage",
        `roles=${roles} isTenantAdmin=${String(flag)}`,
      );
    }
  }
});

function signedAssertion(): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1, sub: "idp|user-123", tenantId: "11111111-1111-1111-1111-111111111111", workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    roles: ["admin"], entitlements: { workspaceIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"], sourceDocumentAccessAllowed: false },
    authMethod: "oidc", sessionId: "session-1", iat: nowSeconds - 10, exp: nowSeconds + 230,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", "trusted-secret").update(encoded).digest("base64url")}`;
}

function authorization(roles: Role[], isTenantAdmin: boolean): MembershipAuthorization {
  return {
    roles, workspaceIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"], fundIds: [], documentIds: [], sourceDocumentIds: [],
    internalAnalyticsAllowed: false, modelTrainingAllowed: false, redistributionAllowed: false, isTenantAdmin,
    memberships: [{ workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", roles }],
  };
}

test("resolveAdminRequestIdentity refuses a caller without the role even when the path-based scope check does not apply", { concurrency: false }, async () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = { node: env.NODE_ENV, demo: env.CORVIS_DEMO_MODE, secret: env.CORVIS_TRUSTED_AUTH_PROXY_SECRET };
  env.NODE_ENV = "test";
  env.CORVIS_DEMO_MODE = "false";
  env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = "trusted-secret";
  try {
    const resolve = (path: string, authorized: MembershipAuthorization) => {
      const repository: MembershipAuthorizationRepository = { resolve: async () => authorized };
      const request = new Request(`https://corvis.example${path}`, { headers: { "x-corvis-identity-assertion": signedAssertion() } });
      return resolveAdminRequestIdentity(request, { repository, requireAuthoritative: true, rateLimiter: new RateLimiter(100, 60_000) });
    };
    const denied = (error: unknown) => error instanceof AuthorizationError;

    // Sanity: on an admin path the path-based scope check rejects an accountadmin (application admin, not tenant admin).
    await assert.rejects(resolve("/api/v1/admin/audit", authorization(["admin"], false)), denied);
    // Bypass: a path the scope check does not cover. The helper still refuses the same caller.
    await assert.rejects(
      resolve("/api/v1/documents", authorization(["admin"], false)),
      (error: unknown) => error instanceof AuthorizationError && error.requiredPermission === "admin:tenant_manage",
    );
    // A tenant admin whose role in the requested workspace lacks admin:manage is refused as well.
    await assert.rejects(
      resolve("/api/v1/documents", authorization(["read_only"], true)),
      (error: unknown) => error instanceof AuthorizationError && error.requiredPermission === "admin:manage",
    );
    // A tenant admin holding admin:manage is admitted on either path.
    for (const path of ["/api/v1/admin/audit", "/api/v1/documents"]) {
      assert.equal((await resolve(path, authorization(["admin"], true))).isTenantAdmin, true);
    }
  } finally {
    for (const [key, value] of [["NODE_ENV", previous.node], ["CORVIS_DEMO_MODE", previous.demo], ["CORVIS_TRUSTED_AUTH_PROXY_SECRET", previous.secret]] as const) {
      if (value == null) delete env[key]; else env[key] = value;
    }
  }
});

test("every admin route handler resolves its identity through resolveAdminRequestIdentity and nothing else", async () => {
  let handlers = 0;
  for (const file of await routeFiles("src/app/api/v1/admin")) {
    const source = await readFile(file, "utf8");
    const exported = [...source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].length;
    assert.ok(exported > 0, `${file} exports no handler`);
    const guarded = [...source.matchAll(/await\s+resolveAdminRequestIdentity\(request\)/g)].length;
    assert.equal(guarded, exported, `${file}: each handler must call resolveAdminRequestIdentity(request)`);
    assert.equal(/resolveAuthorizedRequestIdentity|resolveRequestIdentity/.test(source), false, `${file} must not resolve an identity without the admin guard`);
    handlers += exported;
  }
  assert.ok(handlers >= 28, `expected the whole admin surface, saw ${handlers} handlers`);
});
