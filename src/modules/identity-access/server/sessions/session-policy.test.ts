import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { AuditEvent, RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import type { SessionPolicy } from "../../domain/session-policy.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";

// See src/modules/sources/server/connections/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
register(new URL("../../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
delete process.env.CORVIS_DATABASE_DSN;
console.warn = console.info = console.error = () => undefined;

const { DemoSessionPolicyStore, demoSessionPolicyStore } = await import("../../adapters/session-policy-store.ts");
const { DataGovernanceError } = await import("../../../governance/server/lifecycle/data-governance.ts");
const {
  createSessionPolicyService, demoSessionPolicyService, NO_SESSION_POLICY, overrideSessionPolicyService, PostgresSessionPolicyBackend,
  postgresSessionPolicyService, sessionPolicyErrorResponse, sessionPolicyService,
} = await import("./session-policy.ts");
const { SessionPolicyValidationError } = await import("../../domain/session-policy.ts");
const { platform } = await import("../../../../platform/data/platform.ts");

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const USER = "9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const refusal = (code: string, status: number) => (error: unknown) => error instanceof DataGovernanceError && error.code === code && error.status === status;

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "idp|alex", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["admin"], isTenantAdmin: true, authMethod: "oidc", sessionId: "sid-1",
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}
const update = { idleTimeoutMinutes: 30, maxSessionMinutes: 480, expectedVersion: 0, reason: "Align with our policy" };

// ------------------------------------------------------------------ Postgres backend, against a recording database
type Call = { kind: "query" | "execute"; sql: string; parameters: PostgresPrimitive[] };
class RecordingDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  private readonly respond: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[];
  failOn: RegExp | undefined;
  constructor(respond: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[] = () => []) { this.respond = respond; }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ kind: "query", sql, parameters });
    return this.respond(sql, parameters);
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.calls.push({ kind: "execute", sql, parameters });
    if (this.failOn?.test(sql)) throw new Error("queue unavailable");
  }
  async health() { return true; }
  find(pattern: RegExp): Call | undefined { return this.calls.find((call) => pattern.test(call.sql)); }
  count(pattern: RegExp): number { return this.calls.filter((call) => pattern.test(call.sql)).length; }
}

const policyRow = (overrides: PostgresRow = {}): PostgresRow => ({
  idle_timeout_minutes: 30, max_session_minutes: 480, require_sso: false, version: 2, updated_at: "2026-10-03 09:00:00+00", updated_by_subject: "idp|morgan", ...overrides,
});

test("a policy change calls the SQL function as the caller, and queues a mandatory notice to Organization Admins only when something changed", async () => {
  const db = new RecordingDb((sql) => (/from corvis_control\.set_tenant_session_policy/.test(sql) ? [policyRow({ version: 2 })] : /from corvis_control\.tenant_session_policy/.test(sql) ? [policyRow({ version: 1, idle_timeout_minutes: 60 })] : []));
  const backend = new PostgresSessionPolicyBackend(() => db, () => null);
  const change = await backend.update(identity(), { ...update, expectedVersion: 1 }, db);
  assert.equal(change.changed, true);
  assert.deepEqual([change.previous.version, change.previous.idleTimeoutMinutes, change.policy.version, change.policy.idleTimeoutMinutes, change.policy.updatedBy], [1, 60, 2, 30, "idp|morgan"]);
  assert.deepEqual(db.find(/set_tenant_session_policy/)!.parameters, [TENANT, "oidc", "idp|alex", 30, 480, 1, null, null, null], "the SQL function sees the real actor, tenant and the version the change is based on; Require SSO left out keeps its stored value");
  const outbox = db.find(/insert into corvis_control\.email_outbox/)!;
  assert.ok(outbox, "a notice is queued");
  assert.equal(outbox.parameters[0], TENANT);
  assert.equal(outbox.parameters[1], "security_policy");
  assert.equal(outbox.parameters[2], null, "tenant-wide: not tied to one workspace");
  assert.deepEqual(JSON.parse(String(outbox.parameters[3])), ["tenant_admin"], "Organization Admins only");
  assert.deepEqual(JSON.parse(String(outbox.parameters[4])), { event: "policy_changed" }, "an event description, never the values");
  assert.match(String(outbox.parameters[5]), /^security_policy:[0-9a-f-]{36}$/);
  assert.equal(db.count(/^savepoint corvis_notification/), 1, "the notice cannot abort the change");
  assert.equal(db.count(/^release savepoint corvis_notification/), 1);
});

