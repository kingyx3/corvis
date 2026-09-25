import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import type { Entitlements, RequestIdentity, Role } from "../../core/enterprise.ts";
import { getServerConfig, type ServerConfig } from "./config.ts";
import { OidcVerifier } from "./oidc.ts";

const ASSERTION_VERSION = 1;
const MAX_ASSERTION_LIFETIME_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 30;

export type GatewayIdentityAssertion = {
  v: 1;
  sub: string;
  tenantId: string;
  workspaceId: string;
  roles: Role[];
  entitlements: Entitlements;
  authMethod: "oidc" | "saml" | "service_account";
  sessionId: string;
  iat: number;
  exp: number;
};

function parseRoles(value: string | null): Role[] {
  const allowed = new Set<Role>(["admin","reviewer","analyst","api_client","read_only"]);
  return (value || "").split(",").map((x) => x.trim()).filter((x): x is Role => allowed.has(x as Role));
}

function parseAuthMethod(value: string | null): RequestIdentity["authMethod"] {
  return value === "saml" || value === "service_account" ? value : "oidc";
}

function safeEqualBytes(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new AuthenticationError(`Invalid identity assertion ${field}`);
  }
  return value;
}

function parseAssertionPayload(value: unknown, nowSeconds: number): GatewayIdentityAssertion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthenticationError("Invalid identity assertion payload");
  const body = value as Record<string, unknown>;
  if (body.v !== ASSERTION_VERSION) throw new AuthenticationError("Unsupported identity assertion version");
  for (const field of ["sub","tenantId","workspaceId","sessionId"] as const) {
    if (typeof body[field] !== "string" || !body[field]) throw new AuthenticationError(`Invalid identity assertion ${field}`);
  }
  if (!Array.isArray(body.roles) || body.roles.length === 0) throw new AuthenticationError("Identity assertion has no roles");
  const allowedRoles = new Set<Role>(["admin","reviewer","analyst","api_client","read_only"]);
  const roles = body.roles.map((role) => {
    if (typeof role !== "string" || !allowedRoles.has(role as Role)) throw new AuthenticationError("Identity assertion contains an invalid role");
    return role as Role;
  });
  const authMethod = body.authMethod;
  if (authMethod !== "oidc" && authMethod !== "saml" && authMethod !== "service_account") throw new AuthenticationError("Invalid identity assertion auth method");
  if (!Number.isInteger(body.iat) || !Number.isInteger(body.exp)) throw new AuthenticationError("Invalid identity assertion timestamps");
  const iat = Number(body.iat); const exp = Number(body.exp);
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new AuthenticationError("Identity assertion issued in the future");
  if (exp < nowSeconds - CLOCK_SKEW_SECONDS) throw new AuthenticationError("Identity assertion expired");
  if (exp <= iat || exp - iat > MAX_ASSERTION_LIFETIME_SECONDS) throw new AuthenticationError("Identity assertion lifetime is invalid");
  if (!body.entitlements || typeof body.entitlements !== "object" || Array.isArray(body.entitlements)) throw new AuthenticationError("Invalid identity assertion entitlements");
  const rawEntitlements = body.entitlements as Record<string, unknown>;
  const entitlements: Entitlements = {
    workspaceIds: asStringArray(rawEntitlements.workspaceIds, "workspaceIds"),
    fundIds: rawEntitlements.fundIds === undefined ? undefined : asStringArray(rawEntitlements.fundIds, "fundIds"),
    documentIds: rawEntitlements.documentIds === undefined ? undefined : asStringArray(rawEntitlements.documentIds, "documentIds"),
    sourceDocumentAccessAllowed: rawEntitlements.sourceDocumentAccessAllowed === true,
    internalAnalyticsAllowed: rawEntitlements.internalAnalyticsAllowed === true,
    modelTrainingAllowed: rawEntitlements.modelTrainingAllowed === true,
    redistributionAllowed: rawEntitlements.redistributionAllowed === true,
  };
  const workspaceId = String(body.workspaceId);
  if (!entitlements.workspaceIds.includes(workspaceId)) throw new AuthenticationError("Workspace context not entitled");
  return {
    v: 1,
    sub: String(body.sub),
    tenantId: String(body.tenantId),
    workspaceId,
    roles,
    entitlements,
    authMethod,
    sessionId: String(body.sessionId),
    iat,
    exp,
  };
}

