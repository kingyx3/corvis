import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { parseYaml, responseSchema, validateSchema, type Json, type OpenApiDocument } from "./test-support/openapi-support.ts";

// Route modules use the Next.js "@/..." alias; see src/lib/server/http.test.ts.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";
// Small budget so the 429 response can be produced for real (each test uses its own subject).
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "5";

// A stateless HTTP-SQL double: idempotency rows behave like the real table, export_job
// listings return whatever the current test seeds, everything else is empty.
const idempotencyRows = new Map<string, { response_status: number; response_body: string; request_hash: string }>();
let exportJobRows: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_POSTGRES_DSN) return originalFetch(input, init);
  const { sql, parameters } = JSON.parse(String(init?.body ?? "{}")) as { sql: string; parameters: unknown[] };
  const text = sql.trim();
  let rows: unknown[] = [];
  if (text.startsWith("select response_status")) {
    const [tenantId, scope, key] = parameters;
    const row = idempotencyRows.get(`${String(tenantId)}:${String(scope)}:${String(key)}`);
    rows = row ? [row] : [];
  } else if (text.startsWith("insert into corvis_control.idempotency_key")) {
    const [tenantId, scope, key, hash, status, body] = parameters;
    const rowKey = `${String(tenantId)}:${String(scope)}:${String(key)}`;
    if (!idempotencyRows.has(rowKey)) {
      const row = { response_status: status as number, response_body: body as string, request_hash: hash as string };
      idempotencyRows.set(rowKey, row);
      rows = [row];
    }
  } else if (text.includes("from corvis_serving.export_job")) {
    rows = exportJobRows;
  }
  return new Response(JSON.stringify({ rows }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const spec = parseYaml(await readFile("openapi/corvis-v1.yaml", "utf8")) as unknown as OpenApiDocument;

const { GET: capabilitiesGet } = await import("@/app/api/v1/capabilities/route");
const { GET: myWorkspacesGet } = await import("@/app/api/v1/my-workspaces/route");
const { GET: jobsGet } = await import("@/app/api/v1/jobs/route");
const { GET: exportsGet, POST: exportsPost } = await import("@/app/api/v1/exports/route");
const { GET: exportGet } = await import("@/app/api/v1/exports/[exportId]/route");
const { GET: downloadGet } = await import("@/app/api/v1/exports/[exportId]/download/route");

let counter = 0;
function call(path: string, options: { roles?: string; method?: string; body?: unknown; headers?: Record<string, string>; subject?: string } = {}): Request {
  counter += 1;
  const headers: Record<string, string> = {
    "x-corvis-demo-tenant": "tenant-openapi",
    "x-corvis-demo-workspace": "workspace-1",
    "x-corvis-demo-subject": options.subject ?? `openapi-user-${counter}`,
    "x-corvis-demo-roles": options.roles ?? "admin",
    "x-corvis-demo-redistribution": "true",
    "x-correlation-id": `corr-openapi-${counter}`,
    ...options.headers,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://corvis.test/api/v1${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** Asserts the response has the documented status and that its JSON body conforms to the documented schema. */
async function assertDocumented(response: Response, specPath: string, method: string, status: number): Promise<Json> {
  assert.equal(response.status, status, `${method.toUpperCase()} ${specPath} returned ${response.status}`);
  const body = await response.json() as Json;
  const violations = validateSchema(spec, responseSchema(spec, specPath, method, status), body);
  assert.deepEqual(violations, [], `${method.toUpperCase()} ${specPath} ${status} body violates its OpenAPI schema`);
  return body;
}

test("the spec-driven validator rejects what the schemas forbid (it is not vacuous)", () => {
  const schema = responseSchema(spec, "/my-workspaces", "get", 200);
  assert.deepEqual(validateSchema(spec, schema, { data: [{ workspaceId: "w", roles: ["admin"] }], correlationId: "c" }), []);
  assert.notDeepEqual(validateSchema(spec, schema, { data: [{ workspaceId: "w", roles: ["root"] }], correlationId: "c" }), []);
  assert.notDeepEqual(validateSchema(spec, schema, { data: [{ roles: ["admin"] }], correlationId: "c" }), []);
  assert.notDeepEqual(validateSchema(spec, schema, { data: [] }), []);
  const exportStatus = responseSchema(spec, "/exports/{exportId}", "get", 200);
  assert.ok(validateSchema(spec, exportStatus, { data: { createdAt: "2026-09-29 10:11:12.123456+00" }, correlationId: "c" }).some((v) => v.includes("date-time")));
  assert.throws(() => validateSchema(spec, { type: "string", pattern: "^a" }, "a"), /Unsupported JSON Schema keyword/);
});

test("GET /capabilities and GET /my-workspaces conform to their documented 200 schemas", async () => {
  await assertDocumented(await capabilitiesGet(call("/capabilities", { roles: "analyst" })), "/capabilities", "get", 200);
  const workspaces = await assertDocumented(await myWorkspacesGet(call("/my-workspaces", { roles: "reviewer" })), "/my-workspaces", "get", 200);
  assert.equal((workspaces as { data: unknown[] }).data.length, 1);
});

test("GET /jobs conforms unpaginated and paginated, and documents its invalid_cursor 400", async () => {
  const all = await assertDocumented(await jobsGet(call("/jobs")), "/jobs", "get", 200) as { nextCursor: unknown };
  assert.equal(all.nextCursor, null);
  await assertDocumented(await jobsGet(call("/jobs?limit=5")), "/jobs", "get", 200);
  const invalid = await assertDocumented(await jobsGet(call("/jobs?cursor=not-a-cursor")), "/jobs", "get", 400) as { error: string };
  assert.equal(invalid.error, "invalid_cursor");
  const invalidLimit = await assertDocumented(await jobsGet(call("/jobs?limit=0")), "/jobs", "get", 400) as { error: string };
  assert.equal(invalidLimit.error, "invalid_limit");
});

test("POST /exports 202 conforms to ExportManifest, and its documented 400/403/422 error bodies conform to ErrorResponse", async () => {
  const created = await assertDocumented(await exportsPost(call("/exports", { method: "POST", body: { format: "csv" } })), "/exports", "post", 202) as { data: { format: string } };
  assert.equal(created.data.format, "csv");
  const scoped = await assertDocumented(await exportsPost(call("/exports", {
    method: "POST",
    body: { format: "csv", scope: { positionFinancials: { fundId: "fund-1", holdingId: "h-1", companyId: "c-1", periodicity: "quarterly" } } },
  })), "/exports", "post", 403) as { error: string };
  assert.equal(scoped.error, "forbidden", "an unentitled position-financials scope is refused rather than widened");

  const badFormat = await assertDocumented(await exportsPost(call("/exports", { method: "POST", body: { format: "pdf" } })), "/exports", "post", 400) as { error: string };
  assert.equal(badFormat.error, "invalid_export_format");
  const badScope = await assertDocumented(await exportsPost(call("/exports", { method: "POST", body: { format: "csv", scope: { positionFinancials: { fundId: "f" } } } })), "/exports", "post", 400) as { error: string };
  assert.equal(badScope.error, "invalid_export_scope");
  const badKey = await assertDocumented(await exportsPost(call("/exports", { method: "POST", body: { format: "csv", idempotencyKey: "k".repeat(256) } })), "/exports", "post", 400) as { error: string };
  assert.equal(badKey.error, "invalid_idempotency_key");
  const denied = await assertDocumented(await exportsPost(call("/exports", { method: "POST", body: { format: "parquet" }, headers: { "x-corvis-demo-redistribution": "false" } })), "/exports", "post", 403) as { error: string };
  assert.equal(denied.error, "feature_disabled");
});

test("POST /exports documents idempotency: header replay returns the original 202, a changed request is 422 idempotency_key_reused", async () => {
  const subject = "openapi-idempotent";
  const first = await assertDocumented(await exportsPost(call("/exports", { method: "POST", subject, body: { format: "csv" }, headers: { "idempotency-key": "openapi-key-1" } })), "/exports", "post", 202) as { data: { exportId: string } };
  const replay = await assertDocumented(await exportsPost(call("/exports", { method: "POST", subject, body: { format: "csv" }, headers: { "idempotency-key": "openapi-key-1" } })), "/exports", "post", 202) as { data: { exportId: string } };
  assert.equal(replay.data.exportId, first.data.exportId);
  const reused = await assertDocumented(await exportsPost(call("/exports", { method: "POST", subject, body: { format: "xlsx" }, headers: { "idempotency-key": "openapi-key-1" } })), "/exports", "post", 422) as { error: string };
  assert.equal(reused.error, "idempotency_key_reused");
});

test("GET /exports conforms to the ExportStatus listing schema, and read_only callers get the shared Forbidden response", async () => {
  exportJobRows = [];
  await assertDocumented(await exportsGet(call("/exports")), "/exports", "get", 200);

  const created = "2026-09-29T10:11:12.123Z";
  exportJobRows = [{
    export_id: "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f", format: "csv", state: "queued", created_at: created,
    completed_at: null, expires_at: null, checksum_sha256: "a".repeat(64), snapshot_ids: [],
    manifest: {
      exportId: "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f", tenantId: "tenant-openapi", generatedAt: created, schemaVersion: "v1",
      taxonomyVersion: "v1", snapshotIds: [], format: "csv", rowCounts: { observations: 0, snapshots: 0 }, checksumSha256: "a".repeat(64),
    },
  }];
  const listing = await assertDocumented(await exportsGet(call("/exports?limit=1000")), "/exports", "get", 200) as { data: Array<{ downloadAvailable: boolean }> };
  assert.equal(listing.data.length, 1);
  assert.equal(listing.data[0]!.downloadAvailable, false);
  exportJobRows = [];

  const forbidden = await assertDocumented(await exportsGet(call("/exports", { roles: "read_only" })), "/exports", "get", 403) as { error: string };
  assert.equal(forbidden.error, "forbidden");
});

test("GET /exports/{exportId} and /download document their 400/403/404 responses", async () => {
  const id = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
  const context = { params: Promise.resolve({ exportId: id }) };
  await assertDocumented(await exportGet(call(`/exports/${id}`), context), "/exports/{exportId}", "get", 404);
  await assertDocumented(await exportGet(call("/exports/nope"), { params: Promise.resolve({ exportId: "nope" }) }), "/exports/{exportId}", "get", 400);
  await assertDocumented(await exportGet(call(`/exports/${id}`, { roles: "read_only" }), context), "/exports/{exportId}", "get", 403);
  await assertDocumented(await downloadGet(call(`/exports/${id}/download?grant=bad`), context), "/exports/{exportId}/download", "get", 404);
});

test("every response the spec declares as shared is a real, resolvable component", () => {
  for (const status of [401, 403, 429, 500]) {
    let referencedBy = 0;
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (method === "parameters") continue;
        const declared = (operation.responses ?? {})[String(status)];
        assert.ok(declared, `${method.toUpperCase()} ${path} must document ${status}`);
        referencedBy += 1;
        responseSchema(spec, path, method, status);
      }
    }
    assert.ok(referencedBy >= 30, `expected every operation to document ${status}`);
  }
});

test("401 authentication_required and 429 rate_limited (with Retry-After) match their shared responses", async () => {
  // 429: the per-subject budget is 5 requests per window.
  const subject = "openapi-rate-limited";
  let limited: Response | undefined;
  for (let attempt = 0; attempt < 8 && !limited; attempt += 1) {
    const response = await jobsGet(call("/jobs", { subject }));
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, "the request budget must eventually answer 429");
  const retryAfter = Number(limited.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, "Retry-After must be 1-60 seconds");
  const rateBody = await limited.json() as Json;
  assert.deepEqual(validateSchema(spec, responseSchema(spec, "/jobs", "get", 429), rateBody), []);
  assert.equal((rateBody as { error: string }).error, "rate_limited");

  // 401: with demo identities off, a request with no credentials is unauthenticated.
  process.env.CORVIS_DEMO_MODE = "false";
  try {
    const anonymous = await jobsGet(new Request("https://corvis.test/api/v1/jobs"));
    const body = await assertDocumented(anonymous, "/jobs", "get", 401) as { error: string };
    assert.equal(body.error, "authentication_required");
  } finally {
    process.env.CORVIS_DEMO_MODE = "true";
  }
});

// The native adapter returns timestamptz as raw Postgres text ("2026-09-29 10:11:12.123456+00"); the JSON
// boundary (src/lib/server/http.ts json()) must emit it as RFC 3339 so responses satisfy `format: date-time` (#239).
test("GET /exports emits RFC 3339 timestamps for Postgres-formatted rows", async () => {
  exportJobRows = [{
    export_id: "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f", format: "csv", state: "queued", created_at: "2026-09-29 10:11:12.123456+00",
    completed_at: null, expires_at: null, checksum_sha256: "a".repeat(64), snapshot_ids: [],
    manifest: {
      exportId: "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f", tenantId: "tenant-openapi", generatedAt: "2026-09-29T10:11:12.123Z", schemaVersion: "v1",
      taxonomyVersion: "v1", snapshotIds: [], format: "csv", rowCounts: { observations: 0, snapshots: 0 }, checksumSha256: "a".repeat(64),
    },
  }];
  try {
    await assertDocumented(await exportsGet(call("/exports")), "/exports", "get", 200);
  } finally {
    exportJobRows = [];
  }
});
