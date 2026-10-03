import test from "node:test";
import assert from "node:assert/strict";
import { membershipAuthorizationRepository, PostgresMembershipAuthorizationRepository, PostgresSessionRevocationRepository, sessionRevocationRepository } from "./authorization.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { withTransaction, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

class FakeDb implements PostgresSqlApi {
  lastSql = "";
  lastParameters: PostgresPrimitive[] = [];
  lastExecuteSql = "";
  lastExecuteParameters: PostgresPrimitive[] = [];
  enforceCalls: PostgresPrimitive[][] = [];
  private readonly rows: PostgresRow[];
  private readonly verdict: string | null;

  /** `verdict` is what enforce_session_policy answers; null means it returns no row at all. */
  constructor(rows: PostgresRow[], verdict: string | null = "ok") {
    this.rows = rows;
    this.verdict = verdict;
  }

  async query(sql: string, parameters: PostgresPrimitive[] = []) {
    if (sql.includes("enforce_session_policy")) {
      this.enforceCalls.push(parameters);
      return this.verdict === null ? [] : [{ verdict: this.verdict }];
    }
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

test("authoritative membership and data rights map roles, resources, source access and workspace rights", async () => {
  const rights = { resource_client_visible: true, internal_analytics_allowed: true, model_training_allowed: false, redistribution_allowed: true };
  const db = new FakeDb([
    { ...rights, workspace_id: principal.workspaceId, role_name: "reviewer", tenant_display_name: "Meridian Capital Partners", workspace_display_name: "Primary Workspace", resource_type: "fund", resource_id: "fund-a", resource_permission: "read" },
    { ...rights, workspace_id: principal.workspaceId, role_name: "viewer", resource_type: "document", resource_id: "doc-a", resource_permission: "read", resource_source_access: true },
    { ...rights, workspace_id: principal.workspaceId, role_name: "reviewer", resource_type: "document", resource_id: "doc-no-source", resource_permission: "read", resource_source_access: false },
    { ...rights, workspace_id: principal.workspaceId, role_name: "reviewer", resource_type: "document", resource_id: "doc-write-only", resource_permission: "review", resource_source_access: true },
    { ...rights, workspace_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", role_name: "analyst", resource_type: "fund", resource_id: "fund-other-workspace", resource_permission: "read" },
  ]);
  const repository = new PostgresMembershipAuthorizationRepository(db);
  const result = await repository.resolve(principal);

  assert.deepEqual(result?.roles, ["reviewer", "read_only"]);
  assert.deepEqual(result?.workspaceIds, [principal.workspaceId, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]);
  assert.deepEqual(result?.fundIds, ["fund-a"]);
  assert.deepEqual(result?.documentIds, ["doc-a", "doc-no-source"]);
  assert.deepEqual(result?.sourceDocumentIds, ["doc-a"]);
  assert.equal(result?.internalAnalyticsAllowed, true);
  assert.equal(result?.modelTrainingAllowed, false);
  assert.equal(result?.redistributionAllowed, true);
  assert.equal(result?.tenantDisplayName, "Meridian Capital Partners");
  assert.equal(result?.workspaceDisplayName, "Primary Workspace");
  // Chrome data (e.g. a workspace switcher) covers every workspace the
  // membership rows span, not just the one requested — unlike every other
  // field above, which stays scoped to requestedWorkspaceRows.
  assert.deepEqual(result?.memberships, [
    { workspaceId: principal.workspaceId, workspaceDisplayName: "Primary Workspace", roles: ["reviewer", "read_only"] },
    { workspaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", workspaceDisplayName: undefined, roles: ["analyst"] },
  ]);
  assert.deepEqual(db.lastParameters, [principal.tenantId, principal.subject, principal.authMethod, principal.sessionId, principal.workspaceId]);
  assert.match(db.lastSql, /t\.display_name as tenant_display_name/);
  assert.match(db.lastSql, /w\.display_name as workspace_display_name/);
  // Entitlement rows are joined only for the requested workspace.
  assert.match(db.lastSql, /left join corvis_control\.resource_entitlement e[\s\S]*and m\.workspace_id::text=\$5[\s\S]*where s\.tenant_id/);
  assert.match(db.lastSql, /s\.tenant_id=\$1::uuid/);
  assert.match(db.lastSql, /s\.subject=\$2/);
  assert.match(db.lastSql, /s\.auth_method=\$3/);
  assert.match(db.lastSql, /from corvis_control\.data_rights dr/);
  assert.match(db.lastSql, /bool_and\(dr\.client_visible\)/);
  assert.match(db.lastSql, /bool_and\(dr\.source_document_access_allowed\)/);
  assert.match(db.lastSql, /dr\.resource_type='workspace'/);
  assert.match(db.lastSql, /dr\.resource_id=m\.workspace_id::text/);
  assert.match(db.lastSql, /from corvis_control\.session_revocation r/);
  assert.match(db.lastSql, /r\.tenant_id=s\.tenant_id/);
  assert.match(db.lastSql, /r\.auth_method=s\.auth_method/);
  assert.match(db.lastSql, /r\.subject=s\.subject/);
  assert.match(db.lastSql, /r\.session_id=\$4/);
  assert.match(db.lastSql, /m\.status='active'/);
  assert.match(db.lastSql, /m\.valid_until is null or m\.valid_until > now\(\)/);
  assert.match(db.lastSql, /e\.valid_until is null or e\.valid_until > now\(\)/);
});

test("tenant/workspace display names are undefined, not an empty string, when the row carries none", async () => {
  const db = new FakeDb([{ workspace_id: principal.workspaceId, role_name: "analyst" }]);
  const result = await new PostgresMembershipAuthorizationRepository(db).resolve(principal);
  assert.equal(result?.tenantDisplayName, undefined);
  assert.equal(result?.workspaceDisplayName, undefined);
  assert.deepEqual(result?.memberships, [{ workspaceId: principal.workspaceId, workspaceDisplayName: undefined, roles: ["analyst"] }]);
});

test("missing or denied current data rights fail closed even when a resource entitlement exists", async () => {
  const db = new FakeDb([
    { workspace_id: principal.workspaceId, role_name: "analyst", resource_type: "fund", resource_id: "fund-a", resource_permission: "read", resource_client_visible: false },
    { workspace_id: principal.workspaceId, role_name: "analyst", resource_type: "document", resource_id: "doc-a", resource_permission: "read", resource_client_visible: false, resource_source_access: true },
  ]);
  const result = await new PostgresMembershipAuthorizationRepository(db).resolve(principal);
  assert.deepEqual(result?.fundIds, []);
  assert.deepEqual(result?.documentIds, []);
  assert.deepEqual(result?.sourceDocumentIds, []);
  assert.equal(result?.internalAnalyticsAllowed, false);
  assert.equal(result?.modelTrainingAllowed, false);
  assert.equal(result?.redistributionAllowed, false);
});

test("service-account authorization requires an active, unexpired and currently reviewed lifecycle grant", async () => {
  const servicePrincipal = { ...principal, subject: "svc|allocator-import", authMethod: "service_account" as const };
  const db = new FakeDb([{ workspace_id: principal.workspaceId, role_name: "analyst" }]);
  await new PostgresMembershipAuthorizationRepository(db).resolve(servicePrincipal);

  assert.match(db.lastSql, /s\.auth_method <> 'service_account'/);
  assert.match(db.lastSql, /from corvis_control\.service_identity_grant g/);
  assert.match(db.lastSql, /g\.tenant_id=s\.tenant_id/);
  assert.match(db.lastSql, /g\.auth_method=s\.auth_method/);
  assert.match(db.lastSql, /g\.subject=s\.subject/);
  assert.match(db.lastSql, /g\.status='active'/);
  assert.match(db.lastSql, /g\.valid_from <= now\(\)/);
  assert.match(db.lastSql, /g\.valid_until > now\(\)/);
  assert.match(db.lastSql, /g\.next_review_at > now\(\)/);
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

/**
 * Real (in-memory) transaction semantics: `transaction()` snapshots the
 * revocation table and audit log before running the callback and restores
 * that snapshot if it throws, mirroring NativePostgresSqlApi.transaction's
 * begin/rollback. Used to prove app/api/v1/admin/session-revocations/route.ts
 * wraps the revocation write and its audit event in one transaction.
 */
class TransactionalFakeDb implements PostgresSqlApi {
  revocations = new Set<string>();
  auditRows: PostgresRow[] = [];

  async query(): Promise<PostgresRow[]> { return []; }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    if (sql.includes("insert into corvis_control.session_revocation")) {
      this.revocations.add(parameters.slice(0, 4).join(":"));
      return;
    }
    if (sql.includes("insert into corvis_control.audit_event")) {
      this.auditRows.push({ action: parameters[5] });
    }
  }

  async health(): Promise<boolean> { return true; }

  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    const revocationsSnapshot = new Set(this.revocations);
    const auditSnapshot = [...this.auditRows];
    try {
      return await fn(this);
    } catch (error) {
      this.revocations = revocationsSnapshot;
      this.auditRows = auditSnapshot;
      throw error;
    }
  }
}

test("a session revocation and its audit event commit together, and roll back together when the audit insert fails", async () => {
  const command = {
    tenantId: principal.tenantId, authMethod: principal.authMethod, subject: principal.subject,
    sessionId: principal.sessionId, revokedBySubject: "idp|admin-1", reason: "access removed",
  };
  const event = {
    id: "event-1", occurredAt: new Date().toISOString(), tenantId: principal.tenantId, workspaceId: principal.workspaceId,
    actorSubject: "idp|admin-1", sessionId: "session-1", action: "identity.session.revoke", targetType: "session",
    targetId: principal.sessionId, outcome: "success" as const, correlationId: "corr-1",
  };

  const db = new TransactionalFakeDb();
  await withTransaction(db, async (tx) => {
    await new PostgresSessionRevocationRepository(tx).revoke(command);
    await new PostgresOperationsRepository(tx).audit(event);
  });
  assert.equal(db.revocations.size, 1);
  assert.equal(db.auditRows.length, 1);

  const failing = new TransactionalFakeDb();
  const originalExecute = failing.execute.bind(failing);
  failing.execute = async (sql: string, parameters: PostgresPrimitive[] = []) => {
    if (sql.includes("insert into corvis_control.audit_event")) throw new Error("audit insert failed");
    return originalExecute(sql, parameters);
  };
  await assert.rejects(
    withTransaction(failing, async (tx) => {
      await new PostgresSessionRevocationRepository(tx).revoke(command);
      await new PostgresOperationsRepository(tx).audit(event);
    }),
    /audit insert failed/,
  );
  // The revocation must not be visible: a retry of the same request must see
  // no revocation and be free to try again, not a half-applied one.
  assert.equal(failing.revocations.size, 0);
});

test("missing fine-grained grants resolve to explicit empty allowlists", async () => {
  const db = new FakeDb([{ workspace_id: principal.workspaceId, role_name: "analyst", resource_type: null, resource_id: null, resource_permission: null }]);
  const result = await new PostgresMembershipAuthorizationRepository(db).resolve(principal);
  assert.deepEqual(result?.fundIds, []);
  assert.deepEqual(result?.documentIds, []);
  assert.deepEqual(result?.sourceDocumentIds, []);
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
    { workspace_id: principal.workspaceId, role_name: "accountadmin" },
    { workspace_id: principal.workspaceId, role_name: "tenant_admin" },
  ]);
  const result = await new PostgresMembershipAuthorizationRepository(db).resolve(principal);
  assert.deepEqual(result?.roles, ["admin"]);
});

test("isTenantAdmin is true only for a raw tenant_admin row, not for accountadmin", async () => {
  const accountAdminOnly = await new PostgresMembershipAuthorizationRepository(
    new FakeDb([{ workspace_id: principal.workspaceId, role_name: "accountadmin" }]),
  ).resolve(principal);
  assert.equal(accountAdminOnly?.isTenantAdmin, false);

  const tenantAdmin = await new PostgresMembershipAuthorizationRepository(
    new FakeDb([{ workspace_id: principal.workspaceId, role_name: "tenant_admin" }]),
  ).resolve(principal);
  assert.equal(tenantAdmin?.isTenantAdmin, true);
});

test("isTenantAdmin reflects a tenant_admin membership in another workspace, not only the requested one", async () => {
  const otherWorkspaceId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const result = await new PostgresMembershipAuthorizationRepository(new FakeDb([
    { workspace_id: principal.workspaceId, role_name: "accountadmin" },
    { workspace_id: otherWorkspaceId, role_name: "tenant_admin" },
  ])).resolve(principal);
  assert.equal(result?.isTenantAdmin, true);
  assert.deepEqual(result?.roles, ["admin"]);
});

// ------------------------------------------------------------------ organization session policy (F7, #263)
const memberRows = [{ workspace_id: principal.workspaceId, role_name: "analyst" }];

test("an authorized human session is recorded and checked against the organization's session policy", async () => {
  const db = new FakeDb(memberRows);
  const result = await new PostgresMembershipAuthorizationRepository(db).resolve(principal);
  assert.deepEqual(result?.roles, ["analyst"]);
  assert.deepEqual(db.enforceCalls, [[principal.tenantId, "oidc", principal.subject, principal.sessionId]]);
});

test("a session the policy ends (idle, too long, or not measurable) is denied exactly like a revoked one", async () => {
  for (const verdict of ["idle_timeout", "max_session", "untracked_session", "something_new", ""]) {
    const db = new FakeDb(memberRows, verdict);
    assert.equal(await new PostgresMembershipAuthorizationRepository(db).resolve(principal), null, verdict);
    assert.equal(db.enforceCalls.length, 1, verdict);
  }
});

test("a policy check that answers nothing at all fails closed", async () => {
  assert.equal(await new PostgresMembershipAuthorizationRepository(new FakeDb(memberRows, null)).resolve(principal), null);
});

test("a subject that is not authorized is never recorded as a session", async () => {
  const db = new FakeDb([{ workspace_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", role_name: "analyst" }]);
  assert.equal(await new PostgresMembershipAuthorizationRepository(db).resolve(principal), null, "not a member of the requested workspace");
  const unknownRole = new FakeDb([{ workspace_id: principal.workspaceId, role_name: "mystery" }]);
  assert.equal(await new PostgresMembershipAuthorizationRepository(unknownRole).resolve(principal), null, "no application role");
  assert.equal(db.enforceCalls.length + unknownRole.enforceCalls.length, 0);
});

test("service identities and background re-authorization are not subject to the session policy", async () => {
  const service = new FakeDb(memberRows, "idle_timeout");
  assert.ok(await new PostgresMembershipAuthorizationRepository(service).resolve({ ...principal, authMethod: "service_account" }));
  assert.equal(service.enforceCalls.length, 0, "the policy governs people");

  const background = new FakeDb(memberRows, "idle_timeout");
  assert.ok(await new PostgresMembershipAuthorizationRepository(background).resolve(principal, { applySessionPolicy: false }));
  assert.equal(background.enforceCalls.length, 0, "a queued export neither ends nor extends the person's session");
  assert.equal(await new PostgresMembershipAuthorizationRepository(new FakeDb(memberRows, "idle_timeout")).resolve(principal, { applySessionPolicy: true }), null);
});

test("a demo identity never resolves an authoritative context, and the shared repositories are created once per process", async () => {
  const db = new FakeDb(memberRows);
  assert.equal(await new PostgresMembershipAuthorizationRepository(db).resolve({ ...principal, authMethod: "demo" }), null);
  assert.equal(db.enforceCalls.length, 0, "nothing is recorded for a demo session");
  assert.equal(membershipAuthorizationRepository("https://fake-postgres.test/sql"), membershipAuthorizationRepository());
  assert.equal(sessionRevocationRepository("https://fake-postgres.test/sql"), sessionRevocationRepository());
});

test("session policy enforcement is observable: latency for every check, a denial count tagged with the reason, and never a subject or a session id (F7d)", async (t) => {
  const lines: Array<Record<string, unknown>> = [];
  t.mock.method(console, "info", (line: unknown) => { lines.push(JSON.parse(String(line)) as Record<string, unknown>); });
  t.mock.method(console, "warn", (line: unknown) => { lines.push(JSON.parse(String(line)) as Record<string, unknown>); });

  await new PostgresMembershipAuthorizationRepository(new FakeDb(memberRows, "ok")).resolve(principal);
  const allowed = lines.filter((line) => line.metric === "auth.session_policy");
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0]!.event, "metric.duration");
  assert.equal(allowed[0]!.outcome, "ok");
  assert.equal(typeof allowed[0]!.durationMs, "number");
  assert.ok((allowed[0]!.durationMs as number) >= 0);
  assert.equal(allowed[0]!.tenantId, principal.tenantId);
  assert.equal(lines.some((line) => line.metric === "auth.session_policy_denied"), false, "an allowed session is not a denial");

  lines.length = 0;
  for (const verdict of ["idle_timeout", "max_session", "untracked_session", ""]) {
    await new PostgresMembershipAuthorizationRepository(new FakeDb(memberRows, verdict)).resolve(principal);
  }
  await new PostgresMembershipAuthorizationRepository(new FakeDb(memberRows, null)).resolve(principal);
  const reason = (line: Record<string, unknown>) => line.reason ?? line.outcome;
  assert.deepEqual(lines.filter((line) => line.metric === "auth.session_policy").map(reason), ["idle_timeout", "max_session", "untracked_session", "unknown", "unknown"], "every check is timed and tagged with its verdict");
  const denials = lines.filter((line) => line.metric === "auth.session_policy_denied");
  assert.deepEqual(denials.map(reason), ["idle_timeout", "max_session", "untracked_session", "unknown", "unknown"]);
  assert.ok(denials.every((line) => line.event === "metric.count" && line.value === 1 && line.tenantId === principal.tenantId));
  assert.equal(lines.filter((line) => line.event === "auth.session_policy_denied").length, 5, "the readable warning is still logged once per denial");
  for (const line of lines) {
    const serialized = JSON.stringify(line);
    assert.ok(!serialized.includes(principal.subject) && !serialized.includes(principal.sessionId), "telemetry never names the person or the session");
  }

  lines.length = 0;
  await new PostgresMembershipAuthorizationRepository(new FakeDb(memberRows, "idle_timeout")).resolve({ ...principal, authMethod: "service_account" });
  await new PostgresMembershipAuthorizationRepository(new FakeDb(memberRows, "idle_timeout")).resolve(principal, { applySessionPolicy: false });
  assert.deepEqual(lines, [], "exempt callers are neither timed nor counted");
});