/**
 * Optional trusted-proxy assertion boundary. This remains useful for SAML or a
 * future identity broker, but production OIDC no longer depends on deploying a
 * separate assertion-minting service: bearer tokens can be verified directly.
 */
export function verifyGatewayIdentityAssertion(assertion: string | null, secret?: string, now = new Date()): RequestIdentity {
  if (!assertion || !secret) throw new AuthenticationError("Missing signed identity assertion");
  const separator = assertion.lastIndexOf(".");
  if (separator <= 0 || separator === assertion.length - 1) throw new AuthenticationError("Malformed identity assertion");
  const encodedPayload = assertion.slice(0, separator);
  const encodedSignature = assertion.slice(separator + 1);
  let signature: Buffer;
  let payloadBytes: Buffer;
  try {
    signature = Buffer.from(encodedSignature, "base64url");
    payloadBytes = Buffer.from(encodedPayload, "base64url");
  } catch {
    throw new AuthenticationError("Malformed identity assertion encoding");
  }
  const expected = createHmac("sha256", secret).update(encodedPayload).digest();
  if (!safeEqualBytes(signature, expected)) throw new AuthenticationError("Invalid identity assertion signature");
  let parsed: unknown;
  try { parsed = JSON.parse(payloadBytes.toString("utf8")); }
  catch { throw new AuthenticationError("Malformed identity assertion payload"); }
  const verified = parseAssertionPayload(parsed, Math.floor(now.getTime() / 1000));
  return {
    subject: verified.sub,
    tenantId: verified.tenantId,
    workspaceId: verified.workspaceId,
    roles: verified.roles,
    entitlements: verified.entitlements,
    authMethod: verified.authMethod,
    sessionId: verified.sessionId,
  };
}

function legacyTrustedGatewayIdentity(request: Request, secret?: string): RequestIdentity {
  const supplied = request.headers.get("x-corvis-gateway-secret");
  if (!supplied || !secret || !safeEqualBytes(Buffer.from(supplied), Buffer.from(secret))) throw new AuthenticationError("Untrusted identity gateway");
  const subject = request.headers.get("x-corvis-auth-subject");
  const tenantId = request.headers.get("x-corvis-auth-tenant");
  const workspaceId = request.headers.get("x-corvis-auth-workspace");
  const roles = parseRoles(request.headers.get("x-corvis-auth-roles"));
  if (!subject || !tenantId || !workspaceId || roles.length === 0) throw new AuthenticationError("Missing authenticated request context");
  const split = (name: string) => (request.headers.get(name) || "").split(",").map((x) => x.trim()).filter(Boolean);
  const workspaceIds = split("x-corvis-entitled-workspaces");
  if (workspaceIds.length && !workspaceIds.includes(workspaceId)) throw new AuthenticationError("Workspace context not entitled");
  return {
    subject,
    tenantId,
    workspaceId,
    roles,
    entitlements: {
      workspaceIds: workspaceIds.length ? workspaceIds : [workspaceId],
      fundIds: split("x-corvis-entitled-funds"),
      documentIds: split("x-corvis-entitled-documents"),
      sourceDocumentAccessAllowed: request.headers.get("x-corvis-source-access") === "true",
      internalAnalyticsAllowed: request.headers.get("x-corvis-internal-analytics") === "true",
      modelTrainingAllowed: request.headers.get("x-corvis-model-training") === "true",
      redistributionAllowed: request.headers.get("x-corvis-redistribution") === "true",
    },
    authMethod: parseAuthMethod(request.headers.get("x-corvis-auth-method")),
    sessionId: request.headers.get("x-corvis-session-id") || `session-${randomUUID()}`,
  };
}

