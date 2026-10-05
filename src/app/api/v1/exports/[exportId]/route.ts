import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { getPhysicalExportStatus } from "@/lib/server/physical-exports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ exportId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const { exportId } = await context.params;
    if (!UUID.test(exportId)) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const data = await getPhysicalExportStatus(identity, exportId);
    if (!data) return json({ error: "not_found", correlationId: id }, { status: 404 });
    return json({ data, correlationId: id });
  } catch (error) {
    return apiError(error, id);
  }
}
