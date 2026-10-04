// Real-Postgres acceptance for verified email domains and the per-tenant identity-provider record (F7b #335, F7e #338),
// through the application code: the operator commands and domain check in lib/server/identity-records.ts, the view in
// lib/server/session-policy.ts and the authoritative lookup in lib/server/authorization.ts drive the SQL of migration 095
// inside one transaction that is always rolled back. Covers what the pure-SQL test (tenant-identity-records.sql) cannot:
// that token binding really refuses a request through the authoritative lookup, only when an operator turned it on and
// only for OIDC, and that the view reads the real tables. Run after the full migration chain on a disposable database:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/tenant-identity-records.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { NativePostgresSqlApi } from '../../../lib/server/postgres-native.ts';
import { PostgresMembershipAuthorizationRepository } from '../../../lib/server/authorization.ts';
import { applyTenantIdentityCommand, emailDomainAllowed, readTenantIdentityRecords } from '../../../lib/server/identity-records.ts';

register(new URL('../../../lib/server/test-support/alias-loader.mjs', import.meta.url), import.meta.url);
const { PostgresSessionPolicyBackend } = await import('../../../lib/server/session-policy.ts');

console.info = console.warn = () => undefined;
const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');

const opsTenant = 'f9500000-0000-4000-8000-0000000000f0';
const tenantId = 'f9500000-0000-4000-8000-000000000001';
const workspaceId = 'f9500000-0000-4000-8000-000000000002';
const opsWorkspace = 'f9500000-0000-4000-8000-0000000000f1';
const operator = { userId: 'f9500000-0000-4000-8000-0000000000a1', subject: 'ops-admin' };
const admin = { userId: 'f9500000-0000-4000-8000-0000000000a2', subject: 'admin-subject' };
const ROLLBACK = Symbol('rollback');
const token = { tokenIssuer: 'https://idp.acme.com/realms/acme', tokenAudience: 'corvis-acme' };
const principal = (extra = {}) => ({ subject: admin.subject, tenantId, workspaceId, authMethod: 'oidc', sessionId: 'sid-1', ...extra });
const opsIdentity = { subject: operator.subject, tenantId: opsTenant, workspaceId: opsWorkspace, roles: ['admin'], authMethod: 'oidc', sessionId: 'sid-ops', isTenantAdmin: true, entitlements: { workspaceIds: [opsWorkspace] } };
const customerAdmin = { ...opsIdentity, subject: admin.subject, tenantId, workspaceId };

async function refused(tx, run, fragment) {
  await tx.execute('savepoint probe');
  try {
    await run();
  } catch (error) {
    await tx.execute('rollback to savepoint probe');
    assert.ok(String(error.applicationError ?? error.message).includes(fragment), `expected "${fragment}" but got ${error.applicationError ?? error.message}`);
    return;
  }
  await tx.execute('release savepoint probe');
  assert.fail(`expected "${fragment}"`);
}

