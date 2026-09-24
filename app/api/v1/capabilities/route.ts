import { hasPermission, type Permission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";

const PERMISSIONS: readonly Permission[] = [
  "documents:read",
  "documents:write",
  "sources:read",
  "observations:read",
  "observations:review",
  "snapshots:publish",
  "research:query",
  "exports:create",
  "admin:manage",
];

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    return json({
      data: {
        permissions: PERMISSIONS.filter((permission) => hasPermission(identity, permission)),
        tenantControlAllowed: identity.isTenantAdmin === true,
        sourceDocumentAccessAllowed: identity.entitlements.sourceDocumentAccessAllowed === true,
        redistributionAllowed: identity.entitlements.redistributionAllowed === true,
      },
      correlationId: id,
    });
  } catch (error) {
    return apiError(error, id);
  }
}
