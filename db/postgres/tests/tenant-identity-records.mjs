// Real-Postgres acceptance for verified email domains and the per-tenant identity-provider record (F7b #335, F7e #338),
// through the application code: the operator commands and domain check in src/lib/server/identity-records.ts, the view in
// src/lib/server/session-policy.ts and the authoritative lookup in src/lib/server/authorization.ts drive the SQL of migration 095
// inside one transaction that is always rolled back. Covers what the pure-SQL test (tenant-identity-records.sql) cannot:
// that token binding really refuses a request through the authoritative lookup, only when an operator turned it on and
// only for OIDC, and that the view reads the real tables; (migration 099, F7a #334, F7c #336) that Require SSO really refuses
// every sign-in but the bound OIDC one in the authoritative lookup and can never be enabled from a session it would refuse,
// that the MFA a token reported is shown, that "sign out everywhere" names a recorded end-session endpoint, and that a signed
// OIDC back-channel logout token revokes the session immediately while a replayed, forged or expired one does nothing.
// Run after the full migration chain on a disposable database:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/tenant-identity-records.mjs
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { register } from 'node:module';
import { NativePostgresSqlApi } from '../../../src/lib/server/postgres-native.ts';
import { PostgresMembershipAuthorizationRepository } from '../../../src/lib/server/authorization.ts';
import { applyTenantIdentityCommand, emailDomainAllowed, readTenantIdentityRecords } from '../../../src/lib/server/identity-records.ts';

register(new URL('../../../src/lib/server/test-support/alias-loader.mjs', import.meta.url), import.meta.url);
const { PostgresSessionPolicyBackend } = await import('../../../src/lib/server/session-policy.ts');
const { handleBackchannelLogout } = await import('../../../src/lib/server/backchannel-logout.ts');
const { BACKCHANNEL_LOGOUT_EVENT, OidcVerifier } = await import('../../../src/lib/server/oidc.ts');
const { RateLimiter } = await import('../../../src/lib/server/rate-limit.ts');

console.info = console.warn = () => undefined;
const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');

