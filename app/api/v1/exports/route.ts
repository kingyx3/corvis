import { assertPermission } from "@/core/enterprise";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { assertFeatureEnabled } from "@/lib/server/feature-flags";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const body = await request.json() as { format?: "parquet" | "csv" | "xlsx" };
    const format = body.format;
    if (!format || !["parquet","csv","xlsx"].includes(format)) return json({ error: "invalid_export_format", correlationId: id }, { status: 400 });
    // Real emergency-kill-switch enforcement for the registered
    // "exports.parquet_delivery" flag, not just the governance API that
    // reads/writes its rollout state (issue #10).
    if (format === "parquet") await assertFeatureEnabled(identity, "exports.parquet_delivery", "export");
    const data = await platform().export(identity, format);
    return json({ data, correlationId: id }, { status: 202 });
  } catch (error) { return apiError(error, id); }
}
