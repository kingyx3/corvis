import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, type RequestIdentity } from "../../../shared/domain/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import {
  ROLE_EXPLANATIONS,
  acknowledgeSupportAccess,
  createBulkInvitations,
  listTenantAccessAudit,
  markTenantAccessNotificationsRead,
  resendTenantInvitation,
  revokeTenantInvitation,
  tenantAccessAuditCsv,
  tenantSupportAccessState,
  type BulkInviteRow,
  type TenantAccessAuditEvent,
} from "./tenant-admin-self-service.ts";
import { ConflictError } from "../../../platform/data/platform.ts";
import { TenantInvitationError } from "./tenant-invitations.ts";

// No outbound email: the invitation sender must resolve to the "not configured" path.
process.env.CORVIS_DEMO_MODE = "";
delete process.env.CORVIS_EMAIL_PROVIDER;
delete process.env.CORVIS_PUBLIC_APP_URL;
delete process.env.CORVIS_OPERATIONS_TENANT_ID;

const tenantId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const grantId = "55555555-5555-4555-8555-555555555555";
const invitationId = "33333333-3333-4333-8333-333333333333";

const admin: RequestIdentity = {
  subject: "admin@example.com", tenantId, workspaceId, roles: ["admin"],
  entitlements: { workspaceIds: [workspaceId], sourceDocumentAccessAllowed: false }, authMethod: "oidc", sessionId: "session-1", isTenantAdmin: true,
};
const member: RequestIdentity = { ...admin, subject: "member@example.com", isTenantAdmin: false };

type Statement = { sql: string; parameters: PostgresPrimitive[] };
type Handler = { match: RegExp; rows?: PostgresRow[]; error?: unknown };

/** Records every statement and answers `query` from the first handler whose pattern matches the SQL. */
class ScriptedDb implements PostgresSqlApi {
  readonly statements: Statement[] = [];
  readonly executeHandlers: Handler[] = [];
  private readonly handlers: Handler[];
  constructor(handlers: Handler[] = []) { this.handlers = handlers; }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.statements.push({ sql, parameters });
    const handler = this.handlers.find((candidate) => candidate.match.test(sql));
    if (handler?.error) throw handler.error;
    return handler?.rows ?? [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.statements.push({ sql, parameters });
    const handler = this.executeHandlers.find((candidate) => candidate.match.test(sql));
    if (handler?.error) throw handler.error;
  }
  async health(): Promise<boolean> { return true; }
  find(pattern: RegExp): Statement | undefined { return this.statements.find((statement) => pattern.test(statement.sql)); }
  audits(): Array<{ action: string; parameters: PostgresPrimitive[] }> {
    return this.statements.filter((statement) => statement.sql.includes("insert into corvis_control.audit_event"))
      .map((statement) => ({ action: String(statement.parameters[5]), parameters: statement.parameters }));
  }
}

/** A ScriptedDb whose transport supports transactions, recording how each one ended. */
class TransactionalDb extends ScriptedDb {
  readonly outcomes: string[] = [];
  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    try {
      const result = await fn(this);
      this.outcomes.push("commit");
      return result;
    } catch (error) {
      this.outcomes.push("rollback");
      throw error;
    }
  }
}

const isAuthorizationRefusal = (error: unknown) => error instanceof AuthorizationError && error.requiredPermission === "admin:tenant_manage";
const isInvitationError = (code: string, status: number) => (error: unknown) => error instanceof TenantInvitationError && error.code === code && error.status === status;

function silenceConsole(t: test.TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => { lines.push(String(line)); });
  t.mock.method(console, "info", () => undefined);
  t.mock.method(console, "warn", () => undefined);
  return lines;
}

test("role explanations describe every invitable role and never grant management to non-admins", () => {
  for (const role of ["reviewer", "analyst", "viewer", "accountadmin", "tenant_admin", "support"]) assert.ok(ROLE_EXPLANATIONS[role], role);
  for (const role of ["reviewer", "analyst", "viewer", "accountadmin"]) assert.match(ROLE_EXPLANATIONS[role] ?? "", /Cannot (manage|change)/);
  assert.match(ROLE_EXPLANATIONS.tenant_admin ?? "", /user management/);
  assert.match(ROLE_EXPLANATIONS.support ?? "", /time-limited and fully audited/);
});

