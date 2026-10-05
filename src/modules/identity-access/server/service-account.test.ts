import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import type { CreateServiceAccountCommand } from "../domain/service-account.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import {
  PostgresServiceAccountBackend,
  ServiceAccountError,
  assertCanManageServiceAccounts,
  daysFromNow,
  serviceAccountAuditEvent,
  toServiceAccount,
  toServiceAccountCredential,
} from "./service-account.ts";
import {
  credentialIdOf,
  hashCredentialSecret,
  mintCredential,
  sameDigest,
  verifyServiceAccountCredential,
} from "./service-account-credential.ts";

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const ACCOUNT = "44444444-dddd-4ddd-8ddd-444444444444";
const OTHER = "55555555-eeee-4eee-8eee-555555555555";
const refusal = (code: string, status: number) => (error: unknown) => error instanceof ServiceAccountError && error.code === code && error.status === status;

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "idp|alex", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["admin"], isTenantAdmin: true, authMethod: "oidc", sessionId: "s",
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}

type Call = { sql: string; parameters: PostgresPrimitive[] };
class ScriptedDb implements PostgresSqlApi {
  calls: Call[] = [];
  handler: (call: Call) => PostgresRow[] = () => [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    const call = { sql, parameters };
    this.calls.push(call);
    return this.handler(call);
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.calls.push({ sql, parameters }); }
  async health(): Promise<boolean> { return true; }
}

// ------------------------------------------------------------------ the credential secret
test("a minted secret embeds its credential id, is 256 random bits, and only its SHA-256 is derived for storage", () => {
  const first = mintCredential();
  const second = mintCredential();
  assert.match(first.secret, /^corvis_sa_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.secret, second.secret);
  assert.notEqual(first.credentialId, second.credentialId);
  assert.equal(credentialIdOf(first.secret), first.credentialId);
  assert.equal(first.secretSha256, createHash("sha256").update(first.secret).digest("hex"));
  assert.equal(hashCredentialSecret(first.secret), first.secretSha256);
  assert.equal(first.secretSha256.includes(first.secret), false);
});

test("only a well-formed secret names a credential", () => {
  const { secret, credentialId } = mintCredential();
  assert.equal(credentialIdOf(secret), credentialId);
  for (const value of [undefined, null, 5, {}, "", "corvis_sa_", secret.slice(0, -1), `${secret}x`, secret.replace("corvis_sa_", "corvis_xx_"), ` ${secret}`, secret.toUpperCase()]) {
    assert.equal(credentialIdOf(value), null, String(value));
  }
});

test("digests are compared as 32-byte values, never as text", () => {
  const digest = hashCredentialSecret("one");
  assert.equal(sameDigest(digest, digest), true);
  assert.equal(sameDigest(digest, hashCredentialSecret("two")), false);
  assert.equal(sameDigest(digest, digest.slice(0, 62)), false, "a short stored value never matches");
  assert.equal(sameDigest("zz", "zz"), false, "a non-hex value decodes to nothing");
  assert.equal(sameDigest(digest, ""), false);
});

// ------------------------------------------------------------------ verifying a presented credential
function record(secret: string, overrides: Record<string, unknown> = {}): PostgresRow {
  return {
    tenant_id: TENANT, credential_id: credentialIdOf(secret), service_account_id: ACCOUNT, secret_sha256: hashCredentialSecret(secret), subject: `service-account:${ACCOUNT}`,
    workspace_id: WORKSPACE, role_name: "analyst", usable: true, ...overrides,
  };
}

