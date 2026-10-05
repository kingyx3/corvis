import { createHash, createPublicKey, verify as verifySignature, type webcrypto } from "crypto";
import { boundedAuthContext, boundedAuthMethods, mfaEvidence } from "../../core/authentication-evidence.ts";

const CLOCK_SKEW_SECONDS = 30;
const DEFAULT_KEY_CACHE_SECONDS = 300;
const HTTP_TIMEOUT_MS = 5_000;
export const JWKS_MIN_REFRESH_INTERVAL_MS = 30_000;
/** The event a logout token must carry (OpenID Connect Back-Channel Logout 1.0, section 2.4). */
export const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
/** A logout token is accepted for this long after its `iat` (plus clock skew); the single-use ledger is kept longer than that. */
export const LOGOUT_TOKEN_MAX_AGE_SECONDS = 300;
export const MAX_LOGOUT_TOKEN_LENGTH = 8192;

export type OidcIdentity = {
  subject: string;
  sessionId: string;
  /** The issuer and audience the token was verified against (the issuer in the normalised form it was compared in). */
  issuer: string;
  audience: string;
  email?: string;
  emailVerified?: boolean;
  /**
   * What the verified token says about how the person signed in (F7a, #334): its `amr` entries (validated and bounded), whether
   * they show more than one factor, and its `acr`. Each is present only when the identity provider sent it.
   */
  authMethods?: string[];
  mfaUsed?: boolean;
  authContext?: string;
};

/** A verified OpenID Connect Back-Channel Logout token (F7c, #336): who and which session the identity provider ended. */
export type OidcLogoutToken = {
  issuer: string;
  /** The audience that matched one of the accepted audiences. */
  audience: string;
  /** Single-use token id, for replay protection. */
  jti: string;
  subject?: string;
  sessionId?: string;
};

type OidcJwk = {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
};

type JwtHeader = {
  alg?: unknown;
  kid?: unknown;
};

type JwtClaims = {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  sid?: unknown;
  jti?: unknown;
  iat?: unknown;
  exp?: unknown;
  nbf?: unknown;
  email?: unknown;
  email_verified?: unknown;
  amr?: unknown;
  acr?: unknown;
  events?: unknown;
  nonce?: unknown;
};

type DiscoveryDocument = {
  issuer?: unknown;
  jwks_uri?: unknown;
};

function jsonSegment<T>(segment: string, label: string): T {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
  } catch {
    throw new Error(`malformed OIDC ${label}`);
  }
}

function bearerToken(header: string | null): string {
  if (!header) throw new Error("missing OIDC bearer token");
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  if (!match?.[1]) throw new Error("malformed OIDC bearer token");
  return match[1];
}

function cacheSeconds(header: string | null): number {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(header ?? "");
  const seconds = match ? Number(match[1]) : DEFAULT_KEY_CACHE_SECONDS;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 24 * 60 * 60) : DEFAULT_KEY_CACHE_SECONDS;
}

function normalizeIssuer(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid OIDC issuer URL"); }
  if (url.protocol !== "https:") throw new Error("OIDC issuer must use HTTPS");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

/** The issuer in the one form the verifier compares: https, no query, fragment or trailing slash. Throws on anything else. */
export const normalizeOidcIssuer = normalizeIssuer;

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some((entry) => entry === expected);
}

function parseJwks(value: unknown): OidcJwk[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid OIDC JWKS response");
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) throw new Error("invalid OIDC JWKS response");
  return keys.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const jwk = value as Record<string, unknown>;
    if (typeof jwk.kid !== "string" || typeof jwk.kty !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") return [];
    if (jwk.kty !== "RSA" || (jwk.alg !== undefined && jwk.alg !== "RS256") || (jwk.use !== undefined && jwk.use !== "sig")) return [];
    return [{
      kid: jwk.kid,
      kty: jwk.kty,
      alg: typeof jwk.alg === "string" ? jwk.alg : undefined,
      use: typeof jwk.use === "string" ? jwk.use : undefined,
      n: jwk.n,
      e: jwk.e,
    }];
  });
}