test("access audit listing is tenant scoped, admin only, and tolerates sparse rows", async () => {
  const db = new ScriptedDb([{ match: /audit_event/, rows: [
    { audit_event_id: "e1", occurred_at: "2026-09-26T00:00:00Z", workspace_id: workspaceId, actor_subject: "a@example.com", action: "tenant_invitation.issued", target_type: "tenant_invitation", target_id: "i1", outcome: "success", metadata: { email: "x@example.com" } },
    { audit_event_id: "e2", occurred_at: null, workspace_id: null, actor_subject: "b@example.com", action: "access.member.removed", target_type: "membership", target_id: null, outcome: "success", metadata: null },
    { audit_event_id: "e3", occurred_at: "2026-09-25T00:00:00Z", workspace_id: "", actor_subject: "c@example.com", action: "access.scim.sync", target_type: "scim_configuration", target_id: "s", outcome: "failure", metadata: "not-an-object" },
  ] }]);
  const events = await listTenantAccessAudit(admin, db);

  assert.equal(db.statements.length, 1);
  assert.match(db.statements[0]?.sql ?? "", /where tenant_id=\$1::uuid/);
  assert.deepEqual(db.statements[0]?.parameters, [tenantId]);
  assert.deepEqual(events[0], { auditEventId: "e1", occurredAt: "2026-09-26T00:00:00Z", workspaceId, actorSubject: "a@example.com", action: "tenant_invitation.issued", targetType: "tenant_invitation", targetId: "i1", outcome: "success", metadata: { email: "x@example.com" } });
  assert.equal(events[1]?.workspaceId, undefined, "a null workspace is reported as absent");
  assert.equal(events[1]?.occurredAt, "");
  assert.equal(events[1]?.targetId, "");
  assert.deepEqual(events[1]?.metadata, {});
  assert.equal(events[2]?.workspaceId, undefined, "an empty workspace is reported as absent");
  assert.deepEqual(events[2]?.metadata, {}, "non-object metadata is dropped rather than leaked");

  const refused = new ScriptedDb();
  await assert.rejects(listTenantAccessAudit(member, refused), isAuthorizationRefusal);
  assert.equal(refused.statements.length, 0, "a non-admin never reaches the database");
});

test("audit CSV renders absent workspaces as empty cells and stringifies non-string values", () => {
  const event: TenantAccessAuditEvent = { auditEventId: "a", occurredAt: "2026-09-26T00:00:00Z", actorSubject: "admin@example.com", action: "access.member.removed", targetType: "membership", targetId: "m1", outcome: "success", metadata: {} };
  const withWorkspace: TenantAccessAuditEvent = { ...event, workspaceId };
  const [header, plain, scoped, end] = tenantAccessAuditCsv([event, withWorkspace]).split("\r\n");
  assert.equal(header, "occurred_at,actor,action,workspace_id,target_type,target_id,outcome,metadata");
  assert.equal(plain, "2026-09-26T00:00:00Z,admin@example.com,access.member.removed,,membership,m1,success,{}");
  assert.equal(scoped, `2026-09-26T00:00:00Z,admin@example.com,access.member.removed,${workspaceId},membership,m1,success,{}`);
  assert.equal(end, "", "the document ends with a CRLF");
  // A missing metadata value serialises to an empty string rather than the text "undefined".
  const missingMetadata = tenantAccessAuditCsv([{ ...event, metadata: undefined as unknown as Record<string, unknown> }]).split("\r\n")[1];
  assert.ok(!missingMetadata?.includes("undefined"));
});

