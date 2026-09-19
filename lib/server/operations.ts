import { randomUUID } from "crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { platform } from "./platform.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";

function bearer(token?: string): Record<string,string> { return token ? { authorization: `Bearer ${token}` } : {}; }
function controlDb(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }

type Readiness = Record<string, "configured" | "missing" | "demo">;
type EvidenceDependencies = {
  db?: PostgresSqlApi;
  readiness?: () => Promise<Readiness>;
};

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

export async function executeDeletionRequest(identity: RequestIdentity, requestId: string) {
  const db = controlDb();
  const rows = await db.query(`select scope,state from corvis_control.deletion_request
    where tenant_id=$1 and deletion_request_id=$2::uuid limit 1`, [identity.tenantId,requestId]);
  const request = rows[0];
  if (!request) throw new Error("Deletion request not found");
  if (!["requested","approved","retryable"].includes(String(request.state))) throw new Error("Deletion request is not executable");
  const config = getServerConfig();
  if (!config.dataLifecycleEndpoint) throw new Error("Data lifecycle adapter is not configured");
  await db.execute(`update corvis_control.deletion_request set
      state='executing', approved_by=coalesce(approved_by,$1), approved_at=coalesce(approved_at,now()),
      execution_attempts=execution_attempts+1, last_error=null
    where tenant_id=$2 and deletion_request_id=$3::uuid`, [identity.subject,identity.tenantId,requestId]);
  try {
    const response = await fetch(`${config.dataLifecycleEndpoint.replace(/\/$/,"")}/delete`, {
      method:"POST",
      headers:{"content-type":"application/json",...bearer(config.dataLifecycleToken)},
      body:JSON.stringify({ tenantId:identity.tenantId, requestId, scope:request.scope }),
      cache:"no-store",
    });
    if (!response.ok) throw new Error(`Lifecycle adapter rejected deletion (${response.status})`);
    const evidence = await response.json() as { evidence?: unknown };
    await db.execute(`update corvis_control.deletion_request set
        state='completed', completed_at=now(), completion_evidence=$1::jsonb
      where tenant_id=$2 and deletion_request_id=$3::uuid`,
    [JSON.stringify(evidence.evidence ?? {adapterStatus:"completed"}),identity.tenantId,requestId]);
    return evidence.evidence ?? { adapterStatus: "completed" };
  } catch (error) {
    await db.execute(`update corvis_control.deletion_request set state='retryable',last_error=$1
      where tenant_id=$2 and deletion_request_id=$3::uuid`,
    [error instanceof Error ? error.message : "unknown",identity.tenantId,requestId]);
    throw error;
  }
}

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
    (select count(*) from corvis_consolidated.fund_period_snapshot where tenant_id=$1 and status='published') as published_snapshots`,
  [identity.tenantId]);
  const payload = { readiness, counts: counts[0] ?? {}, generatedAt: new Date().toISOString() };
  const result = Object.values(readiness).every((value) => value === "configured") ? "pass" : "attention_required";
  await db.execute(`insert into corvis_control.control_evidence
      (tenant_id,evidence_id,control_code,evidence_type,evidence_payload,result,generated_at,generated_by)
    values ($1,$2::uuid,'ENTERPRISE_RUNTIME','automated_runtime_snapshot',$3::jsonb,$4,now(),$5)`,
  [identity.tenantId,evidenceId,JSON.stringify(payload),result,identity.subject]);
  return { evidenceId, result, payload };
}
