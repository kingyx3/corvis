import { randomUUID } from "crypto";
import { readJsonObject, resolveAdminRequestIdentity } from "@/lib/server/admin-request";
import { runAuditedMutation } from "@/lib/server/audited-mutation";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres } from "@/lib/server/postgres";
import { listTransportDeadLetters, requeueTransportDeadLetter, type TransportRequeueResult } from "@/lib/server/processing-transport-recovery";

/**
 * Processing outbox events the transport dead-lettered (#230). GET lists them for the tenant;
 * POST { eventId, reason } requeues one after the cause is fixed, audited in the same transaction.
 * Tenant-admin only: a requeue re-drives document processing for the whole tenant.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    const config = getServerConfig();
    const data = config.demoMode ? [] : await listTransportDeadLetters(identity, postgres(config.postgresDsn));
    return json({ data, correlationId: id });
  } catch (error) { return apiError(error, id); }
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!eventId || reason.length < 3 || reason.length > 1000) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const result = await runAuditedMutation<TransportRequeueResult>({
      mutate: (db) => db ? requeueTransportDeadLetter(identity, eventId, db) : Promise.resolve({ ok: false, reason: "not_dead_lettered" }),
      audit: (outcome) => outcome.ok ? {
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        actorSubject: identity.subject,
        sessionId: identity.sessionId,
        action: "processing_transport.requeue_dead_letter",
        targetType: "outbox_event",
        targetId: outcome.event.eventId,
        outcome: "success",
        correlationId: id,
        metadata: { eventType: outcome.event.eventType, aggregateId: outcome.event.aggregateId, attempts: outcome.event.attempts, deadLetteredAt: outcome.event.deadLetteredAt, reason },
      } : undefined,
    });
    if (!result.ok) {
      return result.reason === "invalid_event_id"
        ? json({ error: "invalid_request", correlationId: id }, { status: 400 })
        : json({ error: "event_not_dead_lettered", correlationId: id }, { status: 409 });
    }
    return json({ data: { eventId: result.event.eventId, state: "queued" }, correlationId: id }, { status: 202 });
  } catch (error) { return apiError(error, id); }
}
