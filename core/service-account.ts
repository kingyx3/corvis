/**
 * Service accounts (F6, #262): the domain contract shared by the API, the Postgres and demo implementations and the UI.
 *
 * A service account is a non-human identity under the EXISTING RBAC, entitlement and data-rights model (#11): one
 * workspace, one of the ordinary roles, a finite lifetime. An Organization Admin creates one, and issues, rotates and
 * revokes its API credential. The credential secret is returned exactly once, when it is issued; only a hash is kept.
 *
 *   account:     active -> disabled      (final: a new account is created instead; disabling deactivates it everywhere)
 *   credential:  active -> rotating_out -> retired       (rotation, after a short overlap)
 *                active | rotating_out -> revoked        (revocation, effective immediately)
 *                active | rotating_out -> expired        (its expiry passed)
 *   expiry:      moved later only, by an audited extension, never past the maximum lifetime from the moment of the extension
 *   owner:       an active Organization Admin who answers for the account (the creator first); handed to another by an
 *                audited transfer. An owner who is deactivated is never silently orphaned: the account is flagged as
 *                needing a new owner, and it is not extended until it has one.
 *
 * This contract says nothing about how a presented credential is accepted at the API edge: see docs/SERVICE_ACCOUNTS.md.
 */

/** Roles a service account may hold: the ordinary roles below any administrator. A machine is never an administrator. */
export const SERVICE_ACCOUNT_ROLES = ["reviewer", "analyst", "viewer"] as const;
export type ServiceAccountRole = (typeof SERVICE_ACCOUNT_ROLES)[number];

/** Product labels for the roles (ROLE_AND_ACTOR_TERMINOLOGY.md): raw identifiers are never shown to people. */
export const SERVICE_ACCOUNT_ROLE_LABEL: Record<ServiceAccountRole, string> = {
  reviewer: "Review Analyst",
  analyst: "Analyst",
  viewer: "Viewer",
};

export const SERVICE_ACCOUNT_MIN_TEXT_LENGTH = 3;
export const SERVICE_ACCOUNT_MAX_NAME_LENGTH = 120;
export const SERVICE_ACCOUNT_MAX_PURPOSE_LENGTH = 512;
export const SERVICE_ACCOUNT_MAX_REASON_LENGTH = 1000;
/** The longest identity subject the identity tables hold. */
export const SERVICE_ACCOUNT_MAX_SUBJECT_LENGTH = 1024;

/**
 * An account's expiry is at most this many days away (the 009 lifecycle rule: finite, never open-ended): at creation,
 * and again whenever an Organization Admin extends it, which is the audited renewal that also advances its review date.
 */
export const SERVICE_ACCOUNT_MAX_LIFETIME_DAYS = 365;
/** A credential is shorter-lived than its account by default, and is never valid past it. */
export const SERVICE_ACCOUNT_DEFAULT_CREDENTIAL_DAYS = 90;
/** A credential this close to its expiry (or an account this close to its own) is flagged. */
export const SERVICE_ACCOUNT_EXPIRY_WARNING_DAYS = 14;
/** How long a rotated-out credential keeps working: long enough to roll a fleet, never longer than a day. */
export const SERVICE_ACCOUNT_DEFAULT_OVERLAP_MINUTES = 60;
export const SERVICE_ACCOUNT_MAX_OVERLAP_MINUTES = 1440;
/** Active accounts per organization. */
export const SERVICE_ACCOUNT_LIMIT = 100;
/** The most recent credentials listed per account. */
export const SERVICE_ACCOUNT_CREDENTIAL_HISTORY = 10;
/** Effective entitlements one account may hold (a product default, enforced in SQL by the grant function). */
export const SERVICE_ACCOUNT_ENTITLEMENT_LIMIT = 200;
/** The most grantable funds and documents offered to an Organization Admin at once. */
export const SERVICE_ACCOUNT_GRANTABLE_LIMIT = 500;
/** The longest resource identifier the entitlement tables hold. */
export const SERVICE_ACCOUNT_MAX_RESOURCE_ID_LENGTH = 512;

