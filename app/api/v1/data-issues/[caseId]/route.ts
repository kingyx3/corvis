import { assertPermission } from "@/core/enterprise";
import { DataIssueValidationError } from "@/core/data-issue";
import { readJsonObject } from "@/lib/server/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { dataIssueErrorResponse } from "@/lib/server/data-issue-http";
import { dataIssueService } from "@/lib/server/data-issue-service";
import { correlationId, json } from "@/lib/server/http";

/** One case with its status history, for its reporter or an Organization Admin. Anyone else gets the same 404 as a missing case. */
export async function GET(request: Request, context: { params: Promise<{ caseId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const { caseId } = await context.params;
    return json({ data: await dataIssueService().get(identity, caseId), correlationId: id });
  } catch (error) { return dataIssueErrorResponse(error, id); }
}

/** The reporter has seen the case's current status (`{ "seen": true }`): clears its "updated" indicator. Touches nothing else. */
export async function PATCH(request: Request, context: { params: Promise<{ caseId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const body = await readJsonObject(request);
    if (!body || body.seen !== true) throw new DataIssueValidationError("invalid_request");
    const { caseId } = await context.params;
    return json({ data: await dataIssueService().acknowledge(identity, caseId), correlationId: id });
  } catch (error) { return dataIssueErrorResponse(error, id); }
}
