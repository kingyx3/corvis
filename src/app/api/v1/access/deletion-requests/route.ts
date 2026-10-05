import { parseDeletionRequest } from "@/core/data-retention";
import { readJsonObject } from "@/lib/server/admin-request";
import { customerDeletionService } from "@/lib/server/customer-deletion";
import { dataGovernanceErrorResponse, resolveOrganizationAdmin } from "@/lib/server/data-governance";
import { correlationId, json } from "@/lib/server/http";

/**
 * An Organization Admin asks for deletion of whole data classes of their organization's data (F10e, #325). The request
 * waits for a different Organization Admin to approve it (`POST /deletion-requests/{requestId}`), and only then goes to
 * Corvis operations, who carry it out. The requests that affect the organization, including the ones Corvis operations
 * made, are listed with the retention view (`GET /access/retention`).
 *
 * `{ dataClasses: string[], reason: string }`: 1 to 20 data classes the organization has a retention policy for, and why.
 * `201` with the pending request. `409 deletion_blocked_by_legal_hold` while a legal hold covers any of the data,
 * `409 deletion_request_already_pending` while another request waits for approval, `400 invalid_data_classes` for a
 * class the organization has no retention policy for.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    const command = parseDeletionRequest(await readJsonObject(request));
    return json({ data: await customerDeletionService().request(identity, command, id), correlationId: id }, { status: 201 });
  } catch (error) { return dataGovernanceErrorResponse(error, id); }
}
