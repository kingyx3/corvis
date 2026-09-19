import { assertPermission } from "@/core/enterprise";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { assertFeatureEnabled } from "@/lib/server/feature-flags";
import { withIdempotency } from "@/lib/server/idempotency";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const body = await request.json() as { format?: "parquet" | "csv" | "xlsx"; idempotencyKey?: string };
    const format = body.format;
    if (!format || !["parquet","csv","xlsx"].includes(format)) return json({ error: "invalid_export_format", correlationId: id }, { status: 400 });
    // Real emergency-kill-switch enforcement for the registered
    // "exports.parquet_delivery" flag, not just the governance API that
    // reads/writes its rollout state (issue #10).
    if (format === "parquet") await assertFeatureEnabled(identity, "exports.parquet_delivery", "export");
    // Idempotency-Key convention (issue #11), matching the uploads routes:
    // a retried request carrying the same key returns the original export
    // job instead of enqueueing a duplicate. Omitting the key behaves
    // exactly as before.
    const clientKey = body.idempotencyKey || request.headers.get("idempotency-key") || undefined;
    const { status, body: data } = await withIdempotency(identity, "exports.create", clientKey, async () => ({
      status: 202,
      body: await platform().export(identity, format),
    }));
    return json({ data, correlationId: id }, { status });
  } catch (error) { return apiError(error, id); }
}
