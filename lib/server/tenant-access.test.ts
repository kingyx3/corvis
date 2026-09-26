import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { IdentityLifecycleCommand, IdentityLifecycleRepository, IdentityLifecycleResult } from "./identity-lifecycle.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { deactivateTenantAccessMember, listTenantAccessMembers, TenantAccessError } from "./tenant-access.ts";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTOR_USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TARGET_USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const identity: RequestIdentity = {
  subject: "oidc|admin",
  tenantId: TENANT,
  workspaceId: WORKSPACE,
  roles: ["admin"],
  entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: false },
  authMethod: "oidc",
  sessionId: "session-admin",
  isTenantAdmin: true,
};

class FakeDb implements PostgresSqlApi {
  readonly calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (sql.includes("from corvis_control.identity_subject") && sql.includes("order by user_id,auth_method,subject")) {
      return [
        { user_id: ACTOR_USER, auth_method: "oidc", subject: identity.subject },
        { user_id: TARGET_USER, auth_method: "oidc", subject: "oidc|departing-user" },
      ];
    }
    if (sql.includes("from corvis_control.membership m")) {
      return [
        { user_id: TARGET_USER, workspace_id: WORKSPACE, workspace_name: "Primary", role_name: "analyst" },
        { user_id: TARGET_USER, workspace_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", workspace_name: "Secondary", role_name: "viewer" },
      ];
    }
    if (sql.includes("from corvis_control.resource_entitlement e")) {
      return [
        { user_id: TARGET_USER, workspace_id: WORKSPACE, workspace_name: "Primary", resource_type: "fund", resource_id: "fund-1", permission: "read" },
      ];
    }
    if (sql.includes("and user_id=$2::uuid")) {
      return [{ user_id: TARGET_USER, auth_method: "oidc", subject: "oidc|departing-user" }];
    }
    if (sql.includes("and auth_method=$2 and subject=$3")) {
      return [{ user_id: ACTOR_USER }];
    }
    return [];
  }

  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

class FakeLifecycle implements IdentityLifecycleRepository {
  command?: IdentityLifecycleCommand;

  async apply(command: IdentityLifecycleCommand): Promise<IdentityLifecycleResult> {
    this.command = command;
    return {
      eventKey: command.eventKey,
      operation: command.operation,
      subject: command.subject,
      userId: command.userId,
      activeMemberships: 0,
      revokedMemberships: 2,
      expiredEntitlements: 1,
      disabledSubjects: 1,
      disabledServiceGrants: 0,
    };
  }
}

test("tenant access inventory shows the exact memberships and entitlements that offboarding will revoke", async () => {
  const db = new FakeDb();
  const members = await listTenantAccessMembers(identity, db);
  const actor = members.find((member) => member.userId === ACTOR_USER);
  const target = members.find((member) => member.userId === TARGET_USER);

  assert.equal(actor?.isCurrentUser, true);
  assert.equal(target?.isCurrentUser, false);
  assert.deepEqual(target?.memberships.map((entry) => [entry.workspaceName, entry.roleName]), [
    ["Primary", "analyst"],
    ["Secondary", "viewer"],
  ]);
  assert.deepEqual(target?.entitlements.map((entry) => [entry.workspaceName, entry.resourceType, entry.resourceId, entry.permission]), [
    ["Primary", "fund", "fund-1", "read"],
  ]);
  assert.ok(db.calls.every((call) => call.parameters[0] === TENANT), "every access-inventory query must remain tenant-scoped");
});

test("deactivate everywhere delegates once to the existing atomic disable lifecycle command", async () => {
  const db = new FakeDb();
  const lifecycle = new FakeLifecycle();
  const result = await deactivateTenantAccessMember(identity, TARGET_USER, "Employment ended", "correlation-1", {
    db,
    lifecycle,
    eventKey: "offboard-target-1",
  });

  assert.equal(result.revokedMemberships, 2);
  assert.deepEqual(lifecycle.command, {
    tenantId: TENANT,
    eventKey: "offboard-target-1",
    actorSubject: identity.subject,
    actorWorkspaceId: WORKSPACE,
    correlationId: "correlation-1",
    operation: "disable",
    authMethod: "oidc",
    subject: "oidc|departing-user",
    userId: TARGET_USER,
    memberships: [],
    reason: "Employment ended",
  });
});

test("deactivate everywhere refuses to deactivate the current tenant-admin session", async () => {
  class SelfDb extends FakeDb {
    override async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
      if (sql.includes("and user_id=$2::uuid")) return [{ user_id: ACTOR_USER, auth_method: "oidc", subject: identity.subject }];
      if (sql.includes("and auth_method=$2 and subject=$3")) return [{ user_id: ACTOR_USER }];
      return super.query(sql, parameters);
    }
  }
  const lifecycle = new FakeLifecycle();
  await assert.rejects(
    () => deactivateTenantAccessMember(identity, ACTOR_USER, "Self offboarding", "correlation-2", { db: new SelfDb(), lifecycle }),
    (error: unknown) => error instanceof TenantAccessError && error.code === "cannot_deactivate_current_user" && error.status === 409,
  );
  assert.equal(lifecycle.command, undefined);
});

