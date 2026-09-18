import { assertPermission } from "@/core/enterprise";
import { platform } from "@/lib/server/platform";
import { resolveRequestIdentity } from "@/lib/server/request-context";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "observations:read");
    return json({ data: await platform().listSnapshots(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
