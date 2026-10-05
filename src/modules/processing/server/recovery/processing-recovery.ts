import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { getServerConfig } from "../../../../platform/config/config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { sqlApplicationErrorOf } from "../../../../platform/database/sql-application-errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean { return UUID.test(value); }

export type DeadLetterRecoveryResult =
  | { ok: true; version: number; recoveryCount: number; recoveryEventId: string }
  | { ok: false; reason: "not_found_or_version_conflict" | "not_terminal_dead_letter" | "not_exhausted" | "missing_delivery_evidence" | "idempotency_conflict" };

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function number(row: PostgresRow, key: string): number {
  const parsed = Number(row[key]);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function recoverDeadLetterProcessingJob({ db = postgres(getServerConfig().databaseDsn), ...input }: {
  identity: RequestIdentity;
  jobId: string;
  expectedVersion: number;
  recoveryEventId: string;
  reasonCode: string;
  note?: string;
  db?: PostgresSqlApi;
}): Promise<DeadLetterRecoveryResult> {
  // job_id is a uuid column; a malformed id would otherwise reach Postgres as a cast failure (22P02) inside the
  // function call below, which has no apiError() mapping and surfaces as a 500 instead of a normal not-found 409.
  if (!isUuid(input.jobId)) return { ok:false, reason:"not_found_or_version_conflict" };
  try {
    // The database function checks an existing deterministic recovery event before
    // locking the expected job version. That ordering is deliberate: an exact repeat
    // of a successful idempotent command must return the original result even though
    // the first command already advanced the job version.
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
    const message = sqlApplicationErrorOf(error);
    if (message.includes("retained durable stage-delivery evidence")
      || message.includes("retained predecessor lineage evidence")) {
      return { ok:false, reason:"missing_delivery_evidence" };
    }
    if (message.includes("only terminal dead-letter jobs")) {
      return { ok:false, reason:"not_terminal_dead_letter" };
    }
    if (message.includes("idempotency key was reused with different command content")) {
      return { ok:false, reason:"idempotency_conflict" };
    }
    if (message.includes("requires an exhausted job")) {
      return { ok:false, reason:"not_exhausted" };
    }
    throw error;
  }
}
