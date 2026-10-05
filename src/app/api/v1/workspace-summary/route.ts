import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { workspaceSummary } from "@/lib/server/workspace-summary";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    return json({ data: await workspaceSummary(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