test("F7a: Require SSO is passed with the actor's own verified issuer and audience so SQL can refuse a lock-out, and the change is announced like any other", async () => {
  const db = new RecordingDb((sql) => (/from corvis_control\.set_tenant_session_policy/.test(sql) ? [policyRow({ require_sso: true, version: 2 })] : /from corvis_control\.tenant_session_policy/.test(sql) ? [policyRow({ version: 1 })] : []));
  const backend = new PostgresSessionPolicyBackend(() => db, () => null);
  const change = await backend.update(identity({ tokenIssuer: "https://idp.acme.com", tokenAudience: "corvis" }), { ...update, requireSso: true, expectedVersion: 1 }, db);
  assert.deepEqual([change.changed, change.previous.requireSso, change.policy.requireSso], [true, false, true]);
  assert.deepEqual(db.find(/set_tenant_session_policy/)!.parameters, [TENANT, "oidc", "idp|alex", 30, 480, 1, true, "https://idp.acme.com", "corvis"]);
  assert.match(db.find(/set_tenant_session_policy/)!.sql, /\$7::boolean,\$8,\$9\)/);
  assert.equal(db.count(/email_outbox/), 1);
  // Turning it off is also stated, and a session without verified token claims passes nulls (which can only ever refuse an enable).
  const off = new RecordingDb((sql) => (/from corvis_control\.set_tenant_session_policy/.test(sql) ? [policyRow({ require_sso: false, version: 3 })] : [policyRow({ require_sso: true, version: 2 })]));
  const disabled = await new PostgresSessionPolicyBackend(() => off, () => null).update(identity(), { ...update, requireSso: false, expectedVersion: 2 }, off);
  assert.deepEqual([disabled.changed, disabled.policy.requireSso], [true, false]);
  assert.deepEqual(off.find(/set_tenant_session_policy/)!.parameters.slice(6), [false, null, null]);
});

test("setting the values the policy already has queues no notice", async () => {
  const same = policyRow({ version: 2 });
  const db = new RecordingDb((sql) => (/from corvis_control\.(set_tenant_session_policy|tenant_session_policy)/.test(sql) ? [same] : []));
  const change = await new PostgresSessionPolicyBackend(() => db, () => null).update(identity(), { ...update, expectedVersion: 2 }, db);
  assert.equal(change.changed, false);
  assert.equal(db.count(/email_outbox/), 0);
});

test("clearing a policy that never existed returns 'no policy' and changes nothing", async () => {
  const db = new RecordingDb();
  const change = await new PostgresSessionPolicyBackend(() => db, () => null).update(identity(), { ...update, idleTimeoutMinutes: null, maxSessionMinutes: null }, db);
  assert.deepEqual([change.changed, change.policy, change.previous], [false, NO_SESSION_POLICY, NO_SESSION_POLICY]);
  assert.equal(db.count(/email_outbox/), 0);
});

test("a notice that cannot be queued never undoes the change", async () => {
  const db = new RecordingDb((sql) => (/from corvis_control\.set_tenant_session_policy/.test(sql) ? [policyRow()] : []));
  db.failOn = /email_outbox/;
  const change = await new PostgresSessionPolicyBackend(() => db, () => null).update(identity(), update, db);
  assert.equal(change.changed, true);
  assert.equal(db.count(/^rollback to savepoint corvis_notification/), 1, "only the failed notice is rolled back");
});

