import { resolveAdminRequestIdentity } from "@/lib/server/admin-request";
import { getServerConfig } from "@/lib/server/config";
import { dataGovernanceErrorResponse } from "@/lib/server/data-governance";
import { correlationId, json } from "@/lib/server/http";
import { parseLimit } from "@/lib/server/pagination";
import { postgres } from "@/lib/server/postgres";
import { assertOperationsAdmin, listTenantExportBuildIssues, parseBuildIssueStatus } from "@/lib/server/tenant-export-operations";

/**
 * Full tenant export builds that failed or are being retried (F10f, #326), across tenants, for Corvis operations only
 * (the operations tenant's admins, like `/admin/tenant-health`). Shows the tenant, the request id, the attempt count and
 * the stored build error; never the requester, the stated reason, the approver or any data. `?status=failed|retrying`,
 * `?limit=` and `?cursor=` filter and page it, newest change first.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    const config = getServerConfig();
    assertOperationsAdmin(identity, config.operationsTenantId);
    const params = new URL(request.url).searchParams;
    const page = await listTenantExportBuildIssues(postgres(config.postgresDsn), {
      limit: parseLimit(params.get("limit")),
      cursor: params.get("cursor"),
      status: parseBuildIssueStatus(params.get("status")),
    });
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return dataGovernanceErrorResponse(error, id); }
}
