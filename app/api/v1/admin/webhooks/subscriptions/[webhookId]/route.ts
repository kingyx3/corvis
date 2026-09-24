import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { runAuditedMutation } from "@/lib/server/audited-mutation";
import { apiError, correlationId, json } from "@/lib/server/http";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { assertWebhookId, webhookSubscriptionTransition } from "@/lib/server/webhook-subscriptions";

export async function PATCH(request: Request, context: { params: Promise<{ webhookId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { webhookId } = await context.params;
    assertWebhookId(webhookId);
    const body = await request.json() as { action?: unknown } | null;
    const transition = webhookSubscriptionTransition(body?.action);
    if (!transition) return json({ error: "invalid_request", correlationId: id }, { status: 400 });

    const data = await runAuditedMutation({
      mutate: (db) => transition(identity, webhookId, db),
      audit: () => ({
        id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
        actorSubject: identity.subject, sessionId: identity.sessionId, action: `webhook_subscription.${String(body?.action)}`,
        targetType: "webhook_subscription", targetId: webhookId, outcome: "success", correlationId: id,
      }),
    });
    return json({ data, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
