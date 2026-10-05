import { createHmac } from "node:crypto";
import type { PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { verifyServiceAccountCredential } from "./service-account-credential.ts";

export const SERVICE_ACCOUNT_ASSERTION_TTL_SECONDS = 5 * 60;

/** Extract a Corvis service-account credential from the caller bearer header. */
export function serviceAccountBearer(request: Request): string | null {
  const authorization = request.headers.get("x-forwarded-authorization") ?? request.headers.get("authorization");
  const match = /^Bearer\s+(corvis_sa_[^\s]+)$/i.exec(authorization?.trim() ?? "");
  return match?.[1] ?? null;
}

/**
 * Exchange a long-lived, rotatable service-account credential for the same short-lived signed
 * assertion format used by the trusted identity boundary. The assertion carries only identity
 * selectors; authoritative roles, entitlements and contractual data rights are re-resolved from
 * Postgres on every subsequent API request.
 */
export async function exchangeServiceAccountCredential(
  credential: unknown,
  db: PostgresSqlApi,
  signingSecret: string,
  now = new Date(),
): Promise<{ assertion: string; expiresIn: number } | null> {
  if (!signingSecret) throw new Error("Service-account assertion signing is not configured");
  const verified = await verifyServiceAccountCredential(credential, db);
  if (!verified) return null;

  const iat = Math.floor(now.getTime() / 1000);
  const payload = {
    v: 1 as const,
    sub: verified.subject,
    tenantId: verified.tenantId,
    workspaceId: verified.workspaceId,
    roles: ["api_client"],
    entitlements: {
      workspaceIds: [verified.workspaceId],
      sourceDocumentAccessAllowed: false,
      internalAnalyticsAllowed: false,
      modelTrainingAllowed: false,
      redistributionAllowed: false,
    },
    authMethod: "service_account" as const,
    sessionId: `service-account:${verified.credentialId}`,
    iat,
    exp: iat + SERVICE_ACCOUNT_ASSERTION_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", signingSecret).update(encoded).digest("base64url");
  return { assertion: `${encoded}.${signature}`, expiresIn: SERVICE_ACCOUNT_ASSERTION_TTL_SECONDS };
}