test("the database refusing a change (not an admin, out of bounds, stale version) propagates and queues nothing", async () => {
  const db = new RecordingDb((sql) => { if (/set_tenant_session_policy/.test(sql)) throw new Error("session policy version conflict"); return []; });
  await assert.rejects(() => new PostgresSessionPolicyBackend(() => db, () => null).update(identity(), update, db), /session policy version conflict/);
  assert.equal(db.count(/email_outbox/), 0);
});

test("signing a user out calls the SQL function as the caller, reports how many sessions ended and queues a notice", async () => {
  const db = new RecordingDb((sql) => (/sign_out_user_everywhere/.test(sql) ? [{ revoked: "3" }] : [{ label: "morgan.lee@example.test" }]));
  const result = await new PostgresSessionPolicyBackend(() => db, () => null).signOut(identity(), { userId: USER, reason: "Left the firm" }, db);
  assert.deepEqual(result, { userId: USER, label: "morgan.lee@example.test", revokedSessions: 3, idpEndSessionEndpoint: null }, "no end-session endpoint recorded: nothing is said about the identity provider");
  assert.deepEqual(db.find(/sign_out_user_everywhere/)!.parameters, [TENANT, "oidc", "idp|alex", USER, "Left the firm"]);
  assert.deepEqual(JSON.parse(String(db.find(/email_outbox/)!.parameters[4])), { event: "user_signed_out" });
});

test("F7c: when Corvis support recorded the identity provider's end-session endpoint, the result carries it (it is never called)", async () => {
  const db = new RecordingDb((sql) => (/sign_out_user_everywhere/.test(sql) ? [{ revoked: 1 }] : /end_session_endpoint/.test(sql) ? [{ end_session_endpoint: "https://idp.acme.com/logout" }] : [{ label: "morgan" }]));
  const result = await new PostgresSessionPolicyBackend(() => db, () => null).signOut(identity(), { userId: USER, reason: "Left the firm" }, db);
  assert.equal(result.idpEndSessionEndpoint, "https://idp.acme.com/logout");
  assert.deepEqual(db.find(/end_session_endpoint/)!.parameters, [TENANT], "read for the caller's own tenant only");
});

test("a sign-out the database refuses queues no notice", async () => {
  const db = new RecordingDb((sql) => { if (/sign_out_user_everywhere/.test(sql)) throw new Error("session sign-out cannot target current user"); return []; });
  await assert.rejects(() => new PostgresSessionPolicyBackend(() => db, () => null).signOut(identity(), { userId: USER, reason: "Myself" }, db), /cannot target current user/);
  assert.equal(db.count(/email_outbox/), 0);
});

