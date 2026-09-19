import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { createWebhookSubscription, listWebhookSubscriptions } from "@/lib/server/webhook-subscriptions";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const data = await listWebhookSubscriptions(identity);
    return json({ data, correlationId: id });
  } catch (error) { return apiError(error, id); }
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const body = await request.json() as { endpointUrl?: string; eventTypes?: string[] };
    const created = await createWebhookSubscription(identity, { endpointUrl: body.endpointUrl ?? "", eventTypes: body.eventTypes ?? [] });
    await platform().audit({
      id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
      actorSubject: identity.subject, sessionId: identity.sessionId, action: "webhook_subscription.create",
      targetType: "webhook_subscription", targetId: created.webhookId, outcome: "success", correlationId: id,
      metadata: { endpointUrl: created.endpointUrl, eventTypes: created.eventTypes.join(",") },
    });
    // The signing secret is returned exactly once, on creation, and is never re-readable afterward.
    return json({ data: created, correlationId: id }, { status: 201 });
  } catch (error) { return apiError(error, id); }
}
