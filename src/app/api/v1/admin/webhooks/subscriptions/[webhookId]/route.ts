import { randomUUID } from "crypto";
import { resolveAdminRequestIdentity } from "@/platform/http/admin-request";
import { runAuditedMutation } from "@/modules/governance/server/audited-mutation";
import { apiError, correlationId, json } from "@/platform/http/http";
import { assertWebhookId, webhookSubscriptionTransition } from "@/modules/delivery/server/webhook-subscriptions";

export async function PATCH(request: Request, context: { params: Promise<{ webhookId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
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