test("a valid credential verifies to the subject the authorization path resolves, and the use is recorded", async () => {
  const { secret, credentialId } = mintCredential();
  const db = new ScriptedDb();
  db.handler = (call) => /^select/.test(call.sql.trim()) ? [record(secret)] : [];
  const verified = await verifyServiceAccountCredential(secret, db);
  assert.deepEqual(verified, { tenantId: TENANT, serviceAccountId: ACCOUNT, credentialId, subject: `service-account:${ACCOUNT}`, workspaceId: WORKSPACE, roleName: "analyst" });
  // The lookup is by the credential id the secret names; the secret itself never reaches the database.
  assert.deepEqual(db.calls[0]!.parameters, [credentialId]);
  assert.equal(db.calls.some((call) => call.parameters.includes(secret)), false);
  // Validity (status, expiry, rotation end, account state) is decided by the database clock in the same lookup.
  assert.match(db.calls[0]!.sql, /c\.status = 'active' and c\.expires_at > now\(\) and \(c\.ends_at is null or c\.ends_at > now\(\)\)/);
  assert.match(db.calls[0]!.sql, /a\.status = 'active' and a\.expires_at > now\(\)/);
  // Recording is bound to the tenant and throttled to once a minute.
  assert.deepEqual(db.calls[1]!.parameters, [TENANT, credentialId]);
  assert.match(db.calls[1]!.sql, /update corvis_control\.service_account_credential set last_used_at = now\(\)/);
  assert.match(db.calls[1]!.sql, /last_used_at < now\(\) - interval '1 minute'/);
});

test("every refusal is the same null and records nothing: malformed, unknown, wrong secret, unusable", async () => {
  const { secret } = mintCredential();
  const other = mintCredential();
  const cases: Array<[string, unknown, PostgresRow[]]> = [
    ["not a string", 42, []],
    ["malformed", "corvis_sa_nope", []],
    ["no such credential", secret, []],
    ["wrong secret for a real credential", secret, [record(secret, { secret_sha256: other.secretSha256 })]],
    ["revoked, expired or ended credential, or inactive account", secret, [record(secret, { usable: false })]],
    ["a usable flag that is not literally true", secret, [record(secret, { usable: "true" })]],
    ["a stored digest that is not a SHA-256", secret, [record(secret, { secret_sha256: "abc" })]],
  ];
  for (const [name, presented, rows] of cases) {
    const db = new ScriptedDb();
    db.handler = () => rows;
    assert.equal(await verifyServiceAccountCredential(presented, db), null, name);
    assert.equal(db.calls.some((call) => /^update/i.test(call.sql.trim())), false, `${name} records no use`);
  }
  // Malformed input never reaches the database at all.
  const db = new ScriptedDb();
  assert.equal(await verifyServiceAccountCredential("corvis_sa_nope", db), null);
  assert.equal(db.calls.length, 0);
});

// ------------------------------------------------------------------ authorization and audit helpers
test("only a person who is an Organization Admin may manage service accounts", () => {
  assertCanManageServiceAccounts(identity());
  assertCanManageServiceAccounts(identity({ authMethod: "demo" }));
  assertCanManageServiceAccounts(identity({ authMethod: "saml" }));
  for (const overrides of [{ isTenantAdmin: false }, { isTenantAdmin: undefined }, { authMethod: "service_account" as const }]) {
    assert.throws(() => assertCanManageServiceAccounts(identity(overrides)), refusal("tenant_admin_required", 403));
  }
});

test("the audit event names the actor, the account and what changed, and carries no secret", () => {
  const event = serviceAccountAuditEvent(identity(), "corr-1", "service_account.credential_rotated", { serviceAccountId: ACCOUNT, workspaceId: WORKSPACE }, { credentialId: OTHER, overlapMinutes: 60 });
  assert.equal(event.action, "service_account.credential_rotated");
  assert.equal(event.targetType, "service_account");
  assert.equal(event.targetId, ACCOUNT);
  assert.equal(event.actorSubject, "idp|alex");
  assert.equal(event.tenantId, TENANT);
  assert.equal(event.workspaceId, WORKSPACE);
  assert.equal(event.outcome, "success");
  assert.equal(event.correlationId, "corr-1");
  assert.deepEqual(event.metadata, { credentialId: OTHER, overlapMinutes: 60 });
  assert.deepEqual(serviceAccountAuditEvent(identity(), "c", "service_account.disabled", { serviceAccountId: ACCOUNT, workspaceId: WORKSPACE }).metadata, {});
  assert.equal(daysFromNow(2, new Date("2026-10-03T00:00:00.000Z")), "2026-10-05T00:00:00.000Z");
  assert.ok(Date.parse(daysFromNow(1)) > Date.now());
});

