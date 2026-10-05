import { IdentityRecordValidationError, parseTargetTenant, parseTenantIdentityCommand } from "@/modules/identity-access/domain/identity-records";
import { readJsonObject, resolveAdminRequestIdentity } from "@/platform/http/admin-request";
import { getServerConfig } from "@/platform/config/config";
import { apiError, correlationId, json } from "@/platform/http/http";
import { applyTenantIdentityCommand, readTenantIdentityRecords } from "@/modules/identity-access/server/identity-records";
import { postgres } from "@/platform/database/postgres";
import { assertOperationsTenant } from "@/modules/identity-access/server/tenant-provisioning";

/**
 * Corvis-assisted identity records (F7b #335 verified email domains, F7e #338 per-tenant identity-provider record). Initial
 * identity-provider and domain setup stays with Corvis operations (#78), so both methods require the configured operations
 * tenant (after `tenant_admin` and `admin:manage`) and name the customer tenant they act on. The SQL functions
 * independently require an active Organization Admin actor and write the audit event for the target tenant in the same
 * transaction. An Organization Admin reads the result in the session-policy identity view, never here.
 */
function validationResponse(error: unknown, id: string): Response | undefined {
  return error instanceof IdentityRecordValidationError ? json({ error: error.code, correlationId: id }, { status: error.status }) : undefined;
}

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    assertOperationsTenant(identity, getServerConfig());
    const tenantId = parseTargetTenant(new URL(request.url).searchParams.get("tenantId"));
    const records = await readTenantIdentityRecords(postgres(getServerConfig().postgresDsn), tenantId);
    return json({ data: records, correlationId: id });
  } catch (error) {
    return validationResponse(error, id) ?? apiError(error, id);
  }
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    assertOperationsTenant(identity, getServerConfig());
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const command = parseTenantIdentityCommand(body);
    const change = await applyTenantIdentityCommand(identity, command, id);
    return json({ data: { kind: command.kind, tenantId: command.tenantId, ...change }, correlationId: id });
  } catch (error) {
    return validationResponse(error, id) ?? apiError(error, id);
  }
}
