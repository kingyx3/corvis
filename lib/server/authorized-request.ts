import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { membershipAuthorizationRepository, type MembershipAuthorizationRepository } from "./authorization.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { enforceRequestRateLimit } from "./distributed-rate-limit.ts";
import { AuthenticationError, resolveRequestIdentity } from "./request-context.ts";

type ResolveAuthorizedOptions = {
  repository?: MembershipAuthorizationRepository;
  requireAuthoritative?: boolean;
  rateLimiter?: RateLimiter;
  now?: number;
};

/**
 * Authentication and authorization deliberately cross separate boundaries.
 *
 * Production OIDC establishes the immutable subject plus a requested
 * tenant/workspace context (or an optional signed identity broker assertion does
 * so for SAML/service identities). Effective membership, application roles,
 * resource grants, contractual data rights and session/service-identity lifecycle
 * state are always re-resolved from Postgres before a route evaluates access.
 */
export async function resolveAuthorizedRequestIdentity(
  request: Request,
  options: ResolveAuthorizedOptions = {},
): Promise<RequestIdentity> {
  const authenticated = await resolveRequestIdentity(request);

  // Every route that reaches this point has an authenticated tenant and
  // subject (a user or a service account), so this is the narrowest place
  // that still covers the whole authenticated app/api/v1 surface without
  // threading rate limiting through each route handler individually.
  await enforceRequestRateLimit(authenticated.tenantId, authenticated.subject, {
    limiter: options.rateLimiter,
    now: options.now,
  });

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
