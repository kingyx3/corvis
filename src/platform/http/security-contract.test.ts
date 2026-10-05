import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

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

// The general "every route authenticates and enforces a role permission" check and the per-route
// permission table that used to live here as source regexes are now behavioural: see
// src/platform/http/route-authorization.test.ts, which calls every handler with no credentials (401) and with
// each role lacking the route's permission (403), and asserts SCIM, worker, entitlement, upload and
// tenant-scoping behaviour. What remains below is only what a request cannot exercise.
test("invitation acceptance authenticates the invitee before membership exists and lets the token pick the tenant", async () => {
  const text = await source("src/app/api/v1/invitations/accept/route.ts");
  assert.match(text, /resolveRequestIdentity\(request\)/, "the invitee must be cryptographically authenticated before membership exists");
  assert.match(text, /identity\.emailVerified/, "the identity provider's verified email claim must be required");
  assert.match(text, /acceptTenantInvitation\(/, "the token, not a client tenant selector, must determine the granted membership");
});

test("every upload entry point uses the shared owner-or-admin access rule", async () => {
  // The rule lives in src/modules/sources/server/upload-access.ts (tested behaviourally in upload-access.test.ts) and route
  // authorization for every v1 route is exercised behaviourally in route-authorization.test.ts; this only pins
  // that no entry point re-inlines its own copy of the rule.
  for (const file of ["src/app/api/v1/uploads/[uploadId]/route.ts", "src/app/api/v1/uploads/[uploadId]/complete/route.ts", "src/modules/sources/server/uploads.ts"]) {
    const text = await source(file);
    assert.match(text, /canAccessUpload\(identity,/, `${file} must use the shared upload access rule`);
    assert.doesNotMatch(text, /roles\.includes\(["']admin["']\)/, `${file} must not re-inline the upload access rule`);
  }
});

test("browser and client adapter code cannot manufacture trusted identity gateway headers", async () => {
  const moduleAdapterDirectories = (await readdir("src/modules")).map((name) => `src/modules/${name}/adapters`).filter((directory) => existsSync(directory));
  const files = [...await sourceFiles("src/app"), ...await sourceFiles("src/platform/demo"), ...(await Promise.all(moduleAdapterDirectories.map(sourceFiles))).flat()];
  assert.ok(files.length > 20, "expected to scan the app routes, demo adapters and every module adapter directory");
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
  const proxy = await source("src/proxy.ts");
  assert.match(proxy, /matcher:\s*["']\/:path\*["']/);
  assert.match(proxy, /pathname\.startsWith\(["']\/api\/["']\)[\s\S]*checkBrowserRequest\(request\)/);
  assert.match(proxy, /cache-control["']?,\s*["']no-store["']/i);
  assert.match(proxy, /Origin, Sec-Fetch-Site/);
});

test("the proxy issues a fresh per-request CSP nonce to both the request and the response in production", async () => {
  const proxy = await source("src/proxy.ts");
  assert.match(proxy, /generateNonce\(\)/, "each request must get its own nonce, not a shared/module-level one");
  assert.match(proxy, /requestHeaders\.set\(["']x-nonce["'],\s*nonce\)/, "the nonce must reach Server Components via a request header");
  assert.match(proxy, /requestHeaders\.set\(["']content-security-policy["'],\s*contentSecurityPolicy\)/, "Next.js extracts the nonce from the CSP header on the request, not just the response");
  assert.match(proxy, /NextResponse\.next\(\{\s*request:\s*\{\s*headers:\s*requestHeaders\s*\}\s*\}\)/, "the mutated request headers must actually be forwarded downstream");
  assert.match(proxy, /response\.headers\.set\(["']Content-Security-Policy["'],\s*contentSecurityPolicy\)/, "the browser must also receive the CSP header on the response");

  const csp = await source("src/platform/http/content-security-policy.ts");
  assert.match(csp, /script-src[^`]*'nonce-\$\{nonce\}'[^`]*'strict-dynamic'/, "script-src must be nonce/strict-dynamic based, not host-allowlist based");
  assert.equal(/script-src[^`]*unsafe-inline/.test(csp), false, "script-src must not fall back to unsafe-inline");

  const layout = await source("src/app/layout.tsx");
  assert.match(layout, /connection\(\)/, "the root layout must force dynamic rendering so every request gets its own nonce");
});

test("outbound webhook delivery is replay-safe and bounded", async () => {
  const delivery = await source("src/modules/delivery/server/delivery.ts");
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
  const authorization = await source("src/modules/identity-access/server/authorization.ts");

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
