import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { createBulkInvitations, type BulkInviteRow } from "./tenant-admin-self-service.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const identity = {
  subject: "admin", tenantId, workspaceId, roles: ["admin"], isTenantAdmin: true,
  entitlements: { workspaceIds: [workspaceId] }, authMethod: "oidc", sessionId: "s",
} as unknown as RequestIdentity;

class FailingDb implements PostgresSqlApi {
  queries = 0;
  async query(): Promise<PostgresRow[]> {
    this.queries += 1;
    throw new Error("duplicate key value violates unique constraint (email)=(victim@example.com)");
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

const row = (n: number, roleName: string): BulkInviteRow => ({ row: n, name: "", email: `user${n}@example.com`, roleName, workspaceId, reason: "Bulk onboarding" });

test("CSV tenant_admin rows are not implicitly confirmed", async () => {
  const db = new FailingDb();
  const outcome = await createBulkInvitations(identity, [row(2, "tenant_admin")], { confirmTenantAdmin: false, correlationId: "c", db });
  assert.deepEqual(outcome.errors, [{ row: 2, error: "tenant_admin_confirmation_required" }]);
  assert.equal(outcome.created.length, 0);
  assert.equal(db.queries, 0, "an unconfirmed tenant_admin invitation must never reach the database");
});

test("an explicit confirmation lets tenant_admin rows proceed to creation", async () => {
  const db = new FailingDb();
  await createBulkInvitations(identity, [row(2, "tenant_admin")], { confirmTenantAdmin: true, correlationId: "c", db });
  assert.ok(db.queries > 0);
});

test("per-row failures return a stable code, never the raw error message", async () => {
  const db = new FailingDb();
  const outcome = await createBulkInvitations(identity, [row(2, "viewer"), row(3, "reviewer")], { confirmTenantAdmin: false, correlationId: "c", db });
  assert.deepEqual(outcome.errors, [{ row: 2, error: "invitation_failed" }, { row: 3, error: "invitation_failed" }]);
  assert.ok(!JSON.stringify(outcome).includes("victim@example.com"));
});

test("a row whose invitation is already pending reports its conflict code, not invitation_failed", async () => {
  const uniqueViolation = Object.assign(new Error("duplicate key"), { code: "23505" });
  const db: PostgresSqlApi = {
    async query(): Promise<PostgresRow[]> { return [{ display_name: "Primary" }]; },
    async execute(sql: string): Promise<void> {
      if (/insert into corvis_control\.tenant_invitation/i.test(sql)) throw uniqueViolation;
    },
    async health(): Promise<boolean> { return true; },
  };
  const outcome = await createBulkInvitations(identity, [row(2, "viewer")], { confirmTenantAdmin: false, correlationId: "c", db });
  assert.deepEqual(outcome.errors, [{ row: 2, error: "invitation_already_pending" }]);
});
