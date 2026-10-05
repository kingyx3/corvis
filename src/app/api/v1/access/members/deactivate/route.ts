import { assertPermission } from "@/core/enterprise";
import { readJsonObject } from "@/lib/server/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { deactivateTenantAccessMember, TenantAccessError } from "@/lib/server/tenant-access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    if (identity.isTenantAdmin !== true) {
      return json({ error: "tenant_admin_required", correlationId: id }, { status: 403 });
    }

    const body = await readJsonObject(request) as Record<string, unknown> | undefined;
    const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!UUID.test(userId) || !reason || reason.length > 1000) {
      return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    }

    const data = await deactivateTenantAccessMember(identity, userId, reason, id);
    return json({ data, correlationId: id });
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return json({ error: error.code, correlationId: id }, { status: error.status });
    }
    return apiError(error, id);
  }
}
