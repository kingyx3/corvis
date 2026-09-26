import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    return json({ data: identity.workspaceMemberships ?? [], correlationId: id });
  } catch (error) { return apiError(error, id); }
}