// ------------------------------------------------------------------ row mapping
const NOW = new Date("2026-10-03T12:00:00.000Z");
function accountRow(overrides: Record<string, unknown> = {}): PostgresRow {
  return {
    service_account_id: ACCOUNT, user_id: OTHER, display_name: "Reporting sync", purpose: "Nightly", workspace_id: WORKSPACE, workspace_name: "Primary Workspace",
    role_name: "analyst", status: "active", created_by_subject: "idp|alex", created_at: "2026-09-01 08:00:00+00", expires_at: "2027-09-01 08:00:00+00",
    disabled_at: null, disabled_by_subject: null, disable_reason: null, owner_subject: "idp|alex", owner_assigned_at: "2026-09-01 08:00:00+00", owner_active: true, ...overrides,
  };
}
function credentialRow(overrides: Record<string, unknown> = {}): PostgresRow {
  return {
    service_account_id: ACCOUNT, credential_id: "c1", status: "active", created_by_subject: "idp|alex", created_at: "2026-09-01 08:00:00+00",
    expires_at: "2026-10-10 08:00:00+00", ends_at: null, revoked_at: null, last_used_at: "2026-10-03 09:30:00.123456+00", ...overrides,
  };
}

test("rows map to ISO instants, derive credential status from time, and flag a credential nearing expiry", () => {
  const credential = toServiceAccountCredential(credentialRow(), NOW);
  assert.deepEqual(credential, {
    credentialId: "c1", status: "active", createdBy: "idp|alex", createdAt: "2026-09-01T08:00:00.000Z", expiresAt: "2026-10-10T08:00:00.000Z",
    endsAt: null, revokedAt: null, lastUsedAt: "2026-10-03T09:30:00.123Z", expiringSoon: true,
  });
  assert.equal(toServiceAccountCredential(credentialRow({ expires_at: "2026-12-10 08:00:00+00" }), NOW).expiringSoon, false);
  assert.equal(toServiceAccountCredential(credentialRow({ ends_at: "2026-10-03 13:00:00+00" }), NOW).status, "rotating_out");
  assert.equal(toServiceAccountCredential(credentialRow({ ends_at: "2026-10-03 13:00:00+00" }), NOW).expiringSoon, false, "only the credential in use is flagged");
  assert.equal(toServiceAccountCredential(credentialRow({ ends_at: "2026-10-03 11:00:00+00" }), NOW).status, "retired");
  assert.equal(toServiceAccountCredential(credentialRow({ expires_at: "2026-10-01 08:00:00+00" }), NOW).status, "expired");
  const revoked = toServiceAccountCredential(credentialRow({ status: "revoked", revoked_at: "2026-10-02 08:00:00+00", ends_at: "2026-10-02 08:00:00+00" }), NOW);
  assert.deepEqual([revoked.status, revoked.revokedAt, revoked.expiringSoon], ["revoked", "2026-10-02T08:00:00.000Z", false]);
  assert.equal(toServiceAccountCredential(credentialRow({ last_used_at: null }), NOW).lastUsedAt, null);
});

