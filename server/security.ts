import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { getConfig } from "@/server/config";

export type Role = "admin" | "reviewer" | "analyst" | "api_client" | "read_only";
export type Permission =
  | "documents:read"
  | "documents:write"
  | "source:read"
  | "observations:read"
  | "observations:review"
  | "snapshots:publish"
  | "research:ask"
  | "exports:create"
  | "admin:read"
  | "admin:write";

export type Session = {
  subject: string;
  email?: string;
  name?: string;
  tenantId: string;
  workspaceName?: string;
  roles: Role[];
  issuedAt: number;
  expiresAt: number;
};

type OidcDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
};

type OidcTransaction = {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
};

const rolePermissions: Record<Role, Permission[]> = {
  admin: ["documents:read", "documents:write", "source:read", "observations:read", "observations:review", "snapshots:publish", "research:ask", "exports:create", "admin:read", "admin:write"],
  reviewer: ["documents:read", "source:read", "observations:read", "observations:review", "snapshots:publish", "research:ask", "exports:create"],
  analyst: ["documents:read", "source:read", "observations:read", "research:ask", "exports:create"],
  api_client: ["documents:read", "observations:read", "research:ask", "exports:create"],
  read_only: ["documents:read", "observations:read", "research:ask"],
};

let discoveryCache: { issuer: string; value: OidcDiscovery; expiresAt: number } | undefined;
let jwksCache: { uri: string; keys: JsonWebKey[]; expiresAt: number } | undefined;

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function fromBase64url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64");
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Base64url(value: string | Buffer): string {
  return base64url(createHash("sha256").update(value).digest());
}

export function hmacHex(secret: string | Buffer, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

function encryptionKey(): Buffer {
  return createHash("sha256").update(getConfig().sessionSecret).digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${base64url(iv)}.${base64url(encrypted)}.${base64url(tag)}`;
}

export function decryptJson<T>(token: string): T {
  const [ivRaw, encryptedRaw, tagRaw] = token.split(".");
  if (!ivRaw || !encryptedRaw || !tagRaw) throw new Error("Malformed encrypted token");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), fromBase64url(ivRaw));
  decipher.setAuthTag(fromBase64url(tagRaw));
  const plaintext = Buffer.concat([decipher.update(fromBase64url(encryptedRaw)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function sessionCookieName(): string {
  return getConfig().environment === "production" ? "__Host-corvis_session" : "corvis_session";
}

function transactionCookieName(): string {
  return getConfig().environment === "production" ? "__Host-corvis_oidc_tx" : "corvis_oidc_tx";
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return [part.trim(), ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

export function serializeCookie(name: string, value: string, options: { maxAge?: number; clear?: boolean } = {}): string {
  const secure = getConfig().environment === "production";
  const maxAge = options.clear ? 0 : options.maxAge;
  return [
    `${name}=${encodeURIComponent(options.clear ? "" : value)}`,
    "Path=/",
    "HttpOnly",
    secure ? "Secure" : "",
    "SameSite=Lax",
    maxAge !== undefined ? `Max-Age=${maxAge}` : "",
    options.clear ? "Expires=Thu, 01 Jan 1970 00:00:00 GMT" : "",
  ].filter(Boolean).join("; ");
}

export function createSessionCookie(session: Session): string {
  return serializeCookie(sessionCookieName(), encryptJson(session), { maxAge: Math.max(1, session.expiresAt - Math.floor(Date.now() / 1000)) });
}

export function clearSessionCookie(): string {
  return serializeCookie(sessionCookieName(), "", { clear: true });
}

export function readSession(request: Request): Session | null {
  const config = getConfig();
  if (config.demoMode) {
    return {
      subject: "demo-user",
      email: "demo@corvis.local",
      name: "Alex Morgan",
      tenantId: "tenant_demo_northbridge",
      workspaceName: "Northbridge Partners",
      roles: ["admin"],
      issuedAt: Math.floor(Date.now() / 1000) - 60,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }
  const token = parseCookies(request.headers.get("cookie"))[sessionCookieName()];
  if (!token) return null;
  try {
    const session = decryptJson<Session>(token);
    const now = Math.floor(Date.now() / 1000);
    if (!session.subject || !session.tenantId || session.expiresAt <= now) return null;
    return session;
  } catch {
    return null;
  }
}

export function requireSession(request: Request, permission?: Permission): Session {
  const session = readSession(request);
  if (!session) throw Object.assign(new Error("Authentication required"), { status: 401, code: "AUTH_REQUIRED" });
  if (permission && !session.roles.some((role) => rolePermissions[role]?.includes(permission))) {
    throw Object.assign(new Error("Insufficient permission"), { status: 403, code: "FORBIDDEN" });
  }
  return session;
}

export function assertInternalWorker(request: Request): void {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !safeEqual(token, getConfig().internalWorkerToken)) {
    throw Object.assign(new Error("Invalid worker credential"), { status: 401, code: "WORKER_AUTH_FAILED" });
  }
}

export function assertScim(request: Request): void {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !safeEqual(token, getConfig().scimToken)) {
    throw Object.assign(new Error("Invalid SCIM credential"), { status: 401, code: "SCIM_AUTH_FAILED" });
  }
}

export function assertSameOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (request.headers.get("authorization")?.startsWith("Bearer ")) return;
  const origin = request.headers.get("origin");
  const allowed = new URL(getConfig().publicBaseUrl).origin;
  if (!origin || origin !== allowed) {
    throw Object.assign(new Error("Cross-site request rejected"), { status: 403, code: "CSRF_REJECTED" });
  }
}

async function oidcDiscovery(): Promise<OidcDiscovery> {
  const config = getConfig();
  if (discoveryCache && discoveryCache.issuer === config.oidc.issuer && discoveryCache.expiresAt > Date.now()) return discoveryCache.value;
  if (!config.oidc.issuer) throw new Error("OIDC issuer is not configured");
  const response = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OIDC discovery failed (${response.status})`);
  const discovered = await response.json() as OidcDiscovery;
  if (!discovered.authorization_endpoint || !discovered.token_endpoint || !discovered.jwks_uri || discovered.issuer !== config.oidc.issuer) {
    throw new Error("OIDC discovery document is incomplete or issuer-mismatched");
  }
  discoveryCache = { issuer: config.oidc.issuer, value: discovered, expiresAt: Date.now() + 60 * 60 * 1000 };
  return discovered;
}

