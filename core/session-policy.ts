/**
 * Organization sign-in and session policy (F7, #263): the domain contract shared by the API, the Postgres and demo
 * implementations and the UI.
 *
 * Corvis does not run the sign-in itself: users authenticate at the identity provider and Corvis verifies the token it
 * issues. What an Organization Admin can govern is therefore how long a *Corvis session* (the identity provider's
 * session id, `sid`) may stay idle and how long it may live in total, and ending a named user's sessions at once.
 * Both limits are bounded by Corvis: a tenant can tighten them within the bounds below but can never relax them past
 * them, and the bounds are also checks on the table, so no code path can store a value outside them.
 */

/** Idle timeout: 15 minutes to 8 hours. */
export const SESSION_IDLE_TIMEOUT_BOUNDS = { min: 15, max: 480 } as const;
/** Maximum session length: 1 hour to 7 days. */
export const SESSION_MAX_LENGTH_BOUNDS = { min: 60, max: 10080 } as const;

export const SESSION_POLICY_MIN_REASON_LENGTH = 3;
export const SESSION_POLICY_MAX_REASON_LENGTH = 1000;

export type SessionPolicy = {
  /** Minutes without a request after which a session ends; null means the organization sets no idle limit. */
  idleTimeoutMinutes: number | null;
  /** Minutes after which a session ends however active it is; null means the organization sets no limit. */
  maxSessionMinutes: number | null;
  /** Bumped on every change; a change names the version it was based on so two admins cannot overwrite each other. */
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type SessionPolicyUpdate = {
  idleTimeoutMinutes: number | null;
  maxSessionMinutes: number | null;
  expectedVersion: number;
  reason: string;
};

export type IdentityProviderView = {
  /** Always OpenID Connect today: Corvis verifies bearer tokens from one configured issuer. */
  protocol: "oidc";
  /** The issuer URL tokens must come from, or null when none is configured. */
  issuer: string | null;
};

export type ScimView = {
  configured: boolean;
  enabled: boolean;
  authMethod: "oidc" | "saml" | null;
  defaultWorkspaceName: string | null;
  defaultRole: string | null;
  /** SCIM-provisioned users that are currently active. */
  activeUsers: number;
  updatedAt: string | null;
};

export type SignInMethodView = { authMethod: "oidc" | "saml"; users: number };

export type SessionMemberView = {
  userId: string;
  label: string;
  isCurrentUser: boolean;
  /** Sessions Corvis has seen recently that neither expired under the policy nor were signed out. */
  activeSessions: number;
};

export type SessionPolicyView = {
  policy: SessionPolicy;
  bounds: { idleTimeoutMinutes: { min: number; max: number }; maxSessionMinutes: { min: number; max: number } };
  identityProvider: IdentityProviderView;
  scim: ScimView;
  signInMethods: SignInMethodView[];
  members: SessionMemberView[];
};

export type SignOutEverywhereCommand = { userId: string; reason: string };
export type SignOutEverywhereResult = { userId: string; label: string; revokedSessions: number };

export class SessionPolicyValidationError extends Error {
  readonly code: string;
  readonly status = 400 as const;
  constructor(code: string) { super(code); this.name = "SessionPolicyValidationError"; this.code = code; }
}

function fail(code: string): never { throw new SessionPolicyValidationError(code); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

// Free text may hold line breaks and tabs; every other C0 control, DEL and the line/paragraph separators is refused.
const FREE_TEXT_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;

function reasonText(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_reason");
  const trimmed = value.trim();
  if (trimmed.length < SESSION_POLICY_MIN_REASON_LENGTH || trimmed.length > SESSION_POLICY_MAX_REASON_LENGTH || FREE_TEXT_FORBIDDEN.test(trimmed)) return fail("invalid_reason");
  return trimmed;
}

/** `null` clears a limit; anything else must be a whole number inside the bounds. */
function limit(value: unknown, bounds: { min: number; max: number }, code: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min || value > bounds.max) return fail(code);
  return value;
}

/**
 * Validates a policy change. Both limits are always stated (a limit that is left out is not guessed to mean "keep" or
 * "clear"), the change names the version it was based on, and the idle timeout can never exceed the session length.
 */
export function parseSessionPolicyUpdate(body: unknown): SessionPolicyUpdate {
  if (!isRecord(body)) return fail("invalid_request");
  if (!("idleTimeoutMinutes" in body) || !("maxSessionMinutes" in body)) return fail("invalid_request");
  const idleTimeoutMinutes = limit(body.idleTimeoutMinutes, SESSION_IDLE_TIMEOUT_BOUNDS, "invalid_idle_timeout");
  const maxSessionMinutes = limit(body.maxSessionMinutes, SESSION_MAX_LENGTH_BOUNDS, "invalid_max_session");
  if (idleTimeoutMinutes !== null && maxSessionMinutes !== null && idleTimeoutMinutes > maxSessionMinutes) return fail("idle_exceeds_max_session");
  const expectedVersion = body.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 0) return fail("invalid_version");
  return { idleTimeoutMinutes, maxSessionMinutes, expectedVersion, reason: reasonText(body.reason) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseSignOutEverywhere(body: unknown): SignOutEverywhereCommand {
  if (!isRecord(body)) return fail("invalid_request");
  if (typeof body.userId !== "string" || !UUID.test(body.userId.trim())) return fail("invalid_user");
  // Postgres returns canonical lower-case uuids while `::uuid` accepts any spelling.
  return { userId: body.userId.trim().toLowerCase(), reason: reasonText(body.reason) };
}

/** Plain-language summary of one limit, used by the UI and the audit trail alike. */
export function sessionLimitLabel(minutes: number | null): string {
  if (minutes === null) return "No limit set";
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} minutes`;
}
