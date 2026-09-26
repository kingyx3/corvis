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
