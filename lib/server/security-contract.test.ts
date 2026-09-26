import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function routeFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await routeFiles(full));
    else if (entry.isFile() && entry.name === "route.ts") found.push(full.replaceAll("\\", "/"));
  }
  return found.sort();
}

async function sourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(full));
    else if (entry.isFile() && /\.(?:ts|tsx|js|jsx)$/.test(entry.name)) found.push(full.replaceAll("\\", "/"));
  }
  return found.sort();
}

async function source(file: string) {
  return readFile(file, "utf8");
}

function assertPermission(sourceText: string, permission: string, file: string) {
  const escaped = permission.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(sourceText, new RegExp(`assertPermission\\(identity,\\s*[\"']${escaped}[\"']\\)`), `${file} must enforce ${permission}`);
}

test("every non-public v1 route resolves authoritative identity and enforces a role permission", async () => {
  const files = await routeFiles("app/api/v1");
  assert.ok(files.length > 10, "expected the v1 API surface to be discovered");

  const publicRoutes = new Set([
    "app/api/v1/health/route.ts",
  ]);
  const identityOnlyRoutes = new Set([
    "app/api/v1/me/route.ts",
    "app/api/v1/capabilities/route.ts",
    "app/api/v1/my-workspaces/route.ts",
  ]);
  const preMembershipIdentityRoutes = new Set([
    "app/api/v1/invitations/accept/route.ts",
  ]);

  for (const file of files) {
    const text = await source(file);
    if (publicRoutes.has(file)) continue;

    if (preMembershipIdentityRoutes.has(file)) {
      assert.match(text, /resolveRequestIdentity\(request\)/, `${file} must cryptographically authenticate the invitee before membership exists`);
      assert.match(text, /identity\.emailVerified/, `${file} must require the identity provider's verified email claim`);
      assert.match(text, /acceptTenantInvitation\(/, `${file} must let the token, not a client tenant selector, determine the granted membership`);
      continue;
    }

    assert.match(text, /resolveAuthorizedRequestIdentity\(request\)/, `${file} must resolve authoritative request authorization`);
    if (!identityOnlyRoutes.has(file)) {
      assert.match(text, /assertPermission\(identity,/, `${file} must enforce a role permission`);
    }
  }
});

test("privileged and evidence routes preserve their specific authorization boundaries", async () => {
  const expectations: Array<[string, string]> = [
    ["app/api/v1/admin/control-evidence/route.ts", "admin:manage"],
    ["app/api/v1/admin/tenants/invitations/route.ts", "admin:manage"],
    ["app/api/v1/admin/deletion-requests/route.ts", "admin:manage"],
    ["app/api/v1/admin/deletion-requests/[requestId]/execute/route.ts", "admin:manage"],
    ["app/api/v1/admin/feature-flags/route.ts", "admin:manage"],
    ["app/api/v1/admin/readiness/route.ts", "admin:manage"],
    ["app/api/v1/admin/session-revocations/route.ts", "admin:manage"],
    ["app/api/v1/admin/webhooks/subscriptions/route.ts", "admin:manage"],
    ["app/api/v1/admin/webhooks/subscriptions/[webhookId]/route.ts", "admin:manage"],
    ["app/api/v1/admin/webhooks/subscriptions/[webhookId]/rotate-signing-key/route.ts", "admin:manage"],
    ["app/api/v1/admin/webhooks/subscriptions/[webhookId]/deliveries/route.ts", "admin:manage"],
    ["app/api/v1/jobs/[jobId]/retry/route.ts", "admin:manage"],
    ["app/api/v1/exports/route.ts", "exports:create"],
    ["app/api/v1/research/route.ts", "research:query"],
    ["app/api/v1/research/stream/route.ts", "research:query"],
    ["app/api/v1/review/route.ts", "observations:review"],
    ["app/api/v1/snapshots/publish/route.ts", "snapshots:publish"],
    ["app/api/v1/source-connections/route.ts", "admin:manage"],
    ["app/api/v1/source-connections/[sourceConnectionId]/route.ts", "admin:manage"],
    ["app/api/v1/source-connections/[sourceConnectionId]/test/route.ts", "admin:manage"],
    ["app/api/v1/source-connections/[sourceConnectionId]/reauthorize/route.ts", "admin:manage"],
    ["app/api/v1/access/invitations/route.ts", "admin:manage"],
    ["app/api/v1/source-references/[sourceReferenceId]/route.ts", "sources:read"],
    ["app/api/v1/uploads/initiate/route.ts", "documents:write"],
    ["app/api/v1/uploads/[uploadId]/route.ts", "documents:write"],
    ["app/api/v1/uploads/[uploadId]/complete/route.ts", "documents:write"],
  ];

  for (const [file, permission] of expectations) {
    const text = await source(file);
    assertPermission(text, permission, file);
  }

  const sourceReference = await source("app/api/v1/source-references/[sourceReferenceId]/route.ts");
  assert.match(sourceReference, /assertDocumentAccess\(identity,\s*documentId,\s*true\)/, "source evidence must require document-level source entitlement");

  const uploadStatus = await source("app/api/v1/uploads/[uploadId]/route.ts");
  assert.match(uploadStatus, /actorSubject === identity\.subject \|\| identity\.roles\.includes\(["']admin["']\)/, "upload status/abort must stay uploader-scoped except for admins");

  const uploadComplete = await source("app/api/v1/uploads/[uploadId]/complete/route.ts");
  assert.match(uploadComplete, /current\.actorSubject !== identity\.subject && !identity\.roles\.includes\(["']admin["']\)/, "upload completion must stay uploader-scoped except for admins");
});

test("browser and client adapter code cannot manufacture trusted identity gateway headers", async () => {
  const files = [...await sourceFiles("app"), ...await sourceFiles("adapters")];
  const forbidden = [
    "x-corvis-identity-assertion",
    "x-corvis-gateway-secret",
    "x-corvis-auth-subject",
    "x-corvis-auth-tenant",
    "x-corvis-auth-workspace",
    "x-corvis-auth-roles",
    "x-corvis-entitled-workspaces",
    "x-corvis-entitled-documents",
    "x-corvis-source-access",
  ];

  for (const file of files) {
    const text = (await source(file)).toLowerCase();
    for (const header of forbidden) {
      assert.equal(text.includes(header), false, `${file} must not set or embed trusted identity header ${header}`);
    }
  }
});

test("all API routes remain covered by the central browser CSRF/CORS boundary when the proxy also gates runtime surfaces", async () => {
  const proxy = await source("proxy.ts");
  assert.match(proxy, /matcher:\s*["']\/:path\*["']/);
  assert.match(proxy, /pathname\.startsWith\(["']\/api\/["']\)[\s\S]*checkBrowserRequest\(request\)/);
  assert.match(proxy, /cache-control["']?,\s*["']no-store["']/i);
  assert.match(proxy, /Origin, Sec-Fetch-Site/);
});

test("the proxy issues a fresh per-request CSP nonce to both the request and the response in production", async () => {
  const proxy = await source("proxy.ts");
  assert.match(proxy, /generateNonce\(\)/, "each request must get its own nonce, not a shared/module-level one");
  assert.match(proxy, /requestHeaders\.set\(["']x-nonce["'],\s*nonce\)/, "the nonce must reach Server Components via a request header");
  assert.match(proxy, /requestHeaders\.set\(["']content-security-policy["'],\s*contentSecurityPolicy\)/, "Next.js extracts the nonce from the CSP header on the request, not just the response");
  assert.match(proxy, /NextResponse\.next\(\{\s*request:\s*\{\s*headers:\s*requestHeaders\s*\}\s*\}\)/, "the mutated request headers must actually be forwarded downstream");
  assert.match(proxy, /response\.headers\.set\(["']Content-Security-Policy["'],\s*contentSecurityPolicy\)/, "the browser must also receive the CSP header on the response");

  const csp = await source("lib/server/content-security-policy.ts");
  assert.match(csp, /script-src[^`]*'nonce-\$\{nonce\}'[^`]*'strict-dynamic'/, "script-src must be nonce/strict-dynamic based, not host-allowlist based");
  assert.equal(/script-src[^`]*unsafe-inline/.test(csp), false, "script-src must not fall back to unsafe-inline");

  const layout = await source("app/layout.tsx");
  assert.match(layout, /connection\(\)/, "the root layout must force dynamic rendering so every request gets its own nonce");
});

test("outbound webhook delivery is replay-safe and bounded", async () => {
  const delivery = await source("lib/server/delivery.ts");
  const migrations = await Promise.all([
    "db/postgres/migrations/003_operations_delivery_governance.sql",
    "db/postgres/migrations/006_upload_delivery_operations.sql",
  ].map((file) => source(file)));
  const sql = migrations.join("\n").toLowerCase();

  assert.match(delivery, /d\.state in \('delivering','complete'\)/, "claimed/completed webhook deliveries must not be redelivered concurrently");
  assert.match(delivery, /on conflict \(tenant_id,webhook_id,event_id,attempt\) do nothing/, "duplicate delivery claims must be idempotent");
  assert.match(delivery, /coalesce\(\(select max\(d\.attempt\)[\s\S]*?\),0\)<5/, "webhook delivery selection must stop after five attempts");
  assert.match(delivery, /attempt>=5\?["']failed["']:["']retryable["']/, "the fifth failed attempt must become terminal");
  assert.match(delivery, /webhookHeaders\(String\(row\.signing_secret\),envelope\)/, "every outbound delivery must be signed with its subscription's own active key");
  assert.match(delivery, /k\.tenant_id=s\.tenant_id and k\.webhook_id=s\.webhook_id and k\.status='active'/, "delivery must resolve the tenant-scoped active signing key, not a shared secret");
  assert.match(sql, /unique \(tenant_id, webhook_id, event_id, attempt\)/, "database must enforce unique delivery attempts per tenant/webhook/event");
});

test("Postgres tenant authorization remains keyed to auth.uid and tenant/workspace membership", async () => {
  const sql = (await source("db/postgres/migrations/001_control_plane.sql")).toLowerCase();
  assert.match(sql, /where m\.tenant_id = row_tenant_id[\s\S]*m\.user_id = auth\.uid\(\)/);
  assert.match(sql, /where m\.tenant_id = row_tenant_id[\s\S]*m\.workspace_id = row_workspace_id[\s\S]*m\.user_id = auth\.uid\(\)/);
  assert.match(sql, /m\.status = 'active'/);
  assert.match(sql, /m\.valid_from <= now\(\)/);
  assert.match(sql, /m\.valid_until is null or m\.valid_until > now\(\)/);
  assert.equal(/create policy[^;]+for (insert|update|delete|all)/.test(sql), false, "client-side broad mutation policies must remain absent");
});

test("authoritative session revocation is tenant-scoped, server-managed, and checked on every production authorization lookup", async () => {
  const migration = (await source("db/postgres/migrations/008_session_revocation.sql")).toLowerCase();
  const authorization = await source("lib/server/authorization.ts");

  assert.match(migration, /create table if not exists corvis_control\.session_revocation/);
  assert.match(migration, /primary key \(tenant_id, auth_method, subject, session_id\)/);
  assert.match(migration, /alter table corvis_control\.session_revocation enable row level security/);
  assert.match(migration, /alter table corvis_control\.session_revocation force row level security/);
  assert.equal(/create policy[^;]+session_revocation/.test(migration), false, "session revocation must stay server-managed with no client policy");

  assert.match(authorization, /from corvis_control\.session_revocation r/);
  assert.match(authorization, /r\.tenant_id=s\.tenant_id/);
  assert.match(authorization, /r\.auth_method=s\.auth_method/);
  assert.match(authorization, /r\.subject=s\.subject/);
  assert.match(authorization, /r\.session_id=\$4/);
});