test("an account row carries role, workspace, creator, last use, expiry and the credential-expiry flag, and no secret", () => {
  const account = toServiceAccount(accountRow(), [credentialRow(), credentialRow({ credential_id: "c0", ends_at: "2026-10-03 11:00:00+00", last_used_at: "2026-10-01 00:00:00+00" })], [], NOW);
  assert.deepEqual([account.name, account.roleName, account.workspaceName, account.createdBy, account.userId], ["Reporting sync", "analyst", "Primary Workspace", "idp|alex", OTHER]);
  assert.equal(account.status, "active");
  assert.equal(account.expiresAt, "2027-09-01T08:00:00.000Z");
  assert.equal(account.lastUsedAt, "2026-10-03T09:30:00.123Z");
  assert.equal(account.credentialExpiresAt, "2026-10-10T08:00:00.000Z");
  assert.equal(account.expiringSoon, true);
  assert.deepEqual(account.actions, { canIssue: false, canRotate: true, canRevoke: true, canDisable: true, canExtend: true, canTransfer: true });
  assert.deepEqual([account.ownerSubject, account.ownerAssignedAt, account.ownerActive, account.needsOwner], ["idp|alex", "2026-09-01T08:00:00.000Z", true, false]);
  assert.deepEqual([account.disabledAt, account.disabledBy, account.disableReason], [null, null, null]);
  assert.equal(Object.keys(account).some((key) => /secret|hash|sha/i.test(key)), false);
  assert.equal(account.credentials.some((credential) => Object.keys(credential).some((key) => /secret|hash|sha/i.test(key))), false);

  // An owner who was deactivated (or demoted) is reported, not hidden; any value but a real boolean true is "not active".
  for (const owner_active of [false, null, "t"]) {
    const orphaned = toServiceAccount(accountRow({ owner_active }), [credentialRow()], [], NOW);
    assert.deepEqual([orphaned.ownerActive, orphaned.needsOwner, orphaned.actions.canExtend, orphaned.status], [false, true, false, "active"], String(owner_active));
  }

  const disabled = toServiceAccount(accountRow({ status: "disabled", disabled_at: "2026-10-02 10:00:00+00", disabled_by_subject: "idp|sam", disable_reason: "Integration retired" }), [], [], NOW);
  assert.deepEqual([disabled.status, disabled.disabledAt, disabled.disabledBy, disabled.disableReason], ["disabled", "2026-10-02T10:00:00.000Z", "idp|sam", "Integration retired"]);
});

// ------------------------------------------------------------------ the Postgres backend
const COMMAND: CreateServiceAccountCommand = { name: "Reporting sync", purpose: "Nightly", workspaceId: WORKSPACE, roleName: "analyst", expiresInDays: 365, credentialExpiresInDays: 90 };
const READ_ACCOUNTS = /from corvis_control\.service_account a\s+join corvis_control\.workspace/;
const READ_ENTITLEMENTS = /join corvis_control\.resource_entitlement e/;
const READ_GRANTABLE = /from corvis_control\.data_rights dr/;
const READ_CREDENTIALS = /from corvis_control\.service_account_credential c\b/;

function backendWith(db: ScriptedDb, extra: (call: Call) => PostgresRow[] | undefined = () => undefined): PostgresServiceAccountBackend {
  db.handler = (call) => {
    const scripted = extra(call);
    if (scripted) return scripted;
    if (READ_ACCOUNTS.test(call.sql)) return [accountRow()];
    if (READ_CREDENTIALS.test(call.sql)) return [credentialRow({ credential_id: lastMinted })];
    return [];
  };
  return new PostgresServiceAccountBackend(() => db);
}
let lastMinted = "";

