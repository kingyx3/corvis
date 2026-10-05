import { assertPermission } from "@/shared/domain/enterprise";
import { parseReportCommand } from "@/modules/governance/domain/data-issue";
import { readJsonObject } from "@/platform/http/identity/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/identity/authorized-request";
import { dataIssueErrorResponse, listDataIssuesResponse } from "@/modules/governance/server/data-issues/data-issue-http";
import { dataIssueService } from "@/modules/governance/server/data-issues/data-issue-service";
import { correlationId, json } from "@/platform/http/api/http";

/**
 * Data issues (F5): a customer reports a doubt about a published figure. The caller sees their own reports; an
 * Organization Admin may list the whole tenant with `?scope=all`. `?format=csv|json` downloads every matching case for
 * the customer's own records. Reporting records a claim only: it never changes data or publication state.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    return await listDataIssuesResponse(request, identity, id);
  } catch (error) { return dataIssueErrorResponse(error, id); }
}

/** Idempotent per reporter: `idempotencyKey` in the body or the `Idempotency-Key` header. A replay answers 200 with the original case. */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const command = parseReportCommand(await readJsonObject(request), request.headers.get("idempotency-key"));
    const { item, created } = await dataIssueService().report(identity, command, id);
    return json({ data: item, replayed: !created, correlationId: id }, { status: created ? 201 : 200 });
  } catch (error) { return dataIssueErrorResponse(error, id); }
}
