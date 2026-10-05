import { createHmac } from "node:crypto";
import type { Role } from "../shared/domain/enterprise.ts";
import type { GatewayIdentityAssertion } from "../platform/http/request-context.ts";

/**
 * Test-only: signs a gateway identity assertion the way the trusted identity boundary does, so route tests
 * authenticate through the same `x-corvis-identity-assertion` path production uses instead of a header shortcut.
 */
export function signIdentityAssertion(secret: string, payload: GatewayIdentityAssertion): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

export type TrustedCaller = {
  subject: string;
  tenantId: string;
  workspaceId: string;
  /** Comma-separated string or list; the verifier, not this helper, rejects unknown roles. */
  roles: string | readonly string[];
  workspaceIds?: readonly string[];
  fundIds?: readonly string[];
  documentIds?: readonly string[];
  sourceDocumentAccess?: boolean;
  internalAnalytics?: boolean;
  modelTraining?: boolean;
  redistribution?: boolean;
  /** Left as a string so tests can also send values the verifier must reject. */
  authMethod?: string;
  sessionId?: string;
  email?: string;
  emailVerified?: boolean;
};

const list = (value: string | readonly string[]): string[] =>
  (typeof value === "string" ? value.split(",") : [...value]).map((item) => item.trim()).filter(Boolean);

export function trustedIdentityAssertion(secret: string, caller: TrustedCaller, now = new Date()): string {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return signIdentityAssertion(secret, {
    v: 1,
    sub: caller.subject,
    tenantId: caller.tenantId,
    workspaceId: caller.workspaceId,
    roles: list(caller.roles) as Role[],
    entitlements: {
      workspaceIds: [...(caller.workspaceIds ?? [caller.workspaceId])],
      fundIds: [...(caller.fundIds ?? [])],
      documentIds: [...(caller.documentIds ?? [])],
      sourceDocumentAccessAllowed: caller.sourceDocumentAccess ?? false,
      internalAnalyticsAllowed: caller.internalAnalytics ?? false,
      modelTrainingAllowed: caller.modelTraining ?? false,
      redistributionAllowed: caller.redistribution ?? false,
    },
    authMethod: (caller.authMethod ?? "oidc") as GatewayIdentityAssertion["authMethod"],
    sessionId: caller.sessionId ?? "session-test",
    ...(caller.email !== undefined ? { email: caller.email } : {}),
    ...(caller.emailVerified !== undefined ? { emailVerified: caller.emailVerified } : {}),
    iat: nowSeconds - 10,
    exp: nowSeconds + 230,
  });
}

/** The single request header that carries a signed identity. */
export function trustedIdentityHeaders(secret: string, caller: TrustedCaller): Record<string, string> {
  return { "x-corvis-identity-assertion": trustedIdentityAssertion(secret, caller) };
}
