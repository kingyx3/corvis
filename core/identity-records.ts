/**
 * Verified email domains (F7b, #335) and the per-tenant identity-provider record (F7e, #338): the domain contract shared
 * by the operator API, the Postgres implementation and the read-only view an Organization Admin sees.
 *
 * Both are Corvis-assisted: an organization cannot make either claim about itself (initial identity-provider and domain
 * setup is #78), so only Corvis operations change them and the Organization Admin reads them. The values and the
 * bounds here are also CHECK constraints and function checks in migration 095, so no code path can store a value this
 * file would refuse.
 */

export const IDENTITY_PROTOCOLS = ["oidc", "saml"] as const;
export type IdentityProtocol = (typeof IDENTITY_PROTOCOLS)[number];

export const IDENTITY_PROVIDER_STATUSES = ["pending", "active", "disabled"] as const;
export type IdentityProviderStatus = (typeof IDENTITY_PROVIDER_STATUSES)[number];

export const DOMAIN_VERIFICATION_METHODS = ["dns_txt", "operator_attested"] as const;
export type DomainVerificationMethod = (typeof DOMAIN_VERIFICATION_METHODS)[number];

/** Most verified domains one tenant can hold; the SQL function enforces the same number. */
export const MAX_VERIFIED_DOMAINS_PER_TENANT = 20;

export const IDENTITY_RECORD_MIN_REASON_LENGTH = 3;
export const IDENTITY_RECORD_MAX_REASON_LENGTH = 1000;

/** What an Organization Admin sees of a verified domain: never who verified it or the operator's evidence reference. */
export type VerifiedDomainView = {
  domain: string;
  verificationMethod: DomainVerificationMethod;
  verifiedAt: string;
};

/** The tenant's identity-provider record as stored. */
export type IdentityProviderRecord = {
  protocol: IdentityProtocol;
  issuer: string;
  audience: string;
  status: IdentityProviderStatus;
  /** Off unless an operator turned it on: when on, a token is accepted for the tenant only if its verified issuer and audience equal this record. */
  enforceTokenBinding: boolean;
  version: number;
  updatedAt: string;
};

export class IdentityRecordValidationError extends Error {
  readonly code: string;
  readonly status = 400 as const;
  constructor(code: string) { super(code); this.name = "IdentityRecordValidationError"; this.code = code; }
}

function fail(code: string): never { throw new IdentityRecordValidationError(code); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function oneOf<T extends string>(values: readonly T[], value: unknown): value is T { return typeof value === "string" && (values as readonly string[]).includes(value); }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Free text may hold line breaks and tabs; every other C0 control, DEL and the line/paragraph separators is refused.
const FREE_TEXT_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;
// A single token: no whitespace and no control character (issuers and audiences are identifiers, not prose).
const IDENTIFIER_FORBIDDEN = /[\s\u0000-\u001f\u007f\u2028\u2029]/;
// Lower-case ASCII labels, at least two of them, a letter-led top-level label: the same expression as the table check.
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A domain in the one form Corvis stores: lower-case ASCII (an internationalised name is supplied as punycode), at least
 * two labels. A wildcard, an address, a path or a single label is refused, so a verified domain can never be broader
 * than the one name an operator checked.
 */
export function normalizeDomain(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_domain");
  const domain = value.trim().toLowerCase();
  if (domain.length < 4 || domain.length > 253 || !DOMAIN.test(domain)) return fail("invalid_domain");
  return domain;
}

/** The domain of an address (everything after the last `@`, lower-cased), or null when it has no local part or no `@`. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at < 1 ? null : email.slice(at + 1).toLowerCase();
}

/**
 * An OpenID Connect issuer in the form the token verifier compares: an https URL without credentials, query, fragment or
 * trailing slash. A SAML entity id is an opaque identifier and is only checked for shape.
 */
export function normalizeIssuer(protocol: IdentityProtocol, value: unknown): string {
  if (typeof value !== "string") return fail("invalid_issuer");
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 2048 || IDENTIFIER_FORBIDDEN.test(trimmed)) return fail("invalid_issuer");
  if (protocol === "saml") return trimmed;
  let url: URL;
  try { url = new URL(trimmed); } catch { return fail("invalid_issuer"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return fail("invalid_issuer");
  const normalized = url.toString().replace(/\/$/, "");
  return normalized.length > 2048 || normalized.endsWith("/") ? fail("invalid_issuer") : normalized;
}

function audience(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_audience");
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 1024 || IDENTIFIER_FORBIDDEN.test(trimmed)) return fail("invalid_audience");
  return trimmed;
}

function reasonText(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_reason");
  const trimmed = value.trim();
  if (trimmed.length < IDENTITY_RECORD_MIN_REASON_LENGTH || trimmed.length > IDENTITY_RECORD_MAX_REASON_LENGTH || FREE_TEXT_FORBIDDEN.test(trimmed)) return fail("invalid_reason");
  return trimmed;
}

function evidenceText(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_evidence");
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 1000 || FREE_TEXT_FORBIDDEN.test(trimmed)) return fail("invalid_evidence");
  return trimmed;
}

