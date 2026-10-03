import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVICE_ACCOUNT_DEFAULT_CREDENTIAL_DAYS,
  SERVICE_ACCOUNT_DEFAULT_OVERLAP_MINUTES,
  SERVICE_ACCOUNT_MAX_LIFETIME_DAYS,
  SERVICE_ACCOUNT_ROLES,
  ServiceAccountValidationError,
  credentialStatus,
  expiresSoon,
  isServiceAccountId,
  minimumExtensionDays,
  parseCreateServiceAccount,
  parseServiceAccountCommand,
  serviceAccountCredentialSummary,
  serviceAccountLifecycle,
  serviceAccountStatus,
  type ServiceAccountCredentialStatus,
} from "./service-account.ts";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const invalid = (code: string) => (error: unknown) => error instanceof ServiceAccountValidationError && error.code === code && error.status === 400;

test("a machine can hold only the ordinary roles, never an administrator role", () => {
  assert.deepEqual([...SERVICE_ACCOUNT_ROLES], ["reviewer", "analyst", "viewer"]);
  for (const role of ["tenant_admin", "accountadmin", "workspace_admin", "admin", "api_client", ""]) {
    assert.throws(() => parseCreateServiceAccount({ name: "Reporting sync", purpose: "Nightly", workspaceId: WORKSPACE, roleName: role }), invalid("invalid_role"), role);
  }
});

test("a credential's status follows revocation, expiry and the end of a rotation overlap", () => {
  const status = (revoked: boolean, expiresAt: string, endsAt: string | null) => credentialStatus({ revoked, expiresAt, endsAt }, NOW);
  assert.equal(status(false, at(30), null), "active");
  assert.equal(status(false, at(30), at(0.01)), "rotating_out");
  assert.equal(status(false, at(30), at(-0.01)), "retired");
  assert.equal(status(false, at(30), NOW.toISOString()), "retired", "an overlap ending this instant has ended");
  assert.equal(status(false, at(-1), null), "expired");
  assert.equal(status(false, NOW.toISOString(), null), "expired", "expiry at this instant has expired");
  assert.equal(status(true, at(30), at(-1)), "revoked");
  assert.equal(status(true, at(-1), null), "revoked", "revocation wins over expiry");
});

test("a credential is flagged within 14 days of its expiry, and only while it has not expired", () => {
  assert.equal(expiresSoon(at(14), NOW), true);
  assert.equal(expiresSoon(at(14.01), NOW), false);
  assert.equal(expiresSoon(at(1), NOW), true);
  assert.equal(expiresSoon(NOW.toISOString(), NOW), false);
  assert.equal(expiresSoon(at(-1), NOW), false);
});

test("an account is disabled, expired or active", () => {
  assert.equal(serviceAccountStatus(true, at(30), NOW), "disabled");
  assert.equal(serviceAccountStatus(true, at(-30), NOW), "disabled");
  assert.equal(serviceAccountStatus(false, at(-1), NOW), "expired");
  assert.equal(serviceAccountStatus(false, NOW.toISOString(), NOW), "expired");
  assert.equal(serviceAccountStatus(false, at(1), NOW), "active");
});

