import { resolveAdminRequestIdentity } from "@/lib/server/admin-request";
import { platform } from "@/lib/server/platform";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    await resolveAdminRequestIdentity(request);
    const bindings = await platform().readiness();
    const productionReady = Object.values(bindings).every((value) => value === "configured");
    return json({ data: { productionReady, bindings, checkedAt: new Date().toISOString() }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
