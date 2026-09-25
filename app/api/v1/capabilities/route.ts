import { hasPermission, type Permission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { isFeatureEnabled, PORTFOLIO_ATTRIBUTION_FLAG } from "@/lib/server/feature-flags";
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
    const portfolioAttribution = await isFeatureEnabled(identity, PORTFOLIO_ATTRIBUTION_FLAG, "customer_ui");
    return json({
      data: {
        permissions: PERMISSIONS.filter((permission) => hasPermission(identity, permission)),
        sourceDocumentAccessAllowed: identity.entitlements.sourceDocumentAccessAllowed === true,
        redistributionAllowed: identity.entitlements.redistributionAllowed === true,
        features: { portfolioAttribution },
      },
      correlationId: id,
    });
  } catch (error) {
    return apiError(error, id);
  }
}
