import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";

export type ProcessingRetryResult =
  | { ok: true; version: number }
  | { ok: false; reason: "not_found" | "not_retryable" | "attempts_exhausted" | "version_conflict" };

/** Transaction-aware retry command used by the audited operator route. */
export async function retryProcessingJobCommand(
  identity: RequestIdentity,
  jobId: string,
  db: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
): Promise<ProcessingRetryResult> {
  const rows = await db.query(`select state,attempt,max_attempts,version from corvis_control.processing_job
    where tenant_id=$1 and job_id=$2 limit 1`, [identity.tenantId,jobId]);
  const job = rows[0];
  if (!job) return { ok:false, reason:"not_found" };
  const state=String(job.state??""); const attempt=Number(job.attempt??0); const maxAttempts=Number(job.max_attempts??0); const version=Number(job.version??0);
  if (!["retryable","failed","dead_letter"].includes(state)) return { ok:false, reason:"not_retryable" };
  if (attempt >= maxAttempts) return { ok:false, reason:"attempts_exhausted" };
  const result = await db.query(`select corvis_control.retry_processing_job($1::uuid,$2,$3,$4) as new_version`,
    [identity.tenantId,jobId,version,identity.subject]);
  const newVersion=Number(result[0]?.new_version??0);
  if (newVersion !== version+1) return { ok:false, reason:"version_conflict" };
  return { ok:true, version:newVersion };
}
