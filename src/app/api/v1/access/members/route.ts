import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/identity/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { listTenantAccessMembers } from "@/modules/identity-access/server/tenants/tenant-access";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    if (identity.isTenantAdmin !== true) {
      return json({ error: "tenant_admin_required", correlationId: id }, { status: 403 });
    }
    return json({ data: await listTenantAccessMembers(identity), correlationId: id });
  } catch (error) {
    return apiError(error, id);
  }
}
