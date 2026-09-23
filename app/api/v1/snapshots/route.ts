import { assertPermission } from "@/core/enterprise";
import { platform, snapshotPaginationKey } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { paginate, paginationRequested, parseLimit } from "@/lib/server/pagination";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const url = new URL(request.url);
    const all = await platform().listSnapshots(identity);
    if (!paginationRequested(url.searchParams)) return json({ data: all, nextCursor: null, correlationId: id });
    const limit = parseLimit(url.searchParams.get("limit"));
    const page = paginate(all, snapshotPaginationKey, limit, url.searchParams.get("cursor"));
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
