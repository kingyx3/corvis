// Real-Postgres acceptance for the organization session policy (F7, #263), through the application code: the backend in
// src/lib/server/session-policy.ts and the authoritative lookup in src/lib/server/authorization.ts drive the SQL functions of
// migration 087 inside one transaction that is always rolled back. Covers what the pure-SQL test (session-policy.sql)
// cannot: that a request is really refused once its session passes a limit, that "sign out everywhere" really stops
// the next authoritative lookup, the view's queries against the real tables, and the security notice reaching every
// Organization Admin (and nobody else); and (F7d, #337, migration 091) that the housekeeping sweep purges old session
// records without ever weakening enforcement, sign-out-everywhere or an existing revocation. Run after the full migration chain on a disposable database:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/session-policy.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { NativePostgresSqlApi } from '../../../src/lib/server/postgres-native.ts';
import { PostgresMembershipAuthorizationRepository } from '../../../src/lib/server/authorization.ts';
import { SessionEndedByPolicyError } from '../../../src/lib/server/request-context.ts';
import { sweepTenantSessionActivity } from '../../../src/lib/server/session-activity-sweep.ts';

// A session the policy ended is told apart from a refused one (F7c): the lookup raises SessionEndedByPolicyError with the reason.
async function ended(lookup, reason, message) {
  const error = await lookup.then(() => undefined, (failure) => failure);
  assert.ok(error instanceof SessionEndedByPolicyError && error.reason === reason, message);
}

// src/lib/server/session-policy.ts reaches the Next.js "@/..." alias through http.ts.
register(new URL('../../../src/lib/server/test-support/alias-loader.mjs', import.meta.url), import.meta.url);
const { PostgresSessionPolicyBackend } = await import('../../../src/lib/server/session-policy.ts');

console.info = console.warn = () => undefined;
const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');

const tenantId = 'f7000000-0000-4000-8000-000000000001';
const otherTenantId = 'f7000000-0000-4000-8000-000000000009';
const workspaceId = 'f7000000-0000-4000-8000-000000000002';
const admin = { userId: 'f7000000-0000-4000-8000-0000000000a1', subject: 'admin-subject' };
const admin2 = { userId: 'f7000000-0000-4000-8000-0000000000a2', subject: 'admin2-subject' };
const member = { userId: 'f7000000-0000-4000-8000-0000000000a3', subject: 'member-subject' };
const ROLLBACK = Symbol('rollback');

const principal = (person, sessionId) => ({ subject: person.subject, tenantId, workspaceId, authMethod: 'oidc', sessionId });
const identity = (person, overrides = {}) => ({
  subject: person.subject, tenantId, workspaceId, roles: ['admin'], authMethod: 'oidc', sessionId: 'sid-admin', isTenantAdmin: true,
  entitlements: { workspaceIds: [workspaceId], sourceDocumentAccessAllowed: false }, ...overrides,
});
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

