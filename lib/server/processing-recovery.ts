import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export type DeadLetterRecoveryResult =
  | { ok: true; version: number; recoveryCount: number; recoveryEventId: string }
  | { ok: false; reason: "not_found_or_version_conflict" | "not_terminal_dead_letter" | "not_exhausted" | "missing_delivery_evidence" };

function controlDb(): PostgresSqlApi {
  return postgres(getServerConfig().postgresDsn);
}

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function number(row: PostgresRow, key: string): number {
  const parsed = Number(row[key]);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function recoverDeadLetterProcessingJob(input: {
  identity: RequestIdentity;
  jobId: string;
  expectedVersion: number;
  recoveryEventId: string;
  reasonCode: string;
  note?: string;
  db?: PostgresSqlApi;
}): Promise<DeadLetterRecoveryResult> {
  const db = input.db ?? controlDb();
  const rows = await db.query(`select state,attempt,max_attempts,version
    from corvis_control.processing_job
    where tenant_id=$1 and job_id=$2 limit 1`, [input.identity.tenantId,input.jobId]);
  const job = rows[0];
  if (!job || number(job,"version") !== input.expectedVersion) {
    return { ok:false, reason:"not_found_or_version_conflict" };
  }
  if (text(job,"state") !== "dead_letter") {
    return { ok:false, reason:"not_terminal_dead_letter" };
  }
  if (number(job,"attempt") < number(job,"max_attempts")) {
    return { ok:false, reason:"not_exhausted" };
  }

  try {
    const result = await db.query(`select * from corvis_control.recover_dead_letter_processing_job(
      $1::uuid,$2,$3,$4::uuid,$5,$6,$7
    )`, [
      input.identity.tenantId,
      input.jobId,
      input.expectedVersion,
      input.recoveryEventId,
      input.identity.subject,
      input.reasonCode,
      input.note ?? null,
    ]);
    const row = result[0];
    if (!row) return { ok:false, reason:"not_found_or_version_conflict" };
    return {
      ok:true,
      version:number(row,"new_version"),
      recoveryCount:number(row,"recovery_count"),
      recoveryEventId:text(row,"recovery_event_id"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("retained durable stage-delivery evidence")
      || message.includes("retained predecessor lineage evidence")) {
      return { ok:false, reason:"missing_delivery_evidence" };
    }
    if (message.includes("only terminal dead-letter jobs")) {
      return { ok:false, reason:"not_terminal_dead_letter" };
    }
    if (message.includes("requires an exhausted job")) {
      return { ok:false, reason:"not_exhausted" };
    }
    throw error;
  }
}
