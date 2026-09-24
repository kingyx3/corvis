import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("resource entitlement and data-right admin commands are tenant scoped, effective dated and audit atomic", async () => {
  const sql = (await read("db/postgres/migrations/040_admin_access_policy.sql")).toLowerCase();
  assert.match(sql, /apply_resource_entitlement_admin/);
  assert.match(sql, /where tenant_id=p_tenant_id/);
  assert.match(sql, /valid_from/);
  assert.match(sql, /valid_until/);
  assert.match(sql, /apply_data_right_admin/);
  assert.match(sql, /effective_from/);
  assert.match(sql, /effective_to/);
  assert.match(sql, /insert into corvis_control\.audit_event/);
  assert.match(sql, /access\.resource_entitlement\.'\|\|p_operation/);
  assert.match(sql, /access\.data_right\.'\|\|p_operation/);

  const route = await read("app/api/v1/admin/access-policy/route.ts");
  assert.match(route, /resolveAuthorizedRequestIdentity\(request\)/);
  assert.match(route, /assertPermission\(identity, "admin:manage"\)/);
  assert.match(route, /identity\.tenantId/);
  assert.match(route, /apply_resource_entitlement_admin/);
  assert.match(route, /apply_data_right_admin/);
});

test("disabled human identities require an explicit separately audited reactivation", async () => {
  const ordinary = (await read("db/postgres/migrations/011_identity_lifecycle_sync.sql")).toLowerCase();
  const privileged = (await read("db/postgres/migrations/041_reactivation_support_access.sql")).toLowerCase();
  const route = await read("app/api/v1/admin/identity-lifecycle/route.ts");

  assert.match(ordinary, /disabled identity requires explicit reactivation/);
  assert.match(privileged, /reactivate_identity_admin/);
  assert.match(privileged, /v_status<>'disabled'/);
  assert.match(privileged, /identity\.lifecycle\.reactivate/);
  assert.match(privileged, /apply_identity_lifecycle/);
  assert.match(route, /value === "reactivate"/);
  assert.match(route, /reactivate_identity_admin/);
});

test("support access is approval based, time bounded, audited and does not manufacture resource rights", async () => {
  const sql = (await read("db/postgres/migrations/041_reactivation_support_access.sql")).toLowerCase();
  assert.match(sql, /create table if not exists corvis_control\.support_access_grant/);
  assert.match(sql, /purpose text not null/);
  assert.match(sql, /approval_reference text not null/);
  assert.match(sql, /check \(valid_until > valid_from\)/);
  assert.match(sql, /support access requires a future expiry/);
  assert.match(sql, /requested support role is already active outside this grant/);
  assert.match(sql, /access\.support\.'\|\|p_operation/);
  assert.doesNotMatch(sql, /insert into corvis_control\.resource_entitlement/);
  assert.doesNotMatch(sql, /insert into corvis_control\.data_rights/);

  const route = await read("app/api/v1/admin/support-access/route.ts");
  assert.match(route, /assertPermission\(identity, "admin:manage"\)/);
  assert.match(route, /approvalReference/);
  assert.match(route, /validUntil/);
  assert.match(route, /apply_support_access_admin/);
});

test("access review exposes every launch authorization layer through tenant-bound reads", async () => {
  const route = await read("app/api/v1/admin/access-review/route.ts");
  for (const relation of [
    "corvis_control.identity_subject",
    "corvis_control.membership",
    "corvis_control.resource_entitlement",
    "corvis_control.data_rights",
    "corvis_control.service_identity_grant",
    "corvis_control.support_access_grant",
  ]) assert.ok(route.includes(relation), `access review must include ${relation}`);
  assert.ok((route.match(/where .*tenant_id=\$1/g) ?? []).length >= 4, "access-review queries must bind the current tenant");
  assert.match(route, /identity\.tenantId/);
});

test("support access can never be self-approved by the granting administrator", async () => {
  const sql = (await read("db/postgres/migrations/045_support_access_separation_of_duties.sql")).toLowerCase();
  assert.match(sql, /create or replace function corvis_control\.apply_support_access_admin/);
  assert.match(sql, /p_subject=p_actor_subject/);
  assert.match(sql, /a\.subject=p_actor_subject and a\.user_id=p_user_id/);
  assert.match(sql, /support access cannot be self-approved/);
  // The rest of the 041 contract must survive the redefinition.
  assert.match(sql, /support access requires a future expiry/);
  assert.match(sql, /requested support role is already active outside this grant/);
  assert.match(sql, /access\.support\.'\|\|p_operation/);

  const route = await read("app/api/v1/admin/support-access/route.ts");
  assert.match(route, /subject === identity\.subject/);
  assert.match(route, /support_access_self_approval_denied/);
});

test("only a tenant_admin may grant anyone the tenant_admin role, at the app layer and in SQL", async () => {
  const sql = (await read("db/postgres/migrations/048_account_admin_role_separation.sql")).toLowerCase();
  assert.match(sql, /create or replace function corvis_control\.apply_identity_lifecycle/);
  assert.match(sql, /create or replace function corvis_control\.apply_support_access_admin/);
  assert.match(sql, /tenant_admin_role_requires_tenant_admin_actor/);
  // Both guards require the actor to hold their own active tenant_admin
  // membership, not merely to be granting it to themselves.
  assert.match(sql, /and m\.role_name='tenant_admin' and m\.status='active'/);
  // workspace_admin no longer exists as a role check constraint anywhere;
  // accountadmin replaces it (the migration's own header/data-migration
  // comments still name the retired role for context, so this only checks
  // the role-name check-constraint lists, not the whole file).
  assert.doesNotMatch(sql, /not in \('tenant_admin','workspace_admin'/);
  assert.match(sql, /not in \('tenant_admin','accountadmin'/);
  // The redefinitions must still carry the rest of the 043/045 contract.
  assert.match(sql, /support access cannot be self-approved/);
  assert.match(sql, /identity lifecycle event replay conflict/);

  const identityLifecycleRoute = await read("app/api/v1/admin/identity-lifecycle/route.ts");
  assert.match(identityLifecycleRoute, /entry\.roleName === "tenant_admin"/);
  assert.match(identityLifecycleRoute, /identity\.isTenantAdmin !== true/);
  assert.match(identityLifecycleRoute, /tenant_admin_role_requires_tenant_admin_actor/);

  const supportAccessRoute = await read("app/api/v1/admin/support-access/route.ts");
  assert.match(supportAccessRoute, /roleName === "tenant_admin"/);
  assert.match(supportAccessRoute, /identity\.isTenantAdmin !== true/);
  assert.match(supportAccessRoute, /tenant_admin_role_requires_tenant_admin_actor/);

  // The rename must be consistent everywhere a role allowlist is declared.
  for (const path of [
    "app/api/v1/admin/identity-lifecycle/route.ts",
    "app/api/v1/admin/support-access/route.ts",
    "lib/server/identity-lifecycle.ts",
    "features/admin/governance-forms.tsx",
    "lib/server/authorization.ts",
  ]) {
    const source = await read(path);
    assert.doesNotMatch(source, /workspace_admin/, `${path} must not reference the retired workspace_admin role name`);
  }
});
