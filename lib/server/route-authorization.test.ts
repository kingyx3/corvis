import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

// Behavioural authorization tests. Every handler below is invoked directly with an injected
// identity (the trusted-gateway header path, which is how non-production identities and their
// entitlements are supplied) and the observable outcome is asserted: 401 without credentials,
// 403 for a role lacking the permission, and that the permitted role gets past authorization.
// Route modules use the Next.js "@/..." alias; see lib/server/http.test.ts.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const OTHER_TENANT = "22222222-bbbb-4bbb-8bbb-222222222222";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const GATEWAY_SECRET = "route-authorization-gateway-secret";
const WORKER_SECRET = "route-authorization-worker-secret";
const SOME_UUID = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";

process.env.CORVIS_DEMO_MODE = "";
process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = GATEWAY_SECRET;
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";
process.env.CORVIS_WORKER_SECRET = WORKER_SECRET;
process.env.CORVIS_OPERATIONS_TENANT_ID = TENANT;
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";
delete process.env.CORVIS_PROCESSING_WORKER_AUDIENCE;
delete process.env.CORVIS_PROCESSING_WORKER_SERVICE_ACCOUNT;

// Handlers log every denial; keep the TAP stream readable.
const quiet = () => undefined;
console.warn = quiet;
console.info = quiet;
console.error = quiet;

