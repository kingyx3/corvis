import { assertPermission } from "@/core/enterprise";
import { platform, snapshotPaginationKey } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { keysetPage, paginate, paginationRequested, parseLimit } from "@/lib/server/pagination";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const url = new URL(request.url);
    if (!paginationRequested(url.searchParams)) {
      const all = await platform().listSnapshots(identity);
      return json({ data: all, nextCursor: null, correlationId: id });
    }
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    // Keyset page pushed down to storage (limit + 1 rows after the cursor key), so rows past
    // any fetch cap stay reachable; paginate() still derives the page and nextCursor.
    const rows = await platform().listSnapshots(identity, keysetPage(cursor, limit));
    const page = paginate(rows, snapshotPaginationKey, limit, cursor);
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
