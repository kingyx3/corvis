import { resolveAdminRequestIdentity } from "@/modules/identity-access/server/request/admin-request";
import { getServerConfig } from "@/platform/config/config";
import { dataGovernanceErrorResponse } from "@/modules/governance/server/lifecycle/data-governance";
import { correlationId, json } from "@/platform/http/api/http";
import { parseLimit } from "@/platform/http/api/pagination";
import { postgres } from "@/platform/database/postgres";
import { assertOperationsAdmin, listTenantExportBuildIssues, parseBuildIssueStatus } from "@/modules/delivery/server/tenant-export/tenant-export-operations";

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
    const page = await listTenantExportBuildIssues(postgres(config.databaseDsn), {
      limit: parseLimit(params.get("limit")),
      cursor: params.get("cursor"),
      status: parseBuildIssueStatus(params.get("status")),
    });
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return dataGovernanceErrorResponse(error, id); }
}