test("support access state reads only this tenant's live grants and notifications", async () => {
  const db = new ScriptedDb([
    { match: /support_access_grant/, rows: [
      { support_grant_id: grantId, workspace_id: workspaceId, role_name: "tenant_admin", purpose: "diagnostic", valid_from: "2026-09-26T00:00:00Z", valid_until: "2026-09-27T00:00:00Z", status: "pending_ack", requires_tenant_ack: true, acknowledged_at: null, subject: "support@corvis.example" },
      { support_grant_id: "66666666-6666-4666-8666-666666666666", workspace_id: otherWorkspaceId, role_name: "reviewer", purpose: "triage", valid_from: "2026-09-26T00:00:00Z", valid_until: "2026-09-26T02:00:00Z", status: "active", requires_tenant_ack: false, acknowledged_at: "2026-09-26T00:30:00Z", subject: "support2@corvis.example" },
    ] },
    { match: /tenant_access_notification/, rows: [
      { notification_id: "n1", kind: "support_access_pending", support_grant_id: grantId, title: "Ack needed", message: "Please acknowledge", created_at: "2026-09-26T00:00:00Z", read_at: null },
      { notification_id: "n2", kind: "support_access_active", support_grant_id: grantId, title: "Active", message: "Now active", created_at: "2026-09-26T01:00:00Z", read_at: "2026-09-26T02:00:00Z" },
    ] },
  ]);
  const state = await tenantSupportAccessState(admin, db);

  assert.equal(db.statements.length, 2);
  for (const statement of db.statements) {
    assert.match(statement.sql, /tenant_id=\$1::uuid/);
    assert.deepEqual(statement.parameters, [tenantId]);
  }
  assert.match(db.find(/support_access_grant/)?.sql ?? "", /status in \('pending_ack','active'\) and valid_until>now\(\)/);
  assert.equal(state.grants.length, 2);
  assert.deepEqual(state.grants[0], { supportGrantId: grantId, workspaceId, roleName: "tenant_admin", purpose: "diagnostic", validFrom: "2026-09-26T00:00:00Z", validUntil: "2026-09-27T00:00:00Z", status: "pending_ack", requiresTenantAck: true, acknowledgedAt: undefined, subject: "support@corvis.example" });
  assert.equal(state.grants[1]?.requiresTenantAck, false);
  assert.equal(state.grants[1]?.acknowledgedAt, "2026-09-26T00:30:00Z");
  assert.deepEqual(state.notifications[0], { notificationId: "n1", kind: "support_access_pending", supportGrantId: grantId, title: "Ack needed", message: "Please acknowledge", createdAt: "2026-09-26T00:00:00Z", readAt: undefined });
  assert.equal(state.notifications[1]?.readAt, "2026-09-26T02:00:00Z");

  const refused = new ScriptedDb();
  await assert.rejects(tenantSupportAccessState(member, refused), isAuthorizationRefusal);
  assert.equal(refused.statements.length, 0);
});

test("marking notifications read touches only this tenant's unread rows and is admin only", async () => {
  const db = new ScriptedDb();
  await markTenantAccessNotificationsRead(admin, db);
  assert.equal(db.statements.length, 1);
  assert.match(db.statements[0]?.sql ?? "", /update corvis_control\.tenant_access_notification set read_at=coalesce\(read_at,now\(\)\) where tenant_id=\$1::uuid and read_at is null/);
  assert.deepEqual(db.statements[0]?.parameters, [tenantId]);

  const refused = new ScriptedDb();
  await assert.rejects(markTenantAccessNotificationsRead(member, refused), isAuthorizationRefusal);
  assert.equal(refused.statements.length, 0);
});

test("read paths fail closed when no database is configured and none is injected", async () => {
  const original = process.env.CORVIS_POSTGRES_DSN;
  delete process.env.CORVIS_POSTGRES_DSN;
  try {
    const dsnMissing = (error: unknown) => error instanceof Error && /CORVIS_POSTGRES_DSN is required/.test(error.message);
    await assert.rejects(listTenantAccessAudit(admin), dsnMissing);
    await assert.rejects(tenantSupportAccessState(admin), dsnMissing);
    await assert.rejects(markTenantAccessNotificationsRead(admin), dsnMissing);
  } finally {
    if (original === undefined) delete process.env.CORVIS_POSTGRES_DSN; else process.env.CORVIS_POSTGRES_DSN = original;
  }
});

const pendingGrant: PostgresRow = {
  auth_method: "oidc", subject: "support@corvis.example", user_id: "77777777-7777-4777-8777-777777777777", workspace_id: otherWorkspaceId,
  role_name: "tenant_admin", purpose: "incident INC-9", approval_reference: "INC-9", valid_from: "2026-09-26T00:00:00Z", valid_until: "2026-09-27T00:00:00Z", approved_by_subject: "approver@corvis.example",
};