export class OidcVerifier {
  private readonly fetchImpl: typeof fetch;
  private keys = new Map<string, OidcJwk>();
  private keysExpireAt = 0;
  private keysIssuer = "";
  private lastRefreshAttemptAt = Number.NEGATIVE_INFINITY;
  private refreshInFlight?: { issuer: string; promise: Promise<void> };
  private resolvedIssuer = "";
  private resolvedJwksUrl = "";

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private async getJson(url: string): Promise<{ value: unknown; cacheControl: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, redirect: "error" });
      if (!response.ok) throw new Error(`OIDC metadata request failed with status ${response.status}`);
      return { value: await response.json(), cacheControl: response.headers.get("cache-control") };
    } finally {
      clearTimeout(timer);
    }
  }

  private async jwksUrl(issuer: string, configuredJwksUrl?: string): Promise<string> {
    if (configuredJwksUrl) {
      const url = new URL(configuredJwksUrl);
      if (url.protocol !== "https:") throw new Error("OIDC JWKS URL must use HTTPS");
      return url.toString();
    }
    if (this.resolvedIssuer === issuer && this.resolvedJwksUrl) return this.resolvedJwksUrl;
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
    const { value } = await this.getJson(discoveryUrl);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid OIDC discovery document");
    const discovery = value as DiscoveryDocument;
    if (typeof discovery.issuer !== "string" || normalizeIssuer(discovery.issuer) !== issuer) throw new Error("OIDC discovery issuer mismatch");
    if (typeof discovery.jwks_uri !== "string") throw new Error("OIDC discovery document has no JWKS URI");
    const jwks = new URL(discovery.jwks_uri);
    if (jwks.protocol !== "https:") throw new Error("OIDC JWKS URL must use HTTPS");
    this.resolvedIssuer = issuer;
    this.resolvedJwksUrl = jwks.toString();
    return this.resolvedJwksUrl;
  }

  /**
   * JWKS refresh is single-flight and, including cold-start failures, rate limited: an
   * unauthenticated token with an unknown `kid` (or an IdP outage) can trigger
   * at most one JWKS fetch per JWKS_MIN_REFRESH_INTERVAL_MS. A failed refresh
   * keeps unexpired keys only; expired signing authority must fail closed.
   */
  private async key(kid: string, issuer: string, configuredJwksUrl: string | undefined, nowMs: number): Promise<OidcJwk> {
    if (this.keysIssuer !== issuer) {
      this.keys = new Map();
      this.keysExpireAt = 0;
      this.lastRefreshAttemptAt = Number.NEGATIVE_INFINITY;
      this.keysIssuer = issuer;
    }
    if (nowMs >= this.keysExpireAt || !this.keys.has(kid)) {
      const throttled = nowMs - this.lastRefreshAttemptAt < JWKS_MIN_REFRESH_INTERVAL_MS
        && this.refreshInFlight?.issuer !== issuer;
      if (!throttled) {
        try {
          await this.refreshKeys(issuer, configuredJwksUrl, nowMs);
        } catch (error) {
          if (this.keys.size === 0 || nowMs >= this.keysExpireAt) throw error;
        }
      }
    }
    if (nowMs >= this.keysExpireAt) throw new Error("OIDC signing keys expired; metadata refresh unavailable");
    const key = this.keys.get(kid);
    if (!key) throw new Error("OIDC signing key is unknown");
    return key;
  }

  private refreshKeys(issuer: string, configuredJwksUrl: string | undefined, nowMs: number): Promise<void> {
    if (this.refreshInFlight?.issuer === issuer) return this.refreshInFlight.promise;
    this.lastRefreshAttemptAt = nowMs;
    const promise = (async () => {
      const url = await this.jwksUrl(issuer, configuredJwksUrl);
      const { value, cacheControl } = await this.getJson(url);
      const keys = parseJwks(value);
      if (keys.length === 0) throw new Error("OIDC JWKS response contained no usable signing keys");
      if (this.keysIssuer !== issuer) return;
      this.keys = new Map(keys.map((key) => [key.kid, key]));
      this.keysExpireAt = nowMs + cacheSeconds(cacheControl) * 1_000;
    })();
    const flight = { issuer, promise };
    this.refreshInFlight = flight;
    const clear = () => { if (this.refreshInFlight === flight) this.refreshInFlight = undefined; };
    promise.then(clear, clear);
    return promise;
  }

  /** Verifies the RS256 signature of an already structurally checked token against the issuer's keys. */
  private async assertSignature(encodedHeader: string, encodedClaims: string, encodedSignature: string, kid: string, issuer: string, jwksUrl: string | undefined, nowMs: number): Promise<void> {
    const jwk = await this.key(kid, issuer, jwksUrl, nowMs);
    const publicKey = createPublicKey({ key: jwk as webcrypto.JsonWebKey, format: "jwk" });
    const signature = Buffer.from(encodedSignature, "base64url");
    const verified = verifySignature("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), publicKey, signature);
    if (!verified) throw new Error("invalid OIDC token signature");
  }

  /**
   * Verifies an OpenID Connect Back-Channel Logout token (F7c, #336) from `issuer` (already matched by the caller against a
   * provider Corvis trusts) for any of `audiences`: RS256 signature against the issuer's keys, issuer, audience, `iat` fresh and
   * not in the future, `exp` not passed, the back-channel-logout event, no `nonce`, a single-use `jti`, and a `sub` and/or `sid`.
   * Every refusal is a thrown error; the caller never tells the sender which check failed.
   */
  async verifyLogoutToken(input: { token: string; issuer: string; audiences: string[]; jwksUrl?: string; now?: Date }): Promise<OidcLogoutToken> {
    const parts = input.token.split(".");
    if (input.token.length > MAX_LOGOUT_TOKEN_LENGTH || parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("malformed OIDC logout token");
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = jsonSegment<JwtHeader>(encodedHeader, "header");
    const claims = jsonSegment<JwtClaims>(encodedClaims, "claims");
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new Error("unsupported OIDC signing header");

    const issuer = normalizeIssuer(input.issuer);
    const now = input.now ?? new Date();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (claims.iss !== issuer && (typeof claims.iss !== "string" || normalizeIssuer(claims.iss) !== issuer)) throw new Error("invalid OIDC logout token issuer");
    const audience = input.audiences.find((candidate) => audienceMatches(claims.aud, candidate));
    if (audience === undefined) throw new Error("invalid OIDC logout token audience");
    const iat = typeof claims.iat === "number" ? claims.iat : Number.NaN;
    const exp = typeof claims.exp === "number" ? claims.exp : Number.NaN;
    if (!Number.isInteger(iat) || !Number.isInteger(exp)) throw new Error("invalid OIDC logout token timestamps");
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS || iat < nowSeconds - LOGOUT_TOKEN_MAX_AGE_SECONDS - CLOCK_SKEW_SECONDS) throw new Error("OIDC logout token is not fresh");
    if (exp < nowSeconds - CLOCK_SKEW_SECONDS) throw new Error("expired OIDC logout token");
    const events = claims.events;
    if (!events || typeof events !== "object" || Array.isArray(events)) throw new Error("OIDC logout token has no logout event");
    const event = (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT];
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("OIDC logout token has no logout event");
    // A logout token must never carry a nonce (it would be an ID token, not a logout token).
    if (claims.nonce !== undefined) throw new Error("OIDC logout token must not carry a nonce");
    if (typeof claims.jti !== "string" || claims.jti.length < 1 || claims.jti.length > 256) throw new Error("OIDC logout token has no usable id");
    const subject = claims.sub;
    const sessionId = claims.sid;
    if (subject !== undefined && (typeof subject !== "string" || subject.length < 1 || subject.length > 1024)) throw new Error("invalid OIDC logout token subject");
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 1024)) throw new Error("invalid OIDC logout token session");
    if (subject === undefined && sessionId === undefined) throw new Error("OIDC logout token names neither a subject nor a session");

    await this.assertSignature(encodedHeader, encodedClaims, encodedSignature, header.kid, issuer, input.jwksUrl, now.getTime());
    return { issuer, audience, jti: claims.jti, ...(subject === undefined ? {} : { subject }), ...(sessionId === undefined ? {} : { sessionId }) };
  }

  async verify(input: {
    authorization: string | null;
    issuer: string;
    audience: string;
    jwksUrl?: string;
    now?: Date;
  }): Promise<OidcIdentity> {
    const token = bearerToken(input.authorization);
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("malformed OIDC token");
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = jsonSegment<JwtHeader>(encodedHeader, "header");
    const claims = jsonSegment<JwtClaims>(encodedClaims, "claims");
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new Error("unsupported OIDC signing header");

    const issuer = normalizeIssuer(input.issuer);
    const now = input.now ?? new Date();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const exp = typeof claims.exp === "number" ? claims.exp : Number.NaN;
    const iat = typeof claims.iat === "number" ? claims.iat : Number.NaN;
    if (!Number.isInteger(exp) || !Number.isInteger(iat)) throw new Error("invalid OIDC token timestamps");
    if (exp < nowSeconds - CLOCK_SKEW_SECONDS) throw new Error("expired OIDC token");
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS || exp <= iat) throw new Error("invalid OIDC token lifetime");
    // RFC 7519 4.1.5: a token must not be accepted before its `nbf`.
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isInteger(claims.nbf) || claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS)) {
      throw new Error("OIDC token is not yet valid");
    }
    if (claims.iss !== issuer && (typeof claims.iss !== "string" || normalizeIssuer(claims.iss) !== issuer)) throw new Error("invalid OIDC token issuer");
    if (!audienceMatches(claims.aud, input.audience)) throw new Error("invalid OIDC token audience");
    if (typeof claims.sub !== "string" || !claims.sub) throw new Error("OIDC token has no immutable subject");

    // A back-channel logout token is signed by the same keys and carries a subject and a session, so it must never be taken for a
    // bearer credential (it is neither an ID token nor an access token).
    if (claims.events !== undefined && claims.events !== null && typeof claims.events === "object" && BACKCHANNEL_LOGOUT_EVENT in claims.events) {
      throw new Error("an OIDC logout token is not a bearer token");
    }
    await this.assertSignature(encodedHeader, encodedClaims, encodedSignature, header.kid, issuer, input.jwksUrl, now.getTime());

    const explicitSession = typeof claims.sid === "string" && claims.sid ? claims.sid : typeof claims.jti === "string" && claims.jti ? claims.jti : undefined;
    const sessionId = explicitSession ?? `token-${createHash("sha256").update(token).digest("hex")}`;
    if (claims.email !== undefined && typeof claims.email !== "string") throw new Error("invalid OIDC email claim");
    if (claims.email_verified !== undefined && typeof claims.email_verified !== "boolean") throw new Error("invalid OIDC email verification claim");
    if (claims.email_verified === true && (typeof claims.email !== "string" || !claims.email.trim())) throw new Error("verified OIDC email is missing");
    const authMethods = boundedAuthMethods(claims.amr);
    const authContext = boundedAuthContext(claims.acr);
    return {
      subject: claims.sub,
      sessionId,
      issuer,
      audience: input.audience,
      ...(authMethods.length > 0 ? { authMethods, mfaUsed: mfaEvidence(authMethods) === true } : {}),
      ...(authContext === undefined ? {} : { authContext }),
      ...(typeof claims.email === "string" ? { email: claims.email.trim().toLowerCase() } : {}),
      ...(typeof claims.email_verified === "boolean" ? { emailVerified: claims.email_verified } : {}),
    };
  }
}

/**
 * The issuer a logout token claims, normalised, read WITHOUT trusting the token: it only selects which recorded provider's keys
 * and audiences to verify the token against (an issuer Corvis does not know is refused before any network call). Throws on a
 * malformed token or an unusable issuer.
 */
export function unverifiedLogoutTokenIssuer(token: string): string {
  const parts = token.split(".");
  if (token.length > MAX_LOGOUT_TOKEN_LENGTH || parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("malformed OIDC logout token");
  const claims = jsonSegment<JwtClaims>(parts[1], "claims");
  if (typeof claims.iss !== "string" || !claims.iss) throw new Error("invalid OIDC logout token issuer");
  return normalizeIssuer(claims.iss);
}
