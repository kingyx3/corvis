import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import {
  identityLifecycleRepository,
  type HumanAuthMethod,
  type IdentityLifecycleMembership,
  type IdentityLifecycleOperation,
  type IdentityLifecycleRole,
} from "@/lib/server/identity-lifecycle";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set<IdentityLifecycleRole>(["tenant_admin", "workspace_admin", "reviewer", "analyst", "viewer"]);

function operation(value: unknown): IdentityLifecycleOperation | undefined {
  return value === "sync" || value === "disable" ? value : undefined;
}

function authMethod(value: unknown): HumanAuthMethod | undefined {
  return value === "oidc" || value === "saml" ? value : undefined;
}

function memberships(value: unknown): IdentityLifecycleMembership[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const result: IdentityLifecycleMembership[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const row = entry as Record<string, unknown>;
    const workspaceId = typeof row.workspaceId === "string" ? row.workspaceId.trim() : "";
    const roleName = typeof row.roleName === "string" ? row.roleName.trim() : "";
    if (!UUID.test(workspaceId) || !ROLES.has(roleName as IdentityLifecycleRole)) return undefined;
    const key = `${workspaceId}:${roleName}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    result.push({ workspaceId, roleName: roleName as IdentityLifecycleRole });
  }
  return result;
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");

    const body = await request.json() as Record<string, unknown>;
    const eventKey = typeof body.eventKey === "string" ? body.eventKey.trim() : "";
    const lifecycleOperation = operation(body.operation);
    const lifecycleAuthMethod = authMethod(body.authMethod);
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const desiredMemberships = memberships(body.memberships ?? []);

    if (
      !eventKey || eventKey.length > 256 ||
      !lifecycleOperation || !lifecycleAuthMethod ||
      !subject || subject.length > 1024 ||
      !UUID.test(userId) ||
      !reason || reason.length > 1000 ||
      desiredMemberships === undefined ||
      (lifecycleOperation === "disable" && desiredMemberships.length !== 0)
    ) {
      return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    }

    const data = await identityLifecycleRepository().apply({
      tenantId: identity.tenantId,
      eventKey,
      actorSubject: identity.subject,
      actorWorkspaceId: identity.workspaceId,
      correlationId: id,
      operation: lifecycleOperation,
      authMethod: lifecycleAuthMethod,
      subject,
      userId,
      memberships: desiredMemberships,
      reason,
    });

    return json({ data, correlationId: id }, { status: 200 });
  } catch (error) {
    return apiError(error, id);
  }
}
