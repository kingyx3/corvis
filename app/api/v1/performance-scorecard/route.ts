import { assertPermission } from "@/core/enterprise";
import { buildScorecard, parseScorecardFilters, ScorecardFilterError, type ScorecardPage } from "@/core/performance-scorecard";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { parseLimit } from "@/lib/server/pagination";
import { performanceScorecard, SCORECARD_DEFAULT_PAGE_FUNDS, ScorecardTooLargeError } from "@/lib/server/performance-scorecard";
import { demoScorecardPage } from "@/lib/server/performance-scorecard-demo-page";

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
    // Demo mode has no Postgres to query; it serves a synthetic dataset whose ids match adapters/demo/catalog.ts.
    const page = getServerConfig().demoMode ? demoScorecardPage(filters, pageRequest) : await performanceScorecard().loadPage(identity, filters, pageRequest);
    const data: ScorecardPage = { ...buildScorecard(page.payload), filters, fundOptions: page.fundOptions, periodOptions: page.periodOptions };
    return json({ data, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) {
    if (error instanceof ScorecardFilterError) return json({ error: error.code, correlationId: id }, { status: error.status });
    if (error instanceof ScorecardTooLargeError) return json({ error: error.code, correlationId: id }, { status: 413 });
    return apiError(error, id);
  }
}
