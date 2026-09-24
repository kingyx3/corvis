import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { runAuditedMutation } from "@/lib/server/audited-mutation";
import { apiError, correlationId, json } from "@/lib/server/http";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { rotateWebhookSigningKey } from "@/lib/server/webhook-subscriptions";

/**
 * Retires the current active signing key and activates a freshly generated
 * one. The new secret is returned exactly once, in this response.
 */
export async function POST(request: Request, context: { params: Promise<{ webhookId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
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
