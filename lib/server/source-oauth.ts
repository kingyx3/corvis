import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { ConnectorGovernanceError, type SecretPayload, type SecretStore } from "./source-connectors.ts";

/**
 * The provider-neutral OAuth authorization-code leg of "Connect source" (B1).
 *
 * Corvis, not the browser, owns the security-relevant values: the `state` and
 * the PKCE `code_verifier` are generated here, kept server-side in the managed
 * secret store (with a short TTL) and consumed exactly once when the provider
 * redirects back. The browser only ever holds an opaque pointer to the pending
 * attempt, in an HttpOnly cookie, plus the one-time `code` and `state` the
 * provider put in the redirect URL. A real provider implements
 * {@link SourceOAuthClient}; nothing in this module knows a vendor.
 */

export interface SourceOAuthClient {
  /** The provider consent URL to send the administrator to. */
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** Exchanges the one-time code (proving possession of the PKCE verifier) for the credential material stored as the connection's secret. */
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<SecretPayload>;
  /**
   * Optional token refresh (RFC 6749 section 6): trades the stored refresh token for a replacement credential. It
   * rejects when the provider no longer honors the token (expired, revoked, or the customer removed the grant). A
   * provider that cannot refresh omits it, and an expired credential then simply needs reauthorization.
   */
  refresh?(input: { refreshToken: string }): Promise<SecretPayload>;
}

export const OAUTH_ATTEMPT_COOKIE = "corvis_source_oauth";
export const OAUTH_ATTEMPT_COOKIE_PATH = "/api/v1/source-connections/oauth";
export const OAUTH_ATTEMPT_TTL_SECONDS = 600;
const OAUTH_ATTEMPT_SECRET_KEY = "oauth-attempt";

type PendingAttempt = {
  kind: "source_oauth_attempt";
  providerKey: string;
  connectionLabel: string;
  /** Set when the attempt renews an existing connection's authorization instead of creating a connection. */
  reauthorizeConnectionId?: string;
  state: string;
  codeVerifier: string;
  subject: string;
  workspaceId: string;
  expiresAt: number;
};

function base64Url(bytes: Buffer): string { return bytes.toString("base64url"); }

/** RFC 7636 S256 challenge for a verifier. */
export function pkceChallenge(codeVerifier: string): string {
  return base64Url(createHash("sha256").update(codeVerifier).digest());
}

function equalText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type StartedAttempt = { authorizationUrl: string; attemptReference: string };

/** Records a pending attempt server-side and returns the provider consent URL plus the pointer for the cookie. */
export async function startOAuthAttempt(
  identity: RequestIdentity,
  input: { providerKey: string; connectionLabel: string; client: SourceOAuthClient; redirectUri: string; reauthorizeConnectionId?: string },
  dependencies: { secrets: SecretStore; now?: () => number },
): Promise<StartedAttempt> {
  const now = dependencies.now ?? Date.now;
  const state = base64Url(randomBytes(24));
  const codeVerifier = base64Url(randomBytes(48));
  const pending: PendingAttempt = {
    kind: "source_oauth_attempt",
    providerKey: input.providerKey,
    connectionLabel: input.connectionLabel,
    ...(input.reauthorizeConnectionId ? { reauthorizeConnectionId: input.reauthorizeConnectionId } : {}),
    state,
    codeVerifier,
    subject: identity.subject,
    workspaceId: identity.workspaceId,
    expiresAt: now() + OAUTH_ATTEMPT_TTL_SECONDS * 1000,
  };
  const attemptReference = await dependencies.secrets.write(identity.tenantId, OAUTH_ATTEMPT_SECRET_KEY, pending, { ttlSeconds: OAUTH_ATTEMPT_TTL_SECONDS });
  const authorizationUrl = input.client.authorizationUrl({ state, codeChallenge: pkceChallenge(codeVerifier), redirectUri: input.redirectUri });
  return { authorizationUrl, attemptReference };
}

/** The tenant id is part of the resource name, so a pointer minted for another tenant is refused before any read. */
function belongsToTenant(identity: RequestIdentity, reference: string): boolean {
  return reference.includes(`/secrets/corvis-src-${identity.tenantId}-${OAUTH_ATTEMPT_SECRET_KEY}-`);
}

/** What a discarded attempt was for: only non-secret facts, so the decline can be audited. */
export type DiscardedAttempt = { providerKey: string; reauthorizeConnectionId?: string };

/**
 * Destroys a pending attempt the provider did not approve (the administrator declined). Never fails the caller. It
 * reads the attempt once, only to report which provider (and connection) it was for, and returns nothing at all for
 * a pointer that is not this tenant's, is gone, or belongs to another administrator. No secret value leaves this function.
 */
export async function discardOAuthAttempt(
  identity: RequestIdentity,
  attemptReference: string | undefined,
  dependencies: { secrets: SecretStore },
): Promise<DiscardedAttempt | undefined> {
  if (!attemptReference || !belongsToTenant(identity, attemptReference)) return undefined;
  let pending: SecretPayload | undefined;
  try { pending = await dependencies.secrets.read(attemptReference); } catch { pending = undefined; }
  await dependencies.secrets.revoke(attemptReference).catch(() => undefined);
  if (!pending || !isPending(pending) || pending.subject !== identity.subject) return undefined;
  return { providerKey: pending.providerKey, ...(pending.reauthorizeConnectionId ? { reauthorizeConnectionId: pending.reauthorizeConnectionId } : {}) };
}

