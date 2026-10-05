import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { guardIdentityLifecycleCommand } from "./identity-lifecycle.ts";
import type { PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { TenantInvitationError } from "./tenant-invitations.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const actorUser = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherAdmin = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const member = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const identity = {
  subject: "actor-subject", tenantId, workspaceId, roles: ["admin"], isTenantAdmin: true,
  entitlements: { workspaceIds: [workspaceId] }, authMethod: "oidc", sessionId: "s",
} as unknown as RequestIdentity;

class GuardDb implements PostgresSqlApi {
  sql: string[] = [];
  private readonly admins: string[];
  constructor(admins: string[]) { this.admins = admins; }
  async query(sql: string): Promise<PostgresRow[]> {
    this.sql.push(sql);
    if (sql.includes("for update")) return [{ tenant_id: tenantId }];
    if (sql.includes("from corvis_control.identity_subject\n")) return [{ user_id: actorUser }];
    if (sql.includes("role_name='tenant_admin'")) return this.admins.map((user_id) => ({ user_id }));
    return [];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

const base = { authMethod: "oidc" as const, subject: "someone", memberships: [] as never[] };
const code = (expected: string) => (error: unknown) => error instanceof TenantInvitationError && error.code === expected && error.status === 409;

test("an administrator cannot disable their own identity through the lifecycle endpoint", async () => {
  const db = new GuardDb([actorUser, otherAdmin]);
  await assert.rejects(guardIdentityLifecycleCommand(identity, { ...base, operation: "disable", userId: actorUser }, db), code("cannot_deactivate_current_user"));
  // An upper-case spelling of the same uuid is the same user.
  await assert.rejects(guardIdentityLifecycleCommand(identity, { ...base, operation: "disable", userId: actorUser.toUpperCase() }, db), code("cannot_deactivate_current_user"));
  // The same subject on a different user id is still the actor.
  await assert.rejects(guardIdentityLifecycleCommand(identity, { ...base, operation: "disable", userId: member, subject: "actor-subject" }, db), code("cannot_deactivate_current_user"));
});

test("an administrator cannot strip their own tenant_admin role by syncing", async () => {
  const db = new GuardDb([actorUser, otherAdmin]);
  await assert.rejects(guardIdentityLifecycleCommand(identity, { ...base, operation: "sync", userId: actorUser, memberships: [{ workspaceId, roleName: "viewer" }] }, db), code("cannot_change_current_user"));
});

test("the last active tenant administrator cannot be disabled or demoted", async () => {
  const db = new GuardDb([otherAdmin]);
  await assert.rejects(guardIdentityLifecycleCommand(identity, { ...base, operation: "disable", userId: otherAdmin }, db), code("last_tenant_admin"));
  await assert.rejects(guardIdentityLifecycleCommand(identity, { ...base, operation: "sync", userId: otherAdmin, memberships: [{ workspaceId, roleName: "reviewer" }] }, db), code("last_tenant_admin"));
  await assert.rejects(guardIdentityLifecycleCommand(identity, { ...base, operation: "disable", userId: otherAdmin.toUpperCase() }, db), code("last_tenant_admin"));
});

test("disabling one of several tenant administrators or an ordinary member is allowed", async () => {
  await guardIdentityLifecycleCommand(identity, { ...base, operation: "disable", userId: otherAdmin }, new GuardDb([actorUser, otherAdmin]));
  await guardIdentityLifecycleCommand(identity, { ...base, operation: "disable", userId: member }, new GuardDb([otherAdmin]));
});

test("a sync that keeps tenant_admin is not guarded and takes no locks", async () => {
  const db = new GuardDb([otherAdmin]);
  await guardIdentityLifecycleCommand(identity, { ...base, operation: "sync", userId: otherAdmin, memberships: [{ workspaceId, roleName: "tenant_admin" }] }, db);
  await guardIdentityLifecycleCommand(identity, { ...base, operation: "sync", userId: actorUser, memberships: [{ workspaceId, roleName: "tenant_admin" }] }, db);
  assert.deepEqual(db.sql, []);
});

test("the guard serializes on the tenant row before reading the admin set", async () => {
  const db = new GuardDb([actorUser, otherAdmin]);
  await guardIdentityLifecycleCommand(identity, { ...base, operation: "disable", userId: member }, db);
  assert.match(db.sql[0]!, /from corvis_control\.tenant where tenant_id=\$1::uuid for update/);
});
