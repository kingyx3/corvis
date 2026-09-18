import { resolveRequestIdentity } from "@/lib/server/request-context";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    return json({ data: { subject: identity.subject, tenantId: identity.tenantId, workspaceId: identity.workspaceId, roles: identity.roles, entitlements: identity.entitlements }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
