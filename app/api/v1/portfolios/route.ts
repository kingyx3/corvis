import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { clientPortfolioAttribution } from "@/lib/server/client-portfolio-attribution";
import { assertFeatureEnabled, PORTFOLIO_ATTRIBUTION_FLAG } from "@/lib/server/feature-flags";
import { apiError, correlationId, json } from "@/lib/server/http";
import { keysetPage, paginate, parseLimit } from "@/lib/server/pagination";

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
