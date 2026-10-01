import { resolveAdminRequestIdentity } from "@/lib/server/admin-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { decodeCursor, paginate, parseLimit } from "@/lib/server/pagination";
import { listWebhookDeliveries } from "@/lib/server/webhook-subscriptions";

/** Customer-visible delivery diagnostics for one subscription. Always paginated; there is no pre-existing unpaginated caller to preserve. */
export async function GET(request: Request, context: { params: Promise<{ webhookId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    const { webhookId } = await context.params;
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    // Keyset page in SQL: fetch one row beyond the page so paginate() knows whether another page exists.
    const rows = await listWebhookDeliveries(identity, webhookId, undefined, {
      afterDeliveryId: cursor ? decodeCursor(cursor) : null,
      limit: limit + 1,
    });
    const page = paginate(rows, (delivery) => delivery.deliveryId, limit, cursor);
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
