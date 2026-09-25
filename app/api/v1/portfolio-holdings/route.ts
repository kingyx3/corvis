import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { clientPortfolioAttribution } from "@/lib/server/client-portfolio-attribution";
import { apiError, correlationId, json } from "@/lib/server/http";
import { keysetPage, paginate, parseLimit } from "@/lib/server/pagination";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity,"observations:read");
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    const rows = await clientPortfolioAttribution().holdings(identity,{
      portfolioId: url.searchParams.get("portfolioId") || undefined,
      companyId: url.searchParams.get("companyId") || undefined,
    },keysetPage(cursor,limit));
    const page = paginate(rows,(row) => row.id,limit,cursor);
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return apiError(error,id); }
}
