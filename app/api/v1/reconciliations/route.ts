import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { paginate, parseLimit } from "@/lib/server/pagination";
import { reconciliationServing } from "@/lib/server/reconciliation-serving";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const url = new URL(request.url);
    const rows = await reconciliationServing().list(identity);
    const page = paginate(rows, (row) => row.id, parseLimit(url.searchParams.get("limit")), url.searchParams.get("cursor"));
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
