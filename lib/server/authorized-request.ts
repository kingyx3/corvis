import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { membershipAuthorizationRepository, type MembershipAuthorizationRepository } from "./authorization.ts";
import { AuthenticationError, resolveRequestIdentity } from "./request-context.ts";

type ResolveAuthorizedOptions = {
  repository?: MembershipAuthorizationRepository;
  requireAuthoritative?: boolean;
};

/**
 * Authentication and authorization deliberately cross separate boundaries.
 *
 * The signed gateway assertion establishes subject/tenant/workspace/session. In
 * production, effective workspace membership, application roles, resource grants,
 * contractual data rights and session/service-identity lifecycle state are
 * re-resolved from Postgres before a route evaluates permissions. Signed resource
 * or data-right claims can only be hints at the authentication boundary; they
 * cannot widen authoritative Postgres access.
 */
export async function resolveAuthorizedRequestIdentity(
  request: Request,
  options: ResolveAuthorizedOptions = {},
): Promise<RequestIdentity> {
  const authenticated = resolveRequestIdentity(request);
  const config = getServerConfig();
  const requireAuthoritative = options.requireAuthoritative ?? config.environment === "production";

  if (!requireAuthoritative || authenticated.authMethod === "demo") return authenticated;

  const repository = options.repository ?? membershipAuthorizationRepository(config.postgresDsn);
  const authorized = await repository.resolve({
    subject: authenticated.subject,
    tenantId: authenticated.tenantId,
    workspaceId: authenticated.workspaceId,
    authMethod: authenticated.authMethod,
    sessionId: authenticated.sessionId,
  });
  if (!authorized) throw new AuthenticationError("No active authoritative authorization context");

  return {
    ...authenticated,
    roles: authorized.roles,
    entitlements: {
      workspaceIds: authorized.workspaceIds,
      fundIds: authorized.fundIds,
      documentIds: authorized.documentIds,
      sourceDocumentIds: authorized.sourceDocumentIds,
      sourceDocumentAccessAllowed: authorized.sourceDocumentIds.length > 0,
      internalAnalyticsAllowed: authorized.internalAnalyticsAllowed,
      modelTrainingAllowed: authorized.modelTrainingAllowed,
      redistributionAllowed: authorized.redistributionAllowed,
    },
  };
}
