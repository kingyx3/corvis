import { randomUUID } from "crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { platform } from "./platform.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";

function controlDb(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }

type Readiness = Record<string, "configured" | "missing" | "demo">;
type EvidenceDependencies = {
  db?: PostgresSqlApi;
  readiness?: () => Promise<Readiness>;
};

// Queue/worker saturation thresholds, mirrored from ops/slos.yaml so both stay
// visibly in sync rather than drifting apart as independently-chosen magic numbers.
//   - document_pipeline.dead_letter_rate: { max: 0.005, window: 24h }
//   - alerts: "dead_letter_queue_depth > 0 for 15m" (severity SEV2)
export const DEAD_LETTER_RATE_MAX = 0.005;
export const DEAD_LETTER_BACKLOG_AGE_SECONDS_MAX = 15 * 60;

export type QueueSaturationSeverity = "none" | "warning" | "breach";

export type QueueSaturationCounts = {
  /** Jobs currently sitting in the `dead_letter` state (current backlog depth). */
  deadLetterJobs: number;
  /** Total processing_job rows for the tenant, used as the rate denominator. */
  totalJobs: number;
  /** Age, in seconds, of the oldest job still in `dead_letter` state, or null when the backlog is empty. */
  oldestDeadLetterAgeSeconds: number | null;
};

export type QueueSaturationThresholds = {
  deadLetterRateMax: number;
  backlogAgeSecondsMax: number;
};

export const DEFAULT_QUEUE_SATURATION_THRESHOLDS: QueueSaturationThresholds = {
  deadLetterRateMax: DEAD_LETTER_RATE_MAX,
  backlogAgeSecondsMax: DEAD_LETTER_BACKLOG_AGE_SECONDS_MAX,
};

export type QueueSaturationSignal = {
  severity: QueueSaturationSeverity;
  reasons: string[];
  deadLetterRate: number;
  oldestDeadLetterAgeSeconds: number | null;
};

// Pure, independently-testable saturation signal: turns raw dead-letter counts into a
// severity an operator can act on, instead of just a count that requires reading tea leaves.
// Two independent signals, each mirroring one line of ops/slos.yaml, either of which can
// escalate severity on its own:
//   1. dead-letter rate vs. document_pipeline.dead_letter_rate.max (a "warning" band at half
//      that threshold gives operators lead time before the SLO itself breaches).
//   2. oldest dead-lettered job's age vs. the "dead_letter_queue_depth > 0 for 15m" alert,
//      i.e. a sustained backlog rather than a single point-in-time count.
export function evaluateQueueSaturation(
  counts: QueueSaturationCounts,
  thresholds: QueueSaturationThresholds = DEFAULT_QUEUE_SATURATION_THRESHOLDS,
): QueueSaturationSignal {
  const deadLetterRate = counts.totalJobs > 0 ? counts.deadLetterJobs / counts.totalJobs : 0;
  const reasons: string[] = [];
  let severity: QueueSaturationSeverity = "none";

  const warningRate = thresholds.deadLetterRateMax / 2;
  if (deadLetterRate > thresholds.deadLetterRateMax) {
    severity = "breach";
    reasons.push(`dead-letter rate ${deadLetterRate.toFixed(4)} exceeds SLO max ${thresholds.deadLetterRateMax}`);
  } else if (deadLetterRate > warningRate) {
    severity = "warning";
    reasons.push(`dead-letter rate ${deadLetterRate.toFixed(4)} is above half the SLO max ${thresholds.deadLetterRateMax}`);
  }

  if (counts.oldestDeadLetterAgeSeconds !== null && counts.oldestDeadLetterAgeSeconds > thresholds.backlogAgeSecondsMax) {
    severity = "breach";
    reasons.push(`oldest dead-lettered job is ${counts.oldestDeadLetterAgeSeconds}s old, exceeding the ${thresholds.backlogAgeSecondsMax}s sustained-backlog alert window`);
  }

  return { severity, reasons, deadLetterRate, oldestDeadLetterAgeSeconds: counts.oldestDeadLetterAgeSeconds };
}

export async function listFeatureFlags(identity: RequestIdentity) {
  return controlDb().query(`select flag_key, enabled, configuration as config, updated_at, updated_by
    from corvis_control.feature_flag where tenant_id=$1 order by flag_key`, [identity.tenantId]);
}

export async function setFeatureFlag(identity: RequestIdentity, key: string, enabled: boolean, config: unknown) {
  await controlDb().execute(`insert into corvis_control.feature_flag
      (tenant_id, flag_key, enabled, configuration, updated_at, updated_by)
    values ($1,$2,$3,$4::jsonb,now(),$5)
    on conflict (tenant_id, flag_key) do update set
      enabled=excluded.enabled,
      configuration=excluded.configuration,
      updated_at=excluded.updated_at,
      updated_by=excluded.updated_by`,
  [identity.tenantId,key,enabled,JSON.stringify(config ?? {}),identity.subject]);
}

