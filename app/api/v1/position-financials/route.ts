import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { positionFinancialStatements, type StatementPeriodicity } from "@/lib/server/position-financial-statements";

const PERIODICITIES = new Set<StatementPeriodicity>(["reported","quarterly","annual"]);

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity,"observations:read");
    const url = new URL(request.url);
    const requestedPeriodicity = url.searchParams.get("periodicity") ?? "reported";
    if (!PERIODICITIES.has(requestedPeriodicity as StatementPeriodicity)) {
      return json({ error: "periodicity must be reported, quarterly or annual", correlationId: id }, { status: 400 });
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? "5000");
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 5000) {
      return json({ error: "limit must be an integer between 1 and 5000", correlationId: id }, { status: 400 });
    }
    const data = await positionFinancialStatements().list(identity,{
      fundId: url.searchParams.get("fundId") || undefined,
      holdingId: url.searchParams.get("holdingId") || undefined,
      companyId: url.searchParams.get("companyId") || undefined,
      statementType: url.searchParams.get("statementType") || "income_statement",
      periodicity: requestedPeriodicity as StatementPeriodicity,
      limit: rawLimit,
    });
    return json({ data, nextCursor: null, correlationId: id });
  } catch (error) { return apiError(error,id); }
}
