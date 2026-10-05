import { readJsonObject, resolveAdminRequestIdentity } from "@/platform/http/admin-request";
import { apiError, correlationId, json } from "@/platform/http/http";
import { getServerConfig } from "@/platform/config/config";
import { postgres, withTransaction } from "@/platform/database/postgres";
import { deliverInvitationEmail } from "@/modules/notifications/server/notifications";
import { assertInvitationIssuer, createTenantInvitation, normalizeTenantInvitation, TenantInvitationError } from "@/modules/identity-access/server/tenant-invitations";
import { assertOperationsTenant } from "@/modules/identity-access/server/tenant-provisioning";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    assertOperationsTenant(identity, getServerConfig());
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const command = normalizeTenantInvitation(body);
    if (!command || command.roleName !== "tenant_admin") return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    assertInvitationIssuer(identity, command);
    const db = postgres(getServerConfig().postgresDsn);
    const created = await withTransaction(db, (tx) => createTenantInvitation(identity, command, id, tx));
    // Sent only after the invitation committed; the one-time link is still returned for the manual fallback.
    const data = { ...created, emailDelivery: await deliverInvitationEmail(created.invitation, created.token, { db }) };
    return json({ data, correlationId: id }, { status: 201 });
  } catch (error) {
    if (error instanceof TenantInvitationError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}
