import { parseDeletionDecision } from "@/modules/governance/domain/data-retention";
import { readJsonObject } from "@/modules/identity-access/server/request/admin-request";
import { customerDeletionService } from "@/modules/governance/server/lifecycle/customer-deletion";
import { dataGovernanceErrorResponse, resolveOrganizationAdmin } from "@/modules/governance/server/lifecycle/data-governance";
import { correlationId, json } from "@/platform/http/api/http";

/**
 * `{ action: "approve" | "reject" | "cancel", note?, expectedStatus? }` decides a deletion request an Organization Admin made
 * (F10e, #325). Approve and reject need a different Organization Admin than the requester
 * (`403 deletion_independent_approver_required`, enforced in SQL), reject needs a note, only the requester may cancel, and
 * approval is refused while a legal hold covers the data (`409 deletion_blocked_by_legal_hold`). A request Corvis
 * operations made is never decided here (`404`). Approving hands the request to Corvis operations; nothing is deleted by
 * this call.
 */
export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    const { requestId } = await context.params;
    const command = parseDeletionDecision(await readJsonObject(request));
    return json({ data: await customerDeletionService().decide(identity, requestId, command, id), correlationId: id });
  } catch (error) { return dataGovernanceErrorResponse(error, id); }
}
