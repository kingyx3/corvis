import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { exportObjectKey, redeemPhysicalExportGrant } from "@/lib/server/physical-exports";
import { gcs } from "@/lib/server/gcs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function extension(format: "csv" | "xlsx" | "parquet"): string {
  return format;
}

export async function GET(request: Request, context: { params: Promise<{ exportId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const { exportId } = await context.params;
    if (!UUID.test(exportId)) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const grant = new URL(request.url).searchParams.get("grant") ?? "";
    const delivery = await redeemPhysicalExportGrant(identity, exportId, grant);
    if (!delivery) return json({ error: "not_found", correlationId: id }, { status: 404 });
    // Streamed from GCS: an export can be large, and buffering it here doubled its memory cost (#231).
    const object = await gcs().getObjectStream(exportObjectKey(delivery.objectUri));
    if (!object) return json({ error: "not_found", correlationId: id }, { status: 404 });
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": object.contentType ?? "application/octet-stream",
        ...(object.contentLength ? { "content-length": object.contentLength } : {}),
        "content-disposition": `attachment; filename="corvis-export-${exportId}.${extension(delivery.format)}"`,
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
        "x-corvis-checksum-sha256": delivery.checksumSha256,
        "x-correlation-id": id,
      },
    });
  } catch (error) {
    return apiError(error, id);
  }
}
