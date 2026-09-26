import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey } from "crypto";

const CLOCK_SKEW_SECONDS = 30;
const DEFAULT_KEY_CACHE_SECONDS = 300;
const HTTP_TIMEOUT_MS = 5_000;
export const JWKS_MIN_REFRESH_INTERVAL_MS = 30_000;

export type OidcIdentity = {
  subject: string;
  sessionId: string;
  email?: string;
  emailVerified?: boolean;
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
   * JWKS refresh is single-flight and, once keys are cached, rate limited: an
   * unauthenticated token with an unknown `kid` (or an IdP outage) can trigger
   * at most one JWKS fetch per JWKS_MIN_REFRESH_INTERVAL_MS. A failed refresh
   * keeps the previously fetched keys.
   */
  private async key(kid: string, issuer: string, configuredJwksUrl: string | undefined, nowMs: number): Promise<OidcJwk> {
    if (this.keysIssuer !== issuer) {
      this.keys = new Map();
      this.keysExpireAt = 0;
      this.lastRefreshAttemptAt = Number.NEGATIVE_INFINITY;
      this.keysIssuer = issuer;
    }
    if (nowMs >= this.keysExpireAt || !this.keys.has(kid)) {
      const throttled = this.keys.size > 0 && nowMs - this.lastRefreshAttemptAt < JWKS_MIN_REFRESH_INTERVAL_MS;
      if (!throttled) {
        try {
          await this.refreshKeys(issuer, configuredJwksUrl, nowMs);
        } catch (error) {
          if (this.keys.size === 0) throw error;
        }
      }
    }
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

    const jwk = await this.key(header.kid, issuer, input.jwksUrl, now.getTime());
    const publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    const signature = Buffer.from(encodedSignature, "base64url");
    const verified = verifySignature("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), publicKey, signature);
    if (!verified) throw new Error("invalid OIDC token signature");

    const explicitSession = typeof claims.sid === "string" && claims.sid ? claims.sid : typeof claims.jti === "string" && claims.jti ? claims.jti : undefined;
    const sessionId = explicitSession ?? `token-${createHash("sha256").update(token).digest("hex")}`;
    if (claims.email !== undefined && typeof claims.email !== "string") throw new Error("invalid OIDC email claim");
    if (claims.email_verified !== undefined && typeof claims.email_verified !== "boolean") throw new Error("invalid OIDC email verification claim");
    if (claims.email_verified === true && (typeof claims.email !== "string" || !claims.email.trim())) throw new Error("verified OIDC email is missing");
    return {
      subject: claims.sub,
      sessionId,
      ...(typeof claims.email === "string" ? { email: claims.email.trim().toLowerCase() } : {}),
      ...(typeof claims.email_verified === "boolean" ? { emailVerified: claims.email_verified } : {}),
    };
  }
}
