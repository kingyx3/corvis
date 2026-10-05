// Real-Postgres acceptance for service accounts (F6, #262), through the application code: the Postgres backend in
// lib/server/service-account.ts, the credential record check in lib/server/service-account-credential.ts and the
// existing authorization lookup (lib/server/authorization.ts) drive the SQL of migration 088 inside one transaction that
// is always rolled back. Covers what the pure-SQL test (service-accounts.sql) cannot: that a created account resolves
// through the EXISTING membership/lifecycle-grant authorization (and stops resolving when disabled), that the secret is
// shown once and stored nowhere, that verification enforces rotation overlap / immediate revocation / expiry, that the
// access review and tenant access audit show the account, that an Organization Admin's entitlement grants resolve through
// that same lookup within the organization's data rights (and are refused beyond them), that expiry notices are queued once
// per window, sent in words only and suppressed for an admin who lost the role, and that tenants are isolated. Run after the full migration
// chain on a disposable database:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/service-accounts.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { NativePostgresSqlApi } from '../../../lib/server/postgres-native.ts';

// lib/server/http.ts (reached through the tenant-admin self-service module) uses the Next.js "@/..." alias.
register(new URL('../../../lib/server/test-support/alias-loader.mjs', import.meta.url), import.meta.url);
const { PostgresServiceAccountBackend, serviceAccountAuditEvent } = await import('../../../lib/server/service-account.ts');
const { verifyServiceAccountCredential, hashCredentialSecret } = await import('../../../lib/server/service-account-credential.ts');
const { PostgresMembershipAuthorizationRepository } = await import('../../../lib/server/authorization.ts');
const { PostgresOperationsRepository } = await import('../../../lib/server/platform-repositories.ts');
const { listTenantAccessAudit } = await import('../../../lib/server/tenant-admin-self-service.ts');
const { listTenantAccessMembers } = await import('../../../lib/server/tenant-access.ts');
const { sweepServiceAccountExpiry } = await import('../../../lib/server/service-account-expiry-sweep.ts');
const { processEmailOutbox } = await import('../../../lib/server/notifications.ts');
const { RecordingEmailSender } = await import('../../../adapters/email/recording-email-sender.ts');

const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');

