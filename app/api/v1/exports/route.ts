import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { assertFeatureEnabled } from "@/lib/server/feature-flags";
import { withIdempotency } from "@/lib/server/idempotency";
import { apiError, correlationId, json } from "@/lib/server/http";
import { createPhysicalExport } from "@/lib/server/physical-exports";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const body = await request.json() as { format?: "parquet" | "csv" | "xlsx"; idempotencyKey?: string };
    const format = body.format;
    if (!format || !["parquet","csv","xlsx"].includes(format)) return json({ error: "invalid_export_format", correlationId: id }, { status: 400 });
    if (format === "parquet") await assertFeatureEnabled(identity, "exports.parquet_delivery", "export");
    const clientKey = body.idempotencyKey || request.headers.get("idempotency-key") || undefined;
    const { status, body: data } = await withIdempotency(identity, "exports.create", clientKey, async () => ({
      status: 202,
      body: await createPhysicalExport(identity, format),
    }));
    return json({ data, correlationId: id }, { status });
  } catch (error) { return apiError(error, id); }
}