let oidcVerifier: OidcVerifier | undefined;
function productionOidcVerifier(): OidcVerifier {
  if (!oidcVerifier) oidcVerifier = new OidcVerifier();
  return oidcVerifier;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The caller's end-user bearer token.
 *
 * Deployed traffic reaches the API service through Google API Gateway, whose
 * x-google-backend authentication replaces `Authorization` with the gateway
 * service account's Google ID token (used by Cloud Run IAM) and moves the
 * caller's original header to `X-Forwarded-Authorization`. When that header is
 * present it is the only user credential; the gateway's own token is never
 * treated as a user identity.
 *
 * Trusting the header is safe because it only selects which token to verify:
 * the token is still fully verified (signature, issuer, audience, expiry)
 * against the configured user IdP. The API Cloud Run service has no allUsers
 * invoker; only the dedicated gateway service account holds roles/run.invoker
 * (gcp-api-gateway module), so requests cannot bypass the gateway either.
 */
export function userBearerAuthorization(request: Request): string | null {
  return request.headers.get("x-forwarded-authorization") ?? request.headers.get("authorization");
}

async function directOidcIdentity(request: Request, config: ServerConfig): Promise<RequestIdentity> {
  const tenantId = request.headers.get("x-corvis-tenant")?.trim();
  const workspaceId = request.headers.get("x-corvis-workspace")?.trim();
  if (!tenantId || !workspaceId) throw new AuthenticationError("Tenant and workspace context are required");
  // Tenant/workspace ids are Postgres uuids; reject malformed selectors before
  // they reach `$1::uuid` casts (which would otherwise surface as a 500).
  if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(workspaceId)) {
    throw new AuthenticationError("Tenant and workspace context must be UUIDs");
  }
  if (!config.authIssuer || !config.authAudience) throw new AuthenticationError("OIDC authentication is not configured");
  try {
    const verified = await productionOidcVerifier().verify({
      authorization: userBearerAuthorization(request),
      issuer: config.authIssuer,
      audience: config.authAudience,
      jwksUrl: config.authJwksUrl,
    });
    // Tenant/workspace are untrusted context selectors only. Production routes
    // immediately re-resolve membership, roles, rights and session state from
    // Postgres in resolveAuthorizedRequestIdentity before evaluating access.
    return {
      subject: verified.subject,
      tenantId,
      workspaceId,
      roles: [],
      entitlements: {
        workspaceIds: [workspaceId],
        sourceDocumentAccessAllowed: false,
      },
      authMethod: "oidc",
      sessionId: verified.sessionId,
    };
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("OIDC authentication failed");
  }
}

export async function resolveRequestIdentity(request: Request): Promise<RequestIdentity> {
  const config = getServerConfig();
  const correlation = request.headers.get("x-correlation-id") || randomUUID();

  if (config.demoMode && config.environment !== "production") {
    const demoRoles = parseRoles(request.headers.get("x-corvis-demo-roles"));
    const workspaceId = request.headers.get("x-corvis-demo-workspace") || "workspace_demo";
    return {
      subject: request.headers.get("x-corvis-demo-subject") || "demo-user",
      tenantId: request.headers.get("x-corvis-demo-tenant") || "tenant_demo",
      workspaceId,
      roles: demoRoles.length ? demoRoles : ["admin"],
      entitlements: {
        workspaceIds: [workspaceId],
        sourceDocumentAccessAllowed: true,
        redistributionAllowed: request.headers.get("x-corvis-demo-redistribution") === "true",
      },
      authMethod: "demo",
      sessionId: request.headers.get("x-corvis-session-id") || `demo-${correlation}`,
      tenantDisplayName: request.headers.get("x-corvis-demo-tenant-name") || "Meridian Capital Partners",
      workspaceDisplayName: request.headers.get("x-corvis-demo-workspace-name") || "Primary Workspace",
    };
  }

  const assertion = request.headers.get("x-corvis-identity-assertion");
  if (assertion) return verifyGatewayIdentityAssertion(assertion, config.trustedAuthProxySecret);
  if (config.environment === "production") return directOidcIdentity(request, config);

  // Temporary non-production compatibility path only. Production deliberately
  // rejects independently mutable business-identity headers.
  return legacyTrustedGatewayIdentity(request, config.trustedAuthProxySecret);
}

export class AuthenticationError extends Error {
  constructor(message: string) { super(message); this.name = "AuthenticationError"; }
}