/**
 * What an Organization Admin can scope for a machine (F6c, #342): funds and documents, read-only. Review, publish and admin
 * permissions are never granted to a service account from this screen, and a workspace is the account's own.
 */
export const SERVICE_ACCOUNT_RESOURCE_TYPES = ["fund", "document"] as const;
export type ServiceAccountResourceType = (typeof SERVICE_ACCOUNT_RESOURCE_TYPES)[number];
export const SERVICE_ACCOUNT_RESOURCE_TYPE_LABEL: Record<ServiceAccountResourceType, string> = { fund: "Fund", document: "Document" };
/** Product labels for the permission an entitlement carries (an operator may have granted more than `read`). */
export const SERVICE_ACCOUNT_PERMISSION_LABEL: Record<string, string> = { read: "Can view", review: "Can review", publish: "Can publish", admin: "Administers" };

const DAY_MS = 24 * 60 * 60 * 1000;

export type ServiceAccountStatus = "active" | "expired" | "disabled";
export type ServiceAccountCredentialStatus = "active" | "rotating_out" | "retired" | "expired" | "revoked";

export const SERVICE_ACCOUNT_STATUS_LABEL: Record<ServiceAccountStatus, string> = { active: "Active", expired: "Expired", disabled: "Disabled" };
export const SERVICE_ACCOUNT_CREDENTIAL_STATUS_LABEL: Record<ServiceAccountCredentialStatus, string> = {
  active: "Active",
  rotating_out: "Rotating out",
  retired: "Replaced",
  expired: "Expired",
  revoked: "Revoked",
};

export type ServiceAccountCredential = {
  credentialId: string;
  status: ServiceAccountCredentialStatus;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  /** When it stops working before its expiry: the end of a rotation overlap, or the moment it was revoked. */
  endsAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** In use and within the warning window of its expiry. */
  expiringSoon: boolean;
};

/** The actions the Organization Admin may take on an account right now. Derived once, here, so API and UI agree. */
export type ServiceAccountActions = {
  canIssue: boolean;
  canRotate: boolean;
  canRevoke: boolean;
  canDisable: boolean;
  /** Not deactivated, owned by an active admin, and its expiry can still be moved later. */
  canExtend: boolean;
  canTransfer: boolean;
};

/** A fund or document the account may read, through the same entitlement rows a person's access comes from. */
export type ServiceAccountEntitlement = {
  resourceType: ServiceAccountResourceType;
  resourceId: string;
  /** The fund or document name, or its identifier when no name is known. */
  label: string;
  /** `read` for everything granted here; an operator may have granted more. */
  permission: string;
  grantedAt: string;
  /**
   * The organization still holds an effective, client-visible data right for the resource. When false the entitlement is on
   * record but the authorization lookup ignores it, so the account sees nothing of it until the right is back.
   */
  withinDataRights: boolean;
};

/** A fund or document an Organization Admin may grant: one the organization owns and holds a client-visible data right for. */
export type ServiceAccountGrantableResource = { resourceType: ServiceAccountResourceType; resourceId: string; label: string };

/** What an Organization Admin can do to the account's data access right now. */
export type ServiceAccountEntitlementAccess = {
  /** The account is active (not deactivated or expired). */
  canGrant: boolean;
  /** Not deactivated, and it holds at least one entitlement. Access can be removed from an expired account too. */
  canRevoke: boolean;
};