test("what an Organization Admin can do follows the account's lifecycle, derived once", () => {
  const credential = (status: ServiceAccountCredentialStatus, expiresInDays: number, lastUsedAt: string | null = null) => ({ status, expiresAt: at(expiresInDays), lastUsedAt });
  // In use: rotate, revoke, disable; not issue.
  const live = serviceAccountLifecycle({ disabled: false, ownerActive: true, expiresAt: at(300), credentials: [credential("active", 60, at(-1))] }, NOW);
  assert.deepEqual(live.actions, { canIssue: false, canRotate: true, canRevoke: true, canDisable: true, canExtend: true, canTransfer: true });
  assert.equal(live.status, "active");
  assert.equal(live.credentialExpiresAt, at(60));
  assert.equal(live.lastUsedAt, at(-1));
  assert.equal(live.expiringSoon, false);

  // The current credential close to its expiry flags the account.
  assert.equal(serviceAccountLifecycle({ disabled: false, ownerActive: true, expiresAt: at(300), credentials: [credential("active", 5)] }, NOW).expiringSoon, true);
  // So does the account itself close to its own expiry.
  assert.equal(serviceAccountLifecycle({ disabled: false, ownerActive: true, expiresAt: at(5), credentials: [credential("active", 3)] }, NOW).expiringSoon, true);
  assert.equal(serviceAccountLifecycle({ disabled: false, ownerActive: true, expiresAt: at(5), credentials: [] }, NOW).expiringSoon, true);
  // A rotating-out credential close to its expiry is not the current one and does not flag the account.
  assert.equal(serviceAccountLifecycle({ disabled: false, ownerActive: true, expiresAt: at(300), credentials: [credential("active", 60), credential("rotating_out", 2)] }, NOW).expiringSoon, false);

  // The newest-expiring active credential is the current one; the most recent use of any credential is reported.
  const two = serviceAccountLifecycle({ disabled: false, ownerActive: true, expiresAt: at(300), credentials: [credential("active", 20, at(-3)), credential("active", 80, null), credential("rotating_out", 1, at(-2)), credential("retired", 1, at(-9))] }, NOW);
  assert.equal(two.credentialExpiresAt, at(80));
  assert.equal(two.lastUsedAt, at(-2));

  // Nothing in use: issue only, nothing to revoke.
  const none = serviceAccountLifecycle({ disabled: false, ownerActive: true, expiresAt: at(300), credentials: [credential("revoked", 60, at(-5)), credential("expired", -1), credential("retired", 10)] }, NOW);
  assert.deepEqual(none.actions, { canIssue: true, canRotate: false, canRevoke: false, canDisable: true, canExtend: true, canTransfer: true });
  assert.equal(none.credentialExpiresAt, null);
  assert.equal(none.lastUsedAt, at(-5));
  assert.equal(serviceAccountLifecycle({ disabled: false, ownerActive: true, expiresAt: at(300), credentials: [] }, NOW).lastUsedAt, null);

  // Only a rotating-out credential remains: it can still be revoked, and a new one issued.
  const rotating = serviceAccountLifecycle({ disabled: false, ownerActive: true, expiresAt: at(300), credentials: [credential("rotating_out", 10)] }, NOW);
  assert.deepEqual(rotating.actions, { canIssue: true, canRotate: false, canRevoke: true, canDisable: true, canExtend: true, canTransfer: true });

  // An expired account can be renewed or disabled; a disabled one nothing at all, and neither is flagged.
  const expired = serviceAccountLifecycle({ disabled: false, ownerActive: true, expiresAt: at(-1), credentials: [credential("expired", -1)] }, NOW);
  assert.equal(expired.status, "expired");
  assert.deepEqual(expired.actions, { canIssue: false, canRotate: false, canRevoke: false, canDisable: true, canExtend: true, canTransfer: true }, "an expired account can still be renewed (then issued a credential) or disabled");
  assert.equal(expired.expiringSoon, false);
  const disabled = serviceAccountLifecycle({ disabled: true, ownerActive: true, expiresAt: at(5), credentials: [credential("revoked", 3)] }, NOW);
  assert.equal(disabled.status, "disabled");
  assert.deepEqual(disabled.actions, { canIssue: false, canRotate: false, canRevoke: false, canDisable: false, canExtend: false, canTransfer: false });
  assert.equal(disabled.expiringSoon, false);
});

test("every credential state has a plain sentence", () => {
  const sentence = (status: ServiceAccountCredentialStatus, expiringSoon = false) => serviceAccountCredentialSummary({ status, endsAt: null, expiresAt: at(30), expiringSoon });
  assert.equal(sentence("active"), "In use.");
  assert.match(sentence("active", true), /expires soon/);
  assert.match(sentence("rotating_out"), /keeps working until the overlap ends/);
  assert.match(sentence("retired"), /no longer accepted/);
  assert.match(sentence("expired"), /Past its expiry/);
  assert.match(sentence("revoked"), /Revoked/);
});

test("ids are UUIDs", () => {
  assert.equal(isServiceAccountId(WORKSPACE), true);
  assert.equal(isServiceAccountId(WORKSPACE.toUpperCase()), true);
  for (const value of ["", "not-a-uuid", 7, null, undefined, `${WORKSPACE}x`]) assert.equal(isServiceAccountId(value), false);
});

