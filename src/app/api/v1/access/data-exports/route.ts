import { parseTenantExportRequest } from "@/modules/delivery/domain/tenant-export";
import { readJsonObject } from "@/platform/http/identity/admin-request";
import { dataGovernanceErrorResponse, resolveOrganizationAdmin } from "@/modules/governance/server/lifecycle/data-governance";
import { correlationId, json } from "@/platform/http/api/http";
import { parseLimit } from "@/platform/http/api/pagination";
import { tenantExportService } from "@/modules/delivery/server/tenant-export/tenant-export-service";

/**
 * Full tenant data export (F10, #266). An Organization Admin lists the organization's export requests and asks for a
 * new one; a different Organization Admin must approve it (`POST /data-exports/{exportId}`) before anything is built.
 * `?limit=` (1 to 200, default 50) and `?cursor=` page the list newest first in a stable keyset order; `nextCursor` is `null` on the last page.
 * What an export contains is fixed (published data, the access audit and the source-document inventory, limited to
 * what the organization may redistribute), so a request names only why it is needed.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    const params = new URL(request.url).searchParams;
    const page = await tenantExportService().list(identity, { limit: parseLimit(params.get("limit")), cursor: params.get("cursor") });
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
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
