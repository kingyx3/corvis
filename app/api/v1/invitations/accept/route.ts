import { resolveRequestIdentity } from "@/lib/server/request-context";
import { apiError, correlationId, json } from "@/lib/server/http";
import { acceptTenantInvitation, TenantInvitationError } from "@/lib/server/tenant-invitations";
import { postgres } from "@/lib/server/postgres";
import { getServerConfig } from "@/lib/server/config";
import { enforceRequestRateLimit } from "@/lib/server/distributed-rate-limit";

/**
 * Acceptance is authenticated but intentionally precedes membership
 * authorization: a first-time invitee has no membership until this command
 * atomically creates it. Tenant/workspace headers remain context selectors;
 * the single-use token determines which tenant/workspace is actually granted.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveRequestIdentity(request);
    if (identity.authMethod !== "oidc" && identity.authMethod !== "saml") {
      return json({ error: "invitation_requires_human_identity", correlationId: id }, { status: 403 });
    }
    await enforceRequestRateLimit(identity.tenantId, identity.subject);
    const parsed: unknown = await request.json().catch(() => null);
    const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    const token = typeof body?.token === "string" ? body.token : "";
    if (!token) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const result = await acceptTenantInvitation(token, identity.authMethod, identity.subject, identity.authenticatedEmail, identity.emailVerified, id, postgres(getServerConfig().postgresDsn));
    return json({ data: result, correlationId: id }, { status: 200 });
  } catch (error) {
    if (error instanceof TenantInvitationError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}
