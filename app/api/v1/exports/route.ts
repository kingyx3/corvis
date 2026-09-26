import { assertPermission } from "@/core/enterprise";
import type { ExportScope } from "@/core/delivery";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { assertFeatureEnabled } from "@/lib/server/feature-flags";
import { withIdempotency } from "@/lib/server/idempotency";
import { apiError, correlationId, json } from "@/lib/server/http";
import { createPhysicalExport } from "@/lib/server/physical-exports";
import { listPhysicalExportStatuses } from "@/lib/server/export-history";

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exportScope(value: unknown): ExportScope | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (nonEmptyString(candidate.snapshotId)) return { snapshotId: candidate.snapshotId };
  const raw = candidate.positionFinancials;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const position = raw as Record<string, unknown>;
  if (!nonEmptyString(position.fundId) || !nonEmptyString(position.holdingId) || !nonEmptyString(position.companyId)) return null;
  if (position.periodicity !== "reported" && position.periodicity !== "quarterly" && position.periodicity !== "annual") return null;
  if (position.portfolioId !== undefined && !nonEmptyString(position.portfolioId)) return null;
  return {
    positionFinancials: {
      fundId: position.fundId,
      holdingId: position.holdingId,
      companyId: position.companyId,
      periodicity: position.periodicity,
      ...(position.portfolioId ? { portfolioId: position.portfolioId } : {}),
    },
  };
}

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const url = new URL(request.url);
    const parsed = Number(url.searchParams.get("limit") || 20);
    const limit = Number.isFinite(parsed) ? parsed : 20;
    return json({ data: await listPhysicalExportStatuses(identity, limit), correlationId: id });
  } catch (error) { return apiError(error, id); }
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const parsed: unknown = await request.json();
    // A JSON `null`, array or scalar body is valid JSON but not a request object; reject it instead of throwing a TypeError (500).
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const body = parsed as { format?: "parquet" | "csv" | "xlsx"; scope?: unknown; source?: unknown; idempotencyKey?: string };
    const format = body.format;
    if (!format || !["parquet","csv","xlsx"].includes(format)) return json({ error: "invalid_export_format", correlationId: id }, { status: 400 });
    const scope = exportScope(body.scope);
    if (scope === null) return json({ error: "invalid_export_scope", correlationId: id }, { status: 400 });
    if (body.source !== undefined && body.source !== "delivery" && body.source !== "review") {
      return json({ error: "invalid_export_source", correlationId: id }, { status: 400 });
    }
    const source = body.source as "delivery" | "review" | undefined;
    if (format === "parquet") await assertFeatureEnabled(identity, "exports.parquet_delivery", "export");
    const clientKey = body.idempotencyKey || request.headers.get("idempotency-key") || undefined;
    const { status, body: data } = await withIdempotency(identity, "exports.create", clientKey, async () => ({
      status: 202,
      body: await createPhysicalExport(identity, format, { scope, source }),
    }));
    return json({ data, correlationId: id }, { status });
  } catch (error) { return apiError(error, id); }
}
