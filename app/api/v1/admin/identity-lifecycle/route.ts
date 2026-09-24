import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { readJsonObject } from "@/lib/server/admin-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import {
  identityLifecycleRepository,
  type HumanAuthMethod,
  type IdentityLifecycleMembership,
  type IdentityLifecycleRole,
} from "@/lib/server/identity-lifecycle";
import { postgres } from "@/lib/server/postgres";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set<IdentityLifecycleRole>(["tenant_admin", "accountadmin", "reviewer", "analyst", "viewer"]);
type LifecycleOperation = "sync" | "disable" | "reactivate";

function operation(value: unknown): LifecycleOperation | undefined {
  return value === "sync" || value === "disable" || value === "reactivate" ? value : undefined;
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

    const body = await readJsonObject(request) as Record<string, unknown> | undefined;

    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
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

    // Separation of duties: granting the tenant_admin role (to the actor or
    // to anyone else) requires the actor to already hold an active
    // tenant_admin membership. Re-enforced authoritatively in SQL (migration
    // 048); checked here first so a non-tenant-admin gets a clean 403
    // instead of a raised database exception.
    if (desiredMemberships.some((entry) => entry.roleName === "tenant_admin") && identity.isTenantAdmin !== true) {
      return json({ error: "tenant_admin_role_requires_tenant_admin_actor", correlationId: id }, { status: 403 });
    }

    if (lifecycleOperation === "reactivate") {
      const db = postgres(getServerConfig().postgresDsn);
      const rows = await db.query(`select corvis_control.reactivate_identity_admin(
        $1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8::uuid,$9::jsonb,$10
      ) as result`, [identity.tenantId, eventKey, identity.subject, identity.workspaceId, id,
        lifecycleAuthMethod, subject, userId, JSON.stringify(desiredMemberships), reason]);
      return json({ data: rows[0]?.result ?? null, correlationId: id }, { status: 200 });
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