test("acknowledging support access re-applies the grant for this tenant, stamps the acknowledger and audits it", async () => {
  const db = new ScriptedDb([{ match: /select auth_method/, rows: [pendingGrant] }]);
  await acknowledgeSupportAccess(admin, grantId, "corr-ack", db);

  const lookup = db.statements[0];
  assert.match(lookup?.sql ?? "", /tenant_id=\$1::uuid and support_grant_id=\$2::uuid and status='pending_ack' and valid_until>now\(\) for update/);
  assert.deepEqual(lookup?.parameters, [tenantId, grantId]);

  const removal = db.statements[1];
  assert.match(removal?.sql ?? "", /delete from corvis_control\.support_access_grant where tenant_id=\$1::uuid and support_grant_id=\$2::uuid and status='pending_ack'/);
  assert.deepEqual(removal?.parameters, [tenantId, grantId]);

  const apply = db.find(/apply_support_access_admin/);
  assert.deepEqual(apply?.parameters, [
    tenantId, "approver@corvis.example", workspaceId, "corr-ack", grantId, "oidc", "support@corvis.example", pendingGrant.user_id, otherWorkspaceId,
    "tenant_admin", "incident INC-9", "INC-9", "2026-09-26T00:00:00Z", "2026-09-27T00:00:00Z", "Tenant administrator acknowledged elevated support access",
  ]);

  const stamp = db.find(/set requires_tenant_ack=true,acknowledged_at=now\(\),acknowledged_by_subject=\$3/);
  assert.match(stamp?.sql ?? "", /where tenant_id=\$1::uuid and support_grant_id=\$2::uuid/);
  assert.deepEqual(stamp?.parameters, [tenantId, grantId, "admin@example.com"]);

  // The grant must be removed before it is re-applied, and the acknowledgement stamped after.
  const order = ["delete from", "apply_support_access_admin", "requires_tenant_ack=true", "insert into corvis_control.audit_event"].map((marker) => db.statements.findIndex((statement) => statement.sql.includes(marker)));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((index) => index > 0));

  const [audit] = db.audits();
  assert.equal(audit?.action, "access.support.acknowledged");
  assert.equal(audit?.parameters[0], tenantId);
  assert.equal(audit?.parameters[3], workspaceId);
  assert.equal(audit?.parameters[4], "admin@example.com");
  assert.equal(audit?.parameters[6], "support_access_grant");
  assert.equal(audit?.parameters[7], grantId);
  assert.equal(audit?.parameters[8], "success");
  assert.equal(audit?.parameters[9], "corr-ack");
  assert.deepEqual(JSON.parse(String(audit?.parameters[10])), { sessionId: "session-1", supportGrantId: grantId });
});

test("acknowledging support access refuses non-admins, malformed ids and grants that are not pending", async () => {
  const db = new ScriptedDb();
  await assert.rejects(acknowledgeSupportAccess(member, grantId, "c", db), isAuthorizationRefusal);
  await assert.rejects(acknowledgeSupportAccess(admin, "not-a-uuid", "c", db), isInvitationError("invalid_support_grant_id", 400));
  assert.equal(db.statements.length, 0, "nothing reaches the database for a refused request");

  const notPending = new ScriptedDb();
  await assert.rejects(acknowledgeSupportAccess(admin, grantId, "c", notPending), isInvitationError("support_grant_not_pending", 409));
  assert.equal(notPending.statements.length, 1, "only the locking lookup ran: no delete, apply or audit");
  assert.deepEqual(notPending.statements[0]?.parameters, [tenantId, grantId]);
});

test("revoking an invitation audits the invitee, role and trimmed reason against the invitation's workspace", async () => {
  const db = new ScriptedDb([{ match: /update corvis_control\.tenant_invitation/, rows: [{ workspace_id: otherWorkspaceId, email: "jane@example.com", role_name: "reviewer" }] }]);
  await revokeTenantInvitation(admin, invitationId, "  no longer joining  ", "corr-rev", db);
  const [audit] = db.audits();
  assert.equal(audit?.action, "tenant_invitation.revoked");
  assert.equal(audit?.parameters[0], tenantId);
  assert.equal(audit?.parameters[3], otherWorkspaceId);
  assert.equal(audit?.parameters[7], invitationId);
  assert.equal(audit?.parameters[9], "corr-rev");
  assert.deepEqual(JSON.parse(String(audit?.parameters[10])), { sessionId: "session-1", email: "jane@example.com", roleName: "reviewer", reason: "no longer joining" });

  const tooLong = new ScriptedDb();
  await assert.rejects(revokeTenantInvitation(admin, invitationId, "x".repeat(1001), "c", tooLong), isInvitationError("invalid_request", 400));
  assert.equal(tooLong.statements.length, 0);
});