export type ServiceAccount = {
  serviceAccountId: string;
  /** The account's identity reference (its user id), as it appears in the operator access review. */
  userId: string;
  name: string;
  purpose: string;
  workspaceId: string;
  workspaceName: string;
  roleName: ServiceAccountRole;
  status: ServiceAccountStatus;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  disabledAt: string | null;
  disabledBy: string | null;
  disableReason: string | null;
  /** The Organization Admin who answers for the account: its creator until it is transferred. */
  ownerSubject: string;
  ownerAssignedAt: string;
  /** False when the owner was deactivated or is no longer an Organization Admin. */
  ownerActive: boolean;
  /** Not deactivated and without an active owner: it keeps working, and must be given a new owner. */
  needsOwner: boolean;
  /** The most recent use of any of its credentials; null when none was ever used. */
  lastUsedAt: string | null;
  /** The expiry of the credential in use now (the newest valid one); null when it has none. */
  credentialExpiresAt: string | null;
  /** The credential in use, or the account itself, expires within the warning window. */
  expiringSoon: boolean;
  credentials: ServiceAccountCredential[];
  actions: ServiceAccountActions;
  /** The funds and documents the account can read: its effective entitlements. Nothing until an admin or Corvis operations grants some. */
  entitlements: ServiceAccountEntitlement[];
  entitlementAccess: ServiceAccountEntitlementAccess;
};

/** The one response that carries a secret. It is returned once and cannot be read again. */
export type IssuedServiceAccountCredential = {
  credentialId: string;
  secret: string;
  expiresAt: string;
};
export type ServiceAccountCreated = { serviceAccount: ServiceAccount; credential: IssuedServiceAccountCredential };
export type ServiceAccountCredentialIssued = { serviceAccount: ServiceAccount; credential: IssuedServiceAccountCredential };

/** A person the account can be transferred to: an active Organization Admin of the organization. */
export type ServiceAccountOwnerCandidate = { subject: string };

export type CreateServiceAccountCommand = {
  name: string;
  purpose: string;
  workspaceId: string;
  roleName: ServiceAccountRole;
  expiresInDays: number;
  credentialExpiresInDays: number;
};

export type ServiceAccountCommand =
  | { action: "issue"; credentialExpiresInDays: number }
  | { action: "rotate"; credentialExpiresInDays: number; overlapMinutes: number }
  | { action: "revoke"; reason: string }
  | { action: "disable"; reason: string }
  /** Moves the expiry to this many days from now, which must be later than the current expiry. */
  | { action: "extend"; expiresInDays: number }
  | { action: "transfer"; ownerSubject: string }
  /** Gives the account read access to one fund or document the organization owns and holds a data right for. */
  | { action: "grant_entitlement"; resourceType: ServiceAccountResourceType; resourceId: string; reason: string }
  /** Ends everything the account holds on one fund or document. */
  | { action: "revoke_entitlement"; resourceType: ServiceAccountResourceType; resourceId: string; reason: string };
export type ServiceAccountAction = ServiceAccountCommand["action"];

// ---------------------------------------------------------------------------
// Lifecycle derivation (shared by both backends and the UI)
// ---------------------------------------------------------------------------

export type CredentialFacts = { revoked: boolean; expiresAt: string; endsAt: string | null };

export function credentialStatus(facts: CredentialFacts, now: Date): ServiceAccountCredentialStatus {
  const at = now.getTime();
  if (facts.revoked) return "revoked";
  if (Date.parse(facts.expiresAt) <= at) return "expired";
  if (facts.endsAt === null) return "active";
  return Date.parse(facts.endsAt) > at ? "rotating_out" : "retired";
}

/** A credential in use whose expiry is inside the warning window. */
export function expiresSoon(expiresAt: string, now: Date): boolean {
  const remaining = Date.parse(expiresAt) - now.getTime();
  return remaining > 0 && remaining <= SERVICE_ACCOUNT_EXPIRY_WARNING_DAYS * DAY_MS;
}

export function serviceAccountStatus(disabled: boolean, expiresAt: string, now: Date): ServiceAccountStatus {
  if (disabled) return "disabled";
  return Date.parse(expiresAt) <= now.getTime() ? "expired" : "active";
}

/**
 * The fewest days from now that move an account's expiry at least one day past its current one (and at least one day from
 * now). An extension is allowed when this is within the maximum lifetime, so an account whose expiry is already about a
 * year away cannot be "extended" by a few minutes.
 */
export function minimumExtensionDays(expiresAt: string, now: Date): number {
  return Math.max(1, Math.ceil((Date.parse(expiresAt) - now.getTime()) / DAY_MS) + 1);
}