export async function listControlEvidence(identity: RequestIdentity, db: PostgresSqlApi = controlDb()) {
  return db.query(`select * from corvis_control.control_evidence
    where tenant_id=$1 order by generated_at desc limit 500`, [identity.tenantId]);
}

export async function listDeletionRequests(identity: RequestIdentity) {
  return controlDb().query(`select * from corvis_control.deletion_request
    where tenant_id=$1 order by requested_at desc limit 500`, [identity.tenantId]);
}

export async function createDeletionRequest(identity: RequestIdentity, scope: unknown, reason: string) {
  const id = randomUUID();
  await controlDb().execute(`insert into corvis_control.deletion_request
      (tenant_id,deletion_request_id,requested_by,scope,reason,state,requested_at)
    values ($1,$2::uuid,$3,$4::jsonb,$5,'requested',now())`,
  [identity.tenantId,id,identity.subject,JSON.stringify(scope),reason]);
  return id;
}

// Execution moved to ./data-lifecycle.ts: it adds default-deny retention/legal-hold
// checks and an immutable per-attempt evidence ledger ahead of the same adapter call.

export async function retryProcessingJob(identity: RequestIdentity, jobId: string): Promise<
  | { ok: true; version: number }
  | { ok: false; reason: "not_found" | "not_retryable" | "attempts_exhausted" | "version_conflict" }
> {
  const db = controlDb();
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

export async function getSourceReference(identity: RequestIdentity, sourceReferenceId: string, db: PostgresSqlApi = controlDb()) {
  const rows=await db.query(`select source_reference_id,document_id,page_number,sheet_name,cell_range,bbox,excerpt
    from corvis_serving.source_references
    where tenant_id=$1 and source_reference_id=$2::uuid limit 1`, [identity.tenantId,sourceReferenceId]);
  return rows[0];
}

export async function generateControlEvidence(identity: RequestIdentity, dependencies: EvidenceDependencies = {}) {
  const db = dependencies.db ?? controlDb();
  const evidenceId = randomUUID();
  const readiness = dependencies.readiness ? await dependencies.readiness() : await platform().readiness();
  const counts = await db.query(`select
    (select count(*) from corvis_control.audit_event where tenant_id=$1) as audit_events,
    (select count(*) from corvis_control.processing_job where tenant_id=$1 and state in ('failed','dead_letter')) as failed_jobs,
    (select count(*) from corvis_control.deletion_request where tenant_id=$1 and state='completed') as completed_deletions,
    (select count(*) from corvis_consolidated.fund_period_snapshot where tenant_id=$1 and status='published') as published_snapshots,
    (select count(*) from corvis_control.processing_job where tenant_id=$1 and state='dead_letter') as dead_letter_jobs,
    (select count(*) from corvis_control.processing_job where tenant_id=$1) as total_jobs,
    (select extract(epoch from (now() - min(updated_at)))
       from corvis_control.processing_job where tenant_id=$1 and state='dead_letter') as oldest_dead_letter_age_seconds`,
  [identity.tenantId]);
  const countsRow = counts[0] ?? {};
  // Denominator judgement call: the processing_job table has no reliable "job left the
  // window" boundary (jobs stay dead-lettered indefinitely rather than aging out), so we
  // approximate ops/slos.yaml's 24h-windowed dead_letter_rate with an all-time rate — the
  // dead-letter count over every job ever recorded for the tenant. This is a coarser signal
  // than a true rolling-window rate, but it only needs existing columns and it degrades
  // safely toward the real SLO as the tenant's job history saturates a rolling day.
  const rawOldestAge = countsRow.oldest_dead_letter_age_seconds;
  const queueSaturation = evaluateQueueSaturation({
    deadLetterJobs: Number(countsRow.dead_letter_jobs ?? 0),
    totalJobs: Number(countsRow.total_jobs ?? 0),
    // now() - updated_at, not created_at: updated_at reflects the job's last state
    // transition (i.e. when it entered dead_letter), which is what "how long has this
    // job been stuck" should measure, not how long ago it was originally created.
    oldestDeadLetterAgeSeconds: rawOldestAge === null || rawOldestAge === undefined ? null : Number(rawOldestAge),
  });
  const payload = { readiness, counts: countsRow, queueSaturation, generatedAt: new Date().toISOString() };
  const readinessOk = Object.values(readiness).every((value) => value === "configured");
  const result = readinessOk && queueSaturation.severity !== "breach" ? "pass" : "attention_required";
  await db.execute(`insert into corvis_control.control_evidence
      (tenant_id,evidence_id,control_code,evidence_type,evidence_payload,result,generated_at,generated_by)
    values ($1,$2::uuid,'ENTERPRISE_RUNTIME','automated_runtime_snapshot',$3::jsonb,$4,now(),$5)`,
  [identity.tenantId,evidenceId,JSON.stringify(payload),result,identity.subject]);
  return { evidenceId, result, payload };
}