test("the view reads the identity provider, SCIM, sign-in methods, policy and sessions, scoped to the caller's tenant, without ever selecting the SCIM token", async () => {
  const db = new RecordingDb((sql) => {
    if (/from corvis_control\.tenant_session_policy where/.test(sql)) return [policyRow({ max_session_minutes: null })];
    if (/tenant_scim_configuration/.test(sql)) return [{ enabled: true, auth_method: "saml", default_role_name: "viewer", updated_at: "2026-08-14 09:00:00+00", workspace_name: "Primary", active_users: "12" }];
    if (/group by auth_method/.test(sql)) return [{ auth_method: "oidc", users: "7" }, { auth_method: "saml", users: "2" }];
    if (/tenant_identity_provider/.test(sql)) return [];
    if (/tenant_verified_domain/.test(sql)) return [{ domain: "example.test", verification_method: "dns_txt", verified_at: "2026-10-01 09:00:00+00" }];
    return [
      { user_id: USER, label: "alex@example.test", is_current: "true", active_sessions: "2", sessions_with_mfa: "1" },
      { user_id: "00000000-0000-4000-8000-000000000002", label: "idp|morgan", is_current: false, active_sessions: 0, sessions_with_mfa: 0 },
    ];
  });
  const view = await new PostgresSessionPolicyBackend(() => db, () => "https://login.example.test").view(identity(), db);
  assert.deepEqual(view.policy, { idleTimeoutMinutes: 30, maxSessionMinutes: null, requireSso: false, version: 2, updatedAt: "2026-10-03 09:00:00+00", updatedBy: "idp|morgan" });
  assert.deepEqual(view.bounds, { idleTimeoutMinutes: { min: 15, max: 480 }, maxSessionMinutes: { min: 60, max: 10080 } });
  // No record for the tenant: the shared provider every organization uses, and nothing enforced.
  assert.deepEqual(view.identityProvider, { protocol: "oidc", issuer: "https://login.example.test", audience: null, source: "global", status: null, tokenBindingEnforced: false, idpEnforcesMfa: null, endSessionEndpoint: null });
  assert.deepEqual(view.verifiedDomains, [{ domain: "example.test", verificationMethod: "dns_txt", verifiedAt: "2026-10-01 09:00:00+00" }]);
  assert.deepEqual(view.scim, { configured: true, enabled: true, authMethod: "saml", defaultWorkspaceName: "Primary", defaultRole: "viewer", activeUsers: 12, updatedAt: "2026-08-14 09:00:00+00" });
  assert.deepEqual(view.signInMethods, [{ authMethod: "oidc", users: 7 }, { authMethod: "saml", users: 2 }]);
  assert.deepEqual(view.members, [
    { userId: USER, label: "alex@example.test", isCurrentUser: true, activeSessions: 2, sessionsWithMfa: 1 },
    { userId: "00000000-0000-4000-8000-000000000002", label: "idp|morgan", isCurrentUser: false, activeSessions: 0, sessionsWithMfa: 0 },
  ]);
  assert.deepEqual(view.currentSession, { mfaUsed: null, authContext: null }, "no amr on the caller's token: not reported");
  for (const call of db.calls) {
    assert.equal(call.parameters[0], TENANT, `every query is scoped to the caller's tenant: ${call.sql.slice(0, 60)}`);
    assert.doesNotMatch(call.sql, /token_sha256/, "the SCIM token hash is never read");
  }
  const members = db.calls.find((call) => /make_interval/.test(call.sql))!;
  assert.deepEqual(members.parameters, [TENANT, "oidc", "idp|alex"], "the caller is marked from their own identity");
  assert.match(members.sql, /session_revocation/, "a signed-out session is not counted as active");
  assert.match(members.sql, /and a\.mfa_used\)/, "the sessions with MFA are counted from what each session's token reported");
});

test("F7e: the view shows the tenant's own recorded identity provider, with its audience, status and whether binding is enforced", async () => {
  const db = new RecordingDb((sql) => /tenant_identity_provider/.test(sql)
    ? [{ protocol: "oidc", issuer: "https://idp.acme.com/realms/acme", audience: "corvis-acme", status: "active", enforce_token_binding: true, idp_enforces_mfa: true, end_session_endpoint: "https://idp.acme.com/logout", version: 4, updated_at: "2026-10-02 09:00:00+00" }]
    : []);
  const view = await new PostgresSessionPolicyBackend(() => db, () => "https://login.example.test").view(identity({ mfaUsed: true, authContext: "urn:mfa" }), db);
  assert.deepEqual(view.identityProvider, {
    protocol: "oidc", issuer: "https://idp.acme.com/realms/acme", audience: "corvis-acme", source: "tenant", status: "active", tokenBindingEnforced: true,
    idpEnforcesMfa: true, endSessionEndpoint: "https://idp.acme.com/logout",
  });
  assert.deepEqual(view.currentSession, { mfaUsed: true, authContext: "urn:mfa" }, "this session's evidence is what the administrator's own verified token reported");
  assert.equal((await new PostgresSessionPolicyBackend(() => db, () => null).view(identity({ mfaUsed: false }), db)).currentSession.mfaUsed, false, "a reported single factor is not the same as not reported");
  assert.deepEqual(view.verifiedDomains, []);
  const saml = new RecordingDb((sql) => /tenant_identity_provider/.test(sql)
    ? [{ protocol: "saml", issuer: "urn:acme:idp", audience: "urn:corvis", status: "pending", enforce_token_binding: false, idp_enforces_mfa: null, end_session_endpoint: null, version: 1, updated_at: "x" }]
    : []);
  assert.deepEqual((await new PostgresSessionPolicyBackend(() => saml, () => null).view(identity(), saml)).identityProvider,
    { protocol: "saml", issuer: "urn:acme:idp", audience: "urn:corvis", status: "pending", tokenBindingEnforced: false, source: "tenant", idpEnforcesMfa: null, endSessionEndpoint: null });
});

