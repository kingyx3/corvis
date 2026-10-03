import { assertPermission } from "@/core/enterprise";
import { buildScorecard } from "@/core/performance-scorecard";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { performanceScorecard } from "@/lib/server/performance-scorecard";
import { demoPerformanceScorecard } from "@/lib/server/performance-scorecard-demo";

/**
 * GP-reported performance scorecard (F1): the latest published value of each fund-level metric for every
 * entitled fund and of each investment-level metric for its underlying investments, each with its as-of date,
 * Final/Preliminary/Restated flag and source document. Figures are served as reported; nothing is computed,
 * summed across funds or currencies, or converted.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    // Demo mode has no Postgres to query; it serves a synthetic dataset whose ids match adapters/demo/catalog.ts.
    const payload = getServerConfig().demoMode ? demoPerformanceScorecard() : await performanceScorecard().load(identity);
    return json({ data: buildScorecard(payload), nextCursor: null, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
