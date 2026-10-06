import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/modules/identity-access/server/request/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { workspaceSummary } from "@/modules/workspace/server/workspace-summary";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    return json({ data: await workspaceSummary(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
