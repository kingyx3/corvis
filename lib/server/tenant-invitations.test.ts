import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { AuthorizationError } from "../../core/enterprise.ts";
import { ConflictError } from "./platform.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { acceptTenantInvitation, assertInvitationIssuer, createTenantInvitation, normalizeTenantInvitation } from "./tenant-invitations.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT = "33333333-3333-4333-8333-333333333333";
const identity: RequestIdentity = {
  subject: "oidc|admin", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["admin"],
  entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: false },
  authMethod: "oidc", sessionId: "session-1", isTenantAdmin: true,
};

class FakeDb implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  readonly executions: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  private readonly acceptance?: PostgresRow | Error;
  private readonly failInsert?: unknown;
  constructor(acceptance?: PostgresRow | Error, failInsert?: unknown) { this.acceptance = acceptance; this.failInsert = failInsert; }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    if (sql.includes("from corvis_control.workspace w")) return [{ display_name: "Primary Workspace" }];
    if (sql.includes("accept_tenant_invitation")) {
      if (this.acceptance instanceof Error) throw this.acceptance;
      return this.acceptance ? [this.acceptance] : [];
    }
    return [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.executions.push({ sql, parameters });
    if (sql.includes("insert into corvis_control.tenant_invitation") && this.failInsert) throw this.failInsert;
  }
  async health(): Promise<boolean> { return true; }
}

const command = {
  tenantId: TENANT, workspaceId: WORKSPACE, email: " First.Admin@Example.Test ",
  roleName: "tenant_admin", reason: "Approved organization onboarding", confirmTenantAdmin: true,
} as const;

test("invitation normalization lowercases addresses and requires explicit organization-admin confirmation", () => {
  assert.deepEqual(normalizeTenantInvitation(command), {
    tenantId: TENANT, workspaceId: WORKSPACE, email: "first.admin@example.test",
    roleName: "tenant_admin", reason: command.reason, confirmTenantAdmin: true,
  });
  assert.equal(normalizeTenantInvitation({ ...command, confirmTenantAdmin: false }), undefined);
  assert.equal(normalizeTenantInvitation({ ...command, email: "not-an-email" }), undefined);
  assert.equal(normalizeTenantInvitation({ ...command, reason: "  " }), undefined);
});

test("only the target tenant admin or configured Corvis operations admin can issue an invitation", () => {
  assert.doesNotThrow(() => assertInvitationIssuer(identity, { ...command, tenantId: TENANT }));
  const prior = process.env.CORVIS_OPERATIONS_TENANT_ID;
  try {
    process.env.CORVIS_OPERATIONS_TENANT_ID = TENANT;
    assert.doesNotThrow(() => assertInvitationIssuer(identity, { ...command, tenantId: OTHER_TENANT }));
    process.env.CORVIS_OPERATIONS_TENANT_ID = OTHER_TENANT;
    assert.throws(() => assertInvitationIssuer(identity, { ...command, tenantId: OTHER_TENANT }), AuthorizationError);
  } finally {
    if (prior === undefined) delete process.env.CORVIS_OPERATIONS_TENANT_ID;
    else process.env.CORVIS_OPERATIONS_TENANT_ID = prior;
  }
});

test("invitation creation stores a hash, returns the one-time token once and writes its audit receipt", async () => {
  const db = new FakeDb();
  const normalized = normalizeTenantInvitation(command)!;
  const created = await createTenantInvitation(identity, normalized, "corr-1", db);
  assert.match(created.token, /^[A-Za-z0-9_-]{40,60}$/);
  assert.equal(created.invitation.email, "first.admin@example.test");
  assert.equal(created.invitation.roleName, "tenant_admin");
  assert.equal(Date.parse(created.invitation.expiresAt) - Date.now() > 6 * 24 * 60 * 60 * 1000, true);
  const inserted = db.executions.find((item) => item.sql.includes("insert into corvis_control.tenant_invitation"));
  assert.ok(inserted);
  assert.notEqual(inserted.parameters[5], created.token);
  assert.match(String(inserted.parameters[5]), /^[0-9a-f]{64}$/);
  const audit = db.executions.find((item) => item.sql.includes("insert into corvis_control.audit_event"));
  assert.ok(audit, "issue must leave an audit event");
  assert.equal(audit.parameters[5], "tenant_invitation.issued");
});

test("a duplicate pending invitation is reported as a conflict", async () => {
  const db = new FakeDb(undefined, { code: "23505" });
  await assert.rejects(createTenantInvitation(identity, normalizeTenantInvitation(command)!, "corr-2", db),
    (error: unknown) => error instanceof ConflictError && error.code === "invitation_already_pending");
});

test("acceptance requires verified matching email and sends only a token hash to the database", async () => {
  const token = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";
  await assert.rejects(acceptTenantInvitation(token, "oidc", "idp|user", "first.admin@example.test", false, "corr-3", new FakeDb()),
    (error: unknown) => error instanceof Error && error.message === "verified_email_required");
  const accepted = { invitation_id: "inv-1", tenant_id: TENANT, workspace_id: WORKSPACE, user_id: "user-1", role_name: "tenant_admin" };
  const db = new FakeDb(accepted);
  assert.deepEqual(await acceptTenantInvitation(token, "oidc", "idp|user", "FIRST.ADMIN@example.test", true, "corr-4", db), {
    invitationId: "inv-1", tenantId: TENANT, workspaceId: WORKSPACE, userId: "user-1", roleName: "tenant_admin",
  });
  assert.notEqual(db.queries[0]?.parameters[0], token);
  assert.equal(db.queries[0]?.parameters[3], "first.admin@example.test");
  assert.equal(db.queries[0]?.parameters[4], true);
});

test("acceptance maps expired, reused, disabled and mismatched invitations to safe errors", async () => {
  const token = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";
  for (const [message, status] of [
    ["invitation_expired", 410], ["invitation_not_pending", 409],
    ["invitation_identity_disabled", 409], ["invitation_email_mismatch", 403],
  ] as const) {
    await assert.rejects(acceptTenantInvitation(token, "oidc", "idp|user", "first.admin@example.test", true, "corr-5", new FakeDb(new Error(message))),
      (error: unknown) => (error as { code?: string; status?: number }).code === message && (error as { status?: number }).status === status);
  }
});

test("invitation migration stores only a digest and atomically links identity, membership, state and audit", async () => {
  const sql = (await readFile("db/postgres/migrations/056_tenant_invitations.sql", "utf8")).toLowerCase();
  assert.match(sql, /token_sha256 text not null unique/);
  assert.match(sql, /alter table corvis_control\.tenant_invitation enable row level security/);
  assert.match(sql, /alter table corvis_control\.tenant_invitation force row level security/);
  assert.doesNotMatch(sql, /create policy[^;]+tenant_invitation/);
  const fn = /create or replace function corvis_control\.accept_tenant_invitation[\s\S]*?\$\$;/i.exec(sql)?.[0] ?? "";
  assert.match(fn, /for update/);
  assert.match(fn, /p_email_verified is distinct from true/);
  assert.match(fn, /lower\(btrim\(p_email\)\) <> v_invitation\.email/);
  assert.match(fn, /insert into corvis_control\.identity_subject/);
  assert.match(fn, /insert into corvis_control\.membership/);
  assert.match(fn, /update corvis_control\.tenant_invitation/);
  assert.match(fn, /insert into corvis_control\.audit_event/);
  assert.match(sql, /revoke all on function corvis_control\.accept_tenant_invitation[^;]+from public/);
});
