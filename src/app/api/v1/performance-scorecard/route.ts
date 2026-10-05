import { assertPermission } from "@/shared/domain/enterprise";
import { buildScorecard, parseScorecardFilters, ScorecardFilterError, type ScorecardPage } from "@/modules/analytics/domain/performance-scorecard";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/authorized-request";
import { getServerConfig } from "@/platform/config";
import { apiError, correlationId, json } from "@/platform/http/http";
import { parseLimit } from "@/platform/http/pagination";
import { performanceScorecard, SCORECARD_DEFAULT_PAGE_FUNDS, ScorecardTooLargeError } from "@/modules/analytics/server/performance-scorecard";
import { demoScorecardPage } from "@/modules/analytics/server/performance-scorecard-demo-page";

/**
 * GP-reported performance scorecard (F1): the latest published value of each fund-level metric for every
 * entitled fund and of each investment-level metric for its underlying investments, each with its as-of date,
 * Final/Preliminary/Restated flag and source document. Figures are served as reported; nothing is computed,
 * summed across funds or currencies, or converted.
 *
 * F1c: `fundId` and `period` narrow it (the same filters narrow the governed export); funds are served in keyset pages
 * (`limit`, `cursor`, `nextCursor`), each fund whole, so a tenant above the figure cap still loads. The first page
 * (no `cursor`) also carries the reporting periods that can be filtered by.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const params = new URL(request.url).searchParams;
    const filters = parseScorecardFilters({ fundId: params.get("fundId") ?? undefined, period: params.get("period") ?? undefined });
    const cursor = params.get("cursor");
    const pageRequest = { cursor, limit: parseLimit(params.get("limit"), SCORECARD_DEFAULT_PAGE_FUNDS), periods: !cursor };
    // Demo mode has no Postgres to query; it serves a synthetic dataset whose ids match src/platform/demo/catalog.ts.
    const page = getServerConfig().demoMode ? demoScorecardPage(filters, pageRequest) : await performanceScorecard().loadPage(identity, filters, pageRequest);
    const data: ScorecardPage = { ...buildScorecard(page.payload), filters, fundOptions: page.fundOptions, periodOptions: page.periodOptions };
    return json({ data, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) {
    if (error instanceof ScorecardFilterError) return json({ error: error.code, correlationId: id }, { status: error.status });
    if (error instanceof ScorecardTooLargeError) return json({ error: error.code, correlationId: id }, { status: 413 });
    return apiError(error, id);
  }
}
