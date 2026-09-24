import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { runAuditedMutation } from "@/lib/server/audited-mutation";
import { apiError, correlationId, json } from "@/lib/server/http";
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
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const body = parsed as { endpointUrl?: string; eventTypes?: string[] };
    const input = { endpointUrl: body.endpointUrl ?? "", eventTypes: body.eventTypes ?? [] };
    const created = await runAuditedMutation({
      mutate: (db) => createWebhookSubscription(identity, input, db),
      audit: (result) => ({
        id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
        actorSubject: identity.subject, sessionId: identity.sessionId, action: "webhook_subscription.create",
        targetType: "webhook_subscription", targetId: result.webhookId, outcome: "success", correlationId: id,
        metadata: { endpointUrl: result.endpointUrl, eventTypes: result.eventTypes.join(",") },
      }),
    });
    return json({ data: created, correlationId: id }, { status: 201 });
  } catch (error) { return apiError(error, id); }
}
