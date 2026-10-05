import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

// data-governance.ts reaches the Next.js "@/..." alias through http.ts; see src/lib/server/http.test.ts.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);
const { DataGovernanceError } = await import("./data-governance.ts");
const { InvalidCursorError, encodeCursor, decodeCursor } = await import("./pagination.ts");
const { assertOperationsAdmin, listTenantExportBuildIssues, parseBuildIssueStatus } = await import("./tenant-export-operations.ts");

const OPS = "00000000-0000-4000-8000-000000000001";
const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const FIRST = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const SECOND = "9f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "ops-admin", tenantId: OPS, workspaceId: "w", roles: ["admin"], authMethod: "oidc", sessionId: "s", isTenantAdmin: true,
    entitlements: { workspaceIds: ["w"], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}
const refusal = (code: string, status: number) => (error: unknown) => error instanceof DataGovernanceError && error.code === code && error.status === status;

type Call = { sql: string; parameters: PostgresPrimitive[] };
class FakeDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  private readonly rows: PostgresRow[];
  constructor(rows: PostgresRow[] = []) { this.rows = rows; }
  async query(sql: string, parameters: PostgresPrimitive[] = []) { this.calls.push({ sql, parameters }); return this.rows; }
  async execute() {}
  async health() { return true; }
}

const failedRow = (overrides: PostgresRow = {}): PostgresRow => ({
  tenant_id: TENANT, tenant_name: "Meridian", request_id: FIRST, state: "failed", build_attempts: "5", last_error: "export_row_limit_exceeded",
  requested_at: "2026-10-01 10:00:00+00", state_changed_at: "2026-10-02 10:00:00+00", build_next_attempt_at: null, cursor_at: "2026-10-02T10:00:00.000002Z", ...overrides,
});

test("only the operations organization's admins may read the build view; any other tenant, even its Organization Admins, is refused", () => {
  assert.doesNotThrow(() => assertOperationsAdmin(identity(), OPS));
  assert.throws(() => assertOperationsAdmin(identity({ tenantId: TENANT }), OPS), refusal("operations_admin_required", 403));
  assert.throws(() => assertOperationsAdmin(identity({ roles: ["analyst"] }), OPS), refusal("operations_admin_required", 403));
  assert.throws(() => assertOperationsAdmin(identity(), undefined), refusal("operations_admin_required", 403), "no operations tenant configured: nobody");
  assert.throws(() => assertOperationsAdmin(identity(), ""), refusal("operations_admin_required", 403));
});

test("the status filter accepts failed or retrying, treats nothing as both, and refuses anything else", () => {
  assert.equal(parseBuildIssueStatus(null), undefined);
  assert.equal(parseBuildIssueStatus(""), undefined);
  assert.equal(parseBuildIssueStatus("failed"), "failed");
  assert.equal(parseBuildIssueStatus("retrying"), "retrying");
  assert.throws(() => parseBuildIssueStatus("complete"), refusal("invalid_status", 400));
});

test("a failed and a retrying build are listed with the tenant, the attempt count and the stored error, and nothing about the requester or their reason", async () => {
  const db = new FakeDb([
    failedRow(),
    failedRow({ request_id: SECOND, state: "approved", build_attempts: 2, last_error: null, build_next_attempt_at: "2026-10-02 11:00:00+00", cursor_at: "2026-10-02T09:00:00.000001Z" }),
  ]);
  const page = await listTenantExportBuildIssues(db, { limit: 10 });
  assert.deepEqual(page.items, [
    { tenantId: TENANT, tenantName: "Meridian", requestId: FIRST, status: "failed", attempts: 5, lastError: "export_row_limit_exceeded", requestedAt: "2026-10-01 10:00:00+00", changedAt: "2026-10-02 10:00:00+00", nextAttemptAt: null },
    { tenantId: TENANT, tenantName: "Meridian", requestId: SECOND, status: "retrying", attempts: 2, lastError: null, requestedAt: "2026-10-01 10:00:00+00", changedAt: "2026-10-02 10:00:00+00", nextAttemptAt: "2026-10-02 11:00:00+00" },
  ]);
  assert.equal(page.nextCursor, null);
  const sql = db.calls[0]!.sql;
  assert.match(sql, /r\.state = 'failed' or \(r\.state = 'approved' and r\.last_error is not null\)/);
  assert.doesNotMatch(sql, /requested_by|reason|decided_by|manifest|object_uri/, "no customer-supplied or tenant data is selected");
  assert.match(sql, /order by r\.state_changed_at desc, r\.request_id desc\s+limit \$1::integer/);
  assert.deepEqual(db.calls[0]!.parameters, [11]);
});

test("the status filter narrows the SQL, and each page continues from the last row's microsecond timestamp and id", async () => {
  const failed = new FakeDb([failedRow()]);
  await listTenantExportBuildIssues(failed, { limit: 5, status: "failed" });
  assert.match(failed.calls[0]!.sql, /where r\.state = 'failed'\s+order by/);
  const retrying = new FakeDb([]);
  await listTenantExportBuildIssues(retrying, { limit: 5, status: "retrying" });
  assert.match(retrying.calls[0]!.sql, /where \(r\.state = 'approved' and r\.last_error is not null\)\s+order by/);

  const db = new FakeDb([failedRow(), failedRow({ request_id: SECOND, cursor_at: "2026-10-02T09:00:00.000001Z" }), failedRow({ request_id: "a0000000-0000-4000-8000-00000000000a" })]);
  const first = await listTenantExportBuildIssues(db, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(decodeCursor(first.nextCursor!), `2026-10-02T09:00:00.000001Z|${SECOND}`);
  await listTenantExportBuildIssues(db, { limit: 2, cursor: first.nextCursor });
  assert.match(db.calls[1]!.sql, /\(r\.state_changed_at, r\.request_id\) < \(\$1::timestamptz, \$2::uuid\)/);
  assert.deepEqual(db.calls[1]!.parameters, ["2026-10-02T09:00:00.000001Z", SECOND, 3]);
  assert.deepEqual(await listTenantExportBuildIssues(new FakeDb([]), { limit: 2 }), { items: [], nextCursor: null });
  await assert.rejects(() => listTenantExportBuildIssues(db, { limit: 2, cursor: encodeCursor("nope") }), InvalidCursorError);
  assert.equal(db.calls.length, 2, "a bad cursor never reaches SQL");
});
