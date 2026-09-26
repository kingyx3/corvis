import type { RequestIdentity } from "../../core/enterprise.ts";
import { AuthorizationError } from "../../core/enterprise.ts";
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
 * Tenant-wide control-plane paths. `accountadmin` remains a workspace/product
 * administrator, but it must never inherit tenant-wide authority merely
 * because both raw database roles map to the application `admin` role.
 *
 * Keep this boundary here, immediately after authoritative membership
 * resolution, so every current and future `/api/v1/admin/**` route is covered
 * automatically. Processing retry/recovery also acts on tenant-scoped jobs
 * rather than a workspace-entitled resource, so those operator commands use
 * the same tenant-admin boundary even though their public path is `/jobs`.
 */
export function isTenantAdminOnlyPath(pathname: string): boolean {
  if (pathname === "/api/v1/admin" || pathname.startsWith("/api/v1/admin/")) return true;
  return /^\/api\/v1\/jobs\/[^/]+\/(retry|recover)\/?$/.test(pathname);
}

export function assertTenantAdminRequestScope(request: Request, identity: RequestIdentity): void {
  if (!isTenantAdminOnlyPath(new URL(request.url).pathname)) return;
  if (identity.isTenantAdmin !== true) throw new AuthorizationError("admin:tenant_manage");
}

/** Signed broker identity stays immutable; only human workspace context may change. */
export function selectWorkspaceContext(request: Request, identity: RequestIdentity): RequestIdentity {
  const tenant = request.headers.get("x-corvis-tenant");
  const workspace = request.headers.get("x-corvis-workspace");
  if (!tenant && !workspace) return identity;
  if (!tenant || !workspace || tenant !== identity.tenantId) throw new AuthenticationError("Invalid tenant context");
  if (workspace === identity.workspaceId) return identity;
  if (!["oidc", "saml"].includes(identity.authMethod) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspace)) {
    throw new AuthenticationError("Invalid workspace context");
  }
  return { ...identity, workspaceId: workspace };
}

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
  let authenticated = await resolveRequestIdentity(request);
  authenticated = selectWorkspaceContext(request, authenticated);

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

  // Demo mode and non-production non-authoritative requests never resolve a
  // raw database role. Preserve their historical behavior by treating a demo
  // application admin as tenant admin; production-like requests always use the
  // authoritative raw-role signal below.
  if (!requireAuthoritative || authenticated.authMethod === "demo") {
    if (request.headers.get("x-corvis-identity-assertion") && request.headers.get("x-corvis-workspace") && !requireAuthoritative) throw new AuthenticationError("Workspace selection requires authoritative authorization");
    const identity: RequestIdentity = {
      ...authenticated,
      isTenantAdmin: authenticated.roles.includes("admin"),
      // Demo mode has no concept of multiple workspaces (see workspaceDisplayName
      // above); a non-demo, non-authoritative identity doesn't know its display
      // name either, so there is nothing honest to report here.
      workspaceMemberships: authenticated.authMethod === "demo"
        ? [{ workspaceId: authenticated.workspaceId, workspaceDisplayName: authenticated.workspaceDisplayName, roles: authenticated.roles }]
        : undefined,
    };
    assertTenantAdminRequestScope(request, identity);
    return identity;
  }

  const repository = options.repository ?? membershipAuthorizationRepository(config.postgresDsn);
  const authorized = await repository.resolve({
    subject: authenticated.subject,
    tenantId: authenticated.tenantId,
    workspaceId: authenticated.workspaceId,
    authMethod: authenticated.authMethod,
    sessionId: authenticated.sessionId,
  });
  if (!authorized) throw new AuthenticationError("No active authoritative authorization context");

  const identity: RequestIdentity = {
    ...authenticated,
    roles: authorized.roles,
    isTenantAdmin: authorized.isTenantAdmin,
    tenantDisplayName: authorized.tenantDisplayName,
    workspaceDisplayName: authorized.workspaceDisplayName,
    workspaceMemberships: authorized.memberships,
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
  assertTenantAdminRequestScope(request, identity);
  return identity;
}