test("creating an account validates every field and applies the finite-lifetime defaults", () => {
  const valid = { name: "  Reporting sync ", purpose: " Pulls published data nightly ", workspaceId: WORKSPACE, roleName: "analyst" };
  assert.deepEqual(parseCreateServiceAccount(valid), {
    name: "Reporting sync", purpose: "Pulls published data nightly", workspaceId: WORKSPACE, roleName: "analyst",
    expiresInDays: SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, credentialExpiresInDays: SERVICE_ACCOUNT_DEFAULT_CREDENTIAL_DAYS,
  });
  // A shorter account lifetime caps the default credential lifetime.
  assert.equal(parseCreateServiceAccount({ ...valid, expiresInDays: 30 }).credentialExpiresInDays, 30);
  assert.equal(parseCreateServiceAccount({ ...valid, expiresInDays: 365, credentialExpiresInDays: 7 }).credentialExpiresInDays, 7);
  // An opaque (non-UUID) workspace id is accepted here for the demo composition; the Postgres backend refuses it.
  assert.equal(parseCreateServiceAccount({ ...valid, workspaceId: "workspace_demo" }).workspaceId, "workspace_demo");

  for (const body of [null, undefined, [], "x", 3]) assert.throws(() => parseCreateServiceAccount(body), invalid("invalid_request"));
  for (const name of [undefined, null, 5, "", "  ab ", "x".repeat(121), "two\nlines", "tab\tname", "bell\u0007", "sep arator"]) {
    assert.throws(() => parseCreateServiceAccount({ ...valid, name }), invalid("invalid_name"), String(name));
  }
  for (const purpose of [undefined, "", "ab", "x".repeat(513), "two\nlines"]) assert.throws(() => parseCreateServiceAccount({ ...valid, purpose }), invalid("invalid_purpose"));
  for (const workspaceId of [undefined, null, 5, "", "has space", "a/b", "x".repeat(65)]) assert.throws(() => parseCreateServiceAccount({ ...valid, workspaceId }), invalid("invalid_workspace"), String(workspaceId));
  for (const roleName of [undefined, null, 5, "viewer ", "Viewer"]) assert.throws(() => parseCreateServiceAccount({ ...valid, roleName }), invalid("invalid_role"));
  for (const expiresInDays of [0, -1, 366, 1.5, "30", NaN, Infinity]) assert.throws(() => parseCreateServiceAccount({ ...valid, expiresInDays }), invalid("invalid_expiry"), String(expiresInDays));
  for (const credentialExpiresInDays of [0, 366, 2.5, "9"]) assert.throws(() => parseCreateServiceAccount({ ...valid, credentialExpiresInDays }), invalid("invalid_expiry"));
  assert.equal(parseCreateServiceAccount({ ...valid, expiresInDays: null }).expiresInDays, SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, "null means the default");
});

test("an action on an account validates its own parameters", () => {
  assert.deepEqual(parseServiceAccountCommand({ action: "issue" }), { action: "issue", credentialExpiresInDays: SERVICE_ACCOUNT_DEFAULT_CREDENTIAL_DAYS });
  assert.deepEqual(parseServiceAccountCommand({ action: "issue", credentialExpiresInDays: 30 }), { action: "issue", credentialExpiresInDays: 30 });
  assert.deepEqual(parseServiceAccountCommand({ action: "rotate" }), {
    action: "rotate", credentialExpiresInDays: SERVICE_ACCOUNT_DEFAULT_CREDENTIAL_DAYS, overlapMinutes: SERVICE_ACCOUNT_DEFAULT_OVERLAP_MINUTES,
  });
  assert.deepEqual(parseServiceAccountCommand({ action: "rotate", overlapMinutes: 0, credentialExpiresInDays: 10 }), { action: "rotate", credentialExpiresInDays: 10, overlapMinutes: 0 });
  assert.equal((parseServiceAccountCommand({ action: "rotate", overlapMinutes: 1440 }) as { overlapMinutes: number }).overlapMinutes, 1440);
  assert.deepEqual(parseServiceAccountCommand({ action: "revoke", reason: "  Key leaked in a log  " }), { action: "revoke", reason: "Key leaked in a log" });
  assert.deepEqual(parseServiceAccountCommand({ action: "disable", reason: "Integration retired" }), { action: "disable", reason: "Integration retired" });

  for (const overlapMinutes of [-1, 1441, 1.5, "60"]) assert.throws(() => parseServiceAccountCommand({ action: "rotate", overlapMinutes }), invalid("invalid_overlap"), String(overlapMinutes));
  for (const credentialExpiresInDays of [0, 366, "5"]) {
    assert.throws(() => parseServiceAccountCommand({ action: "issue", credentialExpiresInDays }), invalid("invalid_expiry"));
    assert.throws(() => parseServiceAccountCommand({ action: "rotate", credentialExpiresInDays }), invalid("invalid_expiry"));
  }
  for (const action of ["revoke", "disable"]) {
    for (const reason of [undefined, "", "no", "x".repeat(1001), "line\nbreak"]) assert.throws(() => parseServiceAccountCommand({ action, reason }), invalid("invalid_reason"), `${action} ${String(reason)}`);
  }
  for (const body of [{ action: "delete" }, { action: 5 }, {}, { action: "ROTATE" }]) assert.throws(() => parseServiceAccountCommand(body), invalid("invalid_action"));
  for (const body of [null, undefined, [], "issue"]) assert.throws(() => parseServiceAccountCommand(body), invalid("invalid_request"));
});

