import { parseTransitionCommand } from "@/core/data-issue";
import { readJsonObject, resolveAdminRequestIdentity } from "@/lib/server/admin-request";
import { dataIssueErrorResponse } from "@/lib/server/data-issue-http";
import { dataIssueService } from "@/lib/server/data-issue-service";
import { correlationId, json } from "@/lib/server/http";

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
    const command = parseTransitionCommand(await readJsonObject(request));
    const { caseId } = await context.params;
    return json({ data: await dataIssueService().transition(identity, caseId, command, id), correlationId: id });
  } catch (error) { return dataIssueErrorResponse(error, id); }
}
