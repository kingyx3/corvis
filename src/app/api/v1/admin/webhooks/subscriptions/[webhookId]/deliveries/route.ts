import { resolveAdminRequestIdentity } from "@/modules/identity-access/server/request/admin-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { parseLimit } from "@/platform/http/api/pagination";
import { listWebhookDeliveries } from "@/modules/delivery/server/webhooks/webhook-subscriptions";

/**
 * Customer-visible delivery diagnostics for one subscription, newest first (created_at desc, delivery_id desc).
 * Always paginated; there is no pre-existing unpaginated caller to preserve. Unlike the id-ordered collections this
 * one does not go through `paginate()`, which re-sorts ascending by a single key: the repository owns the
 * composite (created_at, delivery_id) keyset cursor and returns the page with its `nextCursor`. A cursor that does
 * not decode to that composite position (including one issued before the ordering changed) is `invalid_cursor` (400).
 */
export async function GET(request: Request, context: { params: Promise<{ webhookId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    const { webhookId } = await context.params;
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const page = await listWebhookDeliveries(identity, webhookId, undefined, {
      cursor: url.searchParams.get("cursor"),
      limit,
    });
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
