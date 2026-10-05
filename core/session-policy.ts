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

import type { IdentityProtocol, IdentityProviderStatus, VerifiedDomainView } from "./identity-records.ts";

/** Idle timeout: 15 minutes to 8 hours. */
export const SESSION_IDLE_TIMEOUT_BOUNDS = { min: 15, max: 480 } as const;
/** Maximum session length: 1 hour to 7 days. */
export const SESSION_MAX_LENGTH_BOUNDS = { min: 60, max: 10080 } as const;

/**
 * How long a session record (`tenant_session_activity`) is kept after the session was last seen (F7d, #337). It must
 * outlast every session a limit can still be measuring: the longest allowed maximum session plus a day of margin, which
 * is also the floor migration 091's purge function enforces. Anything shorter could drop a record the policy is still
 * judging, so a requested retention is never allowed below it.
 */
export const SESSION_ACTIVITY_RETENTION_FLOOR_MINUTES = SESSION_MAX_LENGTH_BOUNDS.max + 24 * 60;
/** The retention the delivery tick uses: 90 days, so a session that went quiet is still recognised long after it could have been valid. */
export const SESSION_ACTIVITY_RETENTION_MINUTES = 90 * 24 * 60;
/** Most records one purge call removes, so one tick never holds a long scan or lock; the rest wait for the next tick. */
export const SESSION_ACTIVITY_PURGE_LIMIT = 5000;

/** A requested retention, raised to the floor and made a whole number; the default when none is requested. */
export function sessionActivityRetentionMinutes(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return SESSION_ACTIVITY_RETENTION_MINUTES;
  return Math.max(SESSION_ACTIVITY_RETENTION_FLOOR_MINUTES, Math.floor(requested));
}

export const SESSION_POLICY_MIN_REASON_LENGTH = 3;
export const SESSION_POLICY_MAX_REASON_LENGTH = 1000;

export type SessionPolicy = {
  /** Minutes without a request after which a session ends; null means the organization sets no idle limit. */
  idleTimeoutMinutes: number | null;
  /** Minutes after which a session ends however active it is; null means the organization sets no limit. */
  maxSessionMinutes: number | null;
  /**
   * Require SSO (F7a, #334): while on, an interactive human session is accepted only if it authenticated through the
   * organization's recorded, active OpenID Connect provider with token binding. A SAML or gateway-asserted sign-in is refused.
   */
  requireSso: boolean;
  /** Bumped on every change; a change names the version it was based on so two admins cannot overwrite each other. */
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type SessionPolicyUpdate = {
  idleTimeoutMinutes: number | null;
  maxSessionMinutes: number | null;
  /** Left out, the stored value is kept: a caller that does not state it can never weaken it. */
  requireSso?: boolean;
  expectedVersion: number;
  reason: string;
};

export type IdentityProviderView = {
  protocol: IdentityProtocol;
  /** The issuer tokens must come from (an OIDC issuer URL, or a SAML entity id), or null when none is configured. */
  issuer: string | null;
  /** The audience tokens must be issued for; null while the shared provider is shown (its audience is a deployment setting, not a tenant record). */
  audience: string | null;
  /**
   * "tenant": Corvis operations recorded this organization's own provider (F7e, #338), shown with its real configuration.
   * "global": none is recorded, so what is shown is the single provider Corvis verifies tokens from for every organization.
   */
  source: "tenant" | "global";
  /** The recorded provider's status; null for the shared provider. */
  status: IdentityProviderStatus | null;
  /** Whether a token is accepted for this organization only from the recorded issuer and audience (off unless Corvis operations turned it on). */
  tokenBindingEnforced: boolean;
  /**
   * Whether the identity provider enforces MFA for this organization's sign-ins, as recorded by Corvis support (F7a, #334):
   * true, false, or null when it is not reported (also null for the shared provider, which has no tenant record).
   */
  idpEnforcesMfa: boolean | null;
  /** The provider's OIDC end-session (RP-initiated logout) endpoint as recorded by Corvis support, or null when none is recorded. */
  endSessionEndpoint: string | null;
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
  /** Of those, the sessions whose token reported more than one factor (`amr`). Sessions that reported nothing are not counted. */
  sessionsWithMfa: number;
};

/** What the verified token of the administrator's own request says about how they signed in (F7a, #334); never stored from here. */
export type CurrentSessionView = {
  /** True: more than one factor was reported; false: an `amr` was reported without one; null: no `amr` was reported. */
  mfaUsed: boolean | null;
  /** The token's `acr` claim when the provider sent one. */
  authContext: string | null;
};

export type SessionPolicyView = {
  policy: SessionPolicy;
  bounds: { idleTimeoutMinutes: { min: number; max: number }; maxSessionMinutes: { min: number; max: number } };
  identityProvider: IdentityProviderView;
  /**
   * The email domains Corvis operations verified belong to this organization (F7b, #335). While there is at least one, a new
   * invitation or SCIM user must be on one of them; with none the check is off. Existing people are never affected.
   */
  verifiedDomains: VerifiedDomainView[];
  scim: ScimView;
  signInMethods: SignInMethodView[];
  currentSession: CurrentSessionView;
  members: SessionMemberView[];
};

export type SignOutEverywhereCommand = { userId: string; reason: string };
export type SignOutEverywhereResult = {
  userId: string;
  label: string;
  revokedSessions: number;
  /**
   * The identity provider's end-session endpoint when Corvis support recorded one (F7c, #336). Corvis does not call it:
   * ending the person's session at the identity provider is a step for the administrator, who is told so.
   */
  idpEndSessionEndpoint: string | null;
};

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
  if (body.requireSso !== undefined && typeof body.requireSso !== "boolean") return fail("invalid_require_sso");
  return {
    idleTimeoutMinutes, maxSessionMinutes, ...(body.requireSso === undefined ? {} : { requireSso: body.requireSso }),
    expectedVersion, reason: reasonText(body.reason),
  };
}

/** Whether Require SSO can be turned on at all: the organization needs its own active OpenID Connect provider with token binding. */
export function ssoCanBeRequired(provider: IdentityProviderView): boolean {
  return provider.source === "tenant" && provider.protocol === "oidc" && provider.status === "active" && provider.tokenBindingEnforced;
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
