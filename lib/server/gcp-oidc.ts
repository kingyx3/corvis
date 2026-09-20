import { createPublicKey, verify as verifySignature, type JsonWebKey } from "crypto";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CLOCK_SKEW_SECONDS = 30;
const DEFAULT_KEY_CACHE_SECONDS = 300;
const JWKS_TIMEOUT_MS = 5_000;

export type GoogleServiceAccountIdentity = {
  subject: string;
  email: string;
};

type GoogleJwk = {
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
  typ?: unknown;
};

type JwtClaims = {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  iat?: unknown;
  exp?: unknown;
};

function jsonSegment<T>(segment: string, label: string): T {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
  } catch {
    throw new Error(`malformed GCP OIDC ${label}`);
  }
}

function bearerToken(header: string | null): string {
  if (!header) throw new Error("missing GCP OIDC bearer token");
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  if (!match?.[1]) throw new Error("malformed GCP OIDC bearer token");
  return match[1];
}

function cacheSeconds(header: string | null): number {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(header ?? "");
  const seconds = match ? Number(match[1]) : DEFAULT_KEY_CACHE_SECONDS;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 24 * 60 * 60) : DEFAULT_KEY_CACHE_SECONDS;
}

function parseJwks(value: unknown): GoogleJwk[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Google JWKS response");
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) throw new Error("invalid Google JWKS response");
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

export class GoogleOidcVerifier {
  private readonly fetchImpl: typeof fetch;
  private keys = new Map<string, GoogleJwk>();
  private keysExpireAt = 0;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private async key(kid: string, nowMs: number): Promise<GoogleJwk> {
    if (nowMs >= this.keysExpireAt || !this.keys.has(kid)) await this.refreshKeys(nowMs);
    const key = this.keys.get(kid);
    if (!key) throw new Error("GCP OIDC signing key is unknown");
    return key;
  }

  private async refreshKeys(nowMs: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(GOOGLE_JWKS_URL, { signal: controller.signal });
      if (!response.ok) throw new Error(`Google JWKS request failed with status ${response.status}`);
      const keys = parseJwks(await response.json());
      if (keys.length === 0) throw new Error("Google JWKS response contained no usable signing keys");
      this.keys = new Map(keys.map((key) => [key.kid, key]));
      this.keysExpireAt = nowMs + cacheSeconds(response.headers.get("cache-control")) * 1_000;
    } finally {
      clearTimeout(timer);
    }
  }

  async verify(input: {
    authorization: string | null;
    audience: string;
    serviceAccountEmail: string;
    now?: Date;
  }): Promise<GoogleServiceAccountIdentity> {
    const token = bearerToken(input.authorization);
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("malformed GCP OIDC token");
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = jsonSegment<JwtHeader>(encodedHeader, "header");
    const claims = jsonSegment<JwtClaims>(encodedClaims, "claims");
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new Error("unsupported GCP OIDC signing header");

    const now = input.now ?? new Date();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const exp = typeof claims.exp === "number" ? claims.exp : Number.NaN;
    const iat = typeof claims.iat === "number" ? claims.iat : Number.NaN;
    if (!Number.isInteger(exp) || !Number.isInteger(iat)) throw new Error("invalid GCP OIDC token timestamps");
    if (exp < nowSeconds - CLOCK_SKEW_SECONDS) throw new Error("expired GCP OIDC token");
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS || exp <= iat) throw new Error("invalid GCP OIDC token lifetime");
    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("invalid GCP OIDC token issuer");
    if (claims.aud !== input.audience) throw new Error("invalid GCP OIDC token audience");
    if (typeof claims.sub !== "string" || !claims.sub) throw new Error("GCP OIDC token has no immutable subject");
    if (claims.email !== input.serviceAccountEmail || claims.email_verified !== true) throw new Error("GCP OIDC service identity is not approved");

    const jwk = await this.key(header.kid, now.getTime());
    const publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    const signature = Buffer.from(encodedSignature, "base64url");
    const verified = verifySignature("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), publicKey, signature);
    if (!verified) throw new Error("invalid GCP OIDC token signature");

    return { subject: claims.sub, email: input.serviceAccountEmail };
  }
}
