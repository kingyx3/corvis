import type { ProcessingStage } from "@/core/enterprise";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

export type ProcessingStageDelivery = {
  tenantId: string;
  consumerName: string;
  eventId: string;
  eventType: string;
  documentId: string;
  jobId: string;
  expectedStage: ProcessingStage;
  payload: Record<string, unknown>;
  payloadSha256: string;
  maxAttempts?: number;
  leaseSeconds?: number;
};

export type ProcessingStageClaim = {
  claimed: boolean;
  duplicateComplete: boolean;
  leaseToken?: string;
  attempt: number;
  inboxState: "received" | "processing" | "retryable" | "complete" | "failed";
  jobVersion: number;
  jobState: string;
};

export type ProcessingStageCompletion = {
  completed: boolean;
  completedJobVersion: number;
  nextJobId?: string;
  nextStage?: ProcessingStage;
};

export type ProcessingStageBlock = {
  blocked: boolean;
  jobVersion: number;
};

export type ProcessingStageFailure = {
  nextState: "retryable" | "dead_letter";
  jobVersion: number;
  inboxAttempt: number;
  nextAttemptAt?: string;
};

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function inboxState(row: PostgresRow): ProcessingStageClaim["inboxState"] {
  const value = String(row.inbox_state ?? "failed");
  return ["received", "processing", "retryable", "complete", "failed"].includes(value)
    ? value as ProcessingStageClaim["inboxState"]
    : "failed";
}

export class PostgresProcessingStageRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async claim(delivery: ProcessingStageDelivery): Promise<ProcessingStageClaim> {
    const rows = await this.db.query(`select * from corvis_control.claim_processing_stage_delivery(
      $1::uuid,$2,$3::uuid,$4,$5::uuid,$6,$7,$8::jsonb,$9,$10,$11)`, [
      delivery.tenantId,
      delivery.consumerName,
      delivery.eventId,
      delivery.eventType,
      delivery.documentId,
      delivery.jobId,
      delivery.expectedStage,
      JSON.stringify(delivery.payload),
      delivery.payloadSha256,
      delivery.maxAttempts ?? 5,
      delivery.leaseSeconds ?? 300,
    ]);
    const row = rows[0] ?? {};
    return {
      claimed: bool(row.claimed),
      duplicateComplete: bool(row.duplicate_complete),
      leaseToken: row.claim_lease_token == null ? undefined : String(row.claim_lease_token),
      attempt: number(row.claim_attempt),
      inboxState: inboxState(row),
      jobVersion: number(row.job_version),
      jobState: String(row.job_state ?? "missing"),
    };
  }

  async complete(input: {
    tenantId: string;
    consumerName: string;
    eventId: string;
    leaseToken: string;
    jobId: string;
  }): Promise<ProcessingStageCompletion | undefined> {
    const rows = await this.db.query(`select * from corvis_control.complete_processing_stage_delivery(
      $1::uuid,$2,$3::uuid,$4::uuid,$5)`, [
      input.tenantId,input.consumerName,input.eventId,input.leaseToken,input.jobId,
    ]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      completed: bool(row.completed),
      completedJobVersion: number(row.completed_job_version),
      nextJobId: row.next_job_id == null ? undefined : String(row.next_job_id),
      nextStage: row.next_stage == null ? undefined : String(row.next_stage) as ProcessingStage,
    };
  }

  async block(input: {
    tenantId: string;
    consumerName: string;
    eventId: string;
    leaseToken: string;
    jobId: string;
    reason: string;
  }): Promise<ProcessingStageBlock | undefined> {
    const rows = await this.db.query(`select * from corvis_control.block_processing_stage_delivery(
      $1::uuid,$2,$3::uuid,$4::uuid,$5,$6)`, [
      input.tenantId,input.consumerName,input.eventId,input.leaseToken,input.jobId,input.reason.slice(0,500),
    ]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      blocked: bool(row.blocked),
      jobVersion: number(row.job_version),
    };
  }

  async fail(input: {
    tenantId: string;
    consumerName: string;
    eventId: string;
    leaseToken: string;
    jobId: string;
    error: string;
  }): Promise<ProcessingStageFailure | undefined> {
    const rows = await this.db.query(`select * from corvis_control.fail_processing_stage_delivery(
      $1::uuid,$2,$3::uuid,$4::uuid,$5,$6)`, [
      input.tenantId,input.consumerName,input.eventId,input.leaseToken,input.jobId,input.error.slice(0,2000),
    ]);
    const row = rows[0];
    if (!row) return undefined;
    const nextState = String(row.next_state);
    if (nextState !== "retryable" && nextState !== "dead_letter") return undefined;
    return {
      nextState,
      jobVersion: number(row.job_version),
      inboxAttempt: number(row.inbox_attempt),
      nextAttemptAt: row.next_attempt_at == null ? undefined : String(row.next_attempt_at),
    };
  }
}