const id = (n) => `f6000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1);
const workspaceId = id(2);
const otherWorkspaceId = id(3);
const admin = { userId: id(11), subject: 'admin-one' };
const analyst = { userId: id(12), subject: 'analyst-one' };
const adminTwo = { userId: id(13), subject: 'admin-two' };
const otherTenantId = id(51);
const otherWorkspace = id(52);
const otherAdmin = { userId: id(61), subject: 'admin-other' };

function identity(person, tenant, workspace, isTenantAdmin) {
  return {
    subject: person.subject, tenantId: tenant, workspaceId: workspace, roles: [isTenantAdmin ? 'admin' : 'analyst'], authMethod: 'oidc', sessionId: `session-${person.subject}`,
    isTenantAdmin, entitlements: { workspaceIds: [workspace], fundIds: [], documentIds: [], sourceDocumentAccessAllowed: false },
  };
}
const adminIdentity = identity(admin, tenantId, workspaceId, true);
const analystIdentity = identity(analyst, tenantId, workspaceId, false);
const otherAdminIdentity = identity(otherAdmin, otherTenantId, otherWorkspace, true);

// A statement that raises aborts a Postgres transaction, so every expected refusal runs under its own savepoint.
async function refused(tx, run) {
  await tx.execute('savepoint probe');
  try {
    await run();
  } catch (error) {
    await tx.execute('rollback to savepoint probe');
    return error;
  }
  await tx.execute('release savepoint probe');
  assert.fail('expected the command to be refused');
}
const code = (error) => error?.applicationError ?? error?.code;

const ROLLBACK = Symbol('rollback');
const db = new NativePostgresSqlApi(dsn);
try {
  await assert.rejects(db.transaction(async (tx) => {
    const backend = new PostgresServiceAccountBackend(() => tx);
    const authorization = new PostgresMembershipAuthorizationRepository(tx);

    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'f6-ci','F6 CI'),($2,'f6-other','F6 Other')`, [tenantId, otherTenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Primary Workspace'),($3,$2,'research','Research Workspace'),($4,$5,'ws','Other Workspace')`,
      [workspaceId, tenantId, otherWorkspaceId, otherWorkspace, otherTenantId]);
    for (const [person, tenant] of [[admin, tenantId], [analyst, tenantId], [adminTwo, tenantId], [otherAdmin, otherTenantId]]) {
      await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'oidc',$3)`, [tenant, person.userId, person.subject]);
    }
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values ($1,$2,$3,'tenant_admin'),($1,$2,$4,'analyst'),($5,$6,$7,'tenant_admin'),($1,$2,$8,'tenant_admin')`,
      [tenantId, workspaceId, admin.userId, analyst.userId, otherTenantId, otherWorkspace, otherAdmin.userId, adminTwo.userId]);

    // The workspaces an account can be created in are the tenant's active ones.
    const empty = await backend.list(adminIdentity, tx);
    assert.deepEqual(empty.serviceAccounts, []);
    assert.deepEqual(empty.workspaces.map((workspace) => workspace.name), ['Primary Workspace', 'Research Workspace']);
    // Who an account can be handed to: the organization's active Organization Admins, by the SQL's own test, never an analyst or another tenant's admin.
    assert.deepEqual(empty.owners, [{ subject: admin.subject }, { subject: adminTwo.subject }]);

    // Who may act is decided in SQL: an analyst is refused, and nothing is left behind.
    const refusal = await refused(tx, () => backend.create(analystIdentity, { name: 'Reporting sync', purpose: 'Nightly reporting', workspaceId, roleName: 'analyst', expiresInDays: 365, credentialExpiresInDays: 90 }, tx));
    assert.equal(code(refusal), 'service account requires an active organization admin');
    assert.equal((await backend.list(adminIdentity, tx)).serviceAccounts.length, 0);
    // An administrator role is refused by the SQL function even if the application validation were bypassed.
    assert.equal(code(await refused(tx, () => backend.create(adminIdentity, { name: 'Sneaky admin', purpose: 'Nightly reporting', workspaceId, roleName: 'tenant_admin', expiresInDays: 365, credentialExpiresInDays: 90 }, tx))), 'service account role not allowed');

    // ---- Create: the credential is shown once; only its hash is stored.
    const created = await backend.create(adminIdentity, { name: 'Reporting sync', purpose: 'Pulls published data nightly', workspaceId, roleName: 'analyst', expiresInDays: 365, credentialExpiresInDays: 10 }, tx);
    const { serviceAccount, credential } = created;
    assert.match(credential.secret, /^corvis_sa_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    assert.equal(serviceAccount.roleName, 'analyst');
    assert.equal(serviceAccount.workspaceName, 'Primary Workspace');
    assert.equal(serviceAccount.createdBy, admin.subject);
    assert.equal(serviceAccount.status, 'active');
    assert.equal(serviceAccount.lastUsedAt, null);
    assert.equal(serviceAccount.credentials.length, 1);
    assert.equal(serviceAccount.credentials[0].status, 'active');
    assert.equal(serviceAccount.expiringSoon, true, 'a credential expiring within 14 days is flagged');
    assert.deepEqual(serviceAccount.actions, { canIssue: false, canRotate: true, canRevoke: true, canDisable: true, canExtend: false, canTransfer: true }, 'a 365 day account is already as far out as an account can be');
    assert.deepEqual([serviceAccount.ownerSubject, serviceAccount.ownerActive, serviceAccount.needsOwner], [admin.subject, true, false], 'the creating admin is the first owner');
    assert.equal(JSON.stringify(serviceAccount).includes(credential.secret), false, 'the listed account never carries the secret');
    const stored = await tx.query(`select secret_sha256 from corvis_control.service_account_credential where credential_id=$1::uuid`, [credential.credentialId]);
    assert.equal(stored[0].secret_sha256, hashCredentialSecret(credential.secret));
    // The secret appears in no stored row: not in the account, its credential, its identity subject or any audit event.
    for (const table of ['service_account', 'service_account_credential', 'identity_subject', 'service_identity_grant', 'membership', 'audit_event']) {
      const rows = await tx.query(`select count(*)::int as n from corvis_control.${table} t where position($1 in to_jsonb(t)::text) > 0`, [credential.secret]);
      assert.equal(rows[0].n, 0, `${table} must not hold the secret`);
    }
    // Reading it back (list or get) cannot produce it again.
    assert.equal(JSON.stringify(await backend.list(adminIdentity, tx)).includes(credential.secret), false);
    assert.equal(JSON.stringify(await backend.get(adminIdentity, serviceAccount.serviceAccountId, tx)).includes(credential.secret), false);

    // ---- One identity model: the EXISTING authorization lookup resolves the account, with its role and nothing more.
    const principal = { subject: `service-account:${serviceAccount.serviceAccountId}`, tenantId, workspaceId, authMethod: 'service_account', sessionId: 'sa-session' };
    const resolved = await authorization.resolve(principal);
    assert.deepEqual(resolved.roles, ['analyst']);
    assert.equal(resolved.isTenantAdmin, false, 'a service account is never an Organization Admin');
    assert.deepEqual(resolved.fundIds, [], 'no entitlement is granted by creating an account');
    assert.deepEqual(resolved.workspaceIds, [workspaceId]);
    // Another workspace of the same tenant, and another tenant, resolve nothing.
    assert.equal(await authorization.resolve({ ...principal, workspaceId: otherWorkspaceId }), null);
    assert.equal(await authorization.resolve({ ...principal, tenantId: otherTenantId, workspaceId: otherWorkspace }), null);
    // The 009 lifecycle rule applies: an overdue grant fails closed on the next lookup.
    await tx.execute('savepoint sp_grant');
    await tx.execute(`set local session_replication_role = replica`);
    await tx.execute(`update corvis_control.service_identity_grant set valid_from = now() - interval '2 days', next_review_at = now() - interval '1 minute', reviewed_at = now() - interval '1 day' where tenant_id=$1::uuid and subject=$2`, [tenantId, principal.subject]);
    assert.equal(await authorization.resolve(principal), null, 'an overdue lifecycle review denies the account');
    await tx.execute('rollback to savepoint sp_grant');
    assert.ok(await authorization.resolve(principal), 'and the same account resolves again once the grant is current');
    // A revoked session denies it too.
    await tx.execute(`insert into corvis_control.session_revocation (tenant_id,auth_method,subject,session_id,revoked_by_subject,reason) values ($1,'service_account',$2,'sa-session','admin-one','test')`, [tenantId, principal.subject]);
    assert.equal(await authorization.resolve(principal), null, 'session revocation stays an independent deny control');
    await tx.execute(`delete from corvis_control.session_revocation where tenant_id=$1::uuid and subject=$2`, [tenantId, principal.subject]);

    // ---- Verification of a presented credential.
    const verified = await verifyServiceAccountCredential(credential.secret, tx);
    assert.deepEqual(verified, { tenantId, serviceAccountId: serviceAccount.serviceAccountId, credentialId: credential.credentialId, subject: principal.subject, workspaceId, roleName: 'analyst' });
    const used = (await backend.get(adminIdentity, serviceAccount.serviceAccountId, tx)).lastUsedAt;
    assert.ok(used, 'a successful use is recorded');
    await verifyServiceAccountCredential(credential.secret, tx);
    assert.equal((await backend.get(adminIdentity, serviceAccount.serviceAccountId, tx)).lastUsedAt, used, 'a use within a minute is not written again');
    // Every refusal is the same null: wrong secret for a real credential, unknown credential, malformed.
    assert.equal(await verifyServiceAccountCredential(credential.secret.slice(0, -1) + (credential.secret.endsWith('A') ? 'B' : 'A'), tx), null);
    assert.equal(await verifyServiceAccountCredential(`corvis_sa_${id(999).replaceAll('-', '')}_${'A'.repeat(43)}`, tx), null);
    assert.equal(await verifyServiceAccountCredential('not-a-credential', tx), null);
    assert.equal(await verifyServiceAccountCredential(undefined, tx), null);

    // ---- Rotation: a short overlap, then only the new credential.
    assert.equal(code(await refused(tx, () => backend.issueCredential(adminIdentity, serviceAccount.serviceAccountId, { action: 'issue', credentialExpiresInDays: 30 }, tx))), 'service account already has a credential');
    const rotated = await backend.issueCredential(adminIdentity, serviceAccount.serviceAccountId, { action: 'rotate', credentialExpiresInDays: 30, overlapMinutes: 60 }, tx);
    assert.notEqual(rotated.credential.secret, credential.secret);
    const duringOverlap = rotated.serviceAccount.credentials.map((entry) => entry.status).sort();
    assert.deepEqual(duringOverlap, ['active', 'rotating_out']);
    assert.ok(await verifyServiceAccountCredential(credential.secret, tx), 'the old credential still works during the overlap');
    assert.ok(await verifyServiceAccountCredential(rotated.credential.secret, tx), 'and so does the new one');
    // The overlap ends: shorten the old credential's end date (the only change the guard allows).
    await tx.execute(`update corvis_control.service_account_credential set ends_at = now() - interval '1 second' where credential_id=$1::uuid`, [credential.credentialId]);
    assert.equal(await verifyServiceAccountCredential(credential.secret, tx), null, 'the old credential stops working when the overlap ends');
    assert.ok(await verifyServiceAccountCredential(rotated.credential.secret, tx));
    const afterOverlap = await backend.get(adminIdentity, serviceAccount.serviceAccountId, tx);
    assert.deepEqual(afterOverlap.credentials.map((entry) => entry.status).sort(), ['active', 'retired']);
    assert.equal(afterOverlap.expiringSoon, false, 'the new 30 day credential is not flagged');

    // ---- Revocation takes effect immediately, for every credential in use.
    const second = await backend.issueCredential(adminIdentity, serviceAccount.serviceAccountId, { action: 'rotate', credentialExpiresInDays: 30, overlapMinutes: 1440 }, tx);
    assert.ok(await verifyServiceAccountCredential(rotated.credential.secret, tx), 'overlap of a day keeps the previous credential valid');
    const revoked = await backend.revoke(adminIdentity, serviceAccount.serviceAccountId, tx);
    assert.equal(revoked.revokedCredentials, 2);
    assert.equal(await verifyServiceAccountCredential(second.credential.secret, tx), null);
    assert.equal(await verifyServiceAccountCredential(rotated.credential.secret, tx), null);
    assert.deepEqual(revoked.serviceAccount.actions, { canIssue: true, canRotate: false, canRevoke: false, canDisable: true, canExtend: false, canTransfer: true });
    assert.equal(code(await refused(tx, () => backend.revoke(adminIdentity, serviceAccount.serviceAccountId, tx))), 'service account has no active credential');
    // Revoking a credential does not remove the account's authorization (that is what disabling is for).
    assert.ok(await authorization.resolve(principal));
    const reissued = await backend.issueCredential(adminIdentity, serviceAccount.serviceAccountId, { action: 'issue', credentialExpiresInDays: 90 }, tx);
    assert.ok(await verifyServiceAccountCredential(reissued.credential.secret, tx), 'a re-issued credential works');

    // ---- Expiry: a credential past its expiry stops working (time-travelled as the owner, with triggers off).
    await tx.execute('savepoint sp_expiry');
    await tx.execute(`set local session_replication_role = replica`);
    await tx.execute(`update corvis_control.service_account_credential set created_at = now() - interval '5 days', expires_at = now() - interval '1 day' where credential_id=$1::uuid`, [reissued.credential.credentialId]);
    assert.equal(await verifyServiceAccountCredential(reissued.credential.secret, tx), null, 'an expired credential is refused');
    await tx.execute('rollback to savepoint sp_expiry');

    // ---- Tenant isolation: another tenant's admin sees and changes nothing.
    assert.equal((await backend.list(otherAdminIdentity, tx)).serviceAccounts.length, 0);
    assert.equal(code(await refused(tx, () => backend.get(otherAdminIdentity, serviceAccount.serviceAccountId, tx))), 'service_account_not_found');
    assert.equal(code(await refused(tx, () => backend.revoke(otherAdminIdentity, serviceAccount.serviceAccountId, tx))), 'service account not found');
    assert.equal(code(await refused(tx, () => backend.disable(otherAdminIdentity, serviceAccount.serviceAccountId, 'Not mine to disable', tx))), 'service account not found');
    assert.equal(code(await refused(tx, () => backend.get(adminIdentity, 'not-a-uuid', tx))), 'service_account_not_found');

    // ---- Access review and the human member list.
    const reviewSource = readFileSync(new URL('../../../app/api/v1/admin/access-review/route.ts', import.meta.url), 'utf8');
    const reviewSql = /db\.query\(`(select s\.subject,s\.auth_method[^`]*)`, \[identity\.tenantId\]\)/.exec(reviewSource)?.[1];
    assert.ok(reviewSql, 'the access review membership query is found');
    const review = await tx.query(reviewSql, [tenantId]);
    const reviewed = review.filter((row) => row.subject === principal.subject);
    assert.equal(reviewed.length, 1, 'the service account appears in the access review');
    assert.equal(reviewed[0].auth_method, 'service_account');
    assert.equal(reviewed[0].role_name, 'analyst');
    assert.equal(reviewed[0].membership_status, 'active');
    const grants = await tx.query(`select subject,purpose,status,valid_until from corvis_control.service_identity_grant where tenant_id=$1::uuid and subject=$2`, [tenantId, principal.subject]);
    assert.equal(grants[0].status, 'active');
    const members = await listTenantAccessMembers(adminIdentity, tx);
    assert.ok(members.every((member) => member.subjects.every((entry) => entry.authMethod === 'oidc' || entry.authMethod === 'saml')), 'the human member list holds no service account');
    assert.equal(members.some((member) => member.userId === serviceAccount.userId), false);

    // ---- Deactivation everywhere.
    await tx.execute(`insert into corvis_control.resource_entitlement (tenant_id,workspace_id,subject_user_id,resource_type,resource_id,permission) values ($1,$2,$3,'fund','fund-1','read')`, [tenantId, workspaceId, serviceAccount.userId]);
    assert.equal(code(await refused(tx, () => backend.disable(adminIdentity, serviceAccount.serviceAccountId, 'no', tx))), 'service account justification required');
    const disabled = await backend.disable(adminIdentity, serviceAccount.serviceAccountId, 'Integration retired', tx);
    assert.equal(disabled.status, 'disabled');
    assert.equal(disabled.disableReason, 'Integration retired');
    assert.deepEqual(disabled.actions, { canIssue: false, canRotate: false, canRevoke: false, canDisable: false, canExtend: false, canTransfer: false });
    assert.equal(await authorization.resolve(principal), null, 'a disabled account resolves nothing');
    assert.equal(await verifyServiceAccountCredential(reissued.credential.secret, tx), null, 'and none of its credentials verify');
    const left = await tx.query(`select
      (select count(*)::int from corvis_control.membership where tenant_id=$1::uuid and user_id=$2::uuid and status='active') as memberships,
      (select count(*)::int from corvis_control.resource_entitlement where tenant_id=$1::uuid and subject_user_id=$2::uuid and (valid_until is null or valid_until>now())) as entitlements,
      (select count(*)::int from corvis_control.identity_subject where tenant_id=$1::uuid and user_id=$2::uuid and status='active') as subjects,
      (select count(*)::int from corvis_control.service_identity_grant where tenant_id=$1::uuid and subject=$3 and status='active') as grants`, [tenantId, serviceAccount.userId, principal.subject]);
    assert.deepEqual(left[0], { memberships: 0, entitlements: 0, subjects: 0, grants: 0 });
    // The disabled account stays listed, as the record of what happened.
    const listed = await backend.list(adminIdentity, tx);
    assert.equal(listed.serviceAccounts.length, 1);
    assert.equal(listed.serviceAccounts[0].status, 'disabled');

    // ---- Renewal and ownership (F6b): an audited extension that advances the lifecycle review date, and an owner who can be handed over.
    const renewable = (await backend.create(adminIdentity, { name: 'Short feed', purpose: 'Renewed in this test', workspaceId, roleName: 'viewer', expiresInDays: 30, credentialExpiresInDays: 10 }, tx)).serviceAccount;
    const renewablePrincipal = { subject: `service-account:${renewable.serviceAccountId}`, tenantId, workspaceId, authMethod: 'service_account', sessionId: 'renewable-session' };
    assert.deepEqual([renewable.ownerSubject, renewable.actions.canExtend], [admin.subject, true]);
    const extension = await backend.extend(adminIdentity, renewable.serviceAccountId, { action: 'extend', expiresInDays: 200 }, tx);
    assert.equal(extension.previousExpiresAt, renewable.expiresAt);
    assert.ok(Math.abs(Date.parse(extension.serviceAccount.expiresAt) - (Date.now() + 200 * 86_400_000)) < 60_000, 'the account now expires 200 days from now');
    assert.equal(extension.serviceAccount.credentials[0].expiresAt, renewable.credentials[0].expiresAt, 'a credential keeps its own expiry');
    const renewedRows = await tx.query(`select
      (select valid_until from corvis_control.membership where tenant_id=$1::uuid and user_id=$2::uuid) as member_until,
      (select valid_until from corvis_control.service_identity_grant where tenant_id=$1::uuid and subject=$3) as grant_until,
      (select next_review_at from corvis_control.service_identity_grant where tenant_id=$1::uuid and subject=$3) as next_review,
      (select reviewed_by_subject from corvis_control.service_identity_grant where tenant_id=$1::uuid and subject=$3) as reviewed_by`, [tenantId, renewable.userId, renewablePrincipal.subject]);
    for (const key of ['member_until', 'grant_until', 'next_review']) assert.equal(new Date(renewedRows[0][key]).toISOString(), extension.serviceAccount.expiresAt, key);
    assert.equal(renewedRows[0].reviewed_by, admin.subject);
    assert.ok(await authorization.resolve(renewablePrincipal), 'the renewed account still resolves through the existing authorization lookup');
    assert.equal(code(await refused(tx, () => backend.extend(adminIdentity, renewable.serviceAccountId, { action: 'extend', expiresInDays: 100 }, tx))), 'service account expiry invalid', 'an extension never shortens');
    assert.equal(code(await refused(tx, () => backend.extend(analystIdentity, renewable.serviceAccountId, { action: 'extend', expiresInDays: 300 }, tx))), 'service account requires an active organization admin');
    assert.equal(code(await refused(tx, () => backend.extend(otherAdminIdentity, renewable.serviceAccountId, { action: 'extend', expiresInDays: 300 }, tx))), 'service account not found');
    assert.equal(code(await refused(tx, () => backend.extend(adminIdentity, 'not-a-uuid', { action: 'extend', expiresInDays: 300 }, tx))), 'service_account_not_found');

    // Handing it to another active Organization Admin; the people on offer are exactly the active admins.
    assert.equal(code(await refused(tx, () => backend.transferOwner(adminIdentity, renewable.serviceAccountId, analyst.subject, tx))), 'service account owner must be an active organization admin');
    assert.equal(code(await refused(tx, () => backend.transferOwner(adminIdentity, renewable.serviceAccountId, admin.subject, tx))), 'service account owner unchanged');
    assert.equal(code(await refused(tx, () => backend.transferOwner(analystIdentity, renewable.serviceAccountId, adminTwo.subject, tx))), 'service account requires an active organization admin');
    const handedOver = await backend.transferOwner(adminIdentity, renewable.serviceAccountId, adminTwo.subject, tx);
    assert.equal(handedOver.previousOwner, admin.subject);
    assert.deepEqual([handedOver.serviceAccount.ownerSubject, handedOver.serviceAccount.ownerActive, handedOver.serviceAccount.createdBy], [adminTwo.subject, true, admin.subject]);
    // The owner is deactivated: the account is surfaced as needing a new owner, keeps working, and is not extended until it has one.
    await tx.execute(`update corvis_control.identity_subject set status='disabled', disabled_at=now() where tenant_id=$1::uuid and user_id=$2::uuid`, [tenantId, adminTwo.userId]);
    const orphaned = await backend.get(adminIdentity, renewable.serviceAccountId, tx);
    assert.deepEqual([orphaned.ownerActive, orphaned.needsOwner, orphaned.status, orphaned.actions.canExtend, orphaned.actions.canTransfer], [false, true, 'active', false, true]);
    assert.ok(await authorization.resolve(renewablePrincipal), 'an account whose owner left keeps working');
    assert.deepEqual((await backend.list(adminIdentity, tx)).owners, [{ subject: admin.subject }], 'a deactivated admin is no longer offered as an owner');
    assert.equal(code(await refused(tx, () => backend.extend(adminIdentity, renewable.serviceAccountId, { action: 'extend', expiresInDays: 300 }, tx))), 'service account needs an owner');
    const taken = await backend.transferOwner(adminIdentity, renewable.serviceAccountId, admin.subject, tx);
    assert.equal(taken.previousOwner, adminTwo.subject);
    assert.equal(taken.serviceAccount.needsOwner, false);
    const again = await backend.extend(adminIdentity, renewable.serviceAccountId, { action: 'extend', expiresInDays: 300 }, tx);
    assert.ok(Math.abs(Date.parse(again.serviceAccount.expiresAt) - (Date.now() + 300 * 86_400_000)) < 60_000, 'with an owner again it extends');

    // ---- Entitlement self-service (F6c, migration 096): an Organization Admin scopes the account's data access without a Corvis
    // operator, within the organization's data rights, through the rows the existing authorization lookup already reads.
    await tx.execute(`insert into corvis_identity.fund (global_fund_id, canonical_name) values ('f6-fund-licensed','Licensed Fund One'),('f6-fund-unlicensed','Unlicensed Fund Two'),('f6-fund-foreign','Foreign Fund Three') on conflict do nothing`);
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version)
      values ($1,gen_random_uuid(),'f6-fund-licensed','Q2 2026',1,'draft','1','1'),($1,gen_random_uuid(),'f6-fund-unlicensed','Q2 2026',1,'draft','1','1'),($2,gen_random_uuid(),'f6-fund-foreign','Q2 2026',1,'draft','1','1')`, [tenantId, otherTenantId]);
    await tx.execute(`insert into corvis_source.document (tenant_id,document_id,display_name,media_type,status,created_by) values ($1,$2,'Licensed report.pdf','application/pdf','published','fixture')`, [tenantId, id(700)]);
    // The organization holds a client-visible right for one fund and one document, and (wrongly) for a fund that is another tenant's: that last one must still be refused.
    await tx.execute(`insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible,effective_from) values ($1,'fund','f6-fund-licensed',true,now()-interval '1 day'),($1,'document',$2,true,now()-interval '1 day'),($1,'fund','f6-fund-foreign',true,now()-interval '1 day')`, [tenantId, id(700)]);
    const target = renewable.serviceAccountId;
    const before = await backend.list(adminIdentity, tx);
    assert.deepEqual(before.grantable.map((resource) => [resource.resourceType, resource.resourceId, resource.label]), [
      ['document', id(700), 'Licensed report.pdf'], ['fund', 'f6-fund-licensed', 'Licensed Fund One'],
    ], 'only what the organization owns and holds a client-visible data right for is offered');
    assert.deepEqual((await authorization.resolve(renewablePrincipal)).fundIds, [], 'a new account sees nothing until granted');

    const grantedFund = await backend.grantEntitlement(adminIdentity, target, { resourceType: 'fund', resourceId: 'f6-fund-licensed' }, tx);
    assert.deepEqual(grantedFund.serviceAccount.entitlements.map((entitlement) => [entitlement.resourceId, entitlement.label, entitlement.permission, entitlement.withinDataRights]), [['f6-fund-licensed', 'Licensed Fund One', 'read', true]]);
    await backend.grantEntitlement(adminIdentity, target, { resourceType: 'document', resourceId: id(700) }, tx);
    const scoped = await authorization.resolve(renewablePrincipal);
    assert.deepEqual([scoped.fundIds, scoped.documentIds], [['f6-fund-licensed'], [id(700)]], 'the existing authorization lookup now resolves exactly what the admin granted');
    assert.deepEqual(scoped.sourceDocumentIds, [], 'source-document access is a separate contractual right and is not granted here');
    const entitlementRows = await tx.query(`select workspace_id::text as workspace_id, permission, valid_until from corvis_control.resource_entitlement where tenant_id=$1::uuid and subject_user_id=$2::uuid`, [tenantId, renewable.userId]);
    assert.equal(entitlementRows.length, 2);
    assert.ok(entitlementRows.every((row) => row.workspace_id === workspaceId && row.permission === 'read' && row.valid_until === null), 'read-only, in the account\'s own workspace');

    // Beyond what the organization holds, the same refusal whatever the reason; nothing is recorded.
    for (const [resourceType, resourceId] of [['fund', 'f6-fund-unlicensed'], ['fund', 'f6-fund-foreign'], ['fund', 'f6-fund-unknown'], ['document', id(701)]]) {
      assert.equal(code(await refused(tx, () => backend.grantEntitlement(adminIdentity, target, { resourceType, resourceId }, tx))), 'service account resource outside organization data rights', `${resourceType} ${resourceId}`);
    }
    assert.equal(code(await refused(tx, () => backend.grantEntitlement(adminIdentity, target, { resourceType: 'fund', resourceId: 'f6-fund-licensed' }, tx))), 'service account entitlement already granted');
    assert.equal(code(await refused(tx, () => backend.grantEntitlement(analystIdentity, target, { resourceType: 'fund', resourceId: 'f6-fund-licensed' }, tx))), 'service account requires an active organization admin');
    assert.equal(code(await refused(tx, () => backend.grantEntitlement(otherAdminIdentity, target, { resourceType: 'fund', resourceId: 'f6-fund-licensed' }, tx))), 'service account not found');
    assert.equal(code(await refused(tx, () => backend.revokeEntitlement(analystIdentity, target, { resourceType: 'fund', resourceId: 'f6-fund-licensed' }, tx))), 'service account requires an active organization admin');
    assert.equal((await authorization.resolve(renewablePrincipal)).fundIds.length, 1, 'refused grants changed nothing');
    // The same refusal for a deactivated account: its entitlements were ended with it, and nothing can be added.
    assert.equal(code(await refused(tx, () => backend.grantEntitlement(adminIdentity, serviceAccount.serviceAccountId, { resourceType: 'fund', resourceId: 'f6-fund-licensed' }, tx))), 'service account is not active');

    // Access follows the organization's right: when the right lapses the entitlement stays on record, flagged, and the lookup ignores it.
    await tx.execute(`update corvis_control.data_rights set effective_to = now() where tenant_id=$1::uuid and resource_id='f6-fund-licensed'`, [tenantId]);
    const lapsed = await backend.get(adminIdentity, target, tx);
    assert.deepEqual(lapsed.entitlements.map((entitlement) => [entitlement.resourceId, entitlement.withinDataRights]).sort(), [['f6-fund-licensed', false], [id(700), true]]);
    assert.deepEqual((await authorization.resolve(renewablePrincipal)).fundIds, [], 'no data right, no access, even though the entitlement row exists');
    assert.deepEqual((await backend.list(adminIdentity, tx)).grantable.map((resource) => resource.resourceId), [id(700)], 'and it is no longer offered');
    // Revocation is never refused for that reason, ends everything on the resource and keeps the row for review.
    const removed = await backend.revokeEntitlement(adminIdentity, target, { resourceType: 'fund', resourceId: 'f6-fund-licensed' }, tx);
    assert.equal(removed.endedEntitlements, 1);
    assert.deepEqual(removed.serviceAccount.entitlements.map((entitlement) => entitlement.resourceId), [id(700)]);
    assert.equal(code(await refused(tx, () => backend.revokeEntitlement(adminIdentity, target, { resourceType: 'fund', resourceId: 'f6-fund-licensed' }, tx))), 'service account entitlement not found');
    assert.equal((await tx.query(`select count(*)::int as n from corvis_control.resource_entitlement where tenant_id=$1::uuid and subject_user_id=$2::uuid and resource_id='f6-fund-licensed'`, [tenantId, renewable.userId]))[0].n, 1);
    assert.equal(code(await refused(tx, () => backend.grantEntitlement(adminIdentity, target, { resourceType: 'fund', resourceId: 'f6-fund-licensed' }, tx))), 'service account resource outside organization data rights', 'with the right gone it cannot be granted again');
    // Another tenant's admin sees none of this.
    assert.equal((await backend.list(otherAdminIdentity, tx)).grantable.length, 0);

    // ---- Every action is audited and visible in the tenant access audit (C9).
    const operations = new PostgresOperationsRepository(tx);
    const events = [
      ['service_account.created', { credentialId: credential.credentialId }],
      ['service_account.credential_rotated', { credentialId: rotated.credential.credentialId, overlapMinutes: 60 }],
      ['service_account.credential_revoked', { reason: 'Rotation drill', revokedCredentials: 2 }],
      ['service_account.credential_issued', { credentialId: reissued.credential.credentialId }],
      ['service_account.disabled', { reason: 'Integration retired' }],
      ['service_account.extended', { previousExpiresAt: extension.previousExpiresAt, expiresAt: extension.serviceAccount.expiresAt, nextReviewAt: extension.serviceAccount.expiresAt }],
      ['service_account.owner_transferred', { previousOwner: admin.subject, ownerSubject: adminTwo.subject }],
      ['service_account.entitlement_granted', { resourceType: 'fund', resourceId: 'f6-fund-licensed', permission: 'read', reason: 'Feeds the warehouse' }],
      ['service_account.entitlement_revoked', { resourceType: 'fund', resourceId: 'f6-fund-licensed', endedEntitlements: 1, reason: 'Right lapsed' }],
    ];
    for (const [action, detail] of events) await operations.audit(serviceAccountAuditEvent(adminIdentity, 'corr-f6', action, serviceAccount, detail));
    const trail = await listTenantAccessAudit(adminIdentity, tx);
    for (const [action] of events) {
      const entry = trail.find((candidate) => candidate.action === action);
      assert.ok(entry, `${action} is visible in the tenant access audit`);
      assert.equal(entry.targetType, 'service_account');
      assert.equal(entry.targetId, serviceAccount.serviceAccountId);
      assert.equal(entry.actorSubject, admin.subject);
    }
    assert.equal((await listTenantAccessAudit(otherAdminIdentity, tx)).some((entry) => entry.targetType === 'service_account'), false, 'another tenant never sees them');
    assert.equal(JSON.stringify(trail).includes(credential.secret), false);

    // ---- Expiry notices (F6d, migration 096) end to end: the delivery tick's sweep queues one mandatory notice per active
    // Organization Admin per window, the outbox dispatcher sends it in words only, and it is never queued twice.
    await tx.execute(`insert into corvis_control.notification_recipient (tenant_id,user_id,email,source) values ($1,$2,'admin-one@example.test','verified_identity_claim'),($1,$3,'admin-two@example.test','verified_identity_claim')`, [tenantId, admin.userId, adminTwo.userId]);
    await backend.create(adminIdentity, { name: 'Expiring feed', purpose: 'Expires within the warning window', workspaceId, roleName: 'viewer', expiresInDays: 10, credentialExpiresInDays: 5 }, tx);
    const noticeRows = () => tx.query(`select recipient_user_id::text as user_id, template_params->>'subject' as subject, template_params->>'window' as win, status, suppression_reason from corvis_control.email_outbox
      where tenant_id=$1::uuid and category='service_account_expiry' order by subject, win, status`, [tenantId]);
    // Drain whatever other tests committed to a shared database, so the counts below are this tenant's.
    await sweepServiceAccountExpiry(tx, 500);
    const queuedNow = (await noticeRows());
    // The new account (warning), its credential (warning), and the 10-day credential of the renewed feed from above (warning): admin two was deactivated, so only admin one is addressed.
    assert.deepEqual(queuedNow.map((row) => [row.user_id, row.subject, row.win]), [
      [admin.userId, 'account', 'warning'], [admin.userId, 'credential', 'warning'], [admin.userId, 'credential', 'warning'],
    ], 'one notice per item per active Organization Admin; a deactivated admin and an analyst are not addressed');
    assert.equal(await sweepServiceAccountExpiry(tx, 500), 0, 'a second tick queues nothing');

    const noticeSender = new RecordingEmailSender();
    const dispatched = await processEmailOutbox({ db: tx, sender: noticeSender, appUrl: 'https://app.corvis.test' });
    assert.ok(dispatched.sent >= 3);
    const noticeEmails = noticeSender.sent.filter((email) => email.category === 'service_account_expiry');
    assert.equal(noticeEmails.length, 3);
    for (const email of noticeEmails) {
      assert.equal(email.to, 'admin-one@example.test');
      assert.match(email.text, /expires within the next 14 days/);
      assert.match(email.text, /https:\/\/app\.corvis\.test\/access-self-service/);
      assert.match(email.text, /cannot be turned off/, 'a mandatory notice says so and carries no settings link');
      assert.doesNotMatch(email.text + email.html + email.subject, /Expiring feed|Short feed|Reporting sync|Primary Workspace|corvis_sa_|service-account:/, 'words only: no account, workspace or credential detail');
    }
    assert.deepEqual((await noticeRows()).map((row) => row.status), ['sent', 'sent', 'sent']);
    assert.equal(await sweepServiceAccountExpiry(tx, 500), 0, 'a sent notice is not queued again');

    // A notice queued for an admin who then loses the role is suppressed at send time, never emailed.
    await backend.create(adminIdentity, { name: 'Late feed', purpose: 'Expires inside the final window', workspaceId, roleName: 'viewer', expiresInDays: 2, credentialExpiresInDays: 2 }, tx);
    assert.equal(await sweepServiceAccountExpiry(tx, 500), 1, 'the final window queues one notice (the credential ends with the account, so it is the account\'s)');
    await tx.execute(`update corvis_control.membership set status='revoked', valid_until=now(), valid_from=now()-interval '1 microsecond' where tenant_id=$1::uuid and user_id=$2::uuid`, [tenantId, admin.userId]);
    const lateSender = new RecordingEmailSender();
    await processEmailOutbox({ db: tx, sender: lateSender, appUrl: 'https://app.corvis.test' });
    assert.equal(lateSender.sent.filter((email) => email.category === 'service_account_expiry').length, 0);
    assert.deepEqual((await noticeRows()).filter((row) => row.win === 'final').map((row) => [row.status, row.suppression_reason]), [['suppressed', 'not_eligible']]);
    // The category is mandatory: it is never a stored preference and the settings read never lets an admin switch it off.
    const mandatory = await tx.query(`select count(*)::int as n from corvis_control.notification_preference where tenant_id=$1::uuid and category='service_account_expiry'`, [tenantId]);
    assert.equal(mandatory[0].n, 0);

    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('service accounts: ok');
} finally {
  await db.close?.();
}
