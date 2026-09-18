import { assertPermission } from "@/core/enterprise";
import { platform } from "@/lib/server/platform";
import { resolveRequestIdentity } from "@/lib/server/request-context";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const body = await request.json() as { format?: "parquet" | "csv" | "xlsx" };
    const format = body.format;
    if (!format || !["parquet","csv","xlsx"].includes(format)) return json({ error: "invalid_export_format", correlationId: id }, { status: 400 });
    const data = await platform().export(identity, format);
    return json({ data, correlationId: id }, { status: 202 });
  } catch (error) { return apiError(error, id); }
}
