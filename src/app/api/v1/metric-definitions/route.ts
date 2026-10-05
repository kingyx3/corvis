import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/identity/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { keysetPage, paginate, parseLimit } from "@/platform/http/api/pagination";
import { publicServingResources } from "@/platform/data/public-serving-resources";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    // Keyset page in SQL (limit + 1 rows after the cursor key) instead of loading the whole entitled set.
    const rows = await publicServingResources().metricDefinitions(keysetPage(cursor, limit));
    const page = paginate(rows, (row) => `${row.metricCode}:${row.definitionVersion}`, limit, cursor);
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
