import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import type { PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";

/**
 * Operator view and requeue for processing outbox events the transport dead-lettered (#230).
 *
 * After TRANSPORT_MAX_ATTEMPTS failed publishes, `fail_processing_transport_event` (migration 021)
 * sets `transport_dead_lettered_at`, and the claim query never selects the event again, so its
 * document stays `registered`. Requeueing clears the dead-letter mark and the attempt count and
 * makes the event claimable immediately; it never touches an event that was already published,
 * so a duplicate requeue is a harmless no-op (`not_dead_lettered`).
 */
export type TransportDeadLetter = {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  deadLetteredAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deadLetter(row: PostgresRow): TransportDeadLetter {
  return {
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    attempts: Number(row.attempt_count ?? 0),
    lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    deadLetteredAt: String(row.transport_dead_lettered_at),
  };
}

export async function listTransportDeadLetters(identity: Pick<RequestIdentity, "tenantId">, db: PostgresSqlApi, limit = 100): Promise<TransportDeadLetter[]> {
  const rows = await db.query(
    `select event_id::text,event_type,aggregate_type,aggregate_id,attempt_count,last_error,created_at,transport_dead_lettered_at
       from corvis_control.outbox_event
      where tenant_id=$1::uuid and published_at is null and transport_dead_lettered_at is not null
      order by transport_dead_lettered_at desc, event_id
      limit $2::int`,
    [identity.tenantId, Math.min(Math.max(1, Math.trunc(limit)), 500)],
  );
  return rows.map(deadLetter);
}

export type TransportRequeueResult =
  | { ok: true; event: TransportDeadLetter }
  | { ok: false; reason: "invalid_event_id" | "not_dead_lettered" };

export async function requeueTransportDeadLetter(identity: Pick<RequestIdentity, "tenantId">, eventId: string, db: PostgresSqlApi): Promise<TransportRequeueResult> {
  if (!UUID.test(eventId)) return { ok: false, reason: "invalid_event_id" };
  const rows = await db.query(
    `update corvis_control.outbox_event o
        set transport_dead_lettered_at=null,attempt_count=0,next_attempt_at=now(),
            transport_lease_token=null,transport_lease_expires_at=null
       from (select event_id,transport_dead_lettered_at as dead_lettered_at,attempt_count as attempts
               from corvis_control.outbox_event
              where tenant_id=$1::uuid and event_id=$2::uuid and published_at is null and transport_dead_lettered_at is not null
              for update) previous
      where o.tenant_id=$1::uuid and o.event_id=previous.event_id
      returning o.event_id::text,o.event_type,o.aggregate_type,o.aggregate_id,previous.attempts as attempt_count,o.last_error,o.created_at,
                previous.dead_lettered_at as transport_dead_lettered_at`,
    [identity.tenantId, eventId],
  );
  return rows[0] ? { ok: true, event: deadLetter(rows[0]) } : { ok: false, reason: "not_dead_lettered" };
}
