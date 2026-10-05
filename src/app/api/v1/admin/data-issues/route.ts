import { resolveAdminRequestIdentity } from "@/lib/server/admin-request";
import { dataIssueErrorResponse, listDataIssuesResponse } from "@/lib/server/data-issue-http";
import { correlationId } from "@/lib/server/http";

/** The Data Operations queue: every data-issue case in the tenant, newest first (`?status=` filters). Organization Admins only. */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    return await listDataIssuesResponse(request, identity, id, "all");
  } catch (error) { return dataIssueErrorResponse(error, id); }
}