const resentRow: PostgresRow = {
  invitation_id: invitationId, tenant_id: tenantId, workspace_id: workspaceId, workspace_name: "Finance", email: "jane@example.com", role_name: "analyst",
  status: "pending", created_at: "2026-09-20T00:00:00Z", expires_at: "2026-10-09T00:00:00Z",
};

test("resending an invitation rotates the token hash and expiry for this tenant only, and returns the new plaintext token once", async () => {
  const db = new ScriptedDb([{ match: /update corvis_control\.tenant_invitation i/, rows: [resentRow] }]);
  const before = Date.now();
  const result = await resendTenantInvitation(admin, invitationId, " reminder ", "corr-resend", db);

  const update = db.statements[0];
  assert.match(update?.sql ?? "", /i\.tenant_id=\$1::uuid and i\.invitation_id=\$2::uuid and i\.status='pending' and i\.expires_at>now\(\)/);
  assert.match(update?.sql ?? "", /w\.tenant_id=i\.tenant_id and w\.workspace_id=i\.workspace_id/);
  const [tenantParam, idParam, hashParam, expiresParam] = update?.parameters ?? [];
  assert.equal(tenantParam, tenantId);
  assert.equal(idParam, invitationId);
  const { createHash } = await import("node:crypto");
  assert.equal(hashParam, createHash("sha256").update(result.token).digest("hex"), "only the hash of the returned token is stored");
  assert.notEqual(hashParam, result.token);
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  const expiresMs = Date.parse(String(expiresParam));
  assert.ok(expiresMs >= before + 7 * 86400000 && expiresMs <= Date.now() + 7 * 86400000, "expiry is the invitation TTL from now");

  assert.deepEqual(result.invitation, { invitationId, tenantId, workspaceId, workspaceName: "Finance", email: "jane@example.com", roleName: "analyst", status: "pending", createdAt: "2026-09-20T00:00:00Z", expiresAt: "2026-10-09T00:00:00Z" });

  const [audit] = db.audits();
  assert.equal(audit?.action, "tenant_invitation.resent");
  assert.equal(audit?.parameters[3], workspaceId);
  assert.equal(audit?.parameters[7], invitationId);
  const metadata = JSON.parse(String(audit?.parameters[10])) as Record<string, unknown>;
  assert.deepEqual({ ...metadata, expiresAt: undefined }, { sessionId: "session-1", email: "jane@example.com", roleName: "analyst", reason: "reminder", expiresAt: undefined });
  assert.equal(metadata.expiresAt, expiresParam);
  assert.ok(!JSON.stringify(audit?.parameters).includes(result.token), "the plaintext token is never audited");
});

test("resending an invitation is refused for non-admins, malformed requests and invitations that are not pending", async () => {
  const db = new ScriptedDb();
  await assert.rejects(resendTenantInvitation(member, invitationId, "reason", "c", db), isAuthorizationRefusal);
  await assert.rejects(resendTenantInvitation(admin, "not-a-uuid", "reason", "c", db), isInvitationError("invalid_request", 400));
  await assert.rejects(resendTenantInvitation(admin, invitationId, " a ", "c", db), isInvitationError("invalid_request", 400));
  await assert.rejects(resendTenantInvitation(admin, invitationId, "x".repeat(1001), "c", db), isInvitationError("invalid_request", 400));
  assert.equal(db.statements.length, 0, "nothing reaches the database for a refused request");

  const none = new ScriptedDb();
  await assert.rejects(resendTenantInvitation(admin, invitationId, "reason", "c", none), isInvitationError("invitation_not_pending", 409));
  assert.equal(none.audits().length, 0, "no audit event for a resend that changed nothing");
});

const csvRow = (row: number, overrides: Partial<BulkInviteRow> = {}): BulkInviteRow => ({
  row, name: `User ${row}`, email: `user${row}@example.com`, roleName: "reviewer", workspaceId, reason: "Finance onboarding", ...overrides,
} as BulkInviteRow);