export type TenantIdentityCommand =
  | { kind: "verified_domain_add"; tenantId: string; domain: string; verificationMethod: DomainVerificationMethod; evidence: string; reason: string }
  | { kind: "verified_domain_remove"; tenantId: string; domain: string; reason: string }
  | {
    kind: "identity_provider_set"; tenantId: string; protocol: IdentityProtocol; issuer: string; audience: string;
    status: IdentityProviderStatus; enforceTokenBinding: boolean; expectedVersion: number; reason: string;
  };

/** The tenant an operator command targets; always stated, never inferred from the operator's own tenant. */
export function parseTargetTenant(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value.trim())) return fail("invalid_tenant");
  // Postgres returns canonical lower-case uuids while `::uuid` accepts any spelling.
  return value.trim().toLowerCase();
}

/**
 * Validates an operator command. Every field is stated (nothing is defaulted from the stored record, so a command cannot
 * silently keep or clear something), an identity-provider change names the version it is based on, and token binding
 * is accepted only for an active OpenID Connect record.
 */
export function parseTenantIdentityCommand(body: unknown): TenantIdentityCommand {
  if (!isRecord(body)) return fail("invalid_request");
  const tenantId = parseTargetTenant(body.tenantId);
  if (body.kind === "verified_domain_add") {
    if (!oneOf(DOMAIN_VERIFICATION_METHODS, body.verificationMethod)) return fail("invalid_verification_method");
    return { kind: body.kind, tenantId, domain: normalizeDomain(body.domain), verificationMethod: body.verificationMethod, evidence: evidenceText(body.evidence), reason: reasonText(body.reason) };
  }
  if (body.kind === "verified_domain_remove") {
    return { kind: body.kind, tenantId, domain: normalizeDomain(body.domain), reason: reasonText(body.reason) };
  }
  if (body.kind === "identity_provider_set") {
    if (!oneOf(IDENTITY_PROTOCOLS, body.protocol)) return fail("invalid_protocol");
    if (!oneOf(IDENTITY_PROVIDER_STATUSES, body.status)) return fail("invalid_status");
    if (typeof body.enforceTokenBinding !== "boolean") return fail("invalid_binding");
    if (body.enforceTokenBinding && (body.protocol !== "oidc" || body.status !== "active")) return fail("invalid_binding");
    const expectedVersion = body.expectedVersion;
    if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 0) return fail("invalid_version");
    return {
      kind: body.kind, tenantId, protocol: body.protocol, issuer: normalizeIssuer(body.protocol, body.issuer), audience: audience(body.audience),
      status: body.status, enforceTokenBinding: body.enforceTokenBinding, expectedVersion, reason: reasonText(body.reason),
    };
  }
  return fail("invalid_kind");
}
