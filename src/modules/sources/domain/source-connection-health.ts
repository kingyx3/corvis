/**
 * Customer-facing health model for source connections (stories B5 and B8).
 *
 * Everything here is pure: it turns the redacted connection record returned by
 * `GET /api/v1/source-connections` into plain-language status, error copy and
 * the one action the customer needs to take, and it owns the lifecycle
 * transition rules that both the server and the UI follow. The raw lifecycle
 * and error enums are inputs only; no function here returns one for display.
 *
 * The id lists below mirror `ConnectionStatus`, `ConnectorErrorClass` and
 * `CredentialType` in `src/modules/sources/server/connectors/source-connectors.ts`. That module cannot be
 * imported from the domain layer (it reaches Postgres), so
 * `src/modules/sources/server/connections/source-connection-health-contract.test.ts` pins the two sets
 * together at compile time and at run time: adding a class on either side
 * without the matching copy here fails typecheck and the test suite.
 */

export const CONNECTION_STATUSES = ["pending_authorization", "active", "paused", "reauthorization_required", "suspended", "revoked"] as const;
export type SourceConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTOR_ERROR_CLASSES = ["auth", "reauthorization", "permission", "provider_change", "network", "download", "validation", "rate_limit"] as const;
export type SourceConnectorErrorClass = (typeof CONNECTOR_ERROR_CLASSES)[number];

export const CREDENTIAL_TYPES = ["oauth_authorization_code", "oauth_client_credentials", "scoped_api_token", "service_account", "browser_session"] as const;
export type SourceCredentialType = (typeof CREDENTIAL_TYPES)[number];

/**
 * An `active` connection with no successful sync inside this window is "stale".
 * 48 hours is two missed daily cycles: long enough that one slow or retried
 * run never flags a healthy connection, short enough that a silently stopped
 * connection is visible within the working week. For a connection that has
 * never synced, the window is measured from when its scope was confirmed.
 */
export const STALE_AFTER_HOURS = 48;
export const STALE_AFTER_MS = STALE_AFTER_HOURS * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Lifecycle transitions: one rule set shared by the Postgres path
// (src/modules/sources/server/connectors/source-connectors.ts), the demo store and the UI.
// ---------------------------------------------------------------------------

export type ConnectionAction = "pause" | "resume" | "revoke" | "reauthorize";

/** Pause keeps the connection and its history; it is allowed while collection is running or is blocked on reauthorization. */
export const PAUSE_ALLOWED_FROM: readonly SourceConnectionStatus[] = ["active", "reauthorization_required"];
/** Resume restarts the schedule and is only meaningful for a paused connection. */
export const RESUME_ALLOWED_FROM: readonly SourceConnectionStatus[] = ["paused"];

export type ConnectionTransition = { status: SourceConnectionStatus } | { refused: string };

/**
 * The status a command moves a connection to, or the governance error code
 * that refuses it. Revoke is terminal and idempotent. Reauthorizing replaces
 * the credential, not the operator's intent: a paused connection stays paused,
 * a connection still awaiting its first successful test stays pending (only a
 * verified `test` call may activate it, same as initial setup), every other
 * live connection becomes active, and a revoked one is refused.
 */
