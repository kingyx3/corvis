import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, type RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { PostgresDriverError } from "../../../../platform/database/postgres-native.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { acceptTenantInvitation, assertInvitationIssuer, listTenantInvitations, TenantInvitationError } from "./tenant-invitations.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const TOKEN = "A".repeat(43);

const identity = (overrides: Partial<RequestIdentity> = {}) => ({
  subject: "admin", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["admin"], isTenantAdmin: true, authMethod: "oidc", sessionId: "s", entitlements: { workspaceIds: [] }, ...overrides,
}) as RequestIdentity;
const command = (tenantId: string) => ({ tenantId, workspaceId: WORKSPACE, email: "a@b.test", roleName: "viewer", reason: "Onboarding", confirmTenantAdmin: false }) as never;

class ScriptedDb implements PostgresSqlApi {
  readonly calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  private readonly answer: () => PostgresRow[];
  constructor(answer: () => PostgresRow[] = () => []) { this.answer = answer; }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> { this.calls.push({ sql, parameters }); return this.answer(); }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

async function withOperationsTenant<T>(value: string | undefined, run: () => T | Promise<T>): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.CORVIS_OPERATIONS_TENANT_ID;
  try {
    if (value === undefined) delete env.CORVIS_OPERATIONS_TENANT_ID; else env.CORVIS_OPERATIONS_TENANT_ID = value;
    return await run();
  } finally {
    if (previous === undefined) delete env.CORVIS_OPERATIONS_TENANT_ID; else env.CORVIS_OPERATIONS_TENANT_ID = previous;
  }
}

test("who may issue an invitation: an Organization Admin for their own tenant, or an admin of the operations tenant", async () => {
  await withOperationsTenant(undefined, () => {
    assert.doesNotThrow(() => assertInvitationIssuer(identity(), command(TENANT)));
    assert.throws(() => assertInvitationIssuer(identity(), command(OTHER)), AuthorizationError, "another tenant, and no operations tenant is configured");
    assert.throws(() => assertInvitationIssuer(identity({ isTenantAdmin: false }), command(TENANT)), AuthorizationError);
  });
  await withOperationsTenant(OTHER, () => {
    assert.throws(() => assertInvitationIssuer(identity(), command(OTHER)), AuthorizationError, "an admin of another tenant is not the operations tenant");
    assert.doesNotThrow(() => assertInvitationIssuer(identity({ tenantId: OTHER }), command(TENANT)));
    assert.throws(() => assertInvitationIssuer(identity({ tenantId: OTHER, isTenantAdmin: false, roles: ["analyst"] }), command(TENANT)), AuthorizationError, "operations tenant without an admin role");
  });
});

test("the invitation list is for Organization Admins and reads only their tenant", async () => {
  await assert.rejects(listTenantInvitations(identity({ isTenantAdmin: false }), new ScriptedDb()), AuthorizationError);
  const db = new ScriptedDb(() => [
    { invitation_id: "i-1", tenant_id: TENANT, workspace_id: WORKSPACE, workspace_name: "Primary", email: "a@b.test", role_name: "viewer", status: "pending", created_at: "2026-10-01", expires_at: "2026-10-08" },
    { invitation_id: "i-2", tenant_id: TENANT, workspace_id: WORKSPACE, workspace_name: null, email: "c@d.test", role_name: "analyst", status: "expired", created_at: null, expires_at: null },
  ]);
  const list = await listTenantInvitations(identity(), db);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT]);
  assert.deepEqual(list.map((item) => [item.invitationId, item.workspaceName, item.status, item.createdAt]), [["i-1", "Primary", "pending", "2026-10-01"], ["i-2", "", "expired", ""]]);
});

test("accepting an invitation needs a well-formed token, a bounded subject and a verified address", async () => {
  const db = new ScriptedDb();
  const refused = (token: string, subject: string, email: string | undefined, verified: boolean | undefined, code: string, status: number) =>
    assert.rejects(acceptTenantInvitation(token, "oidc", subject, email, verified, "corr", db), (e) => e instanceof TenantInvitationError && e.code === code && e.status === status);
  await refused(TOKEN, "sub", undefined, true, "verified_email_required", 403);
  await refused(TOKEN, "sub", "a@b.test", false, "verified_email_required", 403);
  await refused(TOKEN, "sub", "a@b.test", undefined, "verified_email_required", 403);
  await refused("short", "sub", "a@b.test", true, "invitation_not_found", 404);
  await refused(TOKEN, "", "a@b.test", true, "invitation_not_found", 404);
  await refused(TOKEN, "s".repeat(1025), "a@b.test", true, "invitation_not_found", 404);
  await refused(TOKEN, "sub", "not-an-email", true, "invitation_not_found", 404);
  assert.equal(db.calls.length, 0, "nothing is queried for a request that can never be valid");
});

test("an accepted invitation is returned, an unknown one is a 404, and the SQL refusals keep their own status", async () => {
  const accepted = await acceptTenantInvitation(TOKEN, "oidc", "sub", "A@B.Test", true, "corr", new ScriptedDb(() => [
    { invitation_id: "i-1", tenant_id: TENANT, workspace_id: WORKSPACE, user_id: "u-1", role_name: "viewer" },
  ]));
  assert.deepEqual(accepted, { invitationId: "i-1", tenantId: TENANT, workspaceId: WORKSPACE, userId: "u-1", roleName: "viewer" });
  await assert.rejects(acceptTenantInvitation(TOKEN, "oidc", "sub", "a@b.test", true, "corr", new ScriptedDb()), (e) => e instanceof TenantInvitationError && e.status === 404);
  for (const [fragment, code, status] of [
    ["invitation_not_found", "invitation_not_found", 404],
    ["invitation_not_pending", "invitation_not_pending", 409],
    ["invitation_expired", "invitation_expired", 410],
    ["invitation_identity_disabled", "invitation_identity_disabled", 409],
    ["invitation_membership_exists", "invitation_membership_exists", 409],
    ["invitation_email_mismatch", "invitation_email_mismatch", 403],
    ["invalid_invitation_identity", "verified_email_required", 403],
  ] as const) {
    const failing: PostgresSqlApi = { async query() { throw new PostgresDriverError("query", "P0001", fragment); }, async execute() {}, async health() { return true; } };
    await assert.rejects(acceptTenantInvitation(TOKEN, "saml", "sub", "a@b.test", true, "corr", failing), (e) => e instanceof TenantInvitationError && e.code === code && e.status === status, fragment);
  }
  const broken: PostgresSqlApi = { async query() { throw new Error("database exploded"); }, async execute() {}, async health() { return true; } };
  await assert.rejects(acceptTenantInvitation(TOKEN, "oidc", "sub", "a@b.test", true, "corr", broken), /database exploded/);
});