test("the view reports no SCIM, no policy, no issuer and a SAML default as such", async () => {
  const db = new RecordingDb((sql) => (/tenant_scim_configuration/.test(sql) ? [] : /group by auth_method/.test(sql) ? [] : []));
  const view = await new PostgresSessionPolicyBackend(() => db, () => null).view(identity(), db);
  assert.deepEqual(view.policy, NO_SESSION_POLICY);
  assert.deepEqual(view.scim, { configured: false, enabled: false, authMethod: null, defaultWorkspaceName: null, defaultRole: null, activeUsers: 0, updatedAt: null });
  assert.deepEqual([view.identityProvider.issuer, view.signInMethods, view.members], [null, [], []]);
  const odd = new RecordingDb((sql) => (/tenant_scim_configuration/.test(sql) ? [{ enabled: "false", auth_method: "oidc", default_role_name: null, updated_at: null, workspace_name: null, active_users: 0 }] : []));
  const scim = (await new PostgresSessionPolicyBackend(() => odd, () => null).view(identity(), odd)).scim;
  assert.deepEqual([scim.enabled, scim.authMethod, scim.defaultRole, scim.defaultWorkspaceName], [false, "oidc", null, null]);
});

test("the view uses the default database when none is passed", async () => {
  const db = new RecordingDb();
  await new PostgresSessionPolicyBackend(() => db, () => null).view(identity());
  assert.ok(db.calls.length >= 6);
});

// ------------------------------------------------------------------ the service: authorization and audit
async function withAuditCapture<T>(run: (events: AuditEvent[]) => Promise<T>): Promise<T> {
  const events: AuditEvent[] = [];
  const port = platform();
  const original = port.audit.bind(port);
  port.audit = async (event) => { events.push(event); await original(event); };
  try { return await run(events); } finally { port.audit = original; }
}

test("only Organization Admins use the service; a refused command is not audited", async () => {
  await withAuditCapture(async (events) => {
    const service = createSessionPolicyService(new DemoSessionPolicyStore());
    for (const who of [identity({ roles: ["analyst"], isTenantAdmin: false }), identity({ isTenantAdmin: false }), identity({ isTenantAdmin: undefined })]) {
      await assert.rejects(() => service.view(who), refusal("tenant_admin_required", 403));
      await assert.rejects(() => service.update(who, update, "c"), refusal("tenant_admin_required", 403));
      await assert.rejects(() => service.signOut(who, { userId: USER, reason: "Left the firm" }, "c"), refusal("tenant_admin_required", 403));
    }
    assert.equal(events.length, 0);
  });
});

