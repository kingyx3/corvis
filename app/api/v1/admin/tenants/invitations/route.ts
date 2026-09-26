import { assertPermission } from "@/core/enterprise";
import { readJsonObject } from "@/lib/server/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { getServerConfig } from "@/lib/server/config";
import { postgres, withTransaction } from "@/lib/server/postgres";
import { assertInvitationIssuer, createTenantInvitation, normalizeTenantInvitation, TenantInvitationError } from "@/lib/server/tenant-invitations";
import { assertOperationsTenant } from "@/lib/server/tenant-provisioning";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    assertOperationsTenant(identity, getServerConfig());
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const command = normalizeTenantInvitation(body);
    if (!command || command.roleName !== "tenant_admin") return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    assertInvitationIssuer(identity, command);
    const db = postgres(getServerConfig().postgresDsn);
    const data = await withTransaction(db, (tx) => createTenantInvitation(identity, command, id, tx));
    return json({ data, correlationId: id }, { status: 201 });
  } catch (error) {
    if (error instanceof TenantInvitationError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}
