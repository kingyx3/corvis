import { assertPermission } from "@/core/enterprise";
import { readJsonObject } from "@/lib/server/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres, withTransaction } from "@/lib/server/postgres";
import {
  assertOperationsTenant,
  normalizeProvisionTenantCommand,
  PostgresTenantProvisioningRepository,
} from "@/lib/server/tenant-provisioning";
import { createTenantInvitation } from "@/lib/server/tenant-invitations";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    assertOperationsTenant(identity, getServerConfig());

    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const command = normalizeProvisionTenantCommand(body);
    if (!command) return json({ error: "invalid_request", correlationId: id }, { status: 400 });

    const db = postgres(getServerConfig().postgresDsn);
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
    return json({ data, correlationId: id }, { status: 201 });
  } catch (error) {
    return apiError(error, id);
  }
}
