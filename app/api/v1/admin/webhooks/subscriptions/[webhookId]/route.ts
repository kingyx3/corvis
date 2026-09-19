import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { pauseWebhookSubscription, resumeWebhookSubscription, revokeWebhookSubscription } from "@/lib/server/webhook-subscriptions";

const ACTIONS = { pause: pauseWebhookSubscription, resume: resumeWebhookSubscription, revoke: revokeWebhookSubscription } as const;

export async function PATCH(request: Request, context: { params: Promise<{ webhookId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { webhookId } = await context.params;
    const body = await request.json() as { action?: keyof typeof ACTIONS };
    const transition = body.action ? ACTIONS[body.action] : undefined;
    if (!transition) return json({ error: "invalid_request", correlationId: id }, { status: 400 });

    const data = await transition(identity, webhookId);
    await platform().audit({
      id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
      actorSubject: identity.subject, sessionId: identity.sessionId, action: `webhook_subscription.${body.action}`,
      targetType: "webhook_subscription", targetId: webhookId, outcome: "success", correlationId: id,
    });
    return json({ data, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
