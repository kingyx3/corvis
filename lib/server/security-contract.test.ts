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

async function source(file: string) {
  return readFile(file, "utf8");
}

function assertPermission(sourceText: string, permission: string, file: string) {
  const escaped = permission.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(sourceText, new RegExp(`assertPermission\\(identity,\\s*[\"']${escaped}[\"']\\)`), `${file} must enforce ${permission}`);
}

test("every non-public v1 route resolves authenticated identity and enforces a role permission", async () => {
  const files = await routeFiles("app/api/v1");
  assert.ok(files.length > 10, "expected the v1 API surface to be discovered");

  const publicRoutes = new Set([
    "app/api/v1/health/route.ts",
  ]);
  const identityOnlyRoutes = new Set([
    "app/api/v1/me/route.ts",
  ]);

  for (const file of files) {
    const text = await source(file);
    if (publicRoutes.has(file)) continue;

    assert.match(text, /resolveRequestIdentity\(request\)/, `${file} must authenticate the request`);
    if (!identityOnlyRoutes.has(file)) {
      assert.match(text, /assertPermission\(identity,/, `${file} must enforce a role permission`);
    }
  }
});

test("privileged and evidence routes preserve their specific authorization boundaries", async () => {
  const expectations: Array<[string, string]> = [
    ["app/api/v1/admin/control-evidence/route.ts", "admin:manage"],
    ["app/api/v1/admin/deletion-requests/route.ts", "admin:manage"],
    ["app/api/v1/admin/deletion-requests/[requestId]/execute/route.ts", "admin:manage"],
    ["app/api/v1/admin/feature-flags/route.ts", "admin:manage"],
    ["app/api/v1/admin/readiness/route.ts", "admin:manage"],
    ["app/api/v1/jobs/[jobId]/retry/route.ts", "admin:manage"],
    ["app/api/v1/exports/route.ts", "exports:create"],
    ["app/api/v1/research/route.ts", "research:query"],
    ["app/api/v1/review/route.ts", "observations:review"],
    ["app/api/v1/snapshots/publish/route.ts", "snapshots:publish"],
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

test("all API routes are covered by the central browser CSRF/CORS boundary", async () => {
  const proxy = await source("proxy.ts");
  assert.match(proxy, /checkBrowserRequest\(request\)/);
  assert.match(proxy, /matcher:\s*["']\/api\/:path\*["']/);
  assert.match(proxy, /cache-control["']?,\s*["']no-store["']/i);
  assert.match(proxy, /Origin, Sec-Fetch-Site/);
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
  assert.match(delivery, /webhookHeaders\(config\.webhookSigningSecret,envelope\)/, "every outbound delivery must be signed");
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