test("the fewest days that move an expiry past the current one, and so whether it can be extended at all", () => {
  assert.equal(minimumExtensionDays(at(300), NOW), 301, "300 days away: 301 days from now is a day later");
  assert.equal(minimumExtensionDays(at(300.5), NOW), 302, "an extension moves the expiry at least a whole day");
  assert.equal(minimumExtensionDays(at(364), NOW), 365);
  assert.equal(minimumExtensionDays(at(365), NOW), 366, "already a full year away: nothing within the maximum is later");
  assert.equal(minimumExtensionDays(at(1), NOW), 2);
  assert.equal(minimumExtensionDays(NOW.toISOString(), NOW), 1, "expiring this instant: any day from now is later");
  assert.equal(minimumExtensionDays(at(-30), NOW), 1, "an account that already expired needs at least one day from now");
});

test("an account is extendable until its expiry is a full year away, and only while it has an active owner and is not deactivated", () => {
  const facts = (overrides: Partial<Parameters<typeof serviceAccountLifecycle>[0]> = {}) => serviceAccountLifecycle({ disabled: false, ownerActive: true, expiresAt: at(100), credentials: [], ...overrides }, NOW);
  assert.equal(facts().actions.canExtend, true);
  assert.equal(facts({ expiresAt: at(364) }).actions.canExtend, true);
  assert.equal(facts({ expiresAt: at(364.5) }).actions.canExtend, false, "not by a few hours");
  assert.equal(facts({ expiresAt: at(365) }).actions.canExtend, false, "at the maximum there is nothing later to move to");
  assert.equal(facts({ expiresAt: at(-3) }).actions.canExtend, true, "an expired account can be renewed");
  assert.equal(facts({ disabled: true }).actions.canExtend, false);

  // An owner who was deactivated: surfaced, not silently orphaned, and the account is not renewed until it has a new one.
  const orphaned = facts({ ownerActive: false });
  assert.equal(orphaned.needsOwner, true);
  assert.equal(orphaned.actions.canExtend, false);
  assert.equal(orphaned.actions.canTransfer, true, "a new owner can always be assigned to an account that is not deactivated");
  assert.equal(orphaned.status, "active", "it keeps working");
  assert.equal(orphaned.actions.canRotate || orphaned.actions.canIssue, true, "credentials can still be rotated or issued");
  assert.equal(facts().needsOwner, false);
  assert.equal(facts({ ownerActive: false, expiresAt: at(-1) }).needsOwner, true, "an expired account without an owner needs one too");
  const disabled = facts({ disabled: true, ownerActive: false });
  assert.equal(disabled.needsOwner, false, "a deactivated account is not asked for an owner");
  assert.equal(disabled.actions.canTransfer, false);
});

test("extending and transferring validate their own parameters", () => {
  assert.deepEqual(parseServiceAccountCommand({ action: "extend" }), { action: "extend", expiresInDays: SERVICE_ACCOUNT_MAX_LIFETIME_DAYS }, "a year from now by default");
  assert.deepEqual(parseServiceAccountCommand({ action: "extend", expiresInDays: 90 }), { action: "extend", expiresInDays: 90 });
  assert.deepEqual(parseServiceAccountCommand({ action: "extend", expiresInDays: null }), { action: "extend", expiresInDays: SERVICE_ACCOUNT_MAX_LIFETIME_DAYS });
  for (const expiresInDays of [0, -5, 366, 1.5, "90", NaN]) assert.throws(() => parseServiceAccountCommand({ action: "extend", expiresInDays }), invalid("invalid_expiry"), String(expiresInDays));

  assert.deepEqual(parseServiceAccountCommand({ action: "transfer", ownerSubject: "  idp|priya.nair  " }), { action: "transfer", ownerSubject: "idp|priya.nair" });
  for (const ownerSubject of [undefined, null, 7, "", "ab", "x".repeat(1025), "line\nbreak"]) assert.throws(() => parseServiceAccountCommand({ action: "transfer", ownerSubject }), invalid("invalid_owner"), String(ownerSubject));
});
