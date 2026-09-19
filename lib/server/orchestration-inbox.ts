import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

export type EventDeliveryEnvelope = {
  tenantId: string;
  consumerName: string;
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  payloadSha256: string;
  maxAttempts?: number;
  leaseSeconds?: number;
};

export type EventDeliveryClaim = {
  claimed: boolean;
  duplicateComplete: boolean;
  leaseToken?: string;
  attempt: number;
  state: "received" | "processing" | "retryable" | "complete" | "failed";
};

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function state(row: PostgresRow): EventDeliveryClaim["state"] {
  const value = String(row.claim_state ?? "failed");
  if (["received", "processing", "retryable", "complete", "failed"].includes(value)) {
    return value as EventDeliveryClaim["state"];
  }
  return "failed";
}

export class PostgresEventInboxRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async claim(envelope: EventDeliveryEnvelope): Promise<EventDeliveryClaim> {
    const rows = await this.db.query(`select * from corvis_control.claim_event_delivery(
      $1::uuid,$2,$3::uuid,$4,$5,$6,$7::jsonb,$8,$9,$10)`, [
      envelope.tenantId,
      envelope.consumerName,
      envelope.eventId,
      envelope.eventType,
      envelope.aggregateType,
      envelope.aggregateId,
      JSON.stringify(envelope.payload),
      envelope.payloadSha256,
      envelope.maxAttempts ?? 5,
      envelope.leaseSeconds ?? 300,
    ]);
    const row = rows[0] ?? {};
    return {
      claimed: bool(row.claimed),
      duplicateComplete: bool(row.duplicate_complete),
      leaseToken: row.claim_lease_token == null ? undefined : String(row.claim_lease_token),
      attempt: number(row.claim_attempt),
      state: state(row),
    };
  }

  async complete(tenantId: string, consumerName: string, eventId: string, leaseToken: string): Promise<boolean> {
    const rows = await this.db.query(`select corvis_control.complete_event_delivery(
      $1::uuid,$2,$3::uuid,$4::uuid) as completed`, [tenantId, consumerName, eventId, leaseToken]);
    return bool(rows[0]?.completed);
  }

  async fail(tenantId: string, consumerName: string, eventId: string, leaseToken: string, error: string): Promise<"retryable" | "failed" | undefined> {
    const rows = await this.db.query(`select corvis_control.fail_event_delivery(
      $1::uuid,$2,$3::uuid,$4::uuid,$5) as next_state`, [tenantId, consumerName, eventId, leaseToken, error.slice(0, 2000)]);
    const next = rows[0]?.next_state;
    return next === "retryable" || next === "failed" ? next : undefined;
  }
}