// One row answers both statements invitation creation makes: the workspace lookup and the F7b domain check (off: allowed).
const activeWorkspace: Handler = { match: /from corvis_control\.workspace w|email_domain_allowed/, rows: [{ display_name: "Finance", allowed: true }] };

test("bulk invitations create each row in its own transaction, scope them to the caller's tenant and report email delivery", async () => {
  const db = new TransactionalDb([activeWorkspace]);
  const outcome = await createBulkInvitations(admin, [csvRow(2), csvRow(3, { email: "  Other@Example.com ", roleName: "workspace_admin" as BulkInviteRow["roleName"] })], { confirmTenantAdmin: false, correlationId: "bulk-1", db });

  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.created.length, 2);
  assert.deepEqual(db.outcomes, ["commit", "commit"]);
  assert.equal(outcome.created[0]?.row, 2);
  assert.equal(outcome.created[0]?.name, "User 2");
  assert.equal(outcome.created[0]?.emailDelivery, "not_configured");
  const first = outcome.created[0]?.invitation as { tenantId: string; email: string; roleName: string; status: string };
  assert.deepEqual({ tenantId: first.tenantId, email: first.email, roleName: first.roleName, status: first.status }, { tenantId, email: "user2@example.com", roleName: "reviewer", status: "pending" });
  assert.equal(typeof outcome.created[0]?.token, "string");
  const second = outcome.created[1]?.invitation as { email: string; roleName: string };
  assert.equal(second.email, "other@example.com", "emails are trimmed and lower-cased");
  assert.equal(second.roleName, "accountadmin", "the legacy workspace_admin role is canonicalised");

  const inserts = db.statements.filter((statement) => statement.sql.includes("insert into corvis_control.tenant_invitation"));
  assert.equal(inserts.length, 2);
  for (const insert of inserts) {
    assert.equal(insert.parameters[1], tenantId);
    assert.equal(insert.parameters[2], workspaceId);
    assert.equal(insert.parameters[6], "admin@example.com");
  }
  assert.deepEqual(db.audits().map((audit) => audit.action), ["tenant_invitation.issued", "tenant_invitation.issued"]);
  assert.deepEqual(db.audits().map((audit) => audit.parameters[9]), ["bulk-1:2", "bulk-1:3"], "each row audits under its own correlation id");
  assert.equal(db.statements.filter((statement) => statement.sql.includes("insert into corvis_control.email_outbox")).length, 2, "an undelivered invitation leaves a suppressed outbox record");
});

test("bulk invitations fall back to running directly when the transport has no transaction support", async () => {
  const db = new ScriptedDb([activeWorkspace]);
  const outcome = await createBulkInvitations(admin, [csvRow(2)], { confirmTenantAdmin: false, correlationId: "bulk-2", db });
  assert.equal(outcome.created.length, 1);
  assert.equal(db.audits().length, 1);
});

test("bulk invitations never confirm tenant_admin implicitly and reject invalid rows without touching the database", async () => {
  const db = new TransactionalDb([activeWorkspace]);
  const rows = [
    csvRow(2, { roleName: "tenant_admin" }),
    csvRow(3, { email: "not-an-email" }),
    csvRow(4, { workspaceId: "not-a-uuid" }),
    csvRow(5, { reason: "x" }),
    csvRow(6, { roleName: "owner" as BulkInviteRow["roleName"] }),
  ];
  const outcome = await createBulkInvitations(admin, rows, { confirmTenantAdmin: false, correlationId: "bulk-3", db });
  assert.deepEqual(outcome.errors, [
    { row: 2, error: "tenant_admin_confirmation_required" },
    { row: 3, error: "invalid_invitation" },
    { row: 4, error: "invalid_invitation" },
    { row: 5, error: "invalid_invitation" },
    { row: 6, error: "invalid_invitation" },
  ]);
  assert.deepEqual(outcome.created, []);
  assert.equal(db.statements.length, 0);
  assert.deepEqual(db.outcomes, []);

  // A non-boolean confirmation is not accepted as an explicit confirmation either.
  const loose = await createBulkInvitations(admin, [csvRow(2, { roleName: "tenant_admin" })], { confirmTenantAdmin: "yes" as unknown as boolean, correlationId: "bulk-3b", db });
  assert.deepEqual(loose.errors, [{ row: 2, error: "tenant_admin_confirmation_required" }]);
});

