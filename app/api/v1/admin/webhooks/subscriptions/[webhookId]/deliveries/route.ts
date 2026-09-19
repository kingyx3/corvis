import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { paginate, parseLimit } from "@/lib/server/pagination";
import { listWebhookDeliveries } from "@/lib/server/webhook-subscriptions";

/** Customer-visible delivery diagnostics for one subscription. Always paginated; there is no pre-existing unpaginated caller to preserve. */
export async function GET(request: Request, context: { params: Promise<{ webhookId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { webhookId } = await context.params;
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const all = await listWebhookDeliveries(identity, webhookId);
    const page = paginate(all, (delivery) => delivery.deliveryId, limit, url.searchParams.get("cursor"));
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
