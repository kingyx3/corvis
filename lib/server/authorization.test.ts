import test from "node:test";
import assert from "node:assert/strict";
import { PostgresMembershipAuthorizationRepository, PostgresSessionRevocationRepository } from "./authorization.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

class FakeDb implements PostgresSqlApi {
  lastSql = "";
  lastParameters: PostgresPrimitive[] = [];
  lastExecuteSql = "";
  lastExecuteParameters: PostgresPrimitive[] = [];
  private readonly rows: PostgresRow[];

  constructor(rows: PostgresRow[]) {
    this.rows = rows;
  }

  async query(sql: string, parameters: PostgresPrimitive[] = []) {
    this.lastSql = sql;
    this.lastParameters = parameters;
    return this.rows;
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []) {
    this.lastExecuteSql = sql;
    this.lastExecuteParameters = parameters;
  }
  async health() { return true; }
}

const principal = {
  subject: "idp|user-123",
  tenantId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  authMethod: "oidc" as const,
  sessionId: "session-123",
};

test("authoritative membership maps roles, workspaces, readable grants, and excludes revoked sessions", async () => {
  const db = new FakeDb([
    { workspace_id: principal.workspaceId, role_name: "reviewer", resource_type: "fund", resource_id: "fund-a", resource_permission: "read" },
    { workspace_id: principal.workspaceId, role_name: "viewer", resource_type: "document", resource_id: "doc-a", resource_permission: "read" },
    { workspace_id: principal.workspaceId, role_name: "reviewer", resource_type: "document", resource_id: "doc-write-only", resource_permission: "review" },
    { workspace_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", role_name: "analyst", resource_type: "fund", resource_id: "fund-other-workspace", resource_permission: "read" },
  ]);
  const repository = new PostgresMembershipAuthorizationRepository(db);
  const result = await repository.resolve(principal);

  assert.deepEqual(result?.roles, ["reviewer", "read_only"]);
  assert.deepEqual(result?.workspaceIds, [principal.workspaceId, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]);
  assert.deepEqual(result?.fundIds, ["fund-a"]);
  assert.deepEqual(result?.documentIds, ["doc-a"]);
  assert.deepEqual(db.lastParameters, [principal.tenantId, principal.subject, principal.authMethod, principal.sessionId]);
  assert.match(db.lastSql, /s\.tenant_id=\$1::uuid/);
  assert.match(db.lastSql, /s\.subject=\$2/);
  assert.match(db.lastSql, /s\.auth_method=\$3/);
  assert.match(db.lastSql, /from corvis_control\.session_revocation r/);
  assert.match(db.lastSql, /r\.tenant_id=s\.tenant_id/);
  assert.match(db.lastSql, /r\.auth_method=s\.auth_method/);
  assert.match(db.lastSql, /r\.subject=s\.subject/);
  assert.match(db.lastSql, /r\.session_id=\$4/);
  assert.match(db.lastSql, /m\.status='active'/);
  assert.match(db.lastSql, /m\.valid_until is null or m\.valid_until > now\(\)/);
  assert.match(db.lastSql, /e\.valid_until is null or e\.valid_until > now\(\)/);
});

test("session revocation writes an immutable tenant-scoped deny record idempotently", async () => {
  const db = new FakeDb([]);
  const repository = new PostgresSessionRevocationRepository(db);
  await repository.revoke({
    tenantId: principal.tenantId,
    authMethod: principal.authMethod,
    subject: principal.subject,
    sessionId: principal.sessionId,
    revokedBySubject: "idp|admin-1",
    reason: "access removed",
  });

  assert.match(db.lastExecuteSql, /insert into corvis_control\.session_revocation/);
  assert.match(db.lastExecuteSql, /on conflict \(tenant_id,auth_method,subject,session_id\) do nothing/);
  assert.deepEqual(db.lastExecuteParameters, [
    principal.tenantId,
    principal.authMethod,
    principal.subject,
    principal.sessionId,
    "idp|admin-1",
    "access removed",
  ]);
});

test("missing fine-grained grants resolve to explicit empty allowlists", async () => {
  const db = new FakeDb([{ workspace_id: principal.workspaceId, role_name: "analyst", resource_type: null, resource_id: null, resource_permission: null }]);
  const result = await new PostgresMembershipAuthorizationRepository(db).resolve(principal);
  assert.deepEqual(result?.fundIds, []);
  assert.deepEqual(result?.documentIds, []);
});

test("requested workspace must have an active membership", async () => {
  const db = new FakeDb([{ workspace_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", role_name: "analyst" }]);
  const result = await new PostgresMembershipAuthorizationRepository(db).resolve(principal);
  assert.equal(result, null);
});

test("unknown database roles never widen application permissions", async () => {
  const db = new FakeDb([{ workspace_id: principal.workspaceId, role_name: "root" }]);
  const result = await new PostgresMembershipAuthorizationRepository(db).resolve(principal);
  assert.equal(result, null);
});

test("database administrative roles map deliberately to application admin", async () => {
  const db = new FakeDb([
    { workspace_id: principal.workspaceId, role_name: "workspace_admin" },
    { workspace_id: principal.workspaceId, role_name: "tenant_admin" },
  ]);
  const result = await new PostgresMembershipAuthorizationRepository(db).resolve(principal);
  assert.deepEqual(result?.roles, ["admin"]);
});
