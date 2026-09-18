import { assertPermission } from "@/core/enterprise";
import { platform } from "@/lib/server/platform";
import { resolveRequestIdentity } from "@/lib/server/request-context";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const bindings = await platform().readiness();
    const productionReady = Object.values(bindings).every((value) => value === "configured");
    return json({ data: { productionReady, bindings, checkedAt: new Date().toISOString() }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