test("a policy change and a sign-out are each audited once, with who, why and the before and after, and no change is not audited", async () => {
  await withAuditCapture(async (events) => {
    const service = createSessionPolicyService(new DemoSessionPolicyStore());
    const admin = identity({ tenantId: "tenant-audit", authMethod: "demo" });
    const saved = await service.update(admin, update, "corr-1");
    assert.deepEqual([saved.idleTimeoutMinutes, saved.maxSessionMinutes, saved.version, saved.updatedBy], [30, 480, 1, "idp|alex"]);
    assert.equal(events.length, 1);
    assert.deepEqual([events[0]!.action, events[0]!.actorSubject, events[0]!.targetType, events[0]!.targetId, events[0]!.correlationId, events[0]!.outcome],
      ["access.session_policy.updated", "idp|alex", "session_policy", "tenant-audit", "corr-1", "success"]);
    assert.deepEqual(events[0]!.metadata, {
      previousIdleTimeoutMinutes: null, previousMaxSessionMinutes: null, previousRequireSso: false, idleTimeoutMinutes: 30, maxSessionMinutes: 480, requireSso: false, version: 1, reason: "Align with our policy",
    });

    await service.update(admin, { ...update, expectedVersion: 1 }, "corr-2");
    assert.equal(events.length, 1, "the same values change nothing and are not audited");

    const view = await service.view(admin);
    const colleague = view.members.find((member) => !member.isCurrentUser && member.activeSessions > 0)!;
    const result = await service.signOut(admin, { userId: colleague.userId, reason: "Lost laptop" }, "corr-3");
    assert.equal(result.revokedSessions, colleague.activeSessions);
    assert.equal(events.length, 2);
    assert.deepEqual([events[1]!.action, events[1]!.targetType, events[1]!.targetId, events[1]!.metadata], [
      "access.session.signed_out_everywhere", "user_sessions", colleague.userId,
      { revokedSessions: colleague.activeSessions, idpSessionEndRequired: false, idpEndSessionEndpoint: null, reason: "Lost laptop" },
    ]);
    await service.signOut(admin, { userId: colleague.userId, reason: "Lost laptop" }, "corr-4");
    const myId = view.members.find((member) => member.isCurrentUser)!.userId;
    await assert.rejects(() => service.signOut(admin, { userId: myId, reason: "Myself" }, "corr-5"), refusal("cannot_sign_out_current_user", 409));
    assert.equal(events.length, 3, "signing the same person out again is recorded (it ended zero sessions), the refused self sign-out is not");
    assert.equal(events[2]!.metadata?.revokedSessions, 0);
  });
});

test("a limit cannot be saved from a session that cannot be measured, because it would lock the whole organization out", async () => {
  await withAuditCapture(async (events) => {
    const service = createSessionPolicyService(new DemoSessionPolicyStore());
    const unmeasurable = identity({ tenantId: "tenant-lockout", authMethod: "demo", sessionId: "token-0123abcd" });
    await assert.rejects(() => service.update(unmeasurable, update, "c"), refusal("session_not_measurable", 409));
    await assert.rejects(() => service.update(unmeasurable, { ...update, maxSessionMinutes: null }, "c"), refusal("session_not_measurable", 409));
    await assert.rejects(() => service.update(unmeasurable, { ...update, idleTimeoutMinutes: null }, "c"), refusal("session_not_measurable", 409));
    assert.equal((await service.view(unmeasurable)).policy.version, 0, "nothing was saved");
    assert.equal(events.length, 0);
    // Clearing every limit is always allowed, and a measurable session may set limits.
    const cleared = await service.update(unmeasurable, { ...update, idleTimeoutMinutes: null, maxSessionMinutes: null }, "c");
    assert.equal(cleared.version, 0, "nothing to clear: no change");
    assert.equal((await service.update(identity({ tenantId: "tenant-lockout" }), update, "c")).version, 1);
    assert.equal((await service.update(unmeasurable, { ...update, idleTimeoutMinutes: null, maxSessionMinutes: null, expectedVersion: 1 }, "c")).version, 2, "an admin on an unmeasurable session can still remove limits");
  });
});

// ------------------------------------------------------------------ the demo store follows the Postgres rules
test("the demo store refuses a stale version, the same values change nothing and tenants are isolated", async () => {
  const store = new DemoSessionPolicyStore();
  const a = identity({ tenantId: "tenant-a" });
  const b = identity({ tenantId: "tenant-b" });
  await assert.rejects(() => store.update(a, { ...update, expectedVersion: 3 }), refusal("session_policy_version_conflict", 409));
  const first = await store.update(a, update);
  assert.deepEqual([first.changed, first.policy.version, first.previous.version], [true, 1, 0]);
  const same = await store.update(a, { ...update, expectedVersion: 1 });
  assert.deepEqual([same.changed, same.policy.version], [false, 1]);
  await assert.rejects(() => store.update(a, { ...update, expectedVersion: 0 }), refusal("session_policy_version_conflict", 409));
  assert.equal((await store.view(b)).policy.version, 0, "another tenant is untouched");
  const cleared = await store.update(a, { ...update, idleTimeoutMinutes: null, maxSessionMinutes: null, expectedVersion: 1 });
  assert.deepEqual([cleared.changed, cleared.policy.idleTimeoutMinutes, cleared.policy.version], [true, null, 2]);
});

