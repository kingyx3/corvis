import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { keysetPage, paginate, parseLimit } from "@/lib/server/pagination";
import { publicServingResources } from "@/lib/server/public-serving-resources";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    // Keyset page in SQL (limit + 1 rows after the cursor key) instead of loading the whole entitled set.
    const rows = await publicServingResources().companyLifecycleEvents(identity, keysetPage(cursor, limit));
    const page = paginate(rows, (row) => row.id, limit, cursor);
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
