import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTION_ACTION_COPY,
  CONNECTION_STATUSES,
  CONNECTOR_ERROR_CLASSES,
  CONNECTOR_ERROR_COPY,
  CREDENTIAL_TYPES,
  PAUSE_ALLOWED_FROM,
  RESUME_ALLOWED_FROM,
  STALE_AFTER_HOURS,
  STALE_AFTER_MS,
  acquisitionDispositionLabel,
  buildReauthorizeSecret,
  commandFailureMessage,
  connectionStatusLabel,
  connectionTransition,
  credentialInput,
  credentialTypeLabel,
  describeAge,
  describeConnection,
  isOAuthCredential,
  isStale,
  reauthorizeOutcome,
  runErrorSummary,
  runStateLabel,
  scopeSummary,
  type SourceConnectionRecord,
} from "./source-connection-health.ts";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function record(overrides: Partial<SourceConnectionRecord> = {}): SourceConnectionRecord {
  return {
    sourceConnectionId: "00000000-0000-4000-8000-000000000001",
    connectionLabel: "Acme portal",
    credentialType: "scoped_api_token",
    sourceScope: [{ label: "Quarterly reports", path: "/Fund III" }],
    scopeConfirmedAt: hoursAgo(24 * 30),
    status: "active",
    consecutiveFailures: 0,
    lastSuccessAt: hoursAgo(3),
    lastAttemptAt: hoursAgo(3),
    ...overrides,
  };
}