async function jwks(uri: string): Promise<JsonWebKey[]> {
  if (jwksCache && jwksCache.uri === uri && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch(uri, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OIDC JWKS fetch failed (${response.status})`);
  const payload = await response.json() as { keys?: JsonWebKey[] };
  if (!Array.isArray(payload.keys)) throw new Error("OIDC JWKS payload does not contain keys");
  jwksCache = { uri, keys: payload.keys, expiresAt: Date.now() + 15 * 60 * 1000 };
  return payload.keys;
}

function parseJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signingInput: string; signature: Buffer } {
  const [headerRaw, claimsRaw, signatureRaw] = token.split(".");
  if (!headerRaw || !claimsRaw || !signatureRaw) throw new Error("Malformed JWT");
  return {
    header: JSON.parse(fromBase64url(headerRaw).toString("utf8")) as Record<string, unknown>,
    claims: JSON.parse(fromBase64url(claimsRaw).toString("utf8")) as Record<string, unknown>,
    signingInput: `${headerRaw}.${claimsRaw}`,
    signature: fromBase64url(signatureRaw),
  };
}

function audienceMatches(aud: unknown, clientId: string): boolean {
  return typeof aud === "string" ? aud === clientId : Array.isArray(aud) && aud.includes(clientId);
}

async function verifyIdToken(token: string, expectedNonce: string): Promise<Record<string, unknown>> {
  const config = getConfig();
  const discovery = await oidcDiscovery();
  const parsed = parseJwt(token);
  if (parsed.header.alg !== "RS256") throw new Error("Only RS256 OIDC ID tokens are accepted by the reference adapter");
  const kid = typeof parsed.header.kid === "string" ? parsed.header.kid : "";
  const key = (await jwks(discovery.jwks_uri)).find((candidate) => candidate.kid === kid && candidate.kty === "RSA");
  if (!key) throw new Error("OIDC signing key was not found");
  const publicKey = createPublicKey({ key, format: "jwk" });
  const verified = verifySignature("RSA-SHA256", Buffer.from(parsed.signingInput), publicKey, parsed.signature);
  if (!verified) throw new Error("OIDC ID token signature is invalid");

  const now = Math.floor(Date.now() / 1000);
  if (parsed.claims.iss !== config.oidc.issuer) throw new Error("OIDC issuer mismatch");
  if (!audienceMatches(parsed.claims.aud, config.oidc.clientId)) throw new Error("OIDC audience mismatch");
  if (typeof parsed.claims.exp !== "number" || parsed.claims.exp <= now) throw new Error("OIDC ID token expired");
  if (typeof parsed.claims.nbf === "number" && parsed.claims.nbf > now + 60) throw new Error("OIDC ID token is not active yet");
  if (parsed.claims.nonce !== expectedNonce) throw new Error("OIDC nonce mismatch");
  return parsed.claims;
}

function normalizeRoles(value: unknown): Role[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[ ,]+/) : [];
  const allowed = new Set<Role>(["admin", "reviewer", "analyst", "api_client", "read_only"]);
  const roles = raw.map((item) => String(item).toLowerCase() as Role).filter((role) => allowed.has(role));
  return roles.length ? Array.from(new Set(roles)) : ["read_only"];
}

export async function beginOidcLogin(request: Request): Promise<Response> {
  const config = getConfig();
  if (config.demoMode) return Response.redirect(new URL("/", config.publicBaseUrl));
  const discovery = await oidcDiscovery();
  const url = new URL(request.url);
  const requestedReturnTo = url.searchParams.get("returnTo") || "/";
  const returnTo = requestedReturnTo.startsWith("/") && !requestedReturnTo.startsWith("//") ? requestedReturnTo : "/";
  const transaction: OidcTransaction = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(48),
    returnTo,
    createdAt: Date.now(),
  };
  const authorize = new URL(discovery.authorization_endpoint);
  authorize.searchParams.set("client_id", config.oidc.clientId);
  authorize.searchParams.set("redirect_uri", config.oidc.redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid profile email");
  authorize.searchParams.set("state", transaction.state);
  authorize.searchParams.set("nonce", transaction.nonce);
  authorize.searchParams.set("code_challenge", sha256Base64url(transaction.verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  const headers = new Headers({ Location: authorize.toString(), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", serializeCookie(transactionCookieName(), encryptJson(transaction), { maxAge: 600 }));
  return new Response(null, { status: 302, headers });
}

export async function finishOidcLogin(request: Request): Promise<Response> {
  const config = getConfig();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const transactionToken = parseCookies(request.headers.get("cookie"))[transactionCookieName()];
  if (!code || !state || !transactionToken) throw Object.assign(new Error("OIDC callback is incomplete"), { status: 400, code: "OIDC_CALLBACK_INVALID" });
  const transaction = decryptJson<OidcTransaction>(transactionToken);
  if (Date.now() - transaction.createdAt > 10 * 60 * 1000 || !safeEqual(state, transaction.state)) {
    throw Object.assign(new Error("OIDC transaction expired or state mismatched"), { status: 400, code: "OIDC_STATE_INVALID" });
  }
  const discovery = await oidcDiscovery();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.oidc.redirectUri,
    client_id: config.oidc.clientId,
    code_verifier: transaction.verifier,
  });
  if (config.oidc.clientSecret) body.set("client_secret", config.oidc.clientSecret);
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) throw Object.assign(new Error(`OIDC token exchange failed (${tokenResponse.status})`), { status: 401, code: "OIDC_TOKEN_EXCHANGE_FAILED" });
  const tokens = await tokenResponse.json() as { id_token?: string };
  if (!tokens.id_token) throw Object.assign(new Error("OIDC provider did not return an ID token"), { status: 401, code: "OIDC_ID_TOKEN_MISSING" });
  const claims = await verifyIdToken(tokens.id_token, transaction.nonce);
  const tenantValue = claims[config.oidc.tenantClaim];
  if (typeof tenantValue !== "string" || !tenantValue.trim()) throw Object.assign(new Error("OIDC identity does not contain an entitled tenant"), { status: 403, code: "TENANT_CLAIM_MISSING" });

  const now = Math.floor(Date.now() / 1000);
  const session: Session = {
    subject: String(claims.sub || ""),
    email: typeof claims.email === "string" ? claims.email : undefined,
    name: typeof claims.name === "string" ? claims.name : undefined,
    tenantId: tenantValue.trim(),
    workspaceName: typeof claims.workspace_name === "string" ? claims.workspace_name : undefined,
    roles: normalizeRoles(claims[config.oidc.rolesClaim]),
    issuedAt: now,
    expiresAt: Math.min(typeof claims.exp === "number" ? claims.exp : now + 3600, now + 8 * 3600),
  };
  if (!session.subject) throw Object.assign(new Error("OIDC subject is missing"), { status: 401, code: "OIDC_SUBJECT_MISSING" });

  const headers = new Headers({ Location: new URL(transaction.returnTo, config.publicBaseUrl).toString(), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", createSessionCookie(session));
  headers.append("Set-Cookie", serializeCookie(transactionCookieName(), "", { clear: true }));
  return new Response(null, { status: 302, headers });
}

export function logoutResponse(): Response {
  const headers = new Headers({ Location: new URL("/", getConfig().publicBaseUrl).toString(), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearSessionCookie());
  return new Response(null, { status: 302, headers });
}