const db = new NativePostgresSqlApi(dsn);
try {
  await assert.rejects(db.transaction(async (tx) => {
    const backend = new PostgresSessionPolicyBackend(() => tx, () => 'https://login.example.test');
    const authorization = new PostgresMembershipAuthorizationRepository(tx);
    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'f7-ci','F7 CI'),($2,'f7-ci-other','F7 CI Other')`, [tenantId, otherTenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Growth Fund Workspace')`, [workspaceId, tenantId]);
    for (const person of [admin, admin2, member]) {
      await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'oidc',$3)`, [tenantId, person.userId, person.subject]);
    }
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values ($1,$2,$3,'tenant_admin'),($1,$2,$4,'tenant_admin'),($1,$2,$5,'analyst')`,
      [tenantId, workspaceId, admin.userId, admin2.userId, member.userId]);
    const count = async (sql, parameters = [tenantId]) => Number((await tx.query(sql, parameters))[0].n);

    // ------------------------------------------------------------ with no policy, sessions are only recorded
    const first = await authorization.resolve(principal(admin, 'sid-admin'));
    assert.deepEqual(first?.roles, ['admin'], 'an Organization Admin resolves');
    assert.ok(await authorization.resolve(principal(member, 'sid-member-1')));
    assert.ok(await authorization.resolve(principal(member, 'sid-member-2')));
    assert.equal(await count(`select count(*)::int as n from corvis_control.tenant_session_activity where tenant_id=$1`), 3);
    assert.equal(await authorization.resolve(principal({ ...member, subject: 'stranger' }, 'sid-x')), null, 'an unknown subject is refused and never recorded');
    assert.equal(await count(`select count(*)::int as n from corvis_control.tenant_session_activity where tenant_id=$1`), 3);

    // ------------------------------------------------------------ the view, on the real tables
    let view = await backend.view(identity(admin), tx);
    assert.deepEqual([view.policy.version, view.policy.idleTimeoutMinutes, view.scim.configured, view.identityProvider.issuer], [0, null, false, 'https://login.example.test']);
    assert.deepEqual(view.signInMethods, [{ authMethod: 'oidc', users: 3 }]);
    const sessionsOf = (v, person) => v.members.find((m) => m.userId === person.userId);
    assert.deepEqual([sessionsOf(view, admin).isCurrentUser, sessionsOf(view, admin).activeSessions, sessionsOf(view, member).isCurrentUser, sessionsOf(view, member).activeSessions], [true, 1, false, 2]);
    assert.equal(view.members[0].userId, admin.userId, 'the caller is listed first');
    await tx.execute(`insert into corvis_control.tenant_scim_configuration (tenant_id,enabled,token_sha256,auth_method,default_workspace_id,default_role_name,updated_by_subject) values ($1,true,$2,'oidc',$3,'viewer','ops')`, [tenantId, 'a'.repeat(64), workspaceId]);
    await tx.execute(`insert into corvis_control.tenant_scim_identity (tenant_id,external_id,user_id,auth_method,subject,user_name,active) values ($1,'e-1',$2,'oidc','scim-1','one@example.test',true),($1,'e-2',$3,'oidc','scim-2','two@example.test',false)`, [tenantId, member.userId, admin2.userId]);
    view = await backend.view(identity(admin), tx);
    assert.deepEqual([view.scim.configured, view.scim.enabled, view.scim.defaultWorkspaceName, view.scim.defaultRole, view.scim.activeUsers], [true, true, 'Growth Fund Workspace', 'viewer', 1]);
    assert.ok(!JSON.stringify(view).includes('a'.repeat(64)), 'the SCIM token hash never leaves the database');

    // ------------------------------------------------------------ who may change the policy, and the version check
    const asMember = identity(member, { roles: ['analyst'], isTenantAdmin: false });
    const command = { idleTimeoutMinutes: 15, maxSessionMinutes: 60, expectedVersion: 0, reason: 'Align with our policy' };
    assert.equal((await refused(tx, () => backend.update(asMember, command, tx))).applicationError, 'session policy requires an active organization admin', 'refused in SQL even if the application layer is bypassed');
    assert.equal((await refused(tx, () => backend.update(identity(admin), { ...command, idleTimeoutMinutes: 14 }, tx))).applicationError, 'session policy bounds exceeded');
    assert.equal((await refused(tx, () => backend.update(identity(admin), { ...command, expectedVersion: 5 }, tx))).applicationError, 'session policy version conflict');
    assert.equal(await count(`select count(*)::int as n from corvis_control.tenant_session_policy where tenant_id=$1`), 0);
    assert.equal(await count(`select count(*)::int as n from corvis_control.email_outbox where tenant_id=$1 and category='security_policy'`), 0, 'a refused change announces nothing');

    // ------------------------------------------------------------ a change takes effect on the very next request, and is announced
    const change = await backend.update(identity(admin), command, tx);
    assert.deepEqual([change.changed, change.policy.version, change.policy.updatedBy, change.previous.version], [true, 1, admin.subject, 0]);
    const notices = (await tx.query(`select r.user_id::text as user_id, o.template_params, o.required_roles, o.workspace_id from corvis_control.email_outbox o join corvis_control.membership r on r.tenant_id=o.tenant_id and r.user_id=o.recipient_user_id
      where o.tenant_id=$1 and o.category='security_policy' order by r.user_id`, [tenantId])).map((row) => ({ ...row }));
    assert.deepEqual(notices.map((row) => row.user_id), [admin.userId, admin2.userId], 'every Organization Admin, and nobody else, is notified');
    assert.deepEqual([notices[0].template_params, notices[0].required_roles, notices[0].workspace_id], [{ event: 'policy_changed' }, ['tenant_admin'], null]);
    assert.equal((await backend.update(identity(admin), { ...command, expectedVersion: 1 }, tx)).changed, false);
    assert.equal(await count(`select count(*)::int as n from corvis_control.email_outbox where tenant_id=$1 and category='security_policy'`), 2, 'an unchanged policy announces nothing');

    // Within the limits: allowed and refreshed. Past the idle timeout: refused, and staying refused.
    assert.ok(await authorization.resolve(principal(member, 'sid-member-1')));
    await tx.execute(`update corvis_control.tenant_session_activity set last_seen_at = now() - interval '16 minutes', first_seen_at = now() - interval '20 minutes' where tenant_id=$1 and session_id='sid-member-1'`, [tenantId]);
    await ended(authorization.resolve(principal(member, 'sid-member-1')), 'idle_timeout', 'idle past 15 minutes: refused, and told apart (F7c)');
    await ended(authorization.resolve(principal(member, 'sid-member-1')), 'idle_timeout', 'and it stays refused');
    assert.ok(await authorization.resolve(principal(member, 'sid-member-2')), 'another session of the same person is unaffected');
    // Past the maximum length, however active.
    await tx.execute(`update corvis_control.tenant_session_activity set first_seen_at = now() - interval '61 minutes', last_seen_at = now() where tenant_id=$1 and session_id='sid-member-2'`, [tenantId]);
    await ended(authorization.resolve(principal(member, 'sid-member-2')), 'max_session', 'longer than 60 minutes in total: refused');
    // A session whose id cannot be measured fails closed under a limit; background re-authorization is exempt.
    assert.equal(await authorization.resolve(principal(member, 'token-abc123')), null, 'no stable session id, no session');
    assert.ok(await authorization.resolve(principal(member, 'token-abc123'), { applySessionPolicy: false }), 'a queued export is re-authorized without touching the session');
    assert.equal(await count(`select count(*)::int as n from corvis_control.tenant_session_activity where tenant_id=$1 and session_id like 'token-%'`), 0);

    // ------------------------------------------------------------ the policy is per tenant
    assert.equal((await backend.view({ ...identity(admin), tenantId: otherTenantId }, tx)).policy.version, 0, 'another tenant has no policy');

    // ------------------------------------------------------------ clearing it restores the sessions the limits ended
    const cleared = await backend.update(identity(admin), { idleTimeoutMinutes: null, maxSessionMinutes: null, expectedVersion: 1, reason: 'Back to the IdP default' }, tx);
    assert.deepEqual([cleared.changed, cleared.policy.version, cleared.policy.idleTimeoutMinutes], [true, 2, null]);
    assert.ok(await authorization.resolve(principal(member, 'sid-member-1')), 'with no limit the idle session may continue');
    assert.ok(await authorization.resolve(principal(member, 'token-abc123')), 'and an unstable id is allowed again');

    // ------------------------------------------------------------ sign out everywhere
    assert.equal((await refused(tx, () => backend.signOut(asMember, { userId: admin.userId, reason: 'Trying anyway' }, tx))).applicationError, 'session policy requires an active organization admin');
    assert.equal((await refused(tx, () => backend.signOut(identity(admin), { userId: admin.userId, reason: 'Myself' }, tx))).applicationError, 'session sign-out cannot target current user');
    assert.equal((await refused(tx, () => backend.signOut(identity(admin), { userId: 'f7000000-0000-4000-8000-0000000000ff', reason: 'Stranger' }, tx))).applicationError, 'session sign-out target not found');
    assert.equal(await count(`select count(*)::int as n from corvis_control.session_revocation where tenant_id=$1`), 0);
    const before = await count(`select count(*)::int as n from corvis_control.email_outbox where tenant_id=$1 and category='security_policy'`);

    assert.ok(await authorization.resolve(principal(member, 'sid-member-2')), 'the member is signed in on two sessions');
    const result = await backend.signOut(identity(admin), { userId: member.userId, reason: 'Lost laptop' }, tx);
    assert.deepEqual([result.userId, result.revokedSessions], [member.userId, 2]);
    assert.equal(await authorization.resolve(principal(member, 'sid-member-1')), null, 'the very next lookup of either session is refused');
    assert.equal(await authorization.resolve(principal(member, 'sid-member-2')), null);
    assert.equal(await authorization.resolve(principal(member, 'sid-member-1'), { applySessionPolicy: false }), null, 'even background re-authorization honours the sign-out');
    assert.ok(await authorization.resolve(principal(member, 'sid-member-new')), 'signing in again is a new session and works');
    assert.ok(await authorization.resolve(principal(admin, 'sid-admin')), 'nobody else is touched');
    assert.equal(await count(`select count(*)::int as n from corvis_control.email_outbox where tenant_id=$1 and category='security_policy'`), before + 2, 'both Organization Admins are told');
    assert.equal(await count(`select count(*)::int as n from corvis_control.email_outbox where tenant_id=$1 and category='security_policy' and template_params->>'event'='user_signed_out'`), 2, 'the notice says a user was signed out');
    view = await backend.view(identity(admin), tx);
    assert.equal(sessionsOf(view, member).activeSessions, 1, 'only the new session counts as active');
    assert.equal((await backend.signOut(identity(admin), { userId: member.userId, reason: 'Again' }, tx)).revokedSessions, 1, 'only the session started since then is still to end');
    assert.equal((await backend.signOut(identity(admin), { userId: member.userId, reason: 'Once more' }, tx)).revokedSessions, 0, 'and then nothing is left to end');

    // ------------------------------------------------------------ housekeeping: old records go, enforcement and revocations stay
    // (the policy is cleared at this point; set both limits at their longest so every record below is one a limit may still judge)
    const longest = await backend.update(identity(admin), { idleTimeoutMinutes: 480, maxSessionMinutes: 10080, expectedVersion: 2, reason: 'Longest allowed limits' }, tx);
    assert.equal(longest.changed, true);
    assert.ok(await authorization.resolve(principal(member, 'sid-hk-live')), 'a live session is recorded');
    await tx.execute(`insert into corvis_control.tenant_session_activity (tenant_id,auth_method,subject,session_id,first_seen_at,last_seen_at)
      values ($1,'oidc',$2,'sid-hk-old',now() - interval '200 days',now() - interval '150 days'),
             ($1,'oidc',$2,'sid-hk-revoked-old',now() - interval '200 days',now() - interval '150 days'),
             ($1,'oidc',$2,'sid-hk-quiet',now() - interval '9 days',now() - interval '7 days')`, [tenantId, member.subject]);
    await tx.execute(`insert into corvis_control.session_revocation (tenant_id,auth_method,subject,session_id,revoked_by_subject,reason) values ($1,'oidc',$2,'sid-hk-revoked-old',$3,'Old sign-out')`, [tenantId, member.subject, admin.subject]);
    const revocationsBefore = await count(`select count(*)::int as n from corvis_control.session_revocation where tenant_id=$1`);
    const purged = await sweepTenantSessionActivity(tx);
    assert.equal(purged, 2, 'only records unseen for the whole retention are purged');
    assert.equal(await count(`select count(*)::int as n from corvis_control.tenant_session_activity where tenant_id=$1 and session_id in ('sid-hk-old','sid-hk-revoked-old')`), 0);
    assert.equal(await count(`select count(*)::int as n from corvis_control.tenant_session_activity where tenant_id=$1 and session_id in ('sid-hk-live','sid-hk-quiet')`), 2, 'a live session and one quiet for days are kept');
    assert.equal(await sweepTenantSessionActivity(tx), 0, 'nothing is left to purge');
    assert.ok(await authorization.resolve(principal(member, 'sid-hk-live')), 'an active session still resolves after the sweep');
    assert.equal(await authorization.resolve(principal(member, 'sid-hk-revoked-old')), null, 'a revoked session stays revoked although its activity record was purged');
    assert.equal(await authorization.resolve(principal(member, 'sid-hk-revoked-old'), { applySessionPolicy: false }), null, 'also for background re-authorization');
    assert.equal(await count(`select count(*)::int as n from corvis_control.session_revocation where tenant_id=$1`), revocationsBefore, 'the sweep never touches a revocation');
    assert.equal(await count(`select count(*)::int as n from corvis_control.session_revocation where tenant_id=$1 and session_id='sid-member-1'`), 1, 'earlier sign-outs still hold');
    await tx.execute(`update corvis_control.tenant_session_activity set first_seen_at = now() - interval '8 days' where tenant_id=$1 and session_id='sid-hk-live'`, [tenantId]);
    await sweepTenantSessionActivity(tx);
    await ended(authorization.resolve(principal(member, 'sid-hk-live')), 'max_session', 'a session past the maximum is still refused after a sweep: only a quiet record is ever purged');
    assert.equal(await count(`select count(*)::int as n from corvis_control.tenant_session_activity where tenant_id=$1 and session_id='sid-hk-live'`), 1);
    assert.equal(await sweepTenantSessionActivity(tx, { retentionMinutes: 60 }), 0, 'a retention below the floor is raised to it, never obeyed');
    assert.equal(await count(`select count(*)::int as n from corvis_control.tenant_session_activity where tenant_id=$1 and session_id='sid-hk-quiet'`), 1);

    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('session policy: ok');
} finally {
  await db.close?.();
}
