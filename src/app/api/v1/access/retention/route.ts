import { dataGovernanceErrorResponse, resolveOrganizationAdmin } from "@/lib/server/data-governance";
import { retentionService } from "@/lib/server/data-retention";
import { correlationId, json } from "@/lib/server/http";

/**
 * The retention periods and legal holds that apply to the caller's organization (F10, #266). Read-only and
 * Organization-Admin-only: Corvis operations set and lift both; this only shows them.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    return json({ data: await retentionService().view(identity), correlationId: id });
  } catch (error) { return dataGovernanceErrorResponse(error, id); }
}