const opsTenant = 'f9500000-0000-4000-8000-0000000000f0';
const tenantId = 'f9500000-0000-4000-8000-000000000001';
const workspaceId = 'f9500000-0000-4000-8000-000000000002';
const opsWorkspace = 'f9500000-0000-4000-8000-0000000000f1';
const operator = { userId: 'f9500000-0000-4000-8000-0000000000a1', subject: 'ops-admin' };
const admin = { userId: 'f9500000-0000-4000-8000-0000000000a2', subject: 'admin-subject' };
const colleague = { userId: 'f9500000-0000-4000-8000-0000000000a3', subject: 'colleague-subject' };
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
    assert.deepEqual(view.identityProvider, { protocol: 'oidc', issuer: 'https://login.example.test', audience: null, source: 'global', status: null, tokenBindingEnforced: false, idpEnforcesMfa: null, endSessionEndpoint: null });
    assert.deepEqual(view.verifiedDomains.map((d) => [d.domain, d.verificationMethod]), [['acme.com', 'dns_txt']]);
    const record = (extra) => ({ kind: 'identity_provider_set', tenantId, protocol: 'oidc', issuer: token.tokenIssuer, audience: token.tokenAudience, status: 'active', enforceTokenBinding: false, idpEnforcesMfa: null, endSessionEndpoint: null, expectedVersion: 0, reason: 'Initial setup', ...extra });
    assert.deepEqual(await applyTenantIdentityCommand(opsIdentity, record(), 'c-3', tx), { changed: true, version: 1 });
    await refused(tx, () => applyTenantIdentityCommand(opsIdentity, record({ expectedVersion: 0, status: 'disabled' }), 'c-4', tx), 'identity provider version conflict');
    view = await backend.view({ ...customerAdmin }, tx);
    assert.deepEqual(view.identityProvider, { protocol: 'oidc', issuer: token.tokenIssuer, audience: token.tokenAudience, source: 'tenant', status: 'active', tokenBindingEnforced: false, idpEnforcesMfa: null, endSessionEndpoint: null });
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

    // ------------------------------------------------ Require SSO (F7a, #334) through the application
    await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'saml','admin-saml'),($1,$3,'oidc',$4)`, [tenantId, admin.userId, colleague.userId, colleague.subject]);
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values ($1,$2,$3,'analyst')`, [tenantId, workspaceId, colleague.userId]);
    const ssoPolicy = (extra) => ({ idleTimeoutMinutes: null, maxSessionMinutes: null, expectedVersion: 0, reason: 'Require SSO for everyone', ...extra });
    const bound = { ...customerAdmin, ...token, sessionId: 'sso-admin' };
    // Binding is off (turned off above): nothing could satisfy Require SSO, so it is refused in SQL and nothing is stored.
    await refused(tx, () => backend.update(bound, ssoPolicy({ requireSso: true }), tx), 'session policy sso needs token binding');
    assert.deepEqual(await applyTenantIdentityCommand(opsIdentity, record({ enforceTokenBinding: true, expectedVersion: 3, idpEnforcesMfa: true, endSessionEndpoint: 'https://idp.acme.com/realms/acme/logout' }), 'c-7', tx), { changed: true, version: 4 });
    // Lock-out safeguard: a session that would itself be refused (no verified token, or the wrong issuer) cannot turn it on.
    await refused(tx, () => backend.update({ ...customerAdmin }, ssoPolicy({ requireSso: true }), tx), 'session policy sso would lock out current session');
    await refused(tx, () => backend.update({ ...bound, tokenIssuer: 'https://other.example' }, ssoPolicy({ requireSso: true }), tx), 'session policy sso would lock out current session');
    await refused(tx, () => backend.update({ ...bound, authMethod: 'saml', subject: 'admin-saml' }, ssoPolicy({ requireSso: true }), tx), 'session policy sso would lock out current session');
    assert.equal(Number((await tx.query(`select count(*)::int as n from corvis_control.tenant_session_policy where tenant_id=$1`, [tenantId]))[0].n), 0, 'refused changes store nothing');
    const enabled = await backend.update(bound, ssoPolicy({ requireSso: true }), tx);
    assert.deepEqual([enabled.changed, enabled.policy.requireSso, enabled.previous.requireSso], [true, true, false]);
    assert.equal(Number((await tx.query(`select count(*)::int as n from corvis_control.email_outbox where tenant_id=$1 and category='security_policy'`, [tenantId]))[0].n) > 0, true, 'every Organization Admin is notified');

    // The authoritative lookup now refuses every interactive sign-in but the bound OIDC one.
    assert.ok(await authorization.resolve(principal({ sessionId: 'sso-1', ...token }), asked), 'the bound OIDC session passes');
    assert.equal(await authorization.resolve(principal({ sessionId: 'sso-2' }), asked), null, 'a signed gateway assertion (no verified token) is refused');
    assert.equal(await authorization.resolve(principal({ sessionId: 'sso-3', tokenIssuer: 'https://other.example', tokenAudience: token.tokenAudience }), asked), null, 'a token from another issuer is refused');
    assert.equal(await authorization.resolve(principal({ sessionId: 'sso-4', subject: 'admin-saml', authMethod: 'saml', ...token }), asked), null, 'a SAML sign-in is refused even when it carries matching claims');
    assert.equal(await tx.query(`select 1 from corvis_control.tenant_session_activity where tenant_id=$1 and session_id in ('sso-2','sso-3','sso-4')`, [tenantId]).then((r) => r.length), 0, 'a refused sign-in is never recorded as a session');
    // Queued background work and callers that do not ask for the interactive checks are unaffected.
    assert.ok(await authorization.resolve(principal({ sessionId: 'sso-5' }), { applySessionPolicy: false }), 'background re-authorization is unaffected');
    assert.ok(await authorization.resolve(principal({ sessionId: 'sso-6', subject: 'admin-saml', authMethod: 'saml' })), 'a caller that does not ask for interactive enforcement is unaffected');
    // The operator cannot weaken the record underneath it while it is on.
    await refused(tx, () => applyTenantIdentityCommand(opsIdentity, record({ enforceTokenBinding: false, expectedVersion: 4 }), 'c-8', tx), 'identity provider change would weaken require sso');
    // MFA as the token reported it is recorded per session and shown, never claimed when nothing was reported.
    assert.ok(await authorization.resolve(principal({ sessionId: 'sso-mfa', mfaUsed: true, ...token }), asked));
    assert.ok(await authorization.resolve(principal({ sessionId: 'sso-mfa-no', ...token }), asked));
    view = await backend.view({ ...bound, mfaUsed: true, authContext: 'urn:mfa' }, tx);
    assert.deepEqual([view.policy.requireSso, view.identityProvider.idpEnforcesMfa, view.identityProvider.endSessionEndpoint, view.currentSession], [true, true, 'https://idp.acme.com/realms/acme/logout', { mfaUsed: true, authContext: 'urn:mfa' }]);
    assert.equal(view.members.find((m) => m.userId === admin.userId).sessionsWithMfa, 1, 'only the session whose token showed MFA counts');
    assert.deepEqual((await backend.view({ ...bound }, tx)).currentSession, { mfaUsed: null, authContext: null }, 'nothing reported: not reported');
    // Turning it off is always allowed, and everyone is let in again.
    const off = await backend.update({ ...customerAdmin }, ssoPolicy({ requireSso: false, expectedVersion: 1 }), tx);
    assert.deepEqual([off.changed, off.policy.requireSso], [true, false]);
    assert.ok(await authorization.resolve(principal({ sessionId: 'sso-7', subject: 'admin-saml', authMethod: 'saml' }), asked), 'with Require SSO off a SAML sign-in resolves again');

    // ------------------------------------------------ "sign out everywhere" names a recorded end-session endpoint (F7c, #336)
    assert.ok(await authorization.resolve(principal({ subject: colleague.subject, sessionId: 'sid-colleague' })));
    const signedOut = await backend.signOut(customerAdmin, { userId: colleague.userId, reason: 'Left the firm' }, tx);
    assert.deepEqual([signedOut.revokedSessions, signedOut.idpEndSessionEndpoint], [1, 'https://idp.acme.com/realms/acme/logout']);

    // ------------------------------------------------ OIDC back-channel logout (F7c, #336)
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'bc-key', alg: 'RS256', use: 'sig' }] };
    const verifier = new OidcVerifier(async (input) => {
      const url = String(input);
      if (url === `${token.tokenIssuer}/.well-known/openid-configuration`) return new Response(JSON.stringify({ issuer: token.tokenIssuer, jwks_uri: `${token.tokenIssuer}/jwks` }));
      if (url === `${token.tokenIssuer}/jwks` || url === 'https://login.example.test/keys') return new Response(JSON.stringify(jwks));
      return new Response('nope', { status: 404 });
    });
    const config = { demoMode: false, authIssuer: 'https://login.example.test', authAudience: 'corvis-global', authJwksUrl: 'https://login.example.test/keys', postgresDsn: dsn };
    const seconds = Math.floor(Date.now() / 1000);
    const logoutToken = (claims = {}, key = privateKey, iss = token.tokenIssuer, aud = token.tokenAudience) => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'bc-key', typ: 'logout+jwt' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ iss, aud, iat: seconds, exp: seconds + 120, jti: `jti-${Math.random()}`, events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, ...claims })).toString('base64url');
      return `${header}.${body}.${sign('RSA-SHA256', Buffer.from(`${header}.${body}`), key).toString('base64url')}`;
    };
    const post = (tokenValue) => handleBackchannelLogout(new Request('https://corvis.test/api/v1/auth/oidc/backchannel-logout', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ logout_token: tokenValue }).toString(),
    }), { config, db: tx, verifier, limiter: new RateLimiter(100) });
    const resolves = async (sessionId) => Boolean(await authorization.resolve(principal({ sessionId })));
    const answer = async (tokenValue) => { await tx.execute('savepoint bc'); const r = await post(tokenValue); await tx.execute('release savepoint bc'); return r; };

    assert.ok(await resolves('bc-1') && await resolves('bc-2') && await resolves('bc-3'), 'three live sessions of the administrator');
    // A valid token ends that one session immediately.
    const ok = await answer(logoutToken({ sub: admin.subject, sid: 'bc-1', jti: 'jti-ok' }));
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '');
    assert.equal(await resolves('bc-1'), false, 'the revoked session no longer resolves, on the very next request');
    assert.ok(await resolves('bc-2'), 'other sessions are untouched');
    // Replayed, forged, expired, wrong-audience, unknown-issuer and malformed tokens are refused and revoke nothing.
    assert.equal((await answer(logoutToken({ sub: admin.subject, sid: 'bc-2', jti: 'jti-ok' }))).status, 400, 'a replayed token id is refused');
    assert.equal((await answer(logoutToken({ sub: admin.subject, sid: 'bc-2' }, attacker.privateKey))).status, 400, 'a forged signature is refused');
    assert.equal((await answer(logoutToken({ sub: admin.subject, sid: 'bc-2', iat: seconds - 4000, exp: seconds - 3000 }))).status, 400, 'an expired token is refused');
    assert.equal((await answer(logoutToken({ sub: admin.subject, sid: 'bc-2' }, privateKey, token.tokenIssuer, 'someone-else'))).status, 400, 'the wrong audience is refused');
    assert.equal((await answer(logoutToken({ sub: admin.subject, sid: 'bc-2' }, privateKey, 'https://evil.example'))).status, 400, 'an unknown issuer is refused');
    assert.equal((await answer(logoutToken({ sub: admin.subject, sid: 'bc-2', nonce: 'n' }))).status, 400, 'a token with a nonce is refused');
    assert.equal((await answer('x.y.z')).status, 400);
    assert.ok(await resolves('bc-2') && await resolves('bc-3'), 'none of the refused tokens revoked anything');
    // A session alone, then a subject alone (every recorded session of that person).
    assert.equal((await answer(logoutToken({ sid: 'bc-2' }))).status, 200);
    assert.equal(await resolves('bc-2'), false);
    assert.equal((await answer(logoutToken({ sub: admin.subject }))).status, 200);
    assert.equal(await resolves('bc-3'), false, 'every recorded session of the subject ended');
    // The shared provider cannot end a session of a tenant that binds tokens to ANOTHER provider (it answers 200, and changes nothing)...
    assert.ok(await resolves('bc-4'));
    assert.equal((await answer(logoutToken({ sub: admin.subject, sid: 'bc-4' }, privateKey, 'https://login.example.test', 'corvis-global'))).status, 200);
    assert.ok(await resolves('bc-4'), 'a logout from the shared provider does not reach a tenant bound to its own provider');
    // ... but does once the tenant accepts the shared provider's tokens (binding off).
    await applyTenantIdentityCommand(opsIdentity, record({ enforceTokenBinding: false, expectedVersion: 4, endSessionEndpoint: 'https://idp.acme.com/realms/acme/logout' }), 'c-9', tx);
    assert.equal((await answer(logoutToken({ sub: admin.subject, sid: 'bc-4' }, privateKey, 'https://login.example.test', 'corvis-global'))).status, 200);
    assert.equal(await resolves('bc-4'), false);
    // Recorded and audited without naming anyone, and the revocation says who ended it.
    const revocations = await tx.query(`select revoked_by_subject, reason from corvis_control.session_revocation where tenant_id=$1 and session_id in ('bc-1','bc-2','bc-3','bc-4')`, [tenantId]);
    assert.equal(revocations.length, 4);
    assert.ok(revocations.every((row) => row.revoked_by_subject === 'idp:backchannel-logout'));
    const audits = await tx.query(`select metadata::text as metadata from corvis_control.audit_event where tenant_id=$1 and action='access.session.idp_logout'`, [tenantId]);
    assert.equal(audits.length, 4);
    assert.ok(audits.every((row) => !row.metadata.includes(admin.subject) && !row.metadata.includes('bc-')), 'the audit trail never names the person or the session');

    // ------------------------------------------------ the operator's actions are audited for the customer tenant
    const audited = await tx.query(`select action from corvis_control.audit_event where tenant_id=$1 and (action like 'access.verified_domain.%' or action like 'access.identity_provider.%') order by occurred_at, action`, [tenantId]);
    assert.deepEqual(audited.map((r) => r.action).sort(), ['access.identity_provider.configured', 'access.identity_provider.configured', 'access.identity_provider.configured', 'access.identity_provider.configured', 'access.identity_provider.configured', 'access.verified_domain.added']);
    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('tenant identity records: ok');
} finally {
  await db.close?.();
}