type Query = { sql: string; parameters: unknown[] };
const queries: Query[] = [];
let respond: (query: Query) => unknown[] = () => [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_POSTGRES_DSN) return originalFetch(input, init);
  const { sql, parameters } = JSON.parse(String(init?.body ?? "{}")) as Query;
  const query = { sql: sql.trim(), parameters };
  queries.push(query);
  return new Response(JSON.stringify({ rows: respond(query) }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

function seedDatabase(handler: (query: Query) => unknown[] = () => []) {
  queries.length = 0;
  respond = handler;
}

const { hasPermission } = await import("@/core/enterprise");
type Role = "admin" | "reviewer" | "analyst" | "api_client" | "read_only";
type Permission = Parameters<typeof hasPermission>[1];
const ROLES: Role[] = ["admin", "reviewer", "analyst", "api_client", "read_only"];

function holds(role: Role, permission: Permission): boolean {
  return hasPermission({ roles: [role] } as never, permission);
}

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;

type Caller = {
  roles?: Role[] | null; // null => no credentials at all
  tenant?: string;
  subject?: string;
  funds?: string[];
  documents?: string[];
  sourceAccess?: boolean;
  redistribution?: boolean;
  authMethod?: string;
  method?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
};

let sequence = 0;
function requestFor(path: string, caller: Caller = {}): Request {
  sequence += 1;
  const headers: Record<string, string> = { "x-correlation-id": `corr-authz-${sequence}`, ...(caller.headers ?? {}) };
  if (caller.roles !== null) {
    headers["x-corvis-gateway-secret"] = GATEWAY_SECRET;
    headers["x-corvis-auth-subject"] = caller.subject ?? `subject-${sequence}`;
    headers["x-corvis-auth-tenant"] = caller.tenant ?? TENANT;
    headers["x-corvis-auth-workspace"] = WORKSPACE;
    headers["x-corvis-auth-roles"] = (caller.roles ?? ["admin"]).join(",");
    headers["x-corvis-entitled-funds"] = (caller.funds ?? []).join(",");
    headers["x-corvis-entitled-documents"] = (caller.documents ?? []).join(",");
    headers["x-corvis-source-access"] = String(caller.sourceAccess ?? false);
    headers["x-corvis-redistribution"] = String(caller.redistribution ?? false);
    if (caller.authMethod) headers["x-corvis-auth-method"] = caller.authMethod;
  }
  const method = caller.method ?? "GET";
  const hasBody = (caller.body !== undefined || caller.rawBody !== undefined) && method !== "GET" && method !== "HEAD";
  if (hasBody) headers["content-type"] = "application/json";
  return new Request(`https://corvis.test/api/v1${path}`, {
    method,
    headers,
    body: hasBody ? (caller.rawBody ?? JSON.stringify(caller.body)) : undefined,
  });
}

async function load(file: string): Promise<Record<string, Handler>> {
  return await import(`@/app/api/v1/${file.replace(/\/route\.ts$/, "/route")}`) as Record<string, Handler>;
}

function paramsFor(file: string): { params: Promise<Record<string, string>> } {
  const params: Record<string, string> = {};
  for (const match of file.matchAll(/\[([^\]]+)\]/g)) params[match[1]!] = SOME_UUID;
  return { params: Promise.resolve(params) };
}

function pathFor(file: string): string {
  return "/" + file.replace(/\/route\.ts$/, "").replace(/\[[^\]]+\]/g, SOME_UUID);
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

// -------------------------------------------------------------------------------------------
// Authorization matrix: route file -> { exported method -> permission the identity must hold }.
// `null` means "authenticated identity only" (no role permission is required).
// -------------------------------------------------------------------------------------------
const ADMIN = "admin:manage" as const;
const MATRIX: Array<[string, Record<string, Permission | null>]> = [
  ["access/audit/route.ts", { GET: ADMIN }],
  ["access/data-exports/[exportId]/download/route.ts", { GET: ADMIN }],
  ["access/data-exports/[exportId]/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["access/data-exports/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["access/invitations/[invitationId]/route.ts", { POST: ADMIN }],
  ["access/invitations/bulk/route.ts", { POST: ADMIN }],
  ["access/invitations/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["access/members/deactivate/route.ts", { POST: ADMIN }],
  ["access/members/role/route.ts", { POST: ADMIN }],
  ["access/members/route.ts", { GET: ADMIN }],
  ["access/retention/route.ts", { GET: ADMIN }],
  ["access/scim/route.ts", { POST: ADMIN }],
  ["access/session-policy/route.ts", { GET: ADMIN, PUT: ADMIN }],
  ["access/session-policy/sign-out/route.ts", { POST: ADMIN }],
  ["access/service-accounts/[serviceAccountId]/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["access/service-accounts/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["access/support/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["admin/access-policy/route.ts", { POST: ADMIN }],
  ["admin/access-review/route.ts", { GET: ADMIN }],
  ["admin/audit/route.ts", { GET: ADMIN }],
  ["admin/control-evidence/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["admin/data-corrections/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["admin/data-issues/[caseId]/route.ts", { GET: ADMIN, PATCH: ADMIN }],
  ["admin/data-issues/route.ts", { GET: ADMIN }],
  ["admin/deletion-requests/[requestId]/execute/route.ts", { POST: ADMIN }],
  ["admin/deletion-requests/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["admin/feature-flags/emergency-stop/route.ts", { POST: ADMIN }],
  ["admin/feature-flags/governance/route.ts", { GET: ADMIN }],
  ["admin/feature-flags/kill-switch/route.ts", { POST: ADMIN }],
  ["admin/feature-flags/retire/route.ts", { POST: ADMIN }],
  ["admin/feature-flags/route.ts", { GET: ADMIN, PUT: ADMIN }],
  ["admin/identity-lifecycle/route.ts", { POST: ADMIN }],
  ["admin/processing-transport/dead-letters/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["admin/readiness/route.ts", { GET: ADMIN }],
  ["admin/session-revocations/route.ts", { POST: ADMIN }],
  ["admin/support-access/route.ts", { POST: ADMIN }],
  ["admin/tenant-export-builds/route.ts", { GET: ADMIN }],
  ["admin/tenant-health/route.ts", { GET: ADMIN }],
  ["admin/tenant-identity/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["admin/tenants/invitations/route.ts", { POST: ADMIN }],
  ["admin/tenants/route.ts", { POST: ADMIN }],
  ["admin/webhooks/subscriptions/[webhookId]/deliveries/route.ts", { GET: ADMIN }],
  ["admin/webhooks/subscriptions/[webhookId]/rotate-signing-key/route.ts", { POST: ADMIN }],
  ["admin/webhooks/subscriptions/[webhookId]/route.ts", { PATCH: ADMIN }],
  ["admin/webhooks/subscriptions/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["capabilities/route.ts", { GET: null }],
  ["client-errors/route.ts", { POST: null }],
  ["companies/route.ts", { GET: "observations:read" }],
  ["company-lifecycle-events/route.ts", { GET: "observations:read" }],
  ["company-sectors/route.ts", { GET: "observations:read", POST: "observations:review" }],
  ["consolidated-facts/route.ts", { GET: "observations:read" }],
  ["data-issues/[caseId]/route.ts", { GET: "observations:read", PATCH: "observations:read" }],
  ["data-issues/route.ts", { GET: "observations:read", POST: "observations:read" }],
  ["document-lifecycle/route.ts", { GET: "documents:read" }],
  ["documents/route.ts", { GET: "documents:read" }],
  ["export-schedules/[scheduleId]/route.ts", { GET: "exports:create", PATCH: "exports:create", DELETE: "exports:create" }],
  ["export-schedules/route.ts", { GET: "exports:create", POST: "exports:create" }],
  ["export-schedules/runs/route.ts", { GET: "exports:create" }],
  ["exports/[exportId]/download/route.ts", { GET: "exports:create" }],
  ["exports/[exportId]/route.ts", { GET: "exports:create" }],
  ["exports/route.ts", { GET: "exports:create", POST: "exports:create" }],
  ["extraction-review/route.ts", { POST: "observations:review" }],
  ["funds/route.ts", { GET: "observations:read" }],
  ["holdings/route.ts", { GET: "observations:read" }],
  ["instruments/route.ts", { GET: "observations:read" }],
  ["jobs/[jobId]/recover/route.ts", { POST: ADMIN }],
  ["jobs/[jobId]/retry/route.ts", { POST: ADMIN }],
  ["jobs/route.ts", { GET: "documents:read" }],
  ["me/route.ts", { GET: null }],
  ["metric-definitions/route.ts", { GET: "observations:read" }],
  ["my-workspaces/route.ts", { GET: null }],
  ["notification-preferences/route.ts", { GET: null, PUT: null }],
  ["observations/route.ts", { GET: "observations:read" }],
  ["performance-scorecard/route.ts", { GET: "observations:read" }],
  ["portfolio-holdings/route.ts", { GET: "observations:read" }],
  ["portfolios/route.ts", { GET: "observations:read" }],
  ["position-financials/route.ts", { GET: "observations:read" }],
  ["reconciliation-exceptions/resolve/route.ts", { POST: "observations:review" }],
  ["reconciliation-exceptions/route.ts", { GET: "observations:review" }],
  ["reconciliations/route.ts", { GET: "observations:read" }],
  ["research/pins/[pinId]/route.ts", { DELETE: "research:query" }],
  ["research/pins/route.ts", { GET: "research:query", POST: "research:query" }],
  ["research/route.ts", { POST: "research:query" }],
  ["research/stream/route.ts", { POST: "research:query" }],
  ["review-items/[subjectKind]/[subjectId]/assignee/route.ts", { PUT: "observations:review" }],
  ["review-items/[subjectKind]/[subjectId]/comments/route.ts", { POST: "observations:review" }],
  ["review-items/[subjectKind]/[subjectId]/route.ts", { GET: "observations:review" }],
  ["review-items/assigned/route.ts", { GET: "observations:review" }],
  ["review-items/route.ts", { GET: "observations:review" }],
  ["review/route.ts", { POST: "observations:review" }],
  ["sectors/route.ts", { GET: "observations:read" }],
  ["snapshots/publish/route.ts", { POST: "snapshots:publish" }],
  ["snapshots/route.ts", { GET: "observations:read" }],
  ["source-connections/[sourceConnectionId]/reauthorize/route.ts", { POST: ADMIN }],
  ["source-connections/[sourceConnectionId]/route.ts", { GET: ADMIN, PATCH: ADMIN }],
  ["source-connections/[sourceConnectionId]/test/route.ts", { POST: ADMIN }],
  ["source-connections/activity/route.ts", { GET: ADMIN }],
  ["source-connections/connect/route.ts", { POST: ADMIN }],
  ["source-connections/oauth/complete/route.ts", { POST: ADMIN }],
  ["source-connections/oauth/start/route.ts", { POST: ADMIN }],
  ["source-connections/providers/route.ts", { GET: ADMIN }],
  ["source-connections/route.ts", { GET: ADMIN, POST: ADMIN }],
  ["source-references/[sourceReferenceId]/route.ts", { GET: "sources:read" }],
  ["uploads/[uploadId]/complete/route.ts", { POST: "documents:write" }],
  ["uploads/[uploadId]/route.ts", { GET: "documents:write", DELETE: "documents:write" }],
  ["uploads/initiate/route.ts", { POST: "documents:write" }],
  ["user-preferences/route.ts", { GET: null, PUT: null, POST: null }],
  ["source-references/[sourceReferenceId]/document/route.ts", { GET: "sources:read" }],
  ["workspace-preferences/route.ts", { GET: "observations:read", PUT: "observations:read", POST: "observations:read" }],
  ["workspace-summary/route.ts", { GET: "observations:read" }],
];

// Routes with their own (non-session) authentication, exercised in dedicated tests below.
const OWN_AUTHENTICATION = new Set([
  "auth/service-account/token/route.ts", // Corvis-issued service-account credential exchange
  "health/route.ts", // public
  "health/ready/route.ts", // public readiness probe
  "invitations/accept/route.ts", // authenticated but pre-membership
  "source-connections/oauth/demo-consent/route.ts", // demo-mode stand-in for a provider's consent page: 404 outside demo mode, authenticates nobody, grants nothing
  "scim/v2/Users/route.ts", // tenant SCIM bearer token
  "scim/v2/Users/[id]/route.ts",
]);

async function routeFiles(root: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(`${root}${prefix}`, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...await routeFiles(root, `${prefix}${entry.name}/`));
    else if (entry.name === "route.ts") found.push(`${prefix}${entry.name}`);
  }
  return found.sort();
}

test("every v1 route is either in the authorization matrix or has its own documented authentication", async () => {
  const files = await routeFiles("app/api/v1/");
  const known = new Set([...MATRIX.map(([file]) => file), ...OWN_AUTHENTICATION]);
  assert.deepEqual(files.filter((file) => !known.has(file)), [], "new routes must be added to the authorization matrix");
  assert.deepEqual([...known].filter((file) => !files.includes(file)), [], "matrix lists a route that no longer exists");
  assert.ok(files.length > 70, "expected the v1 API surface to be discovered");
});

test("the matrix lists exactly the HTTP methods each route exports (no unguarded method hides in a file)", async () => {
  for (const [file, methods] of MATRIX) {
    const handlers = await load(file);
    const exported = Object.keys(handlers).filter((name) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(name)).sort();
    assert.deepEqual(exported, Object.keys(methods).sort(), `${file} exports a method the matrix does not cover`);
  }
});

test("every session-authenticated route and method rejects a request with no credentials with 401", async () => {
  for (const [file, methods] of MATRIX) {
    const handlers = await load(file);
    for (const method of Object.keys(methods)) {
      seedDatabase();
      const response = await handlers[method]!(requestFor(pathFor(file), { roles: null, method }), paramsFor(file));
      assert.equal(response.status, 401, `${method} ${file} must require authentication`);
      assert.equal(await errorOf(response), "authentication_required");
      assert.equal(queries.length, 0, `${method} ${file} must not touch the database before authenticating`);
    }
  }
});

test("every guarded route and method answers 403 forbidden to each role lacking its permission, before touching data", async () => {
  let checked = 0;
  for (const [file, methods] of MATRIX) {
    const handlers = await load(file);
    for (const [method, permission] of Object.entries(methods)) {
      if (!permission) continue;
      const denied = ROLES.filter((role) => !holds(role, permission));
      for (const role of denied) {
        seedDatabase();
        const response = await handlers[method]!(requestFor(pathFor(file), { roles: [role], method, body: {} }), paramsFor(file));
        assert.equal(response.status, 403, `${method} ${file} must deny ${role} (needs ${permission})`);
        assert.equal(await errorOf(response), "forbidden");
        assert.equal(queries.length, 0, `${method} ${file} must deny ${role} before any query runs`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 200, `expected a broad denial matrix, exercised only ${checked} cases`);
});

// The role matrix above cannot see a dropped check for a permission every role holds (`*:read`): the request just
// succeeds. Pin the guard itself: each method's own body must call assertPermission with the permission the matrix names.
test("each guarded method's handler calls assertPermission with exactly the permission the matrix names", async () => {
  const problems: string[] = [];
  for (const [file, methods] of MATRIX) {
    const source = await readFile(new URL(`../../app/api/v1/${file}`, import.meta.url), "utf8");
    for (const [method, permission] of Object.entries(methods)) {
      if (!permission) continue;
      const start = source.search(new RegExp(`export\\s+async\\s+function\\s+${method}\\b`));
      if (start < 0) { problems.push(`${method} ${file}: handler not found`); continue; }
      const next = source.slice(start + 1).search(/\nexport\s/);
      const body = next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
      const guards = [...body.matchAll(/assertPermission\(\s*\w+\s*,\s*"([^"]+)"/g)].map((match) => match[1]);
      // Tenant-admin routes may use a dedicated helper; every other method must name the permission literally.
      if (permission !== ADMIN && !guards.includes(permission)) problems.push(`${method} ${file}: expected assertPermission(..., "${permission}"), found [${guards.join(", ")}]`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the permission boundaries themselves are what the routes rely on (role/permission table sanity)", () => {
  assert.equal(holds("read_only", "exports:create"), false);
  assert.equal(holds("read_only", "research:query"), false);
  assert.equal(holds("analyst", "admin:manage"), false);
  assert.equal(holds("reviewer", "snapshots:publish"), false);
  assert.equal(holds("api_client", "observations:review"), false);
  assert.equal(holds("admin", "admin:manage"), true);
  assert.equal(holds("read_only", "observations:read"), true);
});

// ---------------------------------------------------------------- positive controls
test("a role that holds the permission is let past authorization (denials above are not a blanket rejection)", async () => {
  const cases: Array<{ file: string; method: string; role: Role; body?: unknown; expect: number; error?: string; path?: string }> = [
    { file: "admin/feature-flags/retire/route.ts", method: "POST", role: "admin", body: {}, expect: 400, error: "invalid_request" },
    { file: "access/members/deactivate/route.ts", method: "POST", role: "admin", body: {}, expect: 400, error: "invalid_request" },
    { file: "access/members/role/route.ts", method: "POST", role: "admin", body: {}, expect: 400, error: "invalid_request" },
    { file: "access/scim/route.ts", method: "POST", role: "admin", body: {}, expect: 400, error: "invalid_request" },
    // Retention and full-export routes (F10): an Organization Admin gets past authorization to validation or an empty result.
    { file: "access/retention/route.ts", method: "GET", role: "admin", expect: 200 },
    // Session policy and sign-out everywhere (F7): an Organization Admin gets past authorization to validation or an empty view.
    { file: "access/session-policy/route.ts", method: "GET", role: "admin", expect: 200 },
    { file: "access/session-policy/route.ts", method: "PUT", role: "admin", body: {}, expect: 400, error: "invalid_request" },
    { file: "access/session-policy/sign-out/route.ts", method: "POST", role: "admin", body: {}, expect: 400, error: "invalid_user" },
    { file: "access/data-exports/route.ts", method: "GET", role: "admin", expect: 200 },
    { file: "access/data-exports/route.ts", method: "POST", role: "admin", body: {}, expect: 400, error: "invalid_reason" },
    { file: "access/data-exports/[exportId]/route.ts", method: "POST", role: "admin", body: {}, expect: 400, error: "invalid_action" },
    { file: "access/service-accounts/route.ts", method: "GET", role: "admin", expect: 200 },
    { file: "access/service-accounts/route.ts", method: "POST", role: "admin", body: {}, expect: 400, error: "invalid_name" },
    { file: "access/service-accounts/[serviceAccountId]/route.ts", method: "POST", role: "admin", body: {}, expect: 400, error: "invalid_action" },
    { file: "access/service-accounts/[serviceAccountId]/route.ts", method: "POST", role: "admin", body: { action: "grant_entitlement" }, expect: 400, error: "invalid_resource_type" },
    { file: "access/service-accounts/[serviceAccountId]/route.ts", method: "POST", role: "admin", body: { action: "revoke_entitlement", resourceType: "fund" }, expect: 400, error: "invalid_resource" },
    { file: "access/service-accounts/[serviceAccountId]/route.ts", method: "GET", role: "admin", expect: 404, error: "service_account_not_found" },
    { file: "admin/tenants/route.ts", method: "POST", role: "admin", body: {}, expect: 400, error: "invalid_request" },
    { file: "exports/route.ts", method: "POST", role: "analyst", body: {}, expect: 400, error: "invalid_export_format" },
    // Any role that can read published figures may report on them and read its own cases; moving a case is Organization Admin only.
    { file: "data-issues/route.ts", method: "POST", role: "read_only", body: {}, expect: 400, error: "idempotency_key_required" },
    { file: "data-issues/route.ts", method: "GET", role: "read_only", expect: 200 },
    { file: "data-issues/[caseId]/route.ts", method: "PATCH", role: "read_only", body: {}, expect: 400, error: "invalid_request" },
    { file: "admin/data-issues/[caseId]/route.ts", method: "PATCH", role: "admin", body: {}, expect: 400, error: "invalid_action" },
    { file: "admin/data-issues/route.ts", method: "GET", role: "admin", expect: 200 },
    // Scheduling an export needs the same permission as requesting one; the owner-only and tenant-admin rules are behavioural (export-schedule-routes.test.ts).
    { file: "export-schedules/route.ts", method: "POST", role: "analyst", body: {}, expect: 400, error: "idempotency_key_required" },
    { file: "export-schedules/route.ts", method: "GET", role: "analyst", expect: 200 },
    { file: "export-schedules/runs/route.ts", method: "GET", role: "analyst", expect: 200 },
    { file: "export-schedules/[scheduleId]/route.ts", method: "PATCH", role: "analyst", body: {}, expect: 400, error: "invalid_action" },
    { file: "export-schedules/[scheduleId]/route.ts", method: "PATCH", role: "analyst", body: { notifyOnCompletion: "no" }, expect: 400, error: "invalid_notify_on_completion" },
    { file: "export-schedules/[scheduleId]/route.ts", method: "DELETE", role: "analyst", expect: 404, error: "export_schedule_not_found" },
    { file: "research/pins/route.ts", method: "POST", role: "analyst", body: {}, expect: 400, error: "invalid_request" },
    // Assigning and discussing is review work: a Review Analyst passes authorization (and then fails validation of the empty command); an Analyst never gets that far.
    { file: "review-items/[subjectKind]/[subjectId]/assignee/route.ts", method: "PUT", role: "reviewer", body: {}, expect: 400, error: "invalid_subject_kind" },
    { file: "review-items/[subjectKind]/[subjectId]/comments/route.ts", method: "POST", role: "reviewer", body: {}, expect: 400, error: "idempotency_key_required" },
    { file: "review-items/[subjectKind]/[subjectId]/route.ts", method: "GET", role: "reviewer", expect: 400, error: "invalid_subject_kind" },
    { file: "review/route.ts", method: "POST", role: "reviewer", body: {}, expect: 400 },
    { file: "snapshots/publish/route.ts", method: "POST", role: "admin", body: {}, expect: 400 },
    { file: "source-references/[sourceReferenceId]/route.ts", method: "GET", role: "analyst", expect: 404, error: "source_reference_not_found", path: "/source-references/not-a-uuid" },
    { file: "jobs/route.ts", method: "GET", role: "read_only", expect: 400, path: "/jobs?limit=abc" },
  ];
  for (const testCase of cases) {
    seedDatabase();
    const handlers = await load(testCase.file);
    const path = testCase.path ?? pathFor(testCase.file);
    const response = await handlers[testCase.method]!(
      requestFor(path, { roles: [testCase.role], method: testCase.method, body: testCase.body, sourceAccess: true }),
      testCase.file.includes("[sourceReferenceId]") ? { params: Promise.resolve({ sourceReferenceId: "not-a-uuid" }) } : paramsFor(testCase.file),
    );
    assert.equal(response.status, testCase.expect, `${testCase.method} ${testCase.file} as ${testCase.role}`);
    if (testCase.error) assert.equal(await errorOf(response), testCase.error);
  }
});

// -------------------------------------------------------------------- admin surfaces
test("admin/tenants provisioning is limited to the operations tenant even for an admin", async () => {
  const handlers = await load("admin/tenants/route.ts");
  seedDatabase();
  const response = await handlers.POST!(requestFor("/admin/tenants", { roles: ["admin"], tenant: OTHER_TENANT, method: "POST", body: {} }));
  assert.equal(response.status, 403);
  assert.equal(queries.length, 0);
});

test("admin/tenant-identity (verified domains, identity-provider record) is limited to the operations tenant and states its target tenant", async () => {
  const handlers = await load("admin/tenant-identity/route.ts");
  const add = { kind: "verified_domain_add", tenantId: OTHER_TENANT, domain: "Acme.com", verificationMethod: "dns_txt", evidence: "ticket-1", reason: "Customer asked" };
  // A customer's Organization Admin can neither read nor change another tenant's records, or its own: initial setup is Corvis-assisted.
  for (const tenant of [OTHER_TENANT, "44444444-dddd-4ddd-8ddd-444444444444"]) {
    seedDatabase();
    let denied = await handlers.POST!(requestFor("/admin/tenant-identity", { roles: ["admin"], tenant, method: "POST", body: { ...add, tenantId: tenant } }));
    assert.equal(denied.status, 403);
    denied = await handlers.GET!(requestFor(`/admin/tenant-identity?tenantId=${tenant}`, { roles: ["admin"], tenant }));
    assert.equal(denied.status, 403);
    assert.equal(queries.length, 0, "a refused caller reaches no data");
  }

  // The operations tenant's admin acts on the TARGET tenant it names, with itself recorded as the actor.
  seedDatabase((query) => query.sql.includes("set_tenant_verified_domain") ? [{ changed: true, version: null }] : []);
  let response = await handlers.POST!(requestFor("/admin/tenant-identity", { roles: ["admin"], subject: "operator-1", method: "POST", body: add }));
  assert.equal(response.status, 200);
  assert.deepEqual(((await response.json()) as { data: unknown }).data, { kind: "verified_domain_add", tenantId: OTHER_TENANT, changed: true, version: null });
  const call = queries.find((query) => query.sql.includes("set_tenant_verified_domain"));
  assert.deepEqual(call?.parameters.slice(0, 6), [OTHER_TENANT, TENANT, "oidc", "operator-1", "acme.com", "dns_txt"]);

  // Validation happens before any query, with a stable code.
  for (const [body, error] of [
    [{ ...add, tenantId: undefined }, "invalid_tenant"],
    [{ ...add, domain: "*.acme.com" }, "invalid_domain"],
    [{ ...add, reason: "no" }, "invalid_reason"],
    [{ ...add, kind: "other" }, "invalid_kind"],
  ] as const) {
    seedDatabase();
    response = await handlers.POST!(requestFor("/admin/tenant-identity", { roles: ["admin"], method: "POST", body }));
    assert.equal(response.status, 400);
    assert.equal(await errorOf(response), error);
    assert.equal(queries.length, 0);
  }
  seedDatabase();
  response = await handlers.POST!(requestFor("/admin/tenant-identity", { roles: ["admin"], method: "POST", rawBody: "[1]" }));
  assert.equal(response.status, 400);
  assert.equal(await errorOf(response), "invalid_request");

  // The operator view names the tenant it reads.
  seedDatabase((query) => query.sql.includes("tenant_identity_provider")
    ? [{ protocol: "oidc", issuer: "https://idp.acme.com", audience: "corvis", status: "active", enforce_token_binding: false, version: 1, updated_at: "2026-10-01T00:00:00.000Z" }]
    : [{ domain: "acme.com", verification_method: "dns_txt", verified_at: "2026-10-01T00:00:00.000Z" }]);
  response = await handlers.GET!(requestFor(`/admin/tenant-identity?tenantId=${OTHER_TENANT}`, { roles: ["admin"] }));
  assert.equal(response.status, 200);
  const view = (await response.json() as { data: { identityProvider: { issuer: string }; verifiedDomains: unknown[] } }).data;
  assert.equal(view.identityProvider.issuer, "https://idp.acme.com");
  assert.equal(view.verifiedDomains.length, 1);
  assert.ok(queries.every((query) => query.parameters[0] === OTHER_TENANT), "every read carries the target tenant predicate");
  seedDatabase();
  response = await handlers.GET!(requestFor("/admin/tenant-identity", { roles: ["admin"] }));
  assert.equal(response.status, 400);
  assert.equal(await errorOf(response), "invalid_tenant");
});

test("admin/audit only ever reads the caller's own tenant and rejects malformed filters", async () => {
  const handlers = await load("admin/audit/route.ts");
  seedDatabase(() => [{ audit_event_id: SOME_UUID, occurred_at: "2026-09-29T00:00:00.000Z", actor_subject: "a", action: "x", target_type: "t", outcome: "success", correlation_id: "c" }]);
  const response = await handlers.GET!(requestFor("/admin/audit?limit=5", { roles: ["admin"], tenant: OTHER_TENANT }));
  assert.equal(response.status, 200);
  const audit = queries.find((query) => query.sql.includes("corvis_control.audit_event"));
  assert.ok(audit, "the audit table must be queried");
  assert.equal(audit.parameters[0], OTHER_TENANT, "the tenant predicate must come from the authenticated identity");
  assert.equal(audit.parameters[7], 5);

  seedDatabase();
  assert.equal((await handlers.GET!(requestFor("/admin/audit?limit=abc", { roles: ["admin"] }))).status, 400);
  assert.equal(queries.length, 0);
});

test("feature-flag kill-switch, emergency-stop and retire act only within the caller's tenant and record who did it", async () => {
  const killSwitch = await load("admin/feature-flags/kill-switch/route.ts");
  const emergency = await load("admin/feature-flags/emergency-stop/route.ts");
  const retire = await load("admin/feature-flags/retire/route.ts");

  seedDatabase((query) => (query.sql.includes("update corvis_control.feature_flag") ? [{ flag_key: "exports.parquet_delivery" }] : []));
  let response = await killSwitch.POST!(requestFor("/admin/feature-flags/kill-switch", {
    roles: ["admin"], subject: "operator-1", method: "POST", body: { key: "exports.parquet_delivery", engaged: true, reason: "incident" },
  }));
  assert.equal(response.status, 200);
  const update = queries.find((query) => query.sql.includes("update corvis_control.feature_flag"));
  assert.ok(update);
  assert.deepEqual([update.parameters[0], update.parameters[1], update.parameters[2], update.parameters[4]], [TENANT, "exports.parquet_delivery", true, "operator-1"]);
  assert.ok(queries.some((query) => query.sql.includes("audit_event") && query.parameters.includes("feature_flag.kill_switch")), "the change must be audited");

  // A kill switch cannot be engaged without a reason; an unknown flag is refused, not created.
  seedDatabase();
  response = await killSwitch.POST!(requestFor("/admin/feature-flags/kill-switch", { roles: ["admin"], method: "POST", body: { key: "exports.parquet_delivery", engaged: true } }));
  assert.equal(response.status, 422);
  assert.equal(await errorOf(response), "kill_switch_reason_required");
  response = await killSwitch.POST!(requestFor("/admin/feature-flags/kill-switch", { roles: ["admin"], method: "POST", body: { key: "no.such.flag", engaged: true, reason: "x" } }));
  assert.equal(response.status, 422);
  assert.equal(await errorOf(response), "unregistered_flag");
  for (const body of [{}, { key: "exports.parquet_delivery" }, { key: "", engaged: true }, { key: "k".repeat(129) }, { key: 7, engaged: true }]) {
    assert.equal((await killSwitch.POST!(requestFor("/admin/feature-flags/kill-switch", { roles: ["admin"], method: "POST", body }))).status, 400, JSON.stringify(body));
  }

  seedDatabase((query) => (query.sql.includes("feature_flag") || query.sql.includes("emergency") ? [{ tenant_id: TENANT }] : []));
  for (const body of [{}, { engaged: "yes" }]) {
    assert.equal((await emergency.POST!(requestFor("/admin/feature-flags/emergency-stop", { roles: ["admin"], method: "POST", body }))).status, 400, JSON.stringify(body));
  }
  for (const body of [{}, { key: "" }, { key: "k".repeat(129) }, { key: 5 }]) {
    assert.equal((await retire.POST!(requestFor("/admin/feature-flags/retire", { roles: ["admin"], method: "POST", body }))).status, 400, JSON.stringify(body));
  }
});

test("access/members role and deactivate validate their input for an admin and never trust a client tenant selector", async () => {
  const role = await load("access/members/role/route.ts");
  const deactivate = await load("access/members/deactivate/route.ts");
  seedDatabase();
  for (const body of [{ userId: "u" }, { userId: 1, workspaceId: "w", expectedRole: "viewer", roleName: null, reason: "r" }]) {
    assert.equal((await role.POST!(requestFor("/access/members/role", { roles: ["admin"], method: "POST", body }))).status, 400, JSON.stringify(body));
  }
  for (const body of [{ userId: "not-a-uuid", reason: "left" }, { userId: SOME_UUID, reason: "" }, { userId: SOME_UUID, reason: "r".repeat(1001) }]) {
    assert.equal((await deactivate.POST!(requestFor("/access/members/deactivate", { roles: ["admin"], method: "POST", body }))).status, 400, JSON.stringify(body));
  }
  assert.equal(queries.length, 0, "invalid requests must be rejected before reaching the database");
});

test("access/scim configuration rejects unsupported roles and auth methods for an admin", async () => {
  const handlers = await load("access/scim/route.ts");
  seedDatabase();
  for (const body of [
    { authMethod: "service_account", workspaceId: WORKSPACE, roleName: "viewer" },
    { authMethod: "oidc", workspaceId: WORKSPACE, roleName: "tenant_admin" },
    { authMethod: "oidc", roleName: "viewer" },
  ]) {
    const response = await handlers.POST!(requestFor("/access/scim", { roles: ["admin"], method: "POST", body }));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(queries.length, 0);
});

// ---------------------------------------------------------------------- research pins
test("research pins are scoped to the caller's own tenant, workspace and subject", async () => {
  const list = await load("research/pins/route.ts");
  const unpin = await load("research/pins/[pinId]/route.ts");

  seedDatabase();
  let response = await list.GET!(requestFor("/research/pins", { roles: ["analyst"], tenant: OTHER_TENANT, subject: "pinner" }));
  assert.equal(response.status, 200);
  const select = queries.find((query) => query.sql.includes("research_answer_pin"));
  assert.ok(select);
  assert.deepEqual(select.parameters.slice(0, 4), [OTHER_TENANT, WORKSPACE, "oidc", "pinner"]);

  response = await unpin.DELETE!(requestFor("/research/pins/not-a-uuid", { roles: ["analyst"], method: "DELETE" }), { params: Promise.resolve({ pinId: "not-a-uuid" }) });
  assert.equal(response.status, 400);
  assert.equal(await errorOf(response), "invalid_pin_id");

  // Someone else's (or a missing) pin is a 404 and the delete predicate carries the caller's identity.
  seedDatabase();
  response = await unpin.DELETE!(requestFor(`/research/pins/${SOME_UUID}`, { roles: ["analyst"], subject: "pinner", method: "DELETE" }), { params: Promise.resolve({ pinId: SOME_UUID }) });
  assert.equal(response.status, 404);
  const removal = queries.find((query) => /delete from corvis_control\.research_answer_pin/i.test(query.sql));
  assert.ok(removal, "unpinning must issue a scoped delete");
  assert.ok(removal.parameters.includes("pinner") && removal.parameters.includes(TENANT) && removal.parameters.includes(SOME_UUID));

  for (const body of [{}, { question: "q", askedAt: "now" }, { question: "q", askedAt: "2026-01-01T00:00:00Z", answer: null }]) {
    assert.equal((await list.POST!(requestFor("/research/pins", { roles: ["analyst"], method: "POST", body }))).status, 400, JSON.stringify(body));
  }
});

// -------------------------------------------------------------- workspace preferences
test("notification-preferences refuses service identities and never lets a mandatory notice be turned off", async () => {
  const handlers = await load("notification-preferences/route.ts");
  seedDatabase();
  const service = await handlers.GET!(requestFor("/notification-preferences", { roles: ["api_client"], authMethod: "service_account" }));
  assert.equal(service.status, 403);
  assert.equal(await errorOf(service), "human_identity_required");
  seedDatabase((query) => /from corvis_control\.identity_subject/.test(query.sql) ? [{ user_id: SOME_UUID }] : []);
  const mandatory = await handlers.PUT!(requestFor("/notification-preferences", { roles: ["analyst"], authMethod: "oidc", method: "PUT", body: { categories: [{ id: "role_changed", enabled: false, delivery: "immediate" }] } }));
  assert.equal(mandatory.status, 400);
  assert.equal(await errorOf(mandatory), "category_not_configurable");
  const hidden = await handlers.PUT!(requestFor("/notification-preferences", { roles: ["analyst"], authMethod: "oidc", method: "PUT", body: { categories: [{ id: "source_attention", enabled: false, delivery: "immediate" }] } }));
  assert.equal(await errorOf(hidden), "unknown_category", "admin-only categories are not configurable by analysts");
  assert.ok(queries.every((query) => !/notification_preference/.test(query.sql) || /^select/.test(query.sql)), "rejected changes write nothing");
});

test("workspace-preferences only lets a caller pin funds they are entitled to", async () => {
  const handlers = await load("workspace-preferences/route.ts");
  seedDatabase();
  const denied = await handlers.PUT!(requestFor("/workspace-preferences", { roles: ["read_only"], funds: ["fund-a"], method: "PUT", body: { pinnedFundIds: ["fund-b"] } }));
  assert.equal(denied.status, 403);
  assert.equal(await errorOf(denied), "fund_not_entitled");
  assert.equal(queries.length, 0, "an unentitled pin must never be written");

  for (const body of [{}, { pinnedFundIds: "fund-a" }, { pinnedFundIds: [""] }, { pinnedFundIds: [3] }]) {
    assert.equal((await handlers.PUT!(requestFor("/workspace-preferences", { roles: ["read_only"], funds: ["fund-a"], method: "PUT", body }))).status, 400, JSON.stringify(body));
  }

  const future = new Date(Date.now() + 3_600_000).toISOString();
  const badVisit = await handlers.POST!(requestFor("/workspace-preferences", { roles: ["read_only"], method: "POST", body: { seenAt: future } }));
  assert.equal(badVisit.status, 400);
  assert.equal(await errorOf(badVisit), "invalid_seen_at");
});

// ----------------------------------------------------- serving list entitlement scoping
test("serving list routes only query the caller's tenant and entitled funds, and fail closed without entitlements", async () => {
  const routes: Array<[string, string]> = [
    ["funds/route.ts", "entity_directory"],
    ["companies/route.ts", "corvis_serving.observations"],
    ["holdings/route.ts", "corvis_serving.holdings"],
    ["instruments/route.ts", "corvis_serving.instruments"],
    ["company-lifecycle-events/route.ts", "entity_lifecycle_event"],
    ["consolidated-facts/route.ts", "consolidated_fact"],
  ];
  for (const [file, table] of routes) {
    const handlers = await load(file);
    const path = pathFor(file);

    seedDatabase();
    const entitled = await handlers.GET!(requestFor(path, { roles: ["read_only"], tenant: OTHER_TENANT, funds: ["fund-a", "fund-b"] }));
    assert.equal(entitled.status, 200, file);
    const scoped = queries.find((query) => query.sql.includes(table));
    assert.ok(scoped, `${file} must query ${table}`);
    const jsonParameters = scoped.parameters.filter((parameter) => typeof parameter === "string" && parameter.startsWith("["));
    assert.deepEqual(jsonParameters.map((parameter) => JSON.parse(String(parameter))), [["fund-a", "fund-b"]], `${file} must pass exactly the entitled funds`);
    if (file !== "funds/route.ts") assert.equal(scoped.parameters[0], OTHER_TENANT, `${file} must scope to the authenticated tenant`);

    seedDatabase();
    await handlers.GET!(requestFor(path, { roles: ["read_only"], funds: [] }));
    const closed = queries.find((query) => query.sql.includes(table));
    assert.ok(closed);
    assert.ok(closed.parameters.includes("[]"), `${file} must fail closed to an empty fund list`);
  }

  // Global governed dictionary: readable by any observations:read caller, no tenant data involved.
  const metrics = await load("metric-definitions/route.ts");
  seedDatabase();
  assert.equal((await metrics.GET!(requestFor("/metric-definitions", { roles: ["read_only"] }))).status, 200);
  assert.ok(queries.every((query) => !query.sql.includes("tenant_id")));
});

test("serving list routes return a page of the rows the database allowed and a resumable cursor, never more than the limit", async () => {
  const handlers = await load("funds/route.ts");
  const rows = ["fund-a", "fund-b", "fund-c"].map((id) => ({ entity_id: id, canonical_name: id, manager_name: null, names: [], external_identifiers: [] }));
  seedDatabase(() => rows);
  const response = await handlers.GET!(requestFor("/funds?limit=2", { roles: ["read_only"], funds: ["fund-a", "fund-b", "fund-c"] }));
  const body = await response.json() as { data: Array<{ id: string }>; nextCursor: string | null };
  assert.deepEqual(body.data.map((row) => row.id), ["fund-a", "fund-b"]);
  assert.ok(body.nextCursor);
  assert.equal((await handlers.GET!(requestFor("/funds?cursor=%%%", { roles: ["read_only"] }))).status, 400);
});

// --------------------------------------------------------------- exports and grants
const EXPORT_ROW = {
  export_id: SOME_UUID, format: "csv", state: "complete", created_at: "2026-09-29T00:00:00.000Z", completed_at: "2026-09-29T00:01:00.000Z",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(), checksum_sha256: "a".repeat(64), snapshot_ids: [],
  object_uri: "gs://bucket/exports/x.csv", manifest: { exportId: SOME_UUID, tenantId: TENANT, format: "csv", snapshotIds: [] },
};

test("GET /exports/{id} is owner-scoped: the lookup carries tenant and subject, another user's export is a 404", async () => {
  const handlers = await load("exports/[exportId]/route.ts");
  seedDatabase(() => []);
  const response = await handlers.GET!(requestFor(`/exports/${SOME_UUID}`, { roles: ["analyst"], subject: "someone-else", redistribution: true }), paramsFor("exports/[exportId]/route.ts"));
  assert.equal(response.status, 404);
  const lookup = queries.find((query) => query.sql.includes("corvis_serving.export_job"));
  assert.ok(lookup);
  assert.deepEqual(lookup.parameters, [TENANT, SOME_UUID, "someone-else"]);
  assert.match(lookup.sql, /requested_by=\$3/);

  assert.equal((await handlers.GET!(requestFor("/exports/nope", { roles: ["analyst"], redistribution: true }), { params: Promise.resolve({ exportId: "nope" }) })).status, 400);

  // Without current redistribution rights an owned, complete export is not readable (403), and no grant is issued.
  seedDatabase((query) => (query.sql.includes("from corvis_serving.export_job") ? [EXPORT_ROW] : []));
  const noRights = await handlers.GET!(requestFor(`/exports/${SOME_UUID}`, { roles: ["analyst"], subject: "owner", redistribution: false }), paramsFor("exports/[exportId]/route.ts"));
  assert.equal(noRights.status, 403);
  assert.ok(!queries.some((query) => query.sql.includes("export_download_grant")), "no grant may be issued without redistribution rights");
});

test("download grants are issued to the owner only, hashed at rest, and redeemed only with subject, tenant, hash and unexpired state", async () => {
  const status = await load("exports/[exportId]/route.ts");
  const download = await load("exports/[exportId]/download/route.ts");
  const ctx = paramsFor("exports/[exportId]/route.ts");

  // Issue a grant: the raw token reaches the caller, only its sha-256 is stored, bound to the caller's subject.
  seedDatabase((query) => (query.sql.includes("from corvis_serving.export_job") ? [EXPORT_ROW] : []));
  const issued = await status.GET!(requestFor(`/exports/${SOME_UUID}`, { roles: ["analyst"], subject: "owner", redistribution: true }), ctx);
  assert.equal(issued.status, 200);
  const payload = await issued.json() as { data: { downloadUrl: string; downloadAvailable: boolean } };
  assert.equal(payload.data.downloadAvailable, true);
  const token = new URL(payload.data.downloadUrl, "https://corvis.test").searchParams.get("grant")!;
  assert.ok(token.length >= 32);
  const insert = queries.find((query) => query.sql.includes("insert into corvis_serving.export_download_grant"));
  assert.ok(insert);
  const { createHash } = await import("node:crypto");
  assert.deepEqual([insert.parameters[0], insert.parameters[1], insert.parameters[2], insert.parameters[3]], [TENANT, SOME_UUID, "owner", createHash("sha256").update(token).digest("hex")]);
  assert.ok(!insert.parameters.includes(token), "the raw grant token must never be stored");

  // Redemption: the query is bound to the caller's tenant + subject + token hash, and requires unexpired grant and export.
  seedDatabase(() => []);
  const redeemed = await download.GET!(requestFor(`/exports/${SOME_UUID}/download?grant=${token}`, { roles: ["analyst"], subject: "thief", redistribution: true }), ctx);
  assert.equal(redeemed.status, 404, "a grant that matches no row for this subject is a 404, not an artifact");
  const redemption = queries.find((query) => query.sql.includes("export_download_grant"));
  assert.ok(redemption);
  assert.deepEqual(redemption.parameters, [TENANT, SOME_UUID, "thief", createHash("sha256").update(token).digest("hex")]);
  for (const predicate of [/g\.subject=\$3/, /g\.tenant_id=\$1/, /g\.token_sha256=\$4/, /g\.expires_at>now\(\)/, /j\.requested_by=\$3/, /j\.state='complete'/, /j\.expires_at>now\(\)/]) {
    assert.match(redemption.sql, predicate);
  }

  // Missing or oversized grants never even reach the database.
  seedDatabase();
  assert.equal((await download.GET!(requestFor(`/exports/${SOME_UUID}/download`, { roles: ["analyst"], redistribution: true }), ctx)).status, 404);
  assert.equal((await download.GET!(requestFor(`/exports/${SOME_UUID}/download?grant=${"x".repeat(257)}`, { roles: ["analyst"], redistribution: true }), ctx)).status, 404);
  assert.equal(queries.length, 0);

  // A HEAD probe must never redeem (and so burn) the single-use grant.
  seedDatabase();
  const head = await download.HEAD!(new Request(`https://corvis.test/api/v1/exports/${SOME_UUID}/download?grant=${token}`, { method: "HEAD" }), ctx);
  assert.equal(head.status, 405);
  assert.equal(head.headers.get("allow"), "GET");
  assert.equal(queries.length, 0, "HEAD must not touch the grant");
});

test("a download whose object cannot be read gives the single-use grant back, so the caller can retry it", async () => {
  const download = await load("exports/[exportId]/download/route.ts");
  const ctx = paramsFor("exports/[exportId]/route.ts");
  const previous = { bucket: process.env.CORVIS_OBJECT_STORE_BUCKET, token: process.env.CORVIS_GCP_ACCESS_TOKEN, fetch: globalThis.fetch };
  process.env.CORVIS_OBJECT_STORE_BUCKET = "test-bucket";
  process.env.CORVIS_GCP_ACCESS_TOKEN = "test-token";
  const dbFetch = globalThis.fetch;
  let storageStatus = 503;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://storage.googleapis.com/")) return new Response("unavailable", { status: storageStatus });
    return dbFetch(input, init);
  }) as typeof fetch;
  try {
    const row = { object_uri: "gs://test-bucket/exports/t/e/attempt-1/observations.csv", format: "csv", checksum_sha256: "a".repeat(64), snapshot_ids: [], manifest: { snapshotIds: [], artifact: { fundIds: [], documentIds: [] } } };
    for (const status of [503, 404]) {
      storageStatus = status;
      seedDatabase((query) => (query.sql.startsWith("update corvis_serving.export_download_grant") && query.sql.includes("consumed_at=now()") ? [row] : []));
      const response = await download.GET!(requestFor(`/exports/${SOME_UUID}/download?grant=${"g".repeat(40)}`, { roles: ["analyst"], subject: "owner", redistribution: true }), ctx);
      assert.equal(response.status, status === 404 ? 404 : 500, `storage ${status}`);
      const restore = queries.find((query) => query.sql.includes("set consumed_at=null"));
      assert.ok(restore, `the grant is restored when storage answers ${status}`);
      assert.equal(restore.parameters[2], "owner");
    }
  } finally {
    (await import("@/lib/server/gcs")).resetGcsClient();
    globalThis.fetch = previous.fetch;
    if (previous.bucket === undefined) delete process.env.CORVIS_OBJECT_STORE_BUCKET; else process.env.CORVIS_OBJECT_STORE_BUCKET = previous.bucket;
    if (previous.token === undefined) delete process.env.CORVIS_GCP_ACCESS_TOKEN; else process.env.CORVIS_GCP_ACCESS_TOKEN = previous.token;
  }
});

// ------------------------------------------------------------------ internal routes
test("internal/delivery rejects unauthenticated, wrongly-authenticated and shared-secret-less callers with 403", async () => {
  const handlers = await load("../internal/delivery/route.ts").catch(async () => await import("@/app/api/internal/delivery/route") as Record<string, Handler>);
  const post = (headers: Record<string, string> = {}) => handlers.POST!(new Request("https://corvis.test/api/internal/delivery", { method: "POST", headers }));
  seedDatabase();
  for (const headers of [{}, { "x-corvis-worker-secret": "wrong" }, { "x-corvis-worker-secret": "" }, { authorization: "Bearer garbage" }, { "x-corvis-gateway-secret": GATEWAY_SECRET }] as Array<Record<string, string>>) {
    const response = await post(headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(await errorOf(response), "forbidden");
  }
  assert.equal(queries.length, 0, "no delivery work may run for an unauthenticated caller");

  const savedSecret = process.env.CORVIS_WORKER_SECRET;
  delete process.env.CORVIS_WORKER_SECRET;
  try {
    assert.equal((await post({ "x-corvis-worker-secret": "undefined" })).status, 403, "an unset secret must not match anything");
    assert.equal((await post({})).status, 403);
  } finally {
    process.env.CORVIS_WORKER_SECRET = savedSecret;
  }

  const authorized = await post({ "x-corvis-worker-secret": WORKER_SECRET });
  assert.notEqual(authorized.status, 403, "the configured non-production worker secret is accepted");
});

test("internal/processing-stage requires an approved worker identity and never runs a delivery without one", async () => {
  const handlers = await import("@/app/api/internal/processing-stage/route") as Record<string, Handler>;
  const delivery = JSON.stringify({ tenantId: TENANT, documentId: SOME_UUID, stage: "registered" });
  const post = (headers: Record<string, string> = {}) => handlers.POST!(new Request("https://corvis.test/api/internal/processing-stage", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: delivery }));

  // Unconfigured ingress fails closed.
  seedDatabase();
  let response = await post();
  assert.ok(response.status >= 400, "an unconfigured worker ingress must not accept deliveries");
  assert.notEqual(response.status, 200);

  process.env.CORVIS_PROCESSING_WORKER_AUDIENCE = "https://worker.corvis.test";
  process.env.CORVIS_PROCESSING_WORKER_SERVICE_ACCOUNT = "worker@corvis-test.iam.gserviceaccount.com";
  try {
    for (const headers of [{}, { authorization: "Bearer not-a-jwt" }, { "x-corvis-worker-secret": WORKER_SECRET }, { "x-corvis-gateway-secret": GATEWAY_SECRET }] as Array<Record<string, string>>) {
      seedDatabase();
      response = await post(headers);
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.equal(await errorOf(response), "worker_authentication_failed");
      assert.equal(queries.length, 0, "no stage repository query may run before the worker is authenticated");
    }
  } finally {
    delete process.env.CORVIS_PROCESSING_WORKER_AUDIENCE;
    delete process.env.CORVIS_PROCESSING_WORKER_SERVICE_ACCOUNT;
  }
});

// -------------------------------------------- routes with their own authentication
test("SCIM routes accept only a tenant-scoped bearer token and never a session identity", async () => {
  const users = await load("scim/v2/Users/route.ts");
  const user = await load("scim/v2/Users/[id]/route.ts");
  const context = { params: Promise.resolve({ id: SOME_UUID }) };
  seedDatabase(() => []);
  const attempts: Array<[string, () => Promise<Response>]> = [
    ["list without credentials", () => users.GET!(new Request("https://corvis.test/api/v1/scim/v2/Users"))],
    ["create without credentials", () => users.POST!(new Request("https://corvis.test/api/v1/scim/v2/Users", { method: "POST", body: "{}" }))],
    ["get without credentials", () => user.GET!(new Request(`https://corvis.test/api/v1/scim/v2/Users/${SOME_UUID}`), context)],
    ["patch without credentials", () => user.PATCH!(new Request(`https://corvis.test/api/v1/scim/v2/Users/${SOME_UUID}`, { method: "PATCH", body: "{}" }), context)],
    ["delete without credentials", () => user.DELETE!(new Request(`https://corvis.test/api/v1/scim/v2/Users/${SOME_UUID}`, { method: "DELETE" }), context)],
    ["a session identity is not a SCIM token", () => users.GET!(requestFor("/scim/v2/Users", { roles: ["admin"] }))],
    ["a bearer token without a tenant", () => users.GET!(new Request("https://corvis.test/api/v1/scim/v2/Users", { headers: { authorization: `Bearer ${"a".repeat(48)}` } }))],
    ["an unknown token", () => users.GET!(new Request("https://corvis.test/api/v1/scim/v2/Users", { headers: { authorization: `Bearer ${"a".repeat(48)}`, "x-corvis-tenant": TENANT } }))],
  ];
  for (const [label, attempt] of attempts) {
    const response = await attempt();
    assert.equal(response.status, 401, label);
    assert.equal(((await response.json()) as { scimType: string }).scimType, "invalidToken", label);
  }
  // The only query allowed is the token-hash lookup, scoped to the presented tenant.
  assert.ok(queries.every((query) => query.sql.includes("tenant_scim_configuration") && query.parameters[0] === TENANT));
});

test("invitation acceptance needs an authenticated human identity, not a service account or anonymous caller", async () => {
  const handlers = await load("invitations/accept/route.ts");
  seedDatabase();
  assert.equal((await handlers.POST!(requestFor("/invitations/accept", { roles: null, method: "POST", body: { token: "t" } }))).status, 401);
  const service = await handlers.POST!(requestFor("/invitations/accept", { roles: ["admin"], authMethod: "service_account", method: "POST", body: { token: "t" } }));
  assert.equal(service.status, 403);
  assert.equal(await errorOf(service), "invitation_requires_human_identity");
  const missing = await handlers.POST!(requestFor("/invitations/accept", { roles: ["read_only"], method: "POST", body: {} }));
  assert.equal(missing.status, 400);
  assert.equal(queries.length, 0);
});

test("the health route is public and identity-only routes need just an authenticated identity", async () => {
  const health = await load("health/route.ts");
  assert.equal((await health.GET!(requestFor("/health", { roles: null }))).status, 200);
  const ready = await load("health/ready/route.ts");
  const probe = await ready.GET!(requestFor("/health/ready", { roles: null }));
  assert.ok([200, 503].includes(probe.status), "the readiness probe is public and detail-free");
  assert.deepEqual(Object.keys(await probe.json() as object).sort(), ["service", "status"]);
  for (const file of ["me/route.ts", "capabilities/route.ts", "my-workspaces/route.ts"]) {
    const handlers = await load(file);
    for (const role of ROLES) {
      seedDatabase();
      assert.equal((await handlers.GET!(requestFor(pathFor(file), { roles: [role] }))).status, 200, `${file} as ${role}`);
    }
  }
});

test("transport dead-letter recovery lists and requeues the tenant's dead letters with an audit row", async () => {
  const handlers = await load("admin/processing-transport/dead-letters/route.ts");
  const dead = { event_id: SOME_UUID, event_type: "DocumentRegistered", aggregate_type: "document", aggregate_id: "d1", attempt_count: 8, last_error: "boom", created_at: "2026-09-29 10:00:00+00", transport_dead_lettered_at: "2026-09-29 11:00:00+00" };
  seedDatabase((query) => /from corvis_control\.outbox_event/.test(query.sql) ? [dead] : []);
  const listed = await handlers.GET!(requestFor("/admin/processing-transport/dead-letters", { roles: ["admin"] }));
  assert.equal(listed.status, 200);
  const body = await listed.json() as { data: Array<{ eventId: string; deadLetteredAt: string }> };
  assert.equal(body.data[0]!.eventId, SOME_UUID);
  assert.equal(body.data[0]!.deadLetteredAt, "2026-09-29T11:00:00Z", "timestamps are RFC 3339");
  assert.ok(queries.every((query) => !/outbox_event/.test(query.sql) || query.parameters[0] === TENANT), "scoped to the caller's tenant");

  seedDatabase((query) => /update corvis_control\.outbox_event/.test(query.sql) ? [dead] : []);
  const requeued = await handlers.POST!(requestFor("/admin/processing-transport/dead-letters", { roles: ["admin"], method: "POST", body: { eventId: SOME_UUID, reason: "provider outage resolved" } }));
  assert.equal(requeued.status, 202);
  assert.ok(queries.some((query) => /insert into corvis_control\.audit_event/.test(query.sql) && JSON.stringify(query.parameters).includes("processing_transport.requeue_dead_letter")), "the requeue is audited");

  seedDatabase();
  const missing = await handlers.POST!(requestFor("/admin/processing-transport/dead-letters", { roles: ["admin"], method: "POST", body: { eventId: SOME_UUID, reason: "again" } }));
  assert.equal(missing.status, 409);
  assert.equal(await errorOf(missing), "event_not_dead_lettered");
  const invalid = await handlers.POST!(requestFor("/admin/processing-transport/dead-letters", { roles: ["admin"], method: "POST", body: { eventId: SOME_UUID } }));
  assert.equal(invalid.status, 400);
});

test("client error ingest accepts only the PII-free event shape from an authenticated identity", async () => {
  const handlers = await load("client-errors/route.ts");
  const event = { event: "corvis.client_error", source: "view-boundary", name: "TypeError", code: "research_timeout", view: "research", occurredAt: "2026-09-29T10:00:00.000Z" };
  const lines: string[] = [];
  console.warn = (line: unknown) => { lines.push(String(line)); };
  try {
    for (const role of ROLES) {
      seedDatabase();
      assert.equal((await handlers.POST!(requestFor("/client-errors", { roles: [role], method: "POST", body: event }))).status, 204, role);
    }
    const logged = JSON.parse(lines.find((line) => line.includes('"client.error"')) ?? "{}") as Record<string, unknown>;
    assert.equal(logged.tenantId, TENANT);
    assert.equal(logged.code, "research_timeout");
    for (const body of [{ ...event, message: "Jane Doe's NAV is 12.5m" }, { ...event, code: "Free text with PII" }, { ...event, view: "/funds?id=secret" }, [event], "x"]) {
      assert.equal((await handlers.POST!(requestFor("/client-errors", { method: "POST", body }))).status, 400, JSON.stringify(body));
    }
    assert.equal((await handlers.POST!(requestFor("/client-errors", { method: "POST", rawBody: `{"pad":"${"x".repeat(4096)}"}` }))).status, 413);
  } finally {
    console.warn = quiet;
  }
});

// ------------------------------------------------------------ uploads (demo identity)
test("uploads are tenant-isolated: another tenant cannot read, complete or abort a session (404), and only documents:write holders reach the routes", async () => {
  process.env.CORVIS_DEMO_MODE = "true";
  try {
    const demo = (path: string, options: { roles?: string; tenant?: string; subject?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) => new Request(`https://corvis.test/api/v1${path}`, {
      method: options.method ?? "GET",
      headers: {
        "x-corvis-demo-tenant": options.tenant ?? "tenant-upload-a",
        "x-corvis-demo-workspace": "workspace-1",
        "x-corvis-demo-subject": options.subject ?? `uploader-${(sequence += 1)}`,
        "x-corvis-demo-roles": options.roles ?? "admin",
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const initiate = await load("uploads/initiate/route.ts");
    const status = await load("uploads/[uploadId]/route.ts");
    const complete = await load("uploads/[uploadId]/complete/route.ts");

    const created = await initiate.POST!(demo("/uploads/initiate", {
      method: "POST", subject: "uploader-owner", body: { fileName: "report.pdf", contentType: "application/pdf", sizeBytes: 2048, idempotencyKey: "upload-authz-1" },
    }));
    assert.equal(created.status, 201);
    // uploads/initiate is one of the two documented non-enveloped families (docs/API_CONVENTIONS.md).
    const data = await created.json() as { uploadId: string };
    const ctx = { params: Promise.resolve({ uploadId: data.uploadId }) };

    // Owner and a same-tenant administrator can see it.
    assert.equal((await status.GET!(demo(`/uploads/${data.uploadId}`, { subject: "uploader-owner" }), ctx)).status, 200);
    assert.equal((await status.GET!(demo(`/uploads/${data.uploadId}`, { subject: "another-admin" }), ctx)).status, 200);

    // Another tenant cannot tell the session exists, whatever its role.
    for (const [handler, method] of [[status.GET!, "GET"], [status.DELETE!, "DELETE"], [complete.POST!, "POST"]] as const) {
      const response = await handler(demo(`/uploads/${data.uploadId}`, { tenant: "tenant-upload-b", method }), ctx);
      assert.equal(response.status, 404, `${method} across tenants`);
      assert.equal(await errorOf(response), "upload_not_found");
    }
    // Everyone below admin is stopped at the permission check, so the owner-or-admin rule is never reachable for them.
    for (const role of ["reviewer", "analyst", "api_client", "read_only"]) {
      for (const [handler, method] of [[status.GET!, "GET"], [status.DELETE!, "DELETE"], [complete.POST!, "POST"]] as const) {
        assert.equal((await handler(demo(`/uploads/${data.uploadId}`, { roles: role, subject: "uploader-owner", method }), ctx)).status, 403, `${role} ${method}`);
      }
    }
    assert.equal((await initiate.POST!(demo("/uploads/initiate", { roles: "analyst", method: "POST", body: { fileName: "x.pdf", contentType: "application/pdf", sizeBytes: 1 } }))).status, 403);
    // The owner's session is still intact after the failed cross-tenant abort.
    assert.equal((await status.GET!(demo(`/uploads/${data.uploadId}`, { subject: "uploader-owner" }), ctx)).status, 200);

    // A client that omits the key at initiate cannot know the server-generated one, so completion without a key
    // must still work (both keys are optional in the OpenAPI contract).
    const keyless = await initiate.POST!(demo("/uploads/initiate", {
      method: "POST", subject: "uploader-keyless", body: { fileName: "keyless.pdf", contentType: "application/pdf", sizeBytes: 2048 },
    }));
    assert.equal(keyless.status, 201);
    const keylessId = (await keyless.json() as { uploadId: string }).uploadId;
    const keylessComplete = await complete.POST!(demo(`/uploads/${keylessId}/complete`, { method: "POST", subject: "uploader-keyless" }), { params: Promise.resolve({ uploadId: keylessId }) });
    assert.equal(keylessComplete.status, 200);
    // An explicit but wrong key is still refused.
    const wrongKey = await complete.POST!(demo(`/uploads/${data.uploadId}/complete`, { method: "POST", subject: "uploader-owner", body: { idempotencyKey: "someone-elses" } }), ctx);
    assert.equal(wrongKey.status, 409);
  } finally {
    process.env.CORVIS_DEMO_MODE = "";
  }
});

// ------------------------------------------------------------ source evidence (entitled documents)
test("source references require sources:read and source-document entitlement for the referenced document", async () => {
  const handlers = await load("source-references/[sourceReferenceId]/route.ts");
  const documentId = "44444444-dddd-4ddd-8ddd-444444444444";
  const reference = { source_reference_id: SOME_UUID, document_id: documentId, page_number: 3, excerpt: "text" };
  const ctx = { params: Promise.resolve({ sourceReferenceId: SOME_UUID }) };
  const withRow = () => seedDatabase((query) => (query.sql.includes("source_reference") ? [reference] : []));

  withRow();
  const noSourceRights = await handlers.GET!(requestFor(`/source-references/${SOME_UUID}`, { roles: ["analyst"], sourceAccess: false, documents: [documentId] }), ctx);
  assert.equal(noSourceRights.status, 403, "sources:read is not enough without source-document access");

  withRow();
  const otherDocument = await handlers.GET!(requestFor(`/source-references/${SOME_UUID}`, { roles: ["analyst"], sourceAccess: true, documents: ["55555555-eeee-4eee-8eee-555555555555"] }), ctx);
  assert.equal(otherDocument.status, 403, "a document outside the caller's entitlement must not be readable");

  withRow();
  const readOnly = await handlers.GET!(requestFor(`/source-references/${SOME_UUID}`, { roles: ["read_only"], sourceAccess: true, documents: [documentId] }), ctx);
  assert.equal(readOnly.status, 403, "read_only lacks sources:read");

  withRow();
  const allowed = await handlers.GET!(requestFor(`/source-references/${SOME_UUID}`, { roles: ["analyst"], sourceAccess: true, documents: [documentId] }), ctx);
  assert.equal(allowed.status, 200);
  const body = await allowed.json() as { data: { documentId: string; page: number } };
  assert.equal(body.data.documentId, documentId);
  const lookup = queries.find((query) => query.sql.includes("source_reference"));
  assert.ok(lookup?.parameters.includes(TENANT), "the evidence lookup must be tenant-scoped");
});

// ------------------------------------------------------- admin surface: who may call what
// Pins today's behaviour for every /admin route and method: an `admin` caller (a tenant admin
// under the gateway identity) is let past authorization, and every other role is refused with
// 403 before any query. The route-layer admin guard must leave this table unchanged.
test("every admin route and method admits a tenant admin and refuses every other role", async () => {
  let admitted = 0;
  for (const [file, methods] of MATRIX.filter(([file]) => file.startsWith("admin/"))) {
    const handlers = await load(file);
    for (const method of Object.keys(methods)) {
      seedDatabase();
      const response = await handlers[method]!(requestFor(pathFor(file), { roles: ["admin"], method, body: {} }), paramsFor(file));
      assert.ok(![401, 403].includes(response.status), `${method} ${file} must admit a tenant admin (got ${response.status})`);
      admitted += 1;
      for (const role of ROLES.filter((candidate) => candidate !== "admin")) {
        seedDatabase();
        const denied = await handlers[method]!(requestFor(pathFor(file), { roles: [role], method, body: {} }), paramsFor(file));
        assert.equal(denied.status, 403, `${method} ${file} must refuse ${role}`);
        assert.equal(queries.length, 0, `${method} ${file} must refuse ${role} before any query runs`);
      }
    }
  }
  assert.ok(admitted >= 28, `expected the whole admin surface, exercised ${admitted} methods`);
});

// ------------------------------------------------------------ bounded request bodies
function chunkedRequest(path: string, roles: Role[], chunk: Uint8Array, count: number): Request {
  const base = requestFor(path, { roles, method: "POST" });
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (sent++ < count) controller.enqueue(chunk); else controller.close(); },
  }, { highWaterMark: 0 });
  return new Request(base.url, { method: "POST", headers: base.headers, body, duplex: "half" } as RequestInit);
}

test("client-errors and bulk invitations bound the body while reading it (declared length, chunked, and normal)", async () => {
  const cases = [
    { file: "client-errors/route.ts", path: "/client-errors", limit: 2048, error: "payload_too_large" },
    { file: "access/invitations/bulk/route.ts", path: "/access/invitations/bulk", limit: 1_000_000, error: "csv_too_large" },
  ];
  for (const { file, path, limit, error } of cases) {
    const handlers = await load(file);

    // Declared Content-Length over the limit (a plain string body carries its own length).
    seedDatabase();
    const declared = await handlers.POST!(requestFor(path, { roles: ["admin"], method: "POST", rawBody: "x".repeat(limit + 1) }));
    assert.equal(declared.status, 413, `${file} declared length`);
    assert.equal(await errorOf(declared), error);

    // Chunked stream with no Content-Length: aborted once the running count passes the limit.
    const chunk = new Uint8Array(1024).fill(120);
    const request = chunkedRequest(path, ["admin"], chunk, Math.ceil(limit / 1024) + 5);
    assert.equal(request.headers.get("content-length"), null);
    const chunked = await handlers.POST!(request);
    assert.equal(chunked.status, 413, `${file} chunked`);
    assert.equal(await errorOf(chunked), error);
    assert.equal(queries.length, 0, `${file} must not touch the database for an oversized body`);
  }

  // A normal body still reaches the route's own validation (400, not 413).
  const clientErrors = await load("client-errors/route.ts");
  const invalid = await clientErrors.POST!(requestFor("/client-errors", { roles: ["admin"], method: "POST", rawBody: "{}" }));
  assert.equal(invalid.status, 400);
  assert.equal(await errorOf(invalid), "invalid_client_error");
});
