import { parseTransitionCommand } from "@/modules/governance/domain/data-issue";
import { readJsonObject, resolveAdminRequestIdentity } from "@/modules/identity-access/server/request/admin-request";
import { dataIssueErrorResponse } from "@/modules/governance/server/data-issues/data-issue-http";
import { dataIssueService } from "@/modules/governance/server/data-issues/data-issue-service";
import { correlationId, json } from "@/platform/http/api/http";

export async function GET(request: Request, context: { params: Promise<{ caseId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    const { caseId } = await context.params;
    return json({ data: await dataIssueService().get(identity, caseId), correlationId: id });
  } catch (error) { return dataIssueErrorResponse(error, id); }
}

/**
 * Data Operations moves a case: `{ "action": "investigate" | "correct" | "no_change", "expectedStatus"?, "correctionIncidentId"?, "note"? }`.
 * `correct` links the replacement publication of a *resolved* governed correction (`/admin/data-corrections`); it never
 * creates or publishes data itself. The status change, its audit event and the reporter's notice commit together.
 */
export async function PATCH(request: Request, context: { params: Promise<{ caseId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const command = parseTransitionCommand(body);
    const { caseId } = await context.params;
    return json({ data: await dataIssueService().transition(identity, caseId, command, id), correlationId: id });
  } catch (error) { return dataIssueErrorResponse(error, id); }
}