test("the demo store signs people out the way SQL does: not yourself, not strangers, and only what was active", async () => {
  const store = new DemoSessionPolicyStore();
  const admin = identity({ tenantId: "tenant-signout", subject: "demo-user" });
  const view = await store.view(admin);
  assert.equal(view.members.filter((member) => member.isCurrentUser).length, 1);
  assert.deepEqual(view.signInMethods, [{ authMethod: "oidc", users: view.members.length }]);
  const me = view.members.find((member) => member.isCurrentUser)!;
  await assert.rejects(() => store.signOut(admin, { userId: me.userId, reason: "Myself" }), refusal("cannot_sign_out_current_user", 409));
  await assert.rejects(() => store.signOut(admin, { userId: "00000000-0000-4000-8000-00000000ffff", reason: "Stranger" }), refusal("member_not_found", 404));
  const other = view.members.find((member) => !member.isCurrentUser && member.activeSessions > 0)!;
  const result = await store.signOut(admin, { userId: other.userId, reason: "Lost laptop" });
  assert.deepEqual(result, { userId: other.userId, label: other.label, revokedSessions: other.activeSessions, idpEndSessionEndpoint: null });
  assert.equal((await store.view(admin)).members.find((member) => member.userId === other.userId)!.activeSessions, 0);
  assert.equal((await store.signOut(admin, { userId: other.userId, reason: "Again" })).revokedSessions, 0);
  assert.equal((await store.view(identity({ tenantId: "tenant-other" }))).members.find((member) => member.userId === other.userId)!.activeSessions, other.activeSessions, "another tenant is untouched");
});

// ------------------------------------------------------------------ selection and error mapping
test("the service follows demo mode, and can be pinned by tests", () => {
  assert.equal(sessionPolicyService(), demoSessionPolicyService);
  assert.equal(demoSessionPolicyStore(), demoSessionPolicyStore());
  const pinned = createSessionPolicyService(new DemoSessionPolicyStore());
  overrideSessionPolicyService(pinned);
  assert.equal(sessionPolicyService(), pinned);
  overrideSessionPolicyService();
  process.env.CORVIS_DEMO_MODE = "";
  try { assert.equal(sessionPolicyService(), postgresSessionPolicyService); } finally { process.env.CORVIS_DEMO_MODE = "true"; }
});

test("typed failures keep their code and status; anything else goes through the shared mapper", async () => {
  const typed = sessionPolicyErrorResponse(new SessionPolicyValidationError("invalid_reason"), "c-1");
  assert.deepEqual([typed.status, await typed.json()], [400, { error: "invalid_reason", correlationId: "c-1" }]);
  const governance = sessionPolicyErrorResponse(new DataGovernanceError("member_not_found", 404), "c-2");
  assert.deepEqual([governance.status, await governance.json()], [404, { error: "member_not_found", correlationId: "c-2" }]);
  const sql = sessionPolicyErrorResponse(new Error("session policy bounds exceeded"), "c-3");
  assert.deepEqual([sql.status, ((await sql.json()) as { error: string }).error], [400, "session_policy_out_of_bounds"]);
  const unknown = sessionPolicyErrorResponse(new Error("boom"), "c-4");
  assert.equal(unknown.status, 500);
});

test("a stale view of the policy type compiles with every field", () => {
  const policy: SessionPolicy = NO_SESSION_POLICY;
  assert.equal(policy.version, 0);
});

test("what the service audits is what an Organization Admin sees (and exports) in the tenant access audit", async () => {
  const { TENANT_ACCESS_AUDIT_FILTER } = await import("../tenants/tenant-admin-self-service.ts");
  assert.match(TENANT_ACCESS_AUDIT_FILTER, /action like 'access\.session_policy\.%'/);
  assert.match(TENANT_ACCESS_AUDIT_FILTER, /action like 'access\.session\.%'/);
  assert.match(TENANT_ACCESS_AUDIT_FILTER, /'session_policy'/);
  assert.match(TENANT_ACCESS_AUDIT_FILTER, /'user_sessions'/);
});

