import { assertPermission } from "@/core/enterprise";
import { readJsonObject } from "@/lib/server/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { changeTenantMemberRole, TenantAccessError } from "@/lib/server/tenant-access";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    if (identity.isTenantAdmin !== true) return json({ error: "tenant_admin_required", correlationId: id }, { status: 403 });
    const body = await readJsonObject(request) as Record<string, unknown> | undefined;
    if (!body || typeof body.userId !== "string" || typeof body.workspaceId !== "string" || typeof body.expectedRole !== "string"
      || (body.roleName !== null && typeof body.roleName !== "string") || typeof body.reason !== "string") {
      return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    }
    const data = await changeTenantMemberRole(identity, { userId: body.userId, workspaceId: body.workspaceId, expectedRole: body.expectedRole,
      roleName: body.roleName as string | null, reason: body.reason, confirmTenantAdmin: body.confirmTenantAdmin === true }, id);
    return json({ data, correlationId: id });
  } catch (error) {
    if (error instanceof TenantAccessError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}