type AccountFacts = {
  disabled: boolean;
  expiresAt: string;
  ownerActive: boolean;
  credentials: Array<Pick<ServiceAccountCredential, "status" | "expiresAt" | "lastUsedAt">>;
  /** How many entitlements the account holds now (0 when not given). */
  entitlementCount?: number;
};

/** Everything an account's presentation derives from its facts: status, last use, current expiry, flag, owner state, actions and data-access actions. */
export function serviceAccountLifecycle(facts: AccountFacts, now: Date): Pick<ServiceAccount, "status" | "lastUsedAt" | "credentialExpiresAt" | "expiringSoon" | "needsOwner" | "actions" | "entitlementAccess"> {
  const status = serviceAccountStatus(facts.disabled, facts.expiresAt, now);
  const usable = facts.credentials.filter((credential) => credential.status === "active" || credential.status === "rotating_out");
  const current = facts.credentials.filter((credential) => credential.status === "active")
    .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0];
  let lastUsedAt: string | null = null;
  for (const credential of facts.credentials) {
    if (credential.lastUsedAt !== null && (lastUsedAt === null || Date.parse(credential.lastUsedAt) > Date.parse(lastUsedAt))) lastUsedAt = credential.lastUsedAt;
  }
  const live = status === "active";
  return {
    status,
    lastUsedAt,
    credentialExpiresAt: current?.expiresAt ?? null,
    expiringSoon: live && (expiresSoon(facts.expiresAt, now) || (current !== undefined && expiresSoon(current.expiresAt, now))),
    needsOwner: status !== "disabled" && !facts.ownerActive,
    actions: {
      canIssue: live && current === undefined,
      canRotate: live && current !== undefined,
      canRevoke: live && usable.length > 0,
      canDisable: status !== "disabled",
      // An account whose owner is gone is not renewed until someone takes it over.
      canExtend: status !== "disabled" && facts.ownerActive && minimumExtensionDays(facts.expiresAt, now) <= SERVICE_ACCOUNT_MAX_LIFETIME_DAYS,
      canTransfer: status !== "disabled",
    },
    entitlementAccess: { canGrant: live, canRevoke: status !== "disabled" && (facts.entitlementCount ?? 0) > 0 },
  };
}

/** An active workspace of the organization an account can be created in. */
export type ServiceAccountWorkspace = { workspaceId: string; name: string };

/**
 * Everything the list screen needs: the accounts, the workspaces a new account can be created in, who can own one, and the
 * funds and documents an admin may grant (the organization's own, within its data rights; at most 500).
 */
export type ServiceAccountList = {
  serviceAccounts: ServiceAccount[];
  workspaces: ServiceAccountWorkspace[];
  owners: ServiceAccountOwnerCandidate[];
  grantable: ServiceAccountGrantableResource[];
};

/** One plain sentence saying where a credential stands. */
export function serviceAccountCredentialSummary(credential: Pick<ServiceAccountCredential, "status" | "endsAt" | "expiresAt" | "expiringSoon">): string {
  switch (credential.status) {
    case "active": return credential.expiringSoon ? "In use. It expires soon: rotate it before then." : "In use.";
    case "rotating_out": return "Replaced by a newer credential. It keeps working until the overlap ends.";
    case "retired": return "Replaced by a newer credential and no longer accepted.";
    case "expired": return "Past its expiry and no longer accepted.";
    case "revoked": return "Revoked and no longer accepted.";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ServiceAccountValidationError extends Error {
  readonly code: string;
  readonly status = 400 as const;
  constructor(code: string) { super(code); this.name = "ServiceAccountValidationError"; this.code = code; }
}

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Free text may hold no control character, line break or separator: names and purposes are shown in tables, CSV and logs.
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029]/;

export function isServiceAccountId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string): never { throw new ServiceAccountValidationError(code); }