// The transactional fake records committed effects, so an audit failure must
// leave neither a role change nor expired resource entitlements behind.
class RoleDb extends FakeDb {
  committed: string[] = [];
  pending: string[] = [];
  failAudit = false;
  actor = ACTOR_USER;
  targetExists = true;
  currentRole = "analyst";
  actorAllowed = true;
  override async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (sql.includes("join corvis_control.membership m")) return this.actorAllowed ? [{ user_id: this.actor }] : [];
    if (sql.includes("from corvis_control.identity_subject")) return this.targetExists ? [{ user_id: TARGET_USER }] : [];
    if (sql.includes("from corvis_control.membership")) return [{ role_name: this.currentRole, valid_until: "2027-01-01T00:00:00Z" }];
    return [];
  }
  override async execute(sql?: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.calls.push({ sql: sql!, parameters });
    if (this.failAudit && sql?.includes("audit_event")) throw new Error("audit unavailable");
    this.pending.push(sql!);
  }
  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    this.pending = [];
    try { const result = await fn(this); this.committed.push(...this.pending); return result; }
    finally { this.pending = []; }
  }
}

const { changeTenantMemberRole } = await import("./tenant-access.ts");
const roleCommand = { userId: TARGET_USER, workspaceId: WORKSPACE, expectedRole: "analyst", roleName: "viewer", reason: "Changed responsibilities", confirmTenantAdmin: false };

test("role change preserves expiry and unrelated workspace access, with one audit receipt", async () => {
  const db = new RoleDb();
  const result = await changeTenantMemberRole(identity, roleCommand, "role-test", db);
  assert.equal(result.roleName, "viewer");
  assert.equal(db.committed.length, 3);
  assert.ok(db.calls.every((call) => call.parameters[0] === TENANT));
  const insert = db.calls.find((call) => call.sql.includes("insert into corvis_control.membership"))!;
  assert.deepEqual(insert.parameters, [TENANT, TARGET_USER, WORKSPACE, "viewer", "2027-01-01T00:00:00Z"]);
  assert.ok(db.committed.at(-1)?.includes("audit_event"));
});

test("removing the last workspace role expires only that workspace's entitlements", async () => {
  const db = new RoleDb();
  await changeTenantMemberRole(identity, { ...roleCommand, roleName: null }, "revoke-test", db);
  const expire = db.calls.find((call) => call.sql.includes("update corvis_control.resource_entitlement"))!;
  assert.deepEqual(expire.parameters, [TENANT, TARGET_USER, WORKSPACE]);
  assert.equal(db.committed.some((sql) => sql.includes("insert into corvis_control.membership")), false);
});

test("failed audit rolls back the whole member change", async () => {
  const db = new RoleDb(); db.failAudit = true;
  await assert.rejects(changeTenantMemberRole(identity, roleCommand, "audit-test", db), /audit unavailable/);
  assert.deepEqual(db.committed, []);
});

test("member edits reject self changes, stale selections, missing tenant members and revoked admin authority", async () => {
  for (const [configure, code] of [
    [(db: RoleDb) => { db.actor = TARGET_USER; }, "cannot_change_current_user"],
    [(db: RoleDb) => { db.currentRole = "reviewer"; }, "membership_changed_refresh_required"],
    [(db: RoleDb) => { db.targetExists = false; }, "member_not_found"],
    [(db: RoleDb) => { db.actorAllowed = false; }, "tenant_admin_required"],
  ] as const) {
    const db = new RoleDb(); configure(db);
    await assert.rejects(changeTenantMemberRole(identity, roleCommand, "negative-test", db), new RegExp(code));
    assert.deepEqual(db.committed, []);
  }
});

test("role changes fail closed for privilege grants, invalid roles, workspace admins and nontransactional transports", async () => {
  await assert.rejects(changeTenantMemberRole(identity, { ...roleCommand, roleName: "tenant_admin" }, "test", new RoleDb()), /confirmation_required/);
  await assert.rejects(changeTenantMemberRole(identity, { ...roleCommand, roleName: "superuser" }, "test", new RoleDb()), /invalid_request/);
  await assert.rejects(changeTenantMemberRole({ ...identity, isTenantAdmin: false }, roleCommand, "test", new RoleDb()), /tenant_admin_required/);
  await assert.rejects(changeTenantMemberRole(identity, roleCommand, "test", new FakeDb()), /transaction_required/);
});