const db = new NativePostgresSqlApi(dsn);
try {
  await assert.rejects(db.transaction(async (tx) => {
    const authorization = new PostgresMembershipAuthorizationRepository(tx);
    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'f95-ops','Ops'),($2,'f95-customer','Customer')`, [opsTenant, tenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Ops'),($3,$4,'ws','Customer')`, [opsWorkspace, opsTenant, workspaceId, tenantId]);
    await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'oidc',$3),($4,$5,'oidc',$6)`, [opsTenant, operator.userId, operator.subject, tenantId, admin.userId, admin.subject]);
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values ($1,$2,$3,'tenant_admin'),($4,$5,$6,'tenant_admin')`, [opsTenant, opsWorkspace, operator.userId, tenantId, workspaceId, admin.userId]);
    const add = (domain) => ({ kind: 'verified_domain_add', tenantId, domain, verificationMethod: 'dns_txt', evidence: 'ticket-1', reason: 'Customer asked' });

    // ------------------------------------------------ the domain check is off until a domain is verified
    assert.equal(await emailDomainAllowed(tx, tenantId, 'anyone@elsewhere.org'), true, 'no verified domain: no rule');
    // An actor that is not an active administrator is refused by the SQL itself, independently of the route.
    // (A real tenant_admin of any tenant passes SQL; the route additionally requires the operations tenant: assertOperationsTenant.)
    await refused(tx, () => applyTenantIdentityCommand({ ...opsIdentity, subject: 'nobody' }, add('acme.com'), 'c-0', tx), 'identity records require an active operations admin');
    assert.deepEqual(await applyTenantIdentityCommand(opsIdentity, add('acme.com'), 'c-1', tx), { changed: true, version: null });
    assert.deepEqual(await applyTenantIdentityCommand(opsIdentity, add('acme.com'), 'c-2', tx), { changed: false, version: null });
    assert.equal(await emailDomainAllowed(tx, tenantId, 'New.Person@ACME.com'), true);
    assert.equal(await emailDomainAllowed(tx, tenantId, 'person@evil.org'), false);
    assert.equal(await emailDomainAllowed(tx, tenantId, 'person@sub.acme.com'), false, 'a subdomain is not implied');

    // ------------------------------------------------ the identity-provider record and the view
    const backend = new PostgresSessionPolicyBackend(() => tx, () => 'https://login.example.test');
    let view = await backend.view({ ...customerAdmin }, tx);
    assert.deepEqual(view.identityProvider, { protocol: 'oidc', issuer: 'https://login.example.test', audience: null, source: 'global', status: null, tokenBindingEnforced: false });
    assert.deepEqual(view.verifiedDomains.map((d) => [d.domain, d.verificationMethod]), [['acme.com', 'dns_txt']]);
    const record = (extra) => ({ kind: 'identity_provider_set', tenantId, protocol: 'oidc', issuer: token.tokenIssuer, audience: token.tokenAudience, status: 'active', enforceTokenBinding: false, expectedVersion: 0, reason: 'Initial setup', ...extra });
    assert.deepEqual(await applyTenantIdentityCommand(opsIdentity, record(), 'c-3', tx), { changed: true, version: 1 });
    await refused(tx, () => applyTenantIdentityCommand(opsIdentity, record({ expectedVersion: 0, status: 'disabled' }), 'c-4', tx), 'identity provider version conflict');
    view = await backend.view({ ...customerAdmin }, tx);
    assert.deepEqual(view.identityProvider, { protocol: 'oidc', issuer: token.tokenIssuer, audience: token.tokenAudience, source: 'tenant', status: 'active', tokenBindingEnforced: false });
    const stored = await readTenantIdentityRecords(tx, tenantId);
    assert.equal(stored.identityProvider.version, 1);

    // ------------------------------------------------ binding: off by default, never for a caller that does not ask
    const asked = { enforceIdentityBinding: true };
    assert.ok(await authorization.resolve(principal({ tokenIssuer: 'https://other.example', tokenAudience: 'x' }), asked), 'binding is off by default: any verified token resolves');
    assert.ok(await authorization.resolve(principal(), asked), 'and so does a request that carries no token claims');
    assert.deepEqual(await applyTenantIdentityCommand(opsIdentity, record({ enforceTokenBinding: true, expectedVersion: 1 }), 'c-5', tx), { changed: true, version: 2 });
    assert.ok(await authorization.resolve(principal({ sessionId: 'sid-2', ...token }), asked), 'the recorded issuer and audience pass');
    assert.equal(await authorization.resolve(principal({ sessionId: 'sid-3', tokenIssuer: 'https://other.example', tokenAudience: token.tokenAudience }), asked), null, 'another issuer is refused');
    assert.equal(await authorization.resolve(principal({ sessionId: 'sid-4', tokenIssuer: token.tokenIssuer, tokenAudience: 'other' }), asked), null, 'another audience is refused');
    assert.equal(await authorization.resolve(principal({ sessionId: 'sid-5' }), asked), null, 'no verified claims at all fails closed');
    assert.equal(await tx.query(`select 1 from corvis_control.tenant_session_activity where tenant_id=$1 and session_id in ('sid-3','sid-4','sid-5')`, [tenantId]).then((r) => r.length), 0, 'a refused token is never recorded as a session');
    assert.ok(await authorization.resolve(principal({ sessionId: 'sid-6', tokenIssuer: 'https://other.example', tokenAudience: 'x' })), 'background re-authorization does not ask for binding');
    assert.ok(await authorization.resolve(principal({ sessionId: 'sid-7', authMethod: 'oidc' }), { applySessionPolicy: false }));
    // Turning it off restores the deployment as it was.
    await applyTenantIdentityCommand(opsIdentity, record({ enforceTokenBinding: false, expectedVersion: 2 }), 'c-6', tx);
    assert.ok(await authorization.resolve(principal({ sessionId: 'sid-8', tokenIssuer: 'https://other.example', tokenAudience: 'x' }), asked));

    // ------------------------------------------------ the operator's actions are audited for the customer tenant
    const audited = await tx.query(`select action from corvis_control.audit_event where tenant_id=$1 and (action like 'access.verified_domain.%' or action like 'access.identity_provider.%') order by occurred_at, action`, [tenantId]);
    assert.deepEqual(audited.map((r) => r.action).sort(), ['access.identity_provider.configured', 'access.identity_provider.configured', 'access.identity_provider.configured', 'access.verified_domain.added']);
    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('tenant identity records: ok');
} finally {
  await db.close?.();
}
