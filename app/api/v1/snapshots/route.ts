import type { FundSnapshot } from "@/core/contracts";
import { assertPermission } from "@/core/enterprise";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { paginate, paginationRequested, parseLimit } from "@/lib/server/pagination";

// A snapshot's own id is optional (not every composition assigns one), so pagination sorts on a
// composite key that is always present and stable within one fund/period/version.
function snapshotSortKey(snapshot: FundSnapshot): string {
  return snapshot.id ?? `${snapshot.fund}\u0000${snapshot.period}\u0000${snapshot.version ?? 0}`;
}

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const url = new URL(request.url);
    const all = await platform().listSnapshots(identity);
    if (!paginationRequested(url.searchParams)) return json({ data: all, nextCursor: null, correlationId: id });
    const limit = parseLimit(url.searchParams.get("limit"));
    all.sort((a, b) => (snapshotSortKey(a) < snapshotSortKey(b) ? -1 : 1));
    const page = paginate(all, snapshotSortKey, limit, url.searchParams.get("cursor"));
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