// ------------------------------------------------------------------ F7a Require SSO and F7c end-session, through the service and the demo store
test("F7a: Require SSO is audited with the before and after, never changes silently and is refused without a bound provider or from a session SQL would refuse", async () => {
  await withAuditCapture(async (events) => {
    const service = createSessionPolicyService(new DemoSessionPolicyStore());
    // An organization whose record binds nothing cannot require SSO.
    const unbound = identity({ tenantId: "tenant-sso-unbound", authMethod: "demo" });
    await assert.rejects(() => service.update(unbound, { ...update, requireSso: true }, "c"), refusal("sso_requires_token_binding", 409));
    assert.equal((await service.view(unbound)).policy.version, 0, "nothing was saved");
    assert.equal(events.length, 0);

    const bound = identity({ tenantId: "sso-ready-tenant", authMethod: "demo" });
    const on = await service.update(bound, { ...update, requireSso: true }, "c-on");
    assert.deepEqual([on.requireSso, on.version], [true, 1]);
    assert.deepEqual([events[0]!.metadata?.previousRequireSso, events[0]!.metadata?.requireSso], [false, true]);
    // Leaving it out keeps the stored value: a limit change by a caller that does not state it can never weaken it.
    const kept = await service.update(bound, { ...update, idleTimeoutMinutes: 60, expectedVersion: 1 }, "c-keep");
    assert.deepEqual([kept.requireSso, kept.version], [true, 2]);
    // Stating the same value changes nothing; turning it off is always allowed and audited.
    assert.equal((await service.update(bound, { ...update, idleTimeoutMinutes: 60, requireSso: true, expectedVersion: 2 }, "c-same")).version, 2);
    const off = await service.update(bound, { ...update, idleTimeoutMinutes: 60, requireSso: false, expectedVersion: 2 }, "c-off");
    assert.deepEqual([off.requireSso, off.version], [false, 3]);
    assert.deepEqual(events.map((event) => event.metadata?.requireSso), [true, true, false]);
    // The view of a bound organization shows what Corvis support recorded about MFA and the end-session endpoint.
    const view = await service.view(bound);
    assert.deepEqual([view.identityProvider.tokenBindingEnforced, view.identityProvider.idpEnforcesMfa, view.identityProvider.endSessionEndpoint], [true, true, "https://login.meridian.example/demo/logout"]);
    assert.deepEqual(view.currentSession, { mfaUsed: null, authContext: null });
    assert.equal((await service.view(identity({ tenantId: "sso-ready-two", mfaUsed: true, authContext: "2" }))).currentSession.mfaUsed, true);
    assert.equal(view.members.find((member) => member.activeSessions === 2)!.sessionsWithMfa, 1);
  });
});

test("F7c: signing out in an organization with a recorded end-session endpoint says the identity provider session must be ended there, in the audit event and the result", async () => {
  await withAuditCapture(async (events) => {
    const service = createSessionPolicyService(new DemoSessionPolicyStore());
    const admin = identity({ tenantId: "sso-ready-signout", authMethod: "demo", subject: "demo-user" });
    const view = await service.view(admin);
    const other = view.members.find((member) => !member.isCurrentUser && member.activeSessions > 0)!;
    const result = await service.signOut(admin, { userId: other.userId, reason: "Lost laptop" }, "c-so");
    assert.equal(result.idpEndSessionEndpoint, "https://login.meridian.example/demo/logout");
    assert.deepEqual([events[0]!.metadata?.idpSessionEndRequired, events[0]!.metadata?.idpEndSessionEndpoint], [true, "https://login.meridian.example/demo/logout"]);
    assert.equal((await service.view(admin)).members.find((member) => member.userId === other.userId)!.sessionsWithMfa, 0);
  });
});