test("bulk invitations grant tenant_admin only with explicit confirmation from a tenant administrator", async (t) => {
  const db = new TransactionalDb([activeWorkspace]);
  const confirmed = await createBulkInvitations(admin, [csvRow(2, { roleName: "tenant_admin" })], { confirmTenantAdmin: true, correlationId: "bulk-4", db });
  assert.deepEqual(confirmed.errors, []);
  assert.equal((confirmed.created[0]?.invitation as { roleName: string }).roleName, "tenant_admin");
  assert.equal(db.audits()[0]?.action, "tenant_invitation.issued");

  // Confirmation does not substitute for authority: a non-admin's row is refused per row, with a stable code.
  const refused = new TransactionalDb([activeWorkspace]);
  const lines = silenceConsole(t);
  const asMember = await createBulkInvitations(member, [csvRow(2)], { confirmTenantAdmin: true, correlationId: "bulk-5", db: refused });
  assert.deepEqual(asMember.created, []);
  assert.deepEqual(refused.outcomes, ["rollback"]);
  assert.equal(refused.audits().length, 0);
  assert.equal(asMember.errors.length, 1);
  assert.equal(asMember.errors[0]?.error, "invitation_failed", "an authorization failure is reported only as a generic code");
  assert.equal(lines.length, 1, "the unexpected failure is logged once");
});

test("bulk invitations report stable codes per row: workspace missing, already pending, and unexpected failures without leaking details", async (t) => {
  const lines = silenceConsole(t);
  const unique = Object.assign(new Error("duplicate key value violates unique constraint \"ux_pending\" (email=secret@example.com)"), { code: "23505" });
  const db = new TransactionalDb([activeWorkspace]);
  db.executeHandlers.push({ match: /insert into corvis_control\.tenant_invitation/, error: unique });
  const conflict = await createBulkInvitations(admin, [csvRow(2)], { confirmTenantAdmin: false, correlationId: "bulk-6", db });
  assert.deepEqual(conflict.errors, [{ row: 2, error: new ConflictError("invitation_already_pending").code }]);
  assert.deepEqual(db.outcomes, ["rollback"]);

  const missingWorkspace = new TransactionalDb();
  const missing = await createBulkInvitations(admin, [csvRow(2)], { confirmTenantAdmin: false, correlationId: "bulk-7", db: missingWorkspace });
  assert.deepEqual(missing.errors, [{ row: 2, error: "workspace_not_found" }]);
  assert.equal(lines.length, 0, "expected failures are not logged as errors");

  const failing = new TransactionalDb([activeWorkspace]);
  failing.executeHandlers.push({ match: /insert into corvis_control\.tenant_invitation/, error: new Error("connection to 10.0.0.5 refused") });
  const unexpected = await createBulkInvitations(admin, [csvRow(2), csvRow(3)], { confirmTenantAdmin: false, correlationId: "bulk-8", db: failing });
  assert.deepEqual(unexpected.errors, [{ row: 2, error: "invitation_failed" }, { row: 3, error: "invitation_failed" }]);
  assert.equal(JSON.stringify(unexpected).includes("10.0.0.5"), false, "the raw error message is never returned");
  assert.equal(lines.length, 2);
  const logged = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(logged.event, "tenant_admin.bulk_invitation_failed");
  assert.equal(logged.correlationId, "bulk-8");
  assert.equal(logged.row, 2);
  assert.equal(logged.errorName, "Error");
  assert.ok(!lines.join("").includes("10.0.0.5"), "the log carries the error name only");

  // A thrown non-Error is logged by its type, still without detail.
  const throwsString = new TransactionalDb([activeWorkspace]);
  throwsString.executeHandlers.push({ match: /insert into corvis_control\.tenant_invitation/, error: "boom" });
  const odd = await createBulkInvitations(admin, [csvRow(9)], { confirmTenantAdmin: false, correlationId: "bulk-9", db: throwsString });
  assert.deepEqual(odd.errors, [{ row: 9, error: "invitation_failed" }]);
  assert.equal((JSON.parse(lines[2] ?? "{}") as Record<string, unknown>).errorName, "string");
});
