import { assertPermission } from "@/core/enterprise";
import { assertFeatureEnabled, PORTFOLIO_ATTRIBUTION_FLAG } from "@/lib/server/feature-flags";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { demoPositionFinancialStatements } from "@/lib/server/position-financial-statements-demo";
import { positionFinancialStatements, type StatementPeriodicity } from "@/lib/server/position-financial-statements";

const PERIODICITIES = new Set<StatementPeriodicity>(["reported","quarterly","annual"]);

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity,"observations:read");
    const url = new URL(request.url);
    const portfolioId = url.searchParams.get("portfolioId") || undefined;
    // Fund/holding financials are a standalone base capability. Only the
    // optional portfolio-scoping path depends on the portfolio module.
    if (portfolioId) await assertFeatureEnabled(identity,PORTFOLIO_ATTRIBUTION_FLAG,"customer_api");
    const requestedPeriodicity = url.searchParams.get("periodicity") ?? "reported";
    if (!PERIODICITIES.has(requestedPeriodicity as StatementPeriodicity)) {
      return json({ error: "periodicity must be reported, quarterly or annual", correlationId: id }, { status: 400 });
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? "5000");
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 5000) {
      return json({ error: "limit must be an integer between 1 and 5000", correlationId: id }, { status: 400 });
    }
    const query = {
      portfolioId,
      fundId: url.searchParams.get("fundId") || undefined,
      holdingId: url.searchParams.get("holdingId") || undefined,
      companyId: url.searchParams.get("companyId") || undefined,
      statementType: url.searchParams.get("statementType") || "income_statement",
      periodicity: requestedPeriodicity as StatementPeriodicity,
      limit: rawLimit,
    };
    // Demo mode has no Postgres to query — serve the same synthetic dataset
    // adapters/demo/catalog.ts's observations link back to, so the axe-core
    // surface matrix and local dev actually exercise this page's real markup.
    const data = getServerConfig().demoMode ? demoPositionFinancialStatements(query) : await positionFinancialStatements().list(identity,query);
    return json({ data, nextCursor: null, correlationId: id });
  } catch (error) { return apiError(error,id); }
}