test("listing is bound to the caller's tenant, shows the workspaces an account can be created in, and skips the credential read when there are no accounts", async () => {
  const db = new ScriptedDb();
  const backend = backendWith(db, (call) => {
    if (/from corvis_control\.workspace/.test(call.sql)) return [{ workspace_id: WORKSPACE, display_name: "Primary Workspace" }];
    if (/from corvis_control\.identity_subject/.test(call.sql)) return [{ subject: "idp|alex" }, { subject: "idp|sam" }];
    return undefined;
  });
  const listed = await backend.list(identity(), db);
  assert.equal(listed.serviceAccounts.length, 1);
  assert.deepEqual(listed.workspaces, [{ workspaceId: WORKSPACE, name: "Primary Workspace" }]);
  assert.deepEqual(listed.owners, [{ subject: "idp|alex" }, { subject: "idp|sam" }], "who an account can be handed to");
  const owners = db.calls.find((call) => /from corvis_control\.identity_subject/.test(call.sql))!;
  assert.deepEqual(owners.parameters, [TENANT], "the candidates are the caller's organization's, never a client selector");
  assert.match(owners.sql, /service_account_owner_active\(s\.tenant_id, s\.user_id\)/, "by the same test the SQL applies to whoever acts");
  assert.match(owners.sql, /auth_method in \('oidc','saml'\)/, "people only");
  const reads = db.calls.filter((call) => READ_ACCOUNTS.test(call.sql) || READ_CREDENTIALS.test(call.sql) || /from corvis_control\.workspace/.test(call.sql));
  assert.equal(reads.length, 3);
  for (const read of reads) assert.equal(read.parameters[0], TENANT, "every read carries the caller's tenant, never a client selector");
  assert.match(db.calls.find((call) => /from corvis_control\.workspace/.test(call.sql))!.sql, /status = 'active'/);
  assert.match(db.calls.find((call) => READ_CREDENTIALS.test(call.sql))!.sql, /position <= 10/);

  const none = new ScriptedDb();
  none.handler = () => [];
  const empty = await new PostgresServiceAccountBackend(() => none).list(identity(), none);
  assert.deepEqual(empty, { serviceAccounts: [], workspaces: [], owners: [], grantable: [] });
  assert.equal(none.calls.some((call) => READ_CREDENTIALS.test(call.sql)), false);
});

test("a single account is read by id within the tenant; a malformed or unknown id is the same 404", async () => {
  const db = new ScriptedDb();
  const backend = backendWith(db);
  assert.equal((await backend.get(identity(), ACCOUNT, db)).serviceAccountId, ACCOUNT);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT, ACCOUNT]);
  await assert.rejects(backend.get(identity(), "not-a-uuid", db), refusal("service_account_not_found", 404));
  const missing = new ScriptedDb();
  missing.handler = () => [];
  await assert.rejects(new PostgresServiceAccountBackend(() => missing).get(identity(), ACCOUNT, missing), refusal("service_account_not_found", 404));
});

test("creating stores only the hash: the secret is returned once and never reaches a statement", async () => {
  const db = new ScriptedDb();
  const backend = backendWith(db, (call) => {
    if (/create_service_account/.test(call.sql)) lastMinted = String(call.parameters[2]);
    return undefined;
  });
  const created = await backend.create(identity(), COMMAND, db);
  const call = db.calls.find((entry) => /create_service_account/.test(entry.sql))!;
  const [tenant, accountId, credentialId, method, subject, name, purpose, workspace, role, expiresAt, credentialExpiresAt, hash, limit] = call.parameters;
  assert.deepEqual([tenant, method, subject, name, purpose, workspace, role, limit], [TENANT, "oidc", "idp|alex", "Reporting sync", "Nightly", WORKSPACE, "analyst", 100]);
  assert.match(String(accountId), /^[0-9a-f-]{36}$/);
  assert.equal(created.credential.credentialId, credentialId);
  assert.equal(hash, hashCredentialSecret(created.credential.secret));
  assert.equal(credentialIdOf(created.credential.secret), credentialId);
  assert.ok(Date.parse(String(expiresAt)) > Date.parse(String(credentialExpiresAt)), "the 365 day account outlives its 90 day credential");
  for (const statement of db.calls) assert.equal(statement.parameters.includes(created.credential.secret), false, "the secret is never sent to the database");
  assert.equal(created.credential.expiresAt, "2026-10-10T08:00:00.000Z", "the expiry reported is the stored one");
  assert.equal(JSON.stringify(created.serviceAccount).includes(created.credential.secret), false);
  await assert.rejects(backend.create(identity(), { ...COMMAND, workspaceId: "workspace_demo" }, db), refusal("invalid_workspace", 400));
});

