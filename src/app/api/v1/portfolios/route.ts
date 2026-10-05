import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/authorized-request";
import { clientPortfolioAttribution } from "@/modules/analytics/server/client-portfolio-attribution";
import { assertFeatureEnabled, PORTFOLIO_ATTRIBUTION_FLAG } from "@/modules/admin/server/feature-flags";
import { apiError, correlationId, json } from "@/platform/http/http";
import { keysetPage, paginate, parseLimit } from "@/platform/http/pagination";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity,"observations:read");
    await assertFeatureEnabled(identity,PORTFOLIO_ATTRIBUTION_FLAG,"customer_api");
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    const rows = await clientPortfolioAttribution().portfolios(identity,keysetPage(cursor,limit));
    const page = paginate(rows,(row) => row.id,limit,cursor);
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return apiError(error,id); }
}
