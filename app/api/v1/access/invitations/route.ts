import { assertPermission } from "@/core/enterprise";
import { readJsonObject } from "@/lib/server/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { createTenantInvitation, listTenantInvitations, normalizeTenantInvitation, TenantInvitationError } from "@/lib/server/tenant-invitations";
import { postgres, withTransaction } from "@/lib/server/postgres";
import { getServerConfig } from "@/lib/server/config";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    if (identity.isTenantAdmin !== true) return json({ error: "tenant_admin_required", correlationId: id }, { status: 403 });
    return json({ data: await listTenantInvitations(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    if (identity.isTenantAdmin !== true) return json({ error: "tenant_admin_required", correlationId: id }, { status: 403 });
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const command = normalizeTenantInvitation({ ...body, tenantId: identity.tenantId });
    if (!command) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const db = postgres(getServerConfig().postgresDsn);
    const data = await withTransaction(db, (tx) => createTenantInvitation(identity, command, id, tx));
    return json({ data, correlationId: id }, { status: 201 });
  } catch (error) {
    if (error instanceof TenantInvitationError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}
