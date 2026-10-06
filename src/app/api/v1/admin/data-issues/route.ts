import { resolveAdminRequestIdentity } from "@/modules/identity-access/server/request/admin-request";
import { dataIssueErrorResponse, listDataIssuesResponse } from "@/modules/governance/server/data-issues/data-issue-http";
import { correlationId } from "@/platform/http/api/http";

/** The Data Operations queue: every data-issue case in the tenant, newest first (`?status=` filters). Organization Admins only. */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    return await listDataIssuesResponse(request, identity, id, "all");
  } catch (error) { return dataIssueErrorResponse(error, id); }
}