test("issuing and rotating pass the mode, the overlap and the hash to the SQL function, which decides every state rule", async () => {
  const db = new ScriptedDb();
  const backend = backendWith(db, (call) => {
    if (/issue_service_account_credential/.test(call.sql)) lastMinted = String(call.parameters[2]);
    return undefined;
  });
  const rotated = await backend.issueCredential(identity(), ACCOUNT, { action: "rotate", credentialExpiresInDays: 30, overlapMinutes: 45 }, db);
  const rotate = db.calls.find((entry) => /issue_service_account_credential/.test(entry.sql))!;
  assert.deepEqual([rotate.parameters[0], rotate.parameters[1], rotate.parameters[3], rotate.parameters[4], rotate.parameters[5], rotate.parameters[8]], [TENANT, ACCOUNT, "rotate", "oidc", "idp|alex", 45]);
  assert.equal(rotate.parameters[6], hashCredentialSecret(rotated.credential.secret));
  assert.equal(rotate.parameters.includes(rotated.credential.secret), false);

  db.calls.length = 0;
  await backend.issueCredential(identity(), ACCOUNT, { action: "issue", credentialExpiresInDays: 30 }, db);
  const issue = db.calls.find((entry) => /issue_service_account_credential/.test(entry.sql))!;
  assert.deepEqual([issue.parameters[3], issue.parameters[8]], ["issue", 0], "an issue has no overlap to give");
  await assert.rejects(backend.issueCredential(identity(), "nope", { action: "issue", credentialExpiresInDays: 30 }, db), refusal("service_account_not_found", 404));
});

test("revoking reports how many credentials were cut off; disabling passes the reason and returns the account", async () => {
  const db = new ScriptedDb();
  const backend = backendWith(db, (call) => /revoke_service_account_credentials/.test(call.sql) ? [{ revoked: 2 }] : undefined);
  const revoked = await backend.revoke(identity(), ACCOUNT, db);
  assert.equal(revoked.revokedCredentials, 2);
  assert.deepEqual(db.calls.find((entry) => /revoke_service_account_credentials/.test(entry.sql))!.parameters, [TENANT, ACCOUNT, "oidc", "idp|alex"]);
  await assert.rejects(backend.revoke(identity(), "nope", db), refusal("service_account_not_found", 404));

  db.calls.length = 0;
  const disabled = await backend.disable(identity(), ACCOUNT, "Integration retired", db);
  assert.equal(disabled.serviceAccountId, ACCOUNT);
  assert.deepEqual(db.calls.find((entry) => /disable_service_account/.test(entry.sql))!.parameters, [TENANT, ACCOUNT, "oidc", "idp|alex", "Integration retired"]);
  await assert.rejects(backend.disable(identity(), "nope", "Integration retired", db), refusal("service_account_not_found", 404));
});

test("service-account actions are part of what an Organization Admin sees in the tenant access audit, and of the access-audit file of a full export", async () => {
  const { TENANT_ACCESS_AUDIT_FILTER } = await import("./tenant-admin-self-service.ts");
  assert.match(TENANT_ACCESS_AUDIT_FILTER, /action like 'service_account\.%'/);
  assert.match(TENANT_ACCESS_AUDIT_FILTER, /'service_account'[,)]/);
  // Every action the service writes is under that prefix and target type.
  for (const action of ["created", "credential_issued", "credential_rotated", "credential_revoked", "disabled", "extended", "owner_transferred", "entitlement_granted", "entitlement_revoked"]) {
    const event = serviceAccountAuditEvent(identity(), "c", `service_account.${action}`, { serviceAccountId: ACCOUNT, workspaceId: WORKSPACE });
    assert.ok(event.action.startsWith("service_account."));
    assert.equal(event.targetType, "service_account");
  }
});

