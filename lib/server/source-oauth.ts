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
}

export const OAUTH_ATTEMPT_COOKIE = "corvis_source_oauth";
export const OAUTH_ATTEMPT_COOKIE_PATH = "/api/v1/source-connections/oauth";
export const OAUTH_ATTEMPT_TTL_SECONDS = 600;
const OAUTH_ATTEMPT_SECRET_KEY = "oauth-attempt";

type PendingAttempt = {
  kind: "source_oauth_attempt";
  providerKey: string;
  connectionLabel: string;
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
  input: { providerKey: string; connectionLabel: string; client: SourceOAuthClient; redirectUri: string },
  dependencies: { secrets: SecretStore; now?: () => number },
): Promise<StartedAttempt> {
  const now = dependencies.now ?? Date.now;
  const state = base64Url(randomBytes(24));
  const codeVerifier = base64Url(randomBytes(48));
  const pending: PendingAttempt = {
    kind: "source_oauth_attempt",
    providerKey: input.providerKey,
    connectionLabel: input.connectionLabel,
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

/** Destroys a pending attempt the provider did not approve (the administrator declined). Never reads it, never fails the caller. */
export async function discardOAuthAttempt(
  identity: RequestIdentity,
  attemptReference: string | undefined,
  dependencies: { secrets: SecretStore },
): Promise<void> {
  if (attemptReference && belongsToTenant(identity, attemptReference)) await dependencies.secrets.revoke(attemptReference).catch(() => undefined);
}

export type ConsumedAttempt = { providerKey: string; connectionLabel: string; codeVerifier: string };

const PENDING_FIELD_TYPES = { providerKey: "string", connectionLabel: "string", state: "string", codeVerifier: "string", subject: "string", workspaceId: "string", expiresAt: "number" } as const;

function isPending(value: SecretPayload): value is PendingAttempt {
  return value.kind === "source_oauth_attempt" && Object.entries(PENDING_FIELD_TYPES).every(([field, type]) => typeof value[field] === type);
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
  return { providerKey: pending.providerKey, connectionLabel: pending.connectionLabel, codeVerifier: pending.codeVerifier };
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
