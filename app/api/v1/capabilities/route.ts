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

/**
 * Optional product-module state fails closed locally. A feature-control storage
 * outage must not turn the base fund/holding workspace into a 500: callers keep
 * their ordinary RBAC/data-right capabilities while optional modules disappear.
 * Module-specific API routes still enforce the same capability directly and do
 * not use this presentation fallback as an authorization boundary.
 */
async function optionalPortfolioAttribution(identity: Awaited<ReturnType<typeof resolveAuthorizedRequestIdentity>>): Promise<boolean> {
  try {
    return await isFeatureEnabled(identity, PORTFOLIO_ATTRIBUTION_FLAG, "customer_ui");
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    const portfolioAttribution = await optionalPortfolioAttribution(identity);
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