test("extending passes the new expiry to the SQL function, which decides every rule, and reports the previous expiry for the audit", async () => {
  const db = new ScriptedDb();
  const backend = backendWith(db, (call) => /extend_service_account/.test(call.sql) ? [{ previous_expires_at: "2026-12-01 08:00:00+00" }] : undefined);
  const before = Date.now();
  const extended = await backend.extend(identity(), ACCOUNT, { action: "extend", expiresInDays: 120 }, db);
  const call = db.calls.find((entry) => /extend_service_account/.test(entry.sql))!;
  assert.deepEqual([call.parameters[0], call.parameters[1], call.parameters[2], call.parameters[3]], [TENANT, ACCOUNT, "oidc", "idp|alex"]);
  const requested = Date.parse(String(call.parameters[4]));
  assert.ok(Math.abs(requested - (before + 120 * 86_400_000)) < 60_000, "120 days from now");
  assert.equal(extended.previousExpiresAt, "2026-12-01T08:00:00.000Z");
  assert.equal(extended.serviceAccount.serviceAccountId, ACCOUNT);
  await assert.rejects(backend.extend(identity(), "nope", { action: "extend", expiresInDays: 30 }, db), refusal("service_account_not_found", 404));
});

test("transferring names the new owner to the SQL function, which checks they are an active Organization Admin, and reports the previous owner", async () => {
  const db = new ScriptedDb();
  const backend = backendWith(db, (call) => /transfer_service_account_owner/.test(call.sql) ? [{ previous_owner: "idp|alex" }] : undefined);
  const transferred = await backend.transferOwner(identity(), ACCOUNT, "idp|sam", db);
  assert.deepEqual(db.calls.find((entry) => /transfer_service_account_owner/.test(entry.sql))!.parameters, [TENANT, ACCOUNT, "oidc", "idp|alex", "idp|sam"]);
  assert.equal(transferred.previousOwner, "idp|alex");
  assert.equal(transferred.serviceAccount.serviceAccountId, ACCOUNT);
  await assert.rejects(backend.transferOwner(identity(), "nope", "idp|sam", db), refusal("service_account_not_found", 404));
});

// ------------------------------------------------------------------ entitlement self-service (F6c)
const ENTITLEMENT_ROW = { service_account_id: ACCOUNT, resource_type: "fund", resource_id: "fund-advent-viii", permission: "read", valid_from: "2026-09-02 08:00:00+00", label: "Advent International GPE VIII", within_data_rights: true };

test("an entitlement row maps to a named resource, and says whether the organization's data right still covers it", () => {
  const account = toServiceAccount(accountRow(), [credentialRow()], [
    ENTITLEMENT_ROW,
    { ...ENTITLEMENT_ROW, resource_type: "document", resource_id: "doc-1", label: "doc-1", permission: "review", within_data_rights: false },
    { ...ENTITLEMENT_ROW, resource_id: "fund-x", within_data_rights: "t" },
  ], NOW);
  assert.deepEqual(account.entitlements[0], { resourceType: "fund", resourceId: "fund-advent-viii", label: "Advent International GPE VIII", permission: "read", grantedAt: "2026-09-02T08:00:00.000Z", withinDataRights: true });
  assert.deepEqual([account.entitlements[1]!.resourceType, account.entitlements[1]!.permission, account.entitlements[1]!.withinDataRights], ["document", "review", false], "an operator-granted permission is shown as it is");
  assert.equal(account.entitlements[2]!.withinDataRights, false, "only a real boolean true counts as within the data right");
  assert.deepEqual(account.entitlementAccess, { canGrant: true, canRevoke: true });
  assert.deepEqual(toServiceAccount(accountRow(), [], [], NOW).entitlements, []);
  assert.deepEqual(toServiceAccount(accountRow(), [], [], NOW).entitlementAccess, { canGrant: true, canRevoke: false });
});

test("an account's entitlements are read inside the caller's tenant, bounded, through the rows the authorization lookup reads", async () => {
  const db = new ScriptedDb();
  const backend = backendWith(db, (call) => READ_ENTITLEMENTS.test(call.sql) ? [ENTITLEMENT_ROW] : undefined);
  const account = await backend.get(identity(), ACCOUNT, db);
  assert.equal(account.entitlements.length, 1);
  const read = db.calls.find((call) => READ_ENTITLEMENTS.test(call.sql))!;
  assert.deepEqual(read.parameters, [TENANT, ACCOUNT], "bound to the caller's tenant and the account");
  assert.match(read.sql, /corvis_control\.resource_entitlement e/, "the same table the authorization lookup reads: no parallel plane");
  assert.match(read.sql, /e\.valid_from <= now\(\) and \(e\.valid_until is null or e\.valid_until > now\(\)\)/, "only what is effective now");
  assert.match(read.sql, /service_account_data_right_effective\(e\.tenant_id, e\.resource_type, e\.resource_id\)/);
  assert.match(read.sql, /position <= 200/);
});