function text(value: unknown, max: number, code: string): string {
  if (typeof value !== "string") return fail(code);
  const clean = value.trim();
  if (clean.length < SERVICE_ACCOUNT_MIN_TEXT_LENGTH || clean.length > max || SINGLE_LINE_FORBIDDEN.test(clean)) return fail(code);
  return clean;
}

function wholeNumber(value: unknown, min: number, max: number, fallback: number, code: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return fail(code);
  return value;
}

function resourceType(value: unknown): ServiceAccountResourceType {
  const found = SERVICE_ACCOUNT_RESOURCE_TYPES.find((type) => type === value);
  return found ?? fail("invalid_resource_type");
}

/** A fund or document identifier: opaque to this layer (the database decides whether the organization owns it), but bounded and single-line. */
function resourceId(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_resource");
  const clean = value.trim();
  if (clean.length === 0 || clean.length > SERVICE_ACCOUNT_MAX_RESOURCE_ID_LENGTH || SINGLE_LINE_FORBIDDEN.test(clean)) return fail("invalid_resource");
  return clean;
}

export function parseCreateServiceAccount(body: unknown): CreateServiceAccountCommand {
  if (!isRecord(body)) return fail("invalid_request");
  const name = text(body.name, SERVICE_ACCOUNT_MAX_NAME_LENGTH, "invalid_name");
  const purpose = text(body.purpose, SERVICE_ACCOUNT_MAX_PURPOSE_LENGTH, "invalid_purpose");
  // A workspace id is opaque here (demo ids are not UUIDs); the Postgres backend refuses anything that is not one.
  if (typeof body.workspaceId !== "string" || !WORKSPACE_ID.test(body.workspaceId)) return fail("invalid_workspace");
  const roleName = SERVICE_ACCOUNT_ROLES.find((role) => role === body.roleName);
  if (roleName === undefined) return fail("invalid_role");
  const expiresInDays = wholeNumber(body.expiresInDays, 1, SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, "invalid_expiry");
  const credentialExpiresInDays = wholeNumber(body.credentialExpiresInDays, 1, SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, Math.min(SERVICE_ACCOUNT_DEFAULT_CREDENTIAL_DAYS, expiresInDays), "invalid_expiry");
  return { name, purpose, workspaceId: body.workspaceId, roleName, expiresInDays, credentialExpiresInDays };
}

export function parseServiceAccountCommand(body: unknown): ServiceAccountCommand {
  if (!isRecord(body)) return fail("invalid_request");
  const credentialDays = () => wholeNumber(body.credentialExpiresInDays, 1, SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, SERVICE_ACCOUNT_DEFAULT_CREDENTIAL_DAYS, "invalid_expiry");
  switch (body.action) {
    case "issue": return { action: "issue", credentialExpiresInDays: credentialDays() };
    case "rotate": return {
      action: "rotate",
      credentialExpiresInDays: credentialDays(),
      overlapMinutes: wholeNumber(body.overlapMinutes, 0, SERVICE_ACCOUNT_MAX_OVERLAP_MINUTES, SERVICE_ACCOUNT_DEFAULT_OVERLAP_MINUTES, "invalid_overlap"),
    };
    case "revoke": return { action: "revoke", reason: text(body.reason, SERVICE_ACCOUNT_MAX_REASON_LENGTH, "invalid_reason") };
    case "disable": return { action: "disable", reason: text(body.reason, SERVICE_ACCOUNT_MAX_REASON_LENGTH, "invalid_reason") };
    case "extend": return { action: "extend", expiresInDays: wholeNumber(body.expiresInDays, 1, SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, "invalid_expiry") };
    case "transfer": return { action: "transfer", ownerSubject: text(body.ownerSubject, SERVICE_ACCOUNT_MAX_SUBJECT_LENGTH, "invalid_owner") };
    case "grant_entitlement":
    case "revoke_entitlement": return {
      action: body.action,
      resourceType: resourceType(body.resourceType),
      resourceId: resourceId(body.resourceId),
      reason: text(body.reason, SERVICE_ACCOUNT_MAX_REASON_LENGTH, "invalid_reason"),
    };
    default: return fail("invalid_action");
  }
}
