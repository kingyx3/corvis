import { randomUUID } from "crypto";
import type { RequestIdentity, Role } from "@/core/enterprise";
import { getServerConfig } from "@/lib/server/config";

function parseRoles(value: string | null): Role[] {
  const allowed = new Set<Role>(["admin","reviewer","analyst","api_client","read_only"]);
  return (value || "").split(",").map((x) => x.trim()).filter((x): x is Role => allowed.has(x as Role));
}

export function resolveRequestIdentity(request: Request): RequestIdentity {
  const config = getServerConfig();
  const correlation = request.headers.get("x-correlation-id") || randomUUID();

  if (config.demoMode && config.environment !== "production") {
    return {
      subject: request.headers.get("x-corvis-demo-subject") || "demo-user",
      tenantId: request.headers.get("x-corvis-demo-tenant") || "tenant_demo",
      workspaceId: request.headers.get("x-corvis-demo-workspace") || "workspace_demo",
      roles: parseRoles(request.headers.get("x-corvis-demo-roles")) || ["admin"],
      entitlements: { workspaceIds: [request.headers.get("x-corvis-demo-workspace") || "workspace_demo"], sourceDocumentAccessAllowed: true },
      authMethod: "demo",
      sessionId: correlation,
    };
  }

  // Production deployments terminate OIDC/SAML at the approved identity gateway.
  // The gateway must inject verified claims. Never accept these headers directly from the public internet.
  const subject = request.headers.get("x-corvis-auth-subject");
  const tenantId = request.headers.get("x-corvis-auth-tenant");
  const workspaceId = request.headers.get("x-corvis-auth-workspace");
  const roles = parseRoles(request.headers.get("x-corvis-auth-roles"));
  const sessionId = request.headers.get("x-corvis-auth-session") || correlation;
  if (!subject || !tenantId || !workspaceId || !roles.length) throw new AuthenticationError();

  return {
    subject, tenantId, workspaceId, roles,
    entitlements: {
      workspaceIds: (request.headers.get("x-corvis-entitled-workspaces") || workspaceId).split(","),
      fundIds: request.headers.get("x-corvis-entitled-funds")?.split(",").filter(Boolean),
      documentIds: request.headers.get("x-corvis-entitled-documents")?.split(",").filter(Boolean),
      sourceDocumentAccessAllowed: request.headers.get("x-corvis-source-access") === "true",
      internalAnalyticsAllowed: request.headers.get("x-corvis-internal-analytics") === "true",
      modelTrainingAllowed: request.headers.get("x-corvis-model-training") === "true",
      redistributionAllowed: request.headers.get("x-corvis-redistribution") === "true",
    },
    authMethod: request.headers.get("x-corvis-auth-method") === "service_account" ? "service_account" : "oidc",
    sessionId,
  };
}

export class AuthenticationError extends Error {
  constructor() { super("Authentication required"); this.name = "AuthenticationError"; }
}
