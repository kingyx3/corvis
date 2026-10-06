import { readJsonObject, resolveAdminRequestIdentity } from "@/modules/identity-access/server/request/admin-request";
import { getServerConfig } from "@/platform/config/config";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { postgres, withTransaction } from "@/platform/database/postgres";
import {
  assertOperationsTenant,
  normalizeProvisionTenantCommand,
  PostgresTenantProvisioningRepository,
} from "@/modules/identity-access/server/tenants/tenant-provisioning";
import { createTenantInvitation } from "@/modules/identity-access/server/tenants/tenant-invitations";
import { deliverInvitationEmail } from "@/modules/notifications/server/notifications";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    assertOperationsTenant(identity, getServerConfig());

    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const command = normalizeProvisionTenantCommand(body);
    if (!command) return json({ error: "invalid_request", correlationId: id }, { status: 400 });

    const db = postgres(getServerConfig().databaseDsn);
    const data = await withTransaction(db, async (tx) => {
      const provisioned = await new PostgresTenantProvisioningRepository(tx).provision(identity, id, command);
      const invitation = await createTenantInvitation(identity, {
        tenantId: provisioned.tenantId,
        workspaceId: provisioned.workspaceId,
        email: command.initialAdminEmail,
        roleName: "tenant_admin",
        reason: `Initial organization administrator invitation: ${command.reason}`,
        confirmTenantAdmin: true,
      }, id, tx);
      return { ...provisioned, initialAdminInvitation: invitation };
    });
    const emailDelivery = await deliverInvitationEmail(data.initialAdminInvitation.invitation, data.initialAdminInvitation.token, { db });
    return json({ data: { ...data, initialAdminInvitation: { ...data.initialAdminInvitation, emailDelivery } }, correlationId: id }, { status: 201 });
  } catch (error) {
    return apiError(error, id);
  }
}
