import { parseTenantExportRequest } from "@/core/tenant-export";
import { readJsonObject } from "@/lib/server/admin-request";
import { dataGovernanceErrorResponse, resolveOrganizationAdmin } from "@/lib/server/data-governance";
import { correlationId, json } from "@/lib/server/http";
import { tenantExportService } from "@/lib/server/tenant-export-service";

/**
 * Full tenant data export (F10, #266). An Organization Admin lists the organization's export requests and asks for a
 * new one; a different Organization Admin must approve it (`POST /data-exports/{exportId}`) before anything is built.
 * What an export contains is fixed (published data, the access audit and the source-document inventory, limited to
 * what the organization may redistribute), so a request names only why it is needed.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    return json({ data: await tenantExportService().list(identity), correlationId: id });
  } catch (error) { return dataGovernanceErrorResponse(error, id); }
}

/** `201` with the pending request. Only one request is open at a time (`409 data_export_already_active`). */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    const command = parseTenantExportRequest(await readJsonObject(request));
    return json({ data: await tenantExportService().request(identity, command, id), correlationId: id }, { status: 201 });
  } catch (error) { return dataGovernanceErrorResponse(error, id); }
}
