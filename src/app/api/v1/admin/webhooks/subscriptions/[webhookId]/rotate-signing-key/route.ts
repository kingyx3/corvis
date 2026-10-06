import { randomUUID } from "crypto";
import { resolveAdminRequestIdentity } from "@/modules/identity-access/server/request/admin-request";
import { runAuditedMutation } from "@/modules/governance/server/evidence/audited-mutation";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { rotateWebhookSigningKey } from "@/modules/delivery/server/webhooks/webhook-subscriptions";

/**
 * Retires the current active signing key and activates a freshly generated
 * one. The new secret is returned exactly once, in this response.
 */
export async function POST(request: Request, context: { params: Promise<{ webhookId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    const { webhookId } = await context.params;
    const rotated = await runAuditedMutation({
      mutate: (db) => rotateWebhookSigningKey(identity, webhookId, db),
      audit: (result) => ({
        id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
        actorSubject: identity.subject, sessionId: identity.sessionId, action: "webhook_subscription.rotate_signing_key",
        targetType: "webhook_subscription", targetId: webhookId, outcome: "success", correlationId: id,
        metadata: { signingKeyId: result.signingKeyId },
      }),
    });
    return json({ data: rotated, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