export type ConsumedAttempt = { providerKey: string; connectionLabel: string; codeVerifier: string; reauthorizeConnectionId?: string };

const PENDING_FIELD_TYPES = { providerKey: "string", connectionLabel: "string", state: "string", codeVerifier: "string", subject: "string", workspaceId: "string", expiresAt: "number" } as const;

function isPending(value: SecretPayload): value is PendingAttempt {
  return value.kind === "source_oauth_attempt"
    && Object.entries(PENDING_FIELD_TYPES).every(([field, type]) => typeof value[field] === type)
    && (value.reauthorizeConnectionId === undefined || typeof value.reauthorizeConnectionId === "string");
}

/**
 * Validates and destroys a pending attempt. It is single-use whatever the
 * outcome (a replayed redirect finds nothing), bound to the tenant (by the
 * secret's resource name), the administrator and the workspace that started
 * it, and to the `state` the provider echoed. Every failure is the same
 * `oauth_attempt_invalid`, so a caller learns nothing about which check failed.
 */
export async function consumeOAuthAttempt(
  identity: RequestIdentity,
  input: { attemptReference: string | undefined; state: string },
  dependencies: { secrets: SecretStore; now?: () => number },
): Promise<ConsumedAttempt> {
  const now = dependencies.now ?? Date.now;
  const reference = input.attemptReference;
  if (!reference || !belongsToTenant(identity, reference)) throw new ConnectorGovernanceError("oauth_attempt_invalid");
  let pending: SecretPayload;
  try { pending = await dependencies.secrets.read(reference); } catch { throw new ConnectorGovernanceError("oauth_attempt_invalid"); }
  await dependencies.secrets.revoke(reference).catch(() => undefined);
  if (!isPending(pending)
    || pending.expiresAt < now()
    || pending.subject !== identity.subject
    || pending.workspaceId !== identity.workspaceId
    || !equalText(pending.state, input.state)) {
    throw new ConnectorGovernanceError("oauth_attempt_invalid");
  }
  return {
    providerKey: pending.providerKey,
    connectionLabel: pending.connectionLabel,
    codeVerifier: pending.codeVerifier,
    ...(pending.reauthorizeConnectionId ? { reauthorizeConnectionId: pending.reauthorizeConnectionId } : {}),
  };
}

/** `Set-Cookie` value pointing the browser at its pending attempt: HttpOnly, SameSite=Lax, scoped to the OAuth routes, short-lived. */
export function attemptCookie(attemptReference: string, secure: boolean): string {
  return `${OAUTH_ATTEMPT_COOKIE}=${encodeURIComponent(attemptReference)}; Path=${OAUTH_ATTEMPT_COOKIE_PATH}; Max-Age=${OAUTH_ATTEMPT_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearedAttemptCookie(secure: boolean): string {
  return `${OAUTH_ATTEMPT_COOKIE}=; Path=${OAUTH_ATTEMPT_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function readAttemptCookie(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== OAUTH_ATTEMPT_COOKIE) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()) || undefined; } catch { return undefined; }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Token lifecycle: expiry and refresh (B1b)
// ---------------------------------------------------------------------------

/** A credential this close to its expiry is refreshed before use, so a request never starts with a token that dies mid-flight. */
export const OAUTH_EXPIRY_SKEW_SECONDS = 60;

/**
 * The stored OAuth credential has expired and cannot be renewed (no refresh token, a provider without refresh, or a
 * provider that refused it). It carries the connector error class `reauthorization`, so a test or a sync run reports it
 * the same way as any other credential the provider no longer accepts: the connection moves to "needs reauthorization".
 */
export class OAuthCredentialExpiredError extends Error {
  readonly connectorErrorClass = "reauthorization" as const;
  constructor() {
    super("oauth_credential_expired");
    this.name = "OAuthCredentialExpiredError";
  }
}

export type FreshCredential = { credential: SecretPayload; refreshed: boolean };

/**
 * Returns a credential that is safe to use now. The provider-neutral contract is a stored `expiresAt` (epoch
 * milliseconds): a credential without one is used as is, one with time left is used as is, and one that is expired or
 * about to be is refreshed through the provider's `refresh` when it has one and a refresh token is held. A refresh the
 * provider refuses is not an error while the credential still has time left; once it has expired it is
 * {@link OAuthCredentialExpiredError}. A refreshed credential keeps the previous refresh token if the provider did not rotate it.
 */
export async function freshOAuthCredential(
  credential: SecretPayload,
  client: SourceOAuthClient | undefined,
  now: () => number = Date.now,
): Promise<FreshCredential> {
  const expiresAt = typeof credential.expiresAt === "number" ? credential.expiresAt : undefined;
  if (expiresAt === undefined || expiresAt - OAUTH_EXPIRY_SKEW_SECONDS * 1000 > now()) return { credential, refreshed: false };
  const refreshToken = typeof credential.refreshToken === "string" && credential.refreshToken ? credential.refreshToken : undefined;
  if (client?.refresh && refreshToken) {
    try {
      const next = await client.refresh({ refreshToken });
      const rotated = typeof next.refreshToken === "string" && next.refreshToken ? next.refreshToken : refreshToken;
      return { credential: { ...next, refreshToken: rotated }, refreshed: true };
    } catch {
      // The provider no longer honors the refresh token. Whether that matters depends on the access token below.
    }
  }
  if (expiresAt <= now()) throw new OAuthCredentialExpiredError();
  return { credential, refreshed: false };
}
