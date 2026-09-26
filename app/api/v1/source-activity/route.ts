import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { listSourceActivity } from "@/lib/server/source-lifecycle";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    return json({ data: await listSourceActivity(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