/** Every string the model can hand to the UI for a connection, flattened. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function renderedText(connection: SourceConnectionRecord): string {
  const health = describeConnection(connection, NOW);
  return strings([
    health.pills, health.headline, health.scopeSummary, health.credentialLabel, health.lastSuccess.relative,
    health.lastAttempt?.relative, health.nextSync, health.error, health.action,
  ]).join("\n");
}

test("transition rules: pause and resume only from the states the server allows, revoke is terminal and idempotent", () => {
  assert.deepEqual([...PAUSE_ALLOWED_FROM], ["active", "reauthorization_required"]);
  assert.deepEqual([...RESUME_ALLOWED_FROM], ["paused"]);
  for (const status of CONNECTION_STATUSES) {
    assert.deepEqual(connectionTransition("pause", status), PAUSE_ALLOWED_FROM.includes(status) ? { status: "paused" } : { refused: `invalid_transition_from_${status}` }, `pause from ${status}`);
    assert.deepEqual(connectionTransition("resume", status), status === "paused" ? { status: "active" } : { refused: `invalid_transition_from_${status}` }, `resume from ${status}`);
    assert.deepEqual(connectionTransition("revoke", status), { status: "revoked" }, `revoke from ${status}`);
  }
});

test("reauthorizing keeps a paused connection paused, leaves a pending one pending, reactivates every other live one and refuses a revoked one", () => {
  assert.deepEqual(connectionTransition("reauthorize", "paused"), { status: "paused" });
  assert.deepEqual(connectionTransition("reauthorize", "pending_authorization"), { status: "pending_authorization" }, "a connection awaiting its first test must not be activated on an unverified credential");
  for (const status of ["active", "reauthorization_required", "suspended"] as const) {
    assert.deepEqual(connectionTransition("reauthorize", status), { status: "active" }, status);
  }
  assert.deepEqual(connectionTransition("reauthorize", "revoked"), { refused: "connection_revoked" });
});

test("every error class has plain-language copy and exactly one required action", () => {
  assert.deepEqual(Object.keys(CONNECTOR_ERROR_COPY).sort(), [...CONNECTOR_ERROR_CLASSES].sort());
  for (const errorClass of CONNECTOR_ERROR_CLASSES) {
    const copy = CONNECTOR_ERROR_COPY[errorClass];
    assert.ok(copy.summary.length > 20 && /[.]$/.test(copy.summary), `${errorClass} summary`);
    assert.ok(copy.action.label.length > 3 && copy.action.detail.length > 20, `${errorClass} action`);
    assert.ok(["reauthorize", "wait", "contact_support"].includes(copy.action.kind), `${errorClass} action kind`);
    assert.equal(copy.summary.includes(errorClass) && errorClass.includes("_"), false, `${errorClass} copy must not print the enum`);
    assert.doesNotMatch(`${copy.summary} ${copy.action.label} ${copy.action.detail}`, /[a-z]+_[a-z]+/, `${errorClass} copy has no snake_case identifier`);
  }
});

test("reauthorization and suspension look and read differently from transient failures", () => {
  const transient = describeConnection(record({ lastErrorClass: "network", consecutiveFailures: 2 }), NOW);
  const reauth = describeConnection(record({ status: "reauthorization_required", lastErrorClass: "auth" }), NOW);
  const suspended = describeConnection(record({ status: "suspended", lastErrorClass: "permission" }), NOW);
  assert.equal(transient.severity, "transient");
  assert.equal(reauth.severity, "reauthorization");
  assert.equal(suspended.severity, "suspended");
  assert.deepEqual(new Set([transient.icon, reauth.icon, suspended.icon]).size, 3, "three different icons");
  assert.deepEqual(new Set([transient.pills[0], reauth.pills[0], suspended.pills[0]]).size, 3, "three different labels");
  assert.deepEqual([transient.pills[0], reauth.pills[0], suspended.pills[0]], ["Retrying", "Needs reauthorization", "Suspended"]);
  assert.equal(transient.action.kind, "wait");
  assert.equal(reauth.action.kind, "reauthorize");
  assert.match(reauth.headline, /stopped/);
  assert.match(suspended.headline, /suspended/);
  assert.equal(transient.error?.transient, true);
  assert.equal(reauth.error?.transient, false);
});

test("a healthy connection is collecting, not stale, with an honest next-sync statement", () => {
  const health = describeConnection(record(), NOW);
  assert.equal(health.severity, "healthy");
  assert.deepEqual(health.pills, ["Healthy"]);
  assert.equal(health.stale, false);
  assert.equal(health.headline, "Collecting normally.");
  assert.equal(health.nextSync, "Scheduled sync is not enabled yet");
  assert.deepEqual(health.lastSuccess, { at: hoursAgo(3), relative: "3 hours ago" });
  assert.deepEqual(health.lastAttempt, { at: hoursAgo(3), relative: "3 hours ago", failed: false });
  assert.equal(health.action.kind, "none");
  assert.equal(health.error, undefined);
  assert.equal(health.scopeSummary, "Quarterly reports");
  assert.deepEqual(health.scopeItems, [{ label: "Quarterly reports", path: "/Fund III" }]);
  assert.equal(health.credentialLabel, "API token");
});

test("staleness: active and no success inside the window (or never synced since the scope was confirmed)", () => {
  assert.equal(STALE_AFTER_HOURS, 48);
  assert.equal(STALE_AFTER_MS, 48 * 3_600_000);
  assert.equal(isStale(record({ lastSuccessAt: hoursAgo(48) }), NOW), false, "exactly at the window is not stale");
  assert.equal(isStale(record({ lastSuccessAt: hoursAgo(48.01) }), NOW), true);
  assert.equal(isStale(record({ lastSuccessAt: undefined, scopeConfirmedAt: hoursAgo(49) }), NOW), true, "never synced, confirmed long ago");
  assert.equal(isStale(record({ lastSuccessAt: undefined, scopeConfirmedAt: hoursAgo(5) }), NOW), false, "never synced, confirmed recently");
  assert.equal(isStale(record({ lastSuccessAt: undefined, scopeConfirmedAt: undefined }), NOW), false, "no reference time means no claim");
  assert.equal(isStale(record({ lastSuccessAt: "not-a-date" }), NOW), false);
  for (const status of ["paused", "revoked", "suspended", "reauthorization_required", "pending_authorization"]) {
    assert.equal(isStale(record({ status, lastSuccessAt: hoursAgo(500) }), NOW), false, `${status} is never stale`);
  }

  const stale = describeConnection(record({ lastSuccessAt: hoursAgo(6 * 24), lastAttemptAt: hoursAgo(6 * 24) }), NOW);
  assert.equal(stale.severity, "stale");
  assert.deepEqual(stale.pills, ["Stale"]);
  assert.equal(stale.icon, "clock");
  assert.equal(stale.headline, "No successful sync for 6 days.");
  assert.equal(stale.action.kind, "contact_support");
  const neverSynced = describeConnection(record({ lastSuccessAt: undefined, lastAttemptAt: undefined, scopeConfirmedAt: hoursAgo(100) }), NOW);
  assert.equal(neverSynced.headline, "No successful sync since this connection was set up.");
  assert.deepEqual(neverSynced.lastSuccess, { relative: "never" });
  assert.equal(neverSynced.lastAttempt, undefined);
});

test("a stale connection that is also failing shows both the failure and the stale marker", () => {
  const health = describeConnection(record({ lastErrorClass: "network", lastSuccessAt: hoursAgo(100), lastAttemptAt: hoursAgo(1) }), NOW);
  assert.equal(health.severity, "transient");
  assert.deepEqual(health.pills, ["Retrying", "Stale"]);
  assert.equal(health.stale, true);
  assert.equal(health.lastAttempt?.failed, true);
});

test("a last attempt counts as failed only when an error is recorded and it is newer than the last success", () => {
  const failedNever = describeConnection(record({ lastErrorClass: "network", lastSuccessAt: undefined, lastAttemptAt: hoursAgo(1) }), NOW);
  assert.equal(failedNever.lastAttempt?.failed, true);
  const failedAfter = describeConnection(record({ lastErrorClass: "network", lastSuccessAt: hoursAgo(5), lastAttemptAt: hoursAgo(1) }), NOW);
  assert.equal(failedAfter.lastAttempt?.failed, true);
  const olderAttempt = describeConnection(record({ lastErrorClass: "network", lastSuccessAt: hoursAgo(1), lastAttemptAt: hoursAgo(5) }), NOW);
  assert.equal(olderAttempt.lastAttempt?.failed, false);
  const noError = describeConnection(record({ lastAttemptAt: hoursAgo(1), lastSuccessAt: hoursAgo(5) }), NOW);
  assert.equal(noError.lastAttempt?.failed, false);
});

test("each status maps to its own label, icon, headline, next-sync text and single action", () => {
  const cases: Array<[Partial<SourceConnectionRecord>, string, string, string, string]> = [
    [{ status: "pending_authorization" }, "Pending", "pending", "test", "Not scheduled — sync starts after setup is finished"],
    [{ status: "paused" }, "Paused", "paused", "resume", "Not scheduled — resume the connection to restart the schedule"],
    [{ status: "reauthorization_required", lastErrorClass: "auth" }, "Needs reauthorization", "reauthorization", "reauthorize", "Sync is stopped until the connection is reauthorized"],
    [{ status: "suspended", lastErrorClass: "permission" }, "Suspended", "suspended", "reauthorize", "Sync is stopped until the issue is resolved and the connection is reauthorized"],
    [{ status: "revoked" }, "Revoked", "revoked", "none", "Never — this connection was revoked"],
  ];
  for (const [overrides, pill, severity, actionKind, nextSync] of cases) {
    const health = describeConnection(record(overrides), NOW);
    assert.equal(health.pills[0], pill);
    assert.equal(health.severity, severity);
    assert.equal(health.action.kind, actionKind);
    assert.equal(health.nextSync, nextSync);
    assert.ok(health.headline.length > 10);
  }
});

test("a suspended connection's action depends on why it was suspended", () => {
  assert.equal(describeConnection(record({ status: "suspended", lastErrorClass: "permission" }), NOW).action.label, "Review access, then reauthorize");
  assert.equal(describeConnection(record({ status: "suspended", lastErrorClass: "provider_change" }), NOW).action.kind, "contact_support");
  const repeated = describeConnection(record({ status: "suspended", lastErrorClass: "network", consecutiveFailures: 5 }), NOW);
  assert.equal(repeated.action.label, "Check the provider, then reauthorize");
  assert.equal(describeConnection(record({ status: "suspended" }), NOW).action.label, "Check the provider, then reauthorize");
  assert.match(repeated.error?.summary ?? "", /could not reach the provider/);
});

test("an active connection with a fail-closed error that is not reauthorization asks for support, not a wait", () => {
  const validation = describeConnection(record({ lastErrorClass: "validation" }), NOW);
  assert.equal(validation.severity, "attention");
  assert.deepEqual(validation.pills, ["Needs attention"]);
  assert.equal(validation.action.kind, "contact_support");
  assert.equal(validation.headline, CONNECTOR_ERROR_COPY.validation.summary);
  for (const errorClass of ["network", "download", "rate_limit"] as const) {
    const health = describeConnection(record({ lastErrorClass: errorClass }), NOW);
    assert.equal(health.severity, "transient", errorClass);
    assert.equal(health.action.kind, "wait", errorClass);
    assert.equal(health.headline, CONNECTOR_ERROR_COPY[errorClass].summary);
  }
});

test("every error class on every status renders without a raw enum, secret-like token or undefined", () => {
  for (const status of CONNECTION_STATUSES) {
    for (const errorClass of [undefined, ...CONNECTOR_ERROR_CLASSES]) {
      for (const credentialType of CREDENTIAL_TYPES) {
        const text = renderedText(record({ status, lastErrorClass: errorClass, credentialType, lastSuccessAt: hoursAgo(200) }));
        for (const raw of [...CONNECTION_STATUSES, ...CONNECTOR_ERROR_CLASSES, ...CREDENTIAL_TYPES].filter((value) => value.includes("_"))) {
          assert.equal(text.includes(raw), false, `${status}/${errorClass}/${credentialType} leaked ${raw}`);
        }
        assert.doesNotMatch(text, /undefined|null|secret|projects\//i, `${status}/${errorClass}`);
      }
    }
  }
});

test("unrecognised status or error class from a newer server degrades safely instead of printing it", () => {
  const unknownStatus = describeConnection(record({ status: "quantum_superposition" }), NOW);
  assert.equal(unknownStatus.severity, "unknown");
  assert.deepEqual(unknownStatus.pills, ["Needs attention"]);
  assert.equal(unknownStatus.action.kind, "contact_support");
  assert.equal(unknownStatus.nextSync, "Not scheduled");
  assert.deepEqual(unknownStatus.controls, { pause: false, resume: false, reauthorize: false, revoke: false, test: false });
  assert.doesNotMatch(JSON.stringify(unknownStatus), /quantum/);

  const unknownError = describeConnection(record({ lastErrorClass: "alien" }), NOW);
  assert.equal(unknownError.severity, "healthy", "an error class this page cannot describe is not invented");
  assert.equal(unknownError.error, undefined);
  const proto = describeConnection(record({ lastErrorClass: "constructor", status: "__proto__" }), NOW);
  assert.equal(proto.severity, "unknown");
  assert.equal(proto.error, undefined);
});

test("controls follow the server transitions, and an OAuth connection is reauthorized like any other", () => {
  const active = describeConnection(record(), NOW).controls;
  assert.deepEqual(active, { pause: true, resume: false, reauthorize: true, revoke: true, test: true });
  const paused = describeConnection(record({ status: "paused" }), NOW).controls;
  assert.deepEqual(paused, { pause: false, resume: true, reauthorize: true, revoke: true, test: true });
  const reauthRequired = describeConnection(record({ status: "reauthorization_required" }), NOW).controls;
  assert.deepEqual(reauthRequired, { pause: true, resume: false, reauthorize: true, revoke: true, test: true });
  const suspended = describeConnection(record({ status: "suspended" }), NOW).controls;
  assert.deepEqual(suspended, { pause: false, resume: false, reauthorize: true, revoke: true, test: true });
  const revoked = describeConnection(record({ status: "revoked" }), NOW).controls;
  assert.deepEqual(revoked, { pause: false, resume: false, reauthorize: false, revoke: false, test: false });

  const oauth = describeConnection(record({ credentialType: "oauth_authorization_code", status: "suspended" }), NOW).controls;
  assert.deepEqual(oauth, { pause: false, resume: false, reauthorize: true, revoke: true, test: true }, "no more \"unavailable\" for OAuth");
  const oauthRevoked = describeConnection(record({ credentialType: "oauth_client_credentials", status: "revoked" }), NOW).controls;
  assert.equal(oauthRevoked.reauthorize, false, "a revoked connection is never reauthorized, whatever its credential");
  assert.doesNotMatch(renderedText(record({ credentialType: "oauth_authorization_code", status: "reauthorization_required" })), /not available yet|redirect flow/);
});

test("scope summaries stay short and never invent a scope", () => {
  assert.equal(scopeSummary([]), "No scope recorded");
  assert.equal(scopeSummary([{ label: "A" }]), "A");
  assert.equal(scopeSummary([{ label: "A" }, { label: "B" }]), "A and B");
  assert.equal(scopeSummary([{ label: "A" }, { label: "B" }, { label: "C" }]), "A, B and 1 more");
  assert.equal(scopeSummary([{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }]), "A, B and 2 more");
  const withoutPath = describeConnection(record({ sourceScope: [{ label: "A" }, { label: "B", path: "/b" }] }), NOW);
  assert.deepEqual(withoutPath.scopeItems, [{ label: "A" }, { label: "B", path: "/b" }]);
});

test("ages read naturally and an unusable timestamp is never presented as a time", () => {
  assert.equal(describeAge(undefined, NOW), "unknown");
  assert.equal(describeAge("garbage", NOW), "unknown");
  assert.equal(describeAge(hoursAgo(0), NOW), "just now");
  assert.equal(describeAge(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW), "5 minutes ago");
  assert.equal(describeAge(hoursAgo(1), NOW), "1 hour ago");
  assert.equal(describeAge(hoursAgo(47), NOW), "47 hours ago");
  assert.equal(describeAge(hoursAgo(48), NOW), "2 days ago");
  assert.equal(describeAge(hoursAgo(24 * 6 + 3), NOW), "6 days ago");
  assert.equal(describeAge(hoursAgo(-1), NOW), "just now", "a clock-skewed future time is not shown as negative");
});

test("credential helpers describe types without leaking the enum", () => {
  assert.equal(credentialTypeLabel("oauth_authorization_code"), "OAuth sign-in");
  assert.equal(credentialTypeLabel("oauth_client_credentials"), "OAuth client credentials");
  assert.equal(credentialTypeLabel("scoped_api_token"), "API token");
  assert.equal(credentialTypeLabel("service_account"), "Service account");
  assert.equal(credentialTypeLabel("browser_session"), "Browser session");
  assert.equal(credentialTypeLabel("toString"), "Credential");
  assert.equal(isOAuthCredential("oauth_authorization_code"), true);
  assert.equal(isOAuthCredential("scoped_api_token"), false);
});

test("credential input kinds: tokens are masked text, keys and client credentials are JSON, an OAuth sign-in has nothing to type", () => {
  assert.equal(credentialInput("scoped_api_token").kind, "token");
  assert.equal(credentialInput("browser_session").kind, "token");
  assert.equal(credentialInput("service_account").kind, "json");
  assert.deepEqual(credentialInput("oauth_authorization_code"), { kind: "oauth" });
  for (const type of ["scoped_api_token", "browser_session", "service_account", "oauth_client_credentials"]) {
    const input = credentialInput(type);
    assert.equal(input.kind !== "oauth" && /never shown again/.test(input.hint), true, type);
  }
  assert.equal(credentialInput("oauth_client_credentials").kind, "json");
});

test("the reauthorize payload is {token} for tokens and the parsed key for service accounts, and errors never echo the input", () => {
  assert.deepEqual(buildReauthorizeSecret("scoped_api_token", "  tok-123 \n"), { ok: true, secret: { token: "tok-123" } });
  assert.deepEqual(buildReauthorizeSecret("browser_session", "cookie-value"), { ok: true, secret: { token: "cookie-value" } });
  assert.deepEqual(buildReauthorizeSecret("service_account", '{"client_email":"svc@example.test","private_key":"k"}'), { ok: true, secret: { client_email: "svc@example.test", private_key: "k" } });

  assert.deepEqual(buildReauthorizeSecret("scoped_api_token", "   "), { ok: false, error: "Enter the new credential." });
  for (const bad of ["{not json SECRET-VALUE", "[1,2]", "null", '"text SECRET-VALUE"', "42"]) {
    const result = buildReauthorizeSecret("service_account", bad);
    assert.equal(result.ok, false, bad);
    assert.equal(JSON.stringify(result).includes("SECRET-VALUE"), false, "error text never repeats the input");
  }
  const oauth = buildReauthorizeSecret("oauth_authorization_code", "anything");
  assert.deepEqual(oauth, { ok: false, error: "Sign in with the provider to reauthorize this connection." });
  assert.deepEqual(buildReauthorizeSecret("oauth_client_credentials", '{"client_id":"a","client_secret":"b"}'), { ok: true, secret: { client_id: "a", client_secret: "b" } });
});

test("confirmation copy states exactly what each action stops and keeps", () => {
  const revoke = CONNECTION_ACTION_COPY.revoke.consequences.join(" ");
  assert.match(revoke, /Scheduled collection stops immediately/);
  assert.match(revoke, /stored credential is destroyed/);
  assert.match(revoke, /Documents already collected and the run history are retained/);
  assert.match(revoke, /cannot be undone/);
  assert.match(CONNECTION_ACTION_COPY.pause.consequences.join(" "), /run history are kept/);
  assert.match(CONNECTION_ACTION_COPY.resume.consequences.join(" "), /restarts/);
  for (const action of ["pause", "resume", "revoke"] as const) {
    const copy = CONNECTION_ACTION_COPY[action];
    assert.ok(copy.confirmLabel && copy.busyLabel.endsWith("…") && copy.success.endsWith("."), action);
  }
});

test("outcome and failure messages are plain language for every case", () => {
  assert.match(reauthorizeOutcome("paused"), /stays paused/);
  assert.match(reauthorizeOutcome("suspended"), /active again/);
  assert.match(reauthorizeOutcome("pending_authorization"), /finish setup/);
  assert.match(commandFailureMessage("pause", 403), /permission/);
  assert.match(commandFailureMessage("pause", 404), /no longer exists/);
  assert.match(commandFailureMessage("reauthorize", 422), /no longer available to reauthorize/);
  assert.match(commandFailureMessage("reauthorize", 429), /Too many sign-in attempts/);
  assert.match(commandFailureMessage("pause", 409), /changed state/);
  assert.match(commandFailureMessage("reauthorize", 409), /revoked or changed/);
  assert.match(commandFailureMessage("pause", 400), /not accepted/);
  assert.match(commandFailureMessage("revoke", 500), /Nothing was changed/);
  assert.match(commandFailureMessage("revoke", undefined), /Nothing was changed/);
});

test("run-history vocabulary covers the stored values and flags unknown ones", () => {
  assert.equal(connectionStatusLabel("active"), "Active");
  assert.equal(connectionStatusLabel("pending_authorization"), "Pending");
  assert.equal(connectionStatusLabel("reauthorization_required"), "Needs reauthorization");
  assert.equal(connectionStatusLabel("whatever"), "Needs attention");
  for (const status of CONNECTION_STATUSES) assert.doesNotMatch(connectionStatusLabel(status), /_/);
  for (const state of ["running", "succeeded", "failed", "retryable", "dead_letter", "refused"]) assert.doesNotMatch(runStateLabel(state), /_|Unrecognised/, state);
  assert.equal(runStateLabel("mystery"), "Unrecognised state");
  assert.equal(runStateLabel("constructor"), "Unrecognised state");
  for (const disposition of ["accepted", "duplicate", "rejected", "quarantined"]) assert.doesNotMatch(acquisitionDispositionLabel(disposition), /Unrecognised/, disposition);
  assert.equal(acquisitionDispositionLabel("mystery"), "Unrecognised outcome");
  assert.equal(runErrorSummary("rate_limit"), CONNECTOR_ERROR_COPY.rate_limit.summary);
  assert.match(runErrorSummary("mystery"), /does not recognise/);
});
