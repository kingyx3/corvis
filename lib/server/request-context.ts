import { randomUUID, timingSafeEqual } from "crypto";
import type { RequestIdentity, Role } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";

function parseRoles(value: string | null): Role[] {
  const allowed = new Set<Role>(["admin","reviewer","analyst","api_client","read_only"]);
  return (value || "").split(",").map((x) => x.trim()).filter((x): x is Role => allowed.has(x as Role));
}

function safeEqual(actual: string | null, expected?: string): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function resolveRequestIdentity(request: Request): RequestIdentity {
  const config = getServerConfig();
  const correlation = request.headers.get("x-correlation-id") || randomUUID();

  if (config.demoMode && config.environment !== "production") {
    const demoRoles = parseRoles(request.headers.get("x-corvis-demo-roles"));
    const workspaceId = request.headers.get("x-corvis-demo-workspace") || "workspace_demo";
    return {
      subject: request.headers.get("x-corvis-demo-subject") || "demo-user",
      tenantId: request.headers.get("x-corvis-demo-tenant") || "tenant_demo",
      workspaceId,
      roles: demoRoles.length ? demoRoles : ["admin"],
      entitlements: { workspaceIds: [workspaceId], sourceDocumentAccessAllowed: true },
      authMethod: "demo",
      sessionId: request.headers.get("x-corvis-session-id") || `demo-${correlation}`,
    };
  }

  if (!safeEqual(request.headers.get("x-corvis-gateway-secret"), config.trustedAuthProxySecret)) {
    throw new AuthenticationError("Untrusted identity gateway");
  }

  const subject = request.headers.get("x-corvis-auth-subject");
  const tenantId = request.headers.get("x-corvis-auth-tenant");
  const workspaceId = request.headers.get("x-corvis-auth-workspace");
  const roles = parseRoles(request.headers.get("x-corvis-auth-roles"));
  if (!subject || !tenantId || !workspaceId || roles.length === 0) throw new AuthenticationError("Missing authenticated request context");
  const split = (name: string) => (request.headers.get(name) || "").split(",").map((x) => x.trim()).filter(Boolean);
  const workspaceIds = split("x-corvis-entitled-workspaces");
  if (workspaceIds.length && !workspaceIds.includes(workspaceId)) throw new AuthenticationError("Workspace context not entitled");
  return {
    subject,
    tenantId,
    workspaceId,
    roles,
    entitlements: {
      workspaceIds: workspaceIds.length ? workspaceIds : [workspaceId],
      fundIds: split("x-corvis-entitled-funds"),
      documentIds: split("x-corvis-entitled-documents"),
      datasetIds: split("x-corvis-entitled-datasets"),
      sourceDocumentAccessAllowed: request.headers.get("x-corvis-source-access") === "true",
    },
    authMethod: request.headers.get("x-corvis-auth-method") || "oidc",
    sessionId: request.headers.get("x-corvis-session-id") || undefined,
  };
}

export class AuthenticationError extends Error {
  constructor(message: string) { super(message); this.name = "AuthenticationError"; }
}
