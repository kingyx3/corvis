import { assertPermission } from "@/shared/domain/enterprise";
import { readJsonObject } from "@/modules/identity-access/server/request/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/modules/identity-access/server/request/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { createTenantInvitation, listTenantInvitations, normalizeTenantInvitation, TenantInvitationError } from "@/modules/identity-access/server/tenants/tenant-invitations";
import { postgres, withTransaction } from "@/platform/database/postgres";
import { deliverInvitationEmail } from "@/modules/notifications/server/notifications";
import { getServerConfig } from "@/platform/config/config";

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
    const db = postgres(getServerConfig().databaseDsn);
    const created = await withTransaction(db, (tx) => createTenantInvitation(identity, command, id, tx));
    // Sent only after the invitation committed; the one-time link is still returned for the manual fallback.
    const data = { ...created, emailDelivery: await deliverInvitationEmail(created.invitation, created.token, { db }) };
    return json({ data, correlationId: id }, { status: 201 });
  } catch (error) {
    if (error instanceof TenantInvitationError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}