test("the grantable list is the organization's own resources that hold an effective client-visible data right, by the grant function's own tests", async () => {
  const db = new ScriptedDb();
  const backend = backendWith(db, (call) => {
    if (/from corvis_control\.workspace/.test(call.sql)) return [];
    if (READ_GRANTABLE.test(call.sql)) return [{ resource_type: "fund", resource_id: "fund-advent-viii", label: "Advent International GPE VIII" }, { resource_type: "document", resource_id: "doc-1", label: "Report.pdf" }];
    return undefined;
  });
  const listed = await backend.list(identity(), db);
  assert.deepEqual(listed.grantable, [
    { resourceType: "fund", resourceId: "fund-advent-viii", label: "Advent International GPE VIII" },
    { resourceType: "document", resourceId: "doc-1", label: "Report.pdf" },
  ]);
  const query = db.calls.find((call) => READ_GRANTABLE.test(call.sql))!;
  assert.deepEqual(query.parameters, [TENANT], "never a client selector");
  assert.match(query.sql, /service_account_data_right_effective\(\$1::uuid, 'fund', r\.resource_id\)/);
  assert.match(query.sql, /access_policy_resource_belongs_to_tenant\(\$1::uuid, 'fund', r\.resource_id\)/);
  assert.match(query.sql, /service_account_data_right_effective\(\$1::uuid, 'document', r\.resource_id\)/);
  assert.match(query.sql, /access_policy_resource_belongs_to_tenant\(\$1::uuid, 'document', r\.resource_id\)/);
  assert.match(query.sql, /limit 500/);
});

test("granting passes the actor, the account, one fund or document and the bound to the SQL function, which decides every rule", async () => {
  const db = new ScriptedDb();
  const backend = backendWith(db, (call) => READ_ENTITLEMENTS.test(call.sql) ? [ENTITLEMENT_ROW] : undefined);
  const granted = await backend.grantEntitlement(identity(), ACCOUNT, { resourceType: "fund", resourceId: "fund-advent-viii" }, db);
  const call = db.calls.find((entry) => /grant_service_account_entitlement/.test(entry.sql))!;
  assert.deepEqual(call.parameters, [TENANT, ACCOUNT, "oidc", "idp|alex", "fund", "fund-advent-viii", 200]);
  assert.match(call.sql, /\$7::integer/);
  assert.equal(granted.serviceAccount.entitlements[0]!.resourceId, "fund-advent-viii");
  // A grant never names a user, a workspace or a permission: those come from the account and are fixed in SQL.
  assert.equal(call.parameters.length, 7);
  await assert.rejects(backend.grantEntitlement(identity(), "nope", { resourceType: "fund", resourceId: "f" }, db), refusal("service_account_not_found", 404));
});

test("revoking reports how many entitlements it ended and returns the account", async () => {
  const db = new ScriptedDb();
  const backend = backendWith(db, (call) => /revoke_service_account_entitlement/.test(call.sql) ? [{ ended: "2" }] : undefined);
  const revoked = await backend.revokeEntitlement(identity(), ACCOUNT, { resourceType: "document", resourceId: "doc-1" }, db);
  assert.deepEqual(db.calls.find((entry) => /revoke_service_account_entitlement/.test(entry.sql))!.parameters, [TENANT, ACCOUNT, "oidc", "idp|alex", "document", "doc-1"]);
  assert.equal(revoked.endedEntitlements, 2);
  assert.equal(revoked.serviceAccount.serviceAccountId, ACCOUNT);
  await assert.rejects(backend.revokeEntitlement(identity(), "nope", { resourceType: "fund", resourceId: "f" }, db), refusal("service_account_not_found", 404));
});
