import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    return json({ data: { subject: identity.subject, tenantId: identity.tenantId, workspaceId: identity.workspaceId, roles: identity.roles, entitlements: identity.entitlements, tenantDisplayName: identity.tenantDisplayName, workspaceDisplayName: identity.workspaceDisplayName }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