export function connectionTransition(action: ConnectionAction, current: SourceConnectionStatus): ConnectionTransition {
  if (action === "pause") return PAUSE_ALLOWED_FROM.includes(current) ? { status: "paused" } : { refused: `invalid_transition_from_${current}` };
  if (action === "resume") return RESUME_ALLOWED_FROM.includes(current) ? { status: "active" } : { refused: `invalid_transition_from_${current}` };
  if (action === "revoke") return { status: "revoked" };
  if (current === "revoked") return { refused: "connection_revoked" };
  if (current === "paused") return { status: "paused" };
  if (current === "pending_authorization") return { status: "pending_authorization" };
  return { status: "active" };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** What the customer has to do. Exactly one per connection. */
export type RequiredActionKind = "reauthorize" | "resume" | "wait" | "test" | "contact_support" | "none";
export type RequiredAction = { kind: RequiredActionKind; label: string; detail: string };

export type ErrorCopy = { summary: string; transient: boolean; action: RequiredAction };

const REAUTHORIZE: RequiredAction = { kind: "reauthorize", label: "Reauthorize", detail: "Provide a new credential for this connection. Collection restarts as soon as it is saved, and the run history is kept." };
const WAIT: RequiredAction = { kind: "wait", label: "Wait — Corvis retries automatically", detail: "Nothing is needed from you. If the failures continue, the connection is suspended and your administrators are notified." };
const CONTACT_SUPPORT: RequiredAction = { kind: "contact_support", label: "Contact support", detail: "Corvis support has to look at this connection. Include the connection name when you get in touch." };

/**
 * Plain-language copy and the single required action for every connector
 * error class. `Record<SourceConnectorErrorClass, …>` makes a missing class a
 * compile error, and the contract test makes it a test failure.
 */
export const CONNECTOR_ERROR_COPY: Record<SourceConnectorErrorClass, ErrorCopy> = {
  auth: {
    summary: "The provider rejected the saved credential, so Corvis can no longer sign in.",
    transient: false,
    action: REAUTHORIZE,
  },
  reauthorization: {
    summary: "The provider is asking for a fresh sign-in. The saved credential has expired or was withdrawn.",
    transient: false,
    action: REAUTHORIZE,
  },
  permission: {
    summary: "The provider denied access to the folders or reports you confirmed for this connection.",
    transient: false,
    action: { kind: "reauthorize", label: "Review access, then reauthorize", detail: "Check that the account behind this connection can still open everything in its scope at the provider, then reauthorize to restart collection." },
  },
  provider_change: {
    summary: "The provider changed how its portal or interface works, and Corvis can no longer read it safely.",
    transient: false,
    action: CONTACT_SUPPORT,
  },
  network: {
    summary: "Corvis could not reach the provider. This is usually temporary.",
    transient: true,
    action: WAIT,
  },
  download: {
    summary: "A file could not be downloaded from the provider. Other files are not affected.",
    transient: true,
    action: WAIT,
  },
  validation: {
    summary: "The provider returned content that failed Corvis's safety or format checks, so collection was held back.",
    transient: false,
    action: CONTACT_SUPPORT,
  },
  rate_limit: {
    summary: "The provider asked Corvis to slow down. Collection resumes at a slower pace.",
    transient: true,
    action: WAIT,
  },
};

const SUSPENDED_GENERIC: RequiredAction = { kind: "reauthorize", label: "Check the provider, then reauthorize", detail: "Collection was suspended after repeated failures. Make sure the provider is reachable and the account still has access, then reauthorize to restart it." };
const RESUME: RequiredAction = { kind: "resume", label: "Resume", detail: "Resume the connection to restart collection. Documents already collected and the run history are kept." };
const NO_ACTION: RequiredAction = { kind: "none", label: "No action needed", detail: "This connection is collecting normally." };
const REVOKED_ACTION: RequiredAction = { kind: "none", label: "No action — create a new connection to collect again", detail: "A revoked connection cannot be restored. Documents already collected and the run history are kept." };
const PENDING_ACTION: RequiredAction = { kind: "test", label: "Run a connection test to finish setup", detail: "Collection starts after the first successful connection test. Until a test passes, nothing is collected." };
const STALE_ACTION: RequiredAction = { kind: "contact_support", label: "Contact support", detail: "No error was reported, but nothing has been collected recently. Corvis support can check why the schedule is not delivering." };
const UNKNOWN_ACTION: RequiredAction = { kind: "contact_support", label: "Contact support", detail: "Corvis does not recognise this connection's state. Contact support rather than changing it." };

const CREDENTIAL_LABELS: Record<SourceCredentialType, string> = {
  oauth_authorization_code: "OAuth sign-in",
  oauth_client_credentials: "OAuth client credentials",
  scoped_api_token: "API token",
  service_account: "Service account",
  browser_session: "Browser session",
};

function has<T extends string>(table: Record<T, unknown>, key: string): key is T {
  return Object.prototype.hasOwnProperty.call(table, key);
}

export function credentialTypeLabel(credentialType: string): string {
  return has(CREDENTIAL_LABELS, credentialType) ? CREDENTIAL_LABELS[credentialType] : "Credential";
}

export function isOAuthCredential(credentialType: string): boolean {
  return credentialType.startsWith("oauth_");
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type SourceConnectionRecord = {
  sourceConnectionId: string;
  connectionLabel: string;
  credentialType: string;
  sourceScope: Array<{ label: string; path?: string }>;
  scopeConfirmedAt?: string;
  status: string;
  consecutiveFailures: number;
  lastErrorClass?: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  /** When the scheduler will next collect from this connection; absent until it has been scheduled (due at the next collection run). */
  nextScheduledAt?: string;
  /** The newest run from the run history, when the page has it; used for "Last run" and to say a sync is under way. */
  lastRun?: RunRecord;
  revokedAt?: string;
};

/** The parts of a run-history entry the connection card describes. */
export type RunRecord = {
  state: string;
  startedAt: string;
  finishedAt?: string;
  discoveredCount: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  errorClass?: string;
};

/** Distinct treatments; the UI renders each with its own icon and text, never colour alone. */
export type HealthSeverity = "healthy" | "stale" | "transient" | "attention" | "reauthorization" | "suspended" | "paused" | "pending" | "revoked" | "unknown";
export type HealthIcon = "check" | "clock" | "refresh" | "alert" | "lock" | "pause" | "source" | "close";

export type ConnectionControls = {
  pause: boolean;
  resume: boolean;
  reauthorize: boolean;
  revoke: boolean;
  /** A connectivity test can be run on demand for every live connection. */
  test: boolean;
};

export type ConnectionHealth = {
  severity: HealthSeverity;
  icon: HealthIcon;
  /** Status pills, primary first. Every label is in the StatusPill vocabulary. */
  pills: string[];
  headline: string;
  stale: boolean;
  scopeSummary: string;
  scopeItems: Array<{ label: string; path?: string }>;
  credentialLabel: string;
  lastSuccess: { at?: string; relative: string };
  lastAttempt?: { at: string; relative: string; failed: boolean };
  nextSync: string;
  /** The scheduled time when one is set and still ahead, for a machine-readable `<time>`. */
  nextSyncAt?: string;
  lastRun?: RunDescription;
  error?: { summary: string; transient: boolean };
  action: RequiredAction;
  controls: ConnectionControls;
};

/** "just now", "3 hours ago", "5 days ago". Unparseable input is "unknown". */
export function describeAge(from: string | undefined, now: Date): string {
  if (!from) return "unknown";
  const then = Date.parse(from);
  if (!Number.isFinite(then)) return "unknown";
  const elapsed = now.getTime() - then;
  if (elapsed < 60 * 60 * 1000) return elapsed < 60 * 1000 ? "just now" : `${Math.floor(elapsed / 60_000)} minutes ago`;
  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  if (hours < 48) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** The documented staleness rule: an `active` connection with no success inside {@link STALE_AFTER_HOURS}. */
export function isStale(record: Pick<SourceConnectionRecord, "status" | "lastSuccessAt" | "scopeConfirmedAt">, now: Date): boolean {
  if (record.status !== "active") return false;
  const reference = Date.parse(record.lastSuccessAt ?? record.scopeConfirmedAt ?? "");
  return Number.isFinite(reference) && now.getTime() - reference > STALE_AFTER_MS;
}

export function scopeSummary(scope: ReadonlyArray<{ label: string }>): string {
  if (scope.length === 0) return "No scope recorded";
  const labels = scope.map((entry) => entry.label);
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more`;
}

/** "in less than a minute", "in 5 minutes", "in 3 hours", "in 2 days". A time already reached is "now"; unparseable input is "unknown". */
export function describeUntil(to: string | undefined, now: Date): string {
  if (!to) return "unknown";
  const then = Date.parse(to);
  if (!Number.isFinite(then)) return "unknown";
  const remaining = then - now.getTime();
  if (remaining <= 0) return "now";
  if (remaining < 60 * 1000) return "in less than a minute";
  if (remaining < 60 * 60 * 1000) return `in ${Math.round(remaining / 60_000)} minutes`;
  const hours = Math.round(remaining / (60 * 60 * 1000));
  if (hours < 48) return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
  return `in ${Math.round(hours / 24)} days`;
}

/**
 * When an active connection is collected from next, from its stored schedule: a time still ahead is described as
 * "in 3 hours"; no schedule, or one already reached, means it is due and starts at the next collection run; a run under
 * way is "Syncing now". Every other status explains why nothing is scheduled.
 */
export function describeNextSync(status: SourceConnectionStatus | undefined, nextScheduledAt: string | undefined, now: Date, syncing = false): string {
  switch (status) {
    case "active": {
      if (syncing) return "Syncing now";
      const scheduled = nextScheduledAt === undefined ? Number.NaN : Date.parse(nextScheduledAt);
      return Number.isFinite(scheduled) && scheduled > now.getTime() ? `Scheduled ${describeUntil(nextScheduledAt, now)}` : "Due now: starts at the next collection run";
    }
    case "paused": return "Not scheduled — resume the connection to restart the schedule";
    case "reauthorization_required": return "Sync is stopped until the connection is reauthorized";
    case "suspended": return "Sync is stopped until the issue is resolved and the connection is reauthorized";
    case "pending_authorization": return "Not scheduled — sync starts after setup is finished";
    case "revoked": return "Never — this connection was revoked";
    default: return "Not scheduled";
  }
}

export type RunDescription = {
  /** When the run finished (or started, while it is still running). */
  at: string;
  relative: string;
  /** The run-state vocabulary word ("Succeeded", "Stopped before collecting"…). */
  label: string;
  tone: "success" | "error" | "neutral";
  /** What the run did or why it did not, in plain words. */
  detail: string;
};

/** What the newest run did, for the connection card: its outcome, the counts, or the plain-language reason it failed or was refused. */
export function describeRun(run: RunRecord, now: Date): RunDescription {
  const at = run.finishedAt ?? run.startedAt;
  const base = { at, relative: describeAge(at, now), label: runStateLabel(run.state) };
  if (run.state === "succeeded") {
    const detail = run.discoveredCount === 0
      ? "No documents were found in the confirmed scope."
      : `${run.discoveredCount} found: ${run.acceptedCount} new, ${run.duplicateCount} already collected, ${run.rejectedCount} not accepted.`;
    return { ...base, tone: "success", detail };
  }
  if (run.state === "running") return { ...base, tone: "neutral", detail: "Collecting now." };
  if (run.state === "refused" || run.state === "failed" || run.state === "retryable" || run.state === "dead_letter") {
    const fallback = run.state === "refused" ? "Nothing was collected because the connection was not active." : "The run ended before it finished.";
    return { ...base, tone: "error", detail: run.errorClass ? runErrorSummary(run.errorClass) : fallback };
  }
  return { ...base, tone: "neutral", detail: "This run's outcome is not recognised." };
}

function knownStatus(status: string): SourceConnectionStatus | undefined {
  return (CONNECTION_STATUSES as readonly string[]).includes(status) ? status as SourceConnectionStatus : undefined;
}

function knownErrorClass(errorClass: string | undefined): SourceConnectorErrorClass | undefined {
  return errorClass !== undefined && has(CONNECTOR_ERROR_COPY, errorClass) ? errorClass : undefined;
}

function controlsFor(record: SourceConnectionRecord, status: SourceConnectionStatus | undefined): ConnectionControls {
  // A state this page does not recognise offers no controls: it must not guess at the server's rules.
  if (status === undefined) return { pause: false, resume: false, reauthorize: false, revoke: false, test: false };
  return {
    pause: "status" in connectionTransition("pause", status),
    resume: "status" in connectionTransition("resume", status),
    reauthorize: "status" in connectionTransition("reauthorize", status),
    revoke: status !== "revoked",
    test: status !== "revoked",
  };
}

type Classification = { severity: HealthSeverity; icon: HealthIcon; pill: string; action: RequiredAction };

function classify(status: SourceConnectionStatus | undefined, errorClass: SourceConnectorErrorClass | undefined, stale: boolean): Classification {
  switch (status) {
    case "revoked": return { severity: "revoked", icon: "close", pill: "Revoked", action: REVOKED_ACTION };
    case "pending_authorization": return { severity: "pending", icon: "source", pill: "Pending", action: PENDING_ACTION };
    case "paused": return { severity: "paused", icon: "pause", pill: "Paused", action: RESUME };
    case "reauthorization_required": return { severity: "reauthorization", icon: "lock", pill: "Needs reauthorization", action: REAUTHORIZE };
    case "suspended": {
      const specific = errorClass === "permission" || errorClass === "provider_change" ? CONNECTOR_ERROR_COPY[errorClass].action : SUSPENDED_GENERIC;
      return { severity: "suspended", icon: "alert", pill: "Suspended", action: specific };
    }
    case "active": {
      if (errorClass) {
        const copy = CONNECTOR_ERROR_COPY[errorClass];
        return copy.transient
          ? { severity: "transient", icon: "refresh", pill: "Retrying", action: copy.action }
          : { severity: "attention", icon: "alert", pill: "Needs attention", action: copy.action };
      }
      return stale
        ? { severity: "stale", icon: "clock", pill: "Stale", action: STALE_ACTION }
        : { severity: "healthy", icon: "check", pill: "Healthy", action: NO_ACTION };
    }
    default: return { severity: "unknown", icon: "alert", pill: "Needs attention", action: UNKNOWN_ACTION };
  }
}

function headlineFor(severity: HealthSeverity, staleSince: string, errorSummary: string): string {
  switch (severity) {
    case "healthy": return "Collecting normally.";
    case "stale": return `No successful sync ${staleSince}.`;
    case "transient":
    case "attention": return errorSummary;
    case "reauthorization": return "Collection has stopped. This connection must be reauthorized.";
    case "suspended": return "Collection is suspended until the cause is resolved.";
    case "paused": return "Paused. No documents are collected while a connection is paused.";
    case "pending": return "Setup is not finished, so nothing is collected yet.";
    case "revoked": return "Revoked. Corvis can no longer access this source.";
    case "unknown": return "This connection is in a state this page does not recognise.";
  }
}

/** The complete customer-facing description of one connection at `now`. */
export function describeConnection(record: SourceConnectionRecord, now: Date = new Date()): ConnectionHealth {
  const status = knownStatus(record.status);
  const errorClass = knownErrorClass(record.lastErrorClass);
  const errorCopy = errorClass ? CONNECTOR_ERROR_COPY[errorClass] : undefined;
  const stale = isStale(record, now);
  const classification = classify(status, errorClass, stale);
  const lastSuccessRelative = record.lastSuccessAt ? describeAge(record.lastSuccessAt, now) : "never";
  const attemptFailed = Boolean(errorClass) && record.lastAttemptAt !== undefined
    && (record.lastSuccessAt === undefined || Date.parse(record.lastAttemptAt) > Date.parse(record.lastSuccessAt));

  return {
    severity: classification.severity,
    icon: classification.icon,
    pills: stale && classification.pill !== "Stale" ? [classification.pill, "Stale"] : [classification.pill],
    headline: headlineFor(classification.severity, record.lastSuccessAt ? `for ${describeAge(record.lastSuccessAt, now).replace(/ ago$/, "")}` : "since this connection was set up", errorCopy?.summary ?? ""),
    stale,
    scopeSummary: scopeSummary(record.sourceScope),
    scopeItems: record.sourceScope.map((entry) => entry.path ? { label: entry.label, path: entry.path } : { label: entry.label }),
    credentialLabel: credentialTypeLabel(record.credentialType),
    lastSuccess: { ...(record.lastSuccessAt ? { at: record.lastSuccessAt } : {}), relative: lastSuccessRelative },
    ...(record.lastAttemptAt ? { lastAttempt: { at: record.lastAttemptAt, relative: describeAge(record.lastAttemptAt, now), failed: attemptFailed } } : {}),
    nextSync: describeNextSync(status, record.nextScheduledAt, now, record.lastRun?.state === "running"),
    ...(status === "active" && record.nextScheduledAt && Date.parse(record.nextScheduledAt) > now.getTime() && record.lastRun?.state !== "running" ? { nextSyncAt: record.nextScheduledAt } : {}),
    ...(record.lastRun ? { lastRun: describeRun(record.lastRun, now) } : {}),
    ...(errorCopy ? { error: { summary: errorCopy.summary, transient: errorCopy.transient } } : {}),
    action: classification.action,
    controls: controlsFor(record, status),
  };
}

// ---------------------------------------------------------------------------
// Confirmation copy and credential input
// ---------------------------------------------------------------------------

export type ActionDialogCopy = { title: string; consequences: string[]; confirmLabel: string; busyLabel: string; success: string };

/** What each state-changing command does and does not do, shown before the customer confirms. */
export const CONNECTION_ACTION_COPY = {
  pause: {
    title: "Pause this connection?",
    consequences: [
      "Scheduled collection stops until you resume the connection.",
      "The stored credential, documents already collected and the run history are kept.",
      "You can resume it at any time.",
    ],
    confirmLabel: "Pause connection",
    busyLabel: "Pausing…",
    success: "Connection paused. Scheduled collection is stopped until you resume it.",
  },
  resume: {
    title: "Resume this connection?",
    consequences: [
      "Scheduled collection restarts using the stored credential.",
      "If the credential has expired or was withdrawn at the provider, the next sync fails and asks you to reauthorize.",
    ],
    confirmLabel: "Resume connection",
    busyLabel: "Resuming…",
    success: "Connection resumed. Scheduled collection is restarted.",
  },
  revoke: {
    title: "Revoke this connection permanently?",
    consequences: [
      "Scheduled collection stops immediately and can never be restarted for this connection.",
      "The stored credential is destroyed, so Corvis can no longer sign in to the provider.",
      "Documents already collected and the run history are retained.",
      "This cannot be undone. To collect from this source again you must create a new connection.",
    ],
    confirmLabel: "Revoke connection",
    busyLabel: "Revoking…",
    success: "Connection revoked. Collection has stopped and the credential was destroyed.",
  },
} as const satisfies Record<"pause" | "resume" | "revoke", ActionDialogCopy>;

/**
 * How a reauthorization dialog collects the new credential for a credential type. A connection that signs in with
 * OAuth is renewed by signing in again at the provider, so there is nothing to type (`oauth`); a client-credentials
 * connection has no sign-in and takes its client credentials as a pasted JSON object.
 */
export type CredentialInput =
  | { kind: "token"; label: string; hint: string }
  | { kind: "json"; label: string; hint: string }
  | { kind: "oauth" };

export const OAUTH_REAUTHORIZE_REQUIRES_SIGN_IN = "Sign in with the provider to reauthorize this connection.";

export function credentialInput(credentialType: string): CredentialInput {
  if (credentialType === "oauth_authorization_code") return { kind: "oauth" };
  if (credentialType === "oauth_client_credentials") return { kind: "json", label: "New client credentials (JSON)", hint: "Paste the client credentials as a JSON object. It is sent once, never shown again and never stored in your browser." };
  if (credentialType === "service_account") return { kind: "json", label: "New service account key (JSON)", hint: "Paste the full JSON key. It is sent once, never shown again and never stored in your browser." };
  if (credentialType === "browser_session") return { kind: "token", label: "New session token", hint: "Paste the session token the provider issued. It is sent once, never shown again and never stored in your browser." };
  return { kind: "token", label: "New API token", hint: "Paste the new token. It is sent once, never shown again and never stored in your browser." };
}

export type SecretBuildResult = { ok: true; secret: Record<string, unknown> } | { ok: false; error: string };

/**
 * The `secret` body of `POST …/reauthorize`: `{ token }` for token-style
 * credentials and the parsed key object for a service account. Error text
 * never repeats what was typed.
 */
export function buildReauthorizeSecret(credentialType: string, raw: string): SecretBuildResult {
  return buildCredentialSecret(credentialType, raw, "Enter the new credential.");
}

/** The secret body for a credential typed into a form: the shared rule behind both reauthorization and the connect wizard. */
export function buildCredentialSecret(credentialType: string, raw: string, emptyMessage: string): SecretBuildResult {
  const input = credentialInput(credentialType);
  if (input.kind === "oauth") return { ok: false, error: OAUTH_REAUTHORIZE_REQUIRES_SIGN_IN };
  const value = raw.trim();
  if (!value) return { ok: false, error: emptyMessage };
  if (input.kind === "token") return { ok: true, secret: { token: value } };
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return { ok: false, error: "That is not valid JSON. Paste the complete key file." }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "The key must be a JSON object. Paste the complete key file." };
  return { ok: true, secret: parsed as Record<string, unknown> };
}

/** Plain-language outcome of a reauthorization, by the status the connection had. */
export function reauthorizeOutcome(previousStatus: string): string {
  if (previousStatus === "paused") return "Credential replaced. The connection stays paused until you resume it.";
  if (previousStatus === "pending_authorization") {
    return "Credential replaced. The previous credential was retired; run a connection test to finish setup.";
  }
  return "Credential replaced. Collection is active again and the previous credential was retired.";
}

/** Plain-language reason for an API failure of a connection command. Never echoes codes or request content. */
export function commandFailureMessage(action: ConnectionAction, status: number | undefined): string {
  if (status === 403) return "You do not have permission to change source connections.";
  if (status === 404) return "This connection no longer exists. Refresh the list.";
  if (status === 422) return "This source is no longer available to reauthorize. Contact Corvis support and mention this connection's name.";
  if (status === 429) return "Too many sign-in attempts in a short time. Wait a few minutes and try again.";
  if (status === 409) return action === "reauthorize"
    ? "This connection was revoked or changed while you were working. Refresh the list."
    : "This connection changed state while you were working. Refresh the list and try again.";
  if (status === 400) return "The request was not accepted. Check what you entered and try again.";
  return "The change could not be completed. Nothing was changed; try again.";
}

// ---------------------------------------------------------------------------
// Run-history vocabulary (the B7 section): plain words instead of stored enums
// ---------------------------------------------------------------------------

const STATUS_PILL_LABELS: Record<SourceConnectionStatus, string> = {
  pending_authorization: "Pending",
  active: "Active",
  paused: "Paused",
  reauthorization_required: "Needs reauthorization",
  suspended: "Suspended",
  revoked: "Revoked",
};

/** The status-pill label for a stored connection status; an unrecognised value is flagged rather than printed. */
export function connectionStatusLabel(status: string): string {
  return has(STATUS_PILL_LABELS, status) ? STATUS_PILL_LABELS[status] : "Needs attention";
}

const RUN_STATE_LABELS: Record<string, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  retryable: "Failed, will retry",
  dead_letter: "Failed, retries used up",
  refused: "Stopped before collecting",
};

export function runStateLabel(state: string): string {
  return has(RUN_STATE_LABELS, state) ? RUN_STATE_LABELS[state]! : "Unrecognised state";
}

const DISPOSITION_LABELS: Record<string, string> = {
  accepted: "Accepted",
  duplicate: "Already collected",
  rejected: "Rejected",
  quarantined: "Held for security review",
};

export function acquisitionDispositionLabel(disposition: string): string {
  return has(DISPOSITION_LABELS, disposition) ? DISPOSITION_LABELS[disposition]! : "Unrecognised outcome";
}

/** Customer wording for the error class recorded on a run. */
export function runErrorSummary(errorClass: string): string {
  const known = knownErrorClass(errorClass);
  return known ? CONNECTOR_ERROR_COPY[known].summary : "The run failed for a reason this page does not recognise.";
}
