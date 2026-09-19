import { assertPermission } from "@/core/enterprise";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const bindings = await platform().readiness();
    const productionReady = Object.values(bindings).every((value) => value === "configured");
    return json({ data: { productionReady, bindings, checkedAt: new Date().toISOString() }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
