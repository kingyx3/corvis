import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

const baselinePath = "db/postgres/migrations/001_baseline.sql";

// The baseline is one file, so assertions about what a single command does (or never does) are scoped to that
// function's body rather than to the whole schema. Expects lower-cased SQL.
function functionBody(sql: string, qualifiedName: string): string {
  const start = sql.indexOf(`create function ${qualifiedName}(`);
  assert.ok(start >= 0, `${qualifiedName} must be defined in the baseline`);
  assert.equal(sql.indexOf(`create function ${qualifiedName}(`, start + 1), -1, `${qualifiedName} must be defined exactly once`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${qualifiedName} body must be terminated`);
  return sql.slice(start, end);
}

test("resource entitlement and data-right admin commands are tenant scoped, effective dated and audit atomic", async () => {
  const sql = (await read(baselinePath)).toLowerCase();
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

  const route = await read("src/app/api/v1/admin/access-policy/route.ts");
  assert.match(route, /resolveAdminRequestIdentity\(request\)/);
  assert.match(route, /identity\.tenantId/);
  assert.match(route, /apply_resource_entitlement_admin/);
  assert.match(route, /apply_data_right_admin/);
});

test("re-granting an entitlement with unchanged dates is not counted as a change in the audit trail", async () => {
  // A plain `on conflict ... do update` always reports row_count=1, so a repeat grant with identical
  // valid_from/valid_until would otherwise read as a fresh change in audit_event.metadata.changed.
  const sql = (await read(baselinePath)).toLowerCase();
  assert.match(sql, /do update set valid_from=excluded\.valid_from, valid_until=excluded\.valid_until/);
  assert.match(sql, /where corvis_control\.resource_entitlement\.valid_from is distinct from excluded\.valid_from/);
  assert.match(sql, /or corvis_control\.resource_entitlement\.valid_until is distinct from excluded\.valid_until/);
  assert.match(sql, /get diagnostics v_changed = row_count/);
});

test("disabled human identities require an explicit separately audited reactivation", async () => {
  const sql = (await read(baselinePath)).toLowerCase();
  const ordinary = functionBody(sql, "corvis_control.apply_identity_lifecycle");
  const privileged = sql;
  const route = await read("src/app/api/v1/admin/identity-lifecycle/route.ts");

  assert.match(ordinary, /disabled identity requires explicit reactivation/);
  assert.match(privileged, /reactivate_identity_admin/);
  assert.match(privileged, /v_status<>'disabled'/);
  assert.match(privileged, /identity\.lifecycle\.reactivate/);
  assert.match(privileged, /apply_identity_lifecycle/);
  assert.match(route, /value === "reactivate"/);
  assert.match(route, /reactivate_identity_admin/);
});

test("support access is approval based, time bounded, audited and does not manufacture resource rights", async () => {
  const sql = (await read(baselinePath)).toLowerCase();
  assert.match(sql, /create table corvis_control\.support_access_grant \(/);
  assert.match(sql, /purpose text not null/);
  assert.match(sql, /approval_reference text not null/);
  assert.match(sql, /check \(\(valid_until > valid_from\)\)/);
  const command = functionBody(sql, "corvis_control.apply_support_access_admin");
  assert.match(command, /support access requires a future expiry/);
  assert.match(command, /requested support role is already active outside this grant/);
  assert.match(command, /access\.support\.'\|\|p_operation/);
  assert.doesNotMatch(command, /insert into corvis_control\.resource_entitlement/);
  assert.doesNotMatch(command, /insert into corvis_control\.data_rights/);

  const route = await read("src/app/api/v1/admin/support-access/route.ts");
  assert.match(route, /resolveAdminRequestIdentity\(request\)/);
  assert.match(route, /approvalReference/);
  assert.match(route, /validUntil/);
  assert.match(route, /apply_support_access_admin/);
});

test("access review exposes every launch authorization layer through tenant-bound reads", async () => {
  const route = await read("src/app/api/v1/admin/access-review/route.ts");
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
  const sql = (await read(baselinePath)).toLowerCase();
  const command = functionBody(sql, "corvis_control.apply_support_access_admin");
  assert.match(command, /p_subject=p_actor_subject/);
  assert.match(command, /a\.subject=p_actor_subject and a\.user_id=p_user_id/);
  assert.match(command, /support access cannot be self-approved/);
  // The rest of the support-access contract must sit alongside the separation-of-duties guard.
  assert.match(command, /support access requires a future expiry/);
  assert.match(command, /requested support role is already active outside this grant/);
  assert.match(command, /access\.support\.'\|\|p_operation/);

  const route = await read("src/app/api/v1/admin/support-access/route.ts");
  assert.match(route, /subject === identity\.subject/);
  assert.match(route, /support_access_self_approval_denied/);
});

test("only a tenant_admin may grant anyone the tenant_admin role, at the app layer and in SQL", async () => {
  const sql = (await read(baselinePath)).toLowerCase();
  const lifecycle = functionBody(sql, "corvis_control.apply_identity_lifecycle");
  const supportAccess = functionBody(sql, "corvis_control.apply_support_access_admin");
  // Both guards require the actor to hold their own active tenant_admin
  // membership, not merely to be granting it to themselves.
  for (const command of [lifecycle, supportAccess]) {
    assert.match(command, /tenant_admin_role_requires_tenant_admin_actor/);
    assert.match(command, /and m\.role_name='tenant_admin' and m\.status='active'/);
  }
  // workspace_admin does not exist anywhere in the schema; accountadmin replaces it in the role allowlists.
  assert.doesNotMatch(sql, /workspace_admin/);
  assert.match(lifecycle, /not in \('tenant_admin','accountadmin'/);
  assert.match(supportAccess, /not in \('tenant_admin','accountadmin'/);
  // The same functions must still carry the rest of their contracts.
  assert.match(supportAccess, /support access cannot be self-approved/);
  assert.match(lifecycle, /identity lifecycle event replay conflict/);

  const identityLifecycleRoute = await read("src/app/api/v1/admin/identity-lifecycle/route.ts");
  assert.match(identityLifecycleRoute, /entry\.roleName === "tenant_admin"/);
  assert.match(identityLifecycleRoute, /identity\.isTenantAdmin !== true/);
  assert.match(identityLifecycleRoute, /tenant_admin_role_requires_tenant_admin_actor/);

  const supportAccessRoute = await read("src/app/api/v1/admin/support-access/route.ts");
  assert.match(supportAccessRoute, /roleName === "tenant_admin"/);
  assert.match(supportAccessRoute, /identity\.isTenantAdmin !== true/);
  assert.match(supportAccessRoute, /tenant_admin_role_requires_tenant_admin_actor/);

  // The rename must be consistent everywhere a role allowlist is declared.
  for (const path of [
    "src/app/api/v1/admin/identity-lifecycle/route.ts",
    "src/app/api/v1/admin/support-access/route.ts",
    "src/modules/identity-access/server/directory/identity-lifecycle.ts",
    "src/modules/admin/ui/governance-forms.tsx",
    "src/modules/identity-access/server/authorization.ts",
  ]) {
    const source = await read(path);
    assert.doesNotMatch(source, /workspace_admin/, `${path} must not reference the retired workspace_admin role name`);
  }
});

test("a successful, irreversible deletion execution is never reported as a failure just because its audit write failed", async () => {
  const route = await read("src/app/api/v1/admin/deletion-requests/[requestId]/execute/route.ts");
  // executeDeletionRequest() (the irreversible mutation, already committed by
  // the time the audit call runs) must not share a try/catch with the audit
  // insert: if it did, apiError() would turn a failed *audit write alone*
  // into a 500 for a deletion that genuinely already succeeded.
  const mutationCall = route.indexOf("executeDeletionRequest(identity,requestId)");
  const auditTry = route.indexOf("try {", mutationCall);
  const auditCall = route.indexOf(".audit(", auditTry);
  const auditCatch = route.indexOf("catch (auditError)", auditCall);
  const responseReturn = route.indexOf("return json({data:result", auditCatch);
  assert.ok(mutationCall >= 0 && auditTry > mutationCall && auditCall > auditTry
    && auditCatch > auditCall && responseReturn > auditCatch,
    "the audit write must be wrapped in its own try/catch, logged on failure, and never block the success response");
  assert.match(route, /logEvent\("error", "deletion_request\.audit_write_failed"/);
});
