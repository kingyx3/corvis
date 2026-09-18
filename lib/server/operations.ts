import { randomUUID } from "crypto";
import type { RequestIdentity } from "@/core/enterprise";
import { getServerConfig } from "@/lib/server/config";
import { platform } from "@/lib/server/platform";
import { snowflake } from "@/lib/server/snowflake";

function bearer(token?: string): Record<string,string> { return token ? { authorization: `Bearer ${token}` } : {}; }

export async function listFeatureFlags(identity: RequestIdentity) {
  return snowflake().query(`SELECT FLAG_KEY,ENABLED,CONFIG,UPDATED_AT,UPDATED_BY FROM PM_CONTROL.FEATURE_FLAG WHERE TENANT_ID=? ORDER BY FLAG_KEY`, [identity.tenantId]);
}

export async function setFeatureFlag(identity: RequestIdentity, key: string, enabled: boolean, config: unknown) {
  await snowflake().execute(`MERGE INTO PM_CONTROL.FEATURE_FLAG t USING (SELECT ? TENANT_ID, ? FLAG_KEY) s ON t.TENANT_ID=s.TENANT_ID AND t.FLAG_KEY=s.FLAG_KEY WHEN MATCHED THEN UPDATE SET ENABLED=?,CONFIG=PARSE_JSON(?),UPDATED_AT=CURRENT_TIMESTAMP(),UPDATED_BY=? WHEN NOT MATCHED THEN INSERT (TENANT_ID,FLAG_KEY,ENABLED,CONFIG,UPDATED_AT,UPDATED_BY) SELECT ?,?,?,PARSE_JSON(?),CURRENT_TIMESTAMP(),?`, [identity.tenantId,key,enabled,JSON.stringify(config ?? {}),identity.subject,identity.tenantId,key,enabled,JSON.stringify(config ?? {}),identity.subject]);
}

export async function createDeletionRequest(identity: RequestIdentity, scope: unknown, reason: string) {
  const id = randomUUID();
  await snowflake().execute(`INSERT INTO PM_CONTROL.DELETION_REQUEST (TENANT_ID,DELETION_REQUEST_ID,REQUESTED_BY,SCOPE,REASON,STATE,REQUESTED_AT) SELECT ?,?,?,PARSE_JSON(?),?,'requested',CURRENT_TIMESTAMP()`, [identity.tenantId,id,identity.subject,JSON.stringify(scope),reason]);
  return id;
}

export async function executeDeletionRequest(identity: RequestIdentity, requestId: string) {
  const rows = await snowflake().query(`SELECT SCOPE,STATE FROM PM_CONTROL.DELETION_REQUEST WHERE TENANT_ID=? AND DELETION_REQUEST_ID=? LIMIT 1`, [identity.tenantId,requestId]);
  const request = rows[0];
  if (!request) throw new Error("Deletion request not found");
  if (!["requested","approved","retryable"].includes(String(request.state))) throw new Error("Deletion request is not executable");
  const config = getServerConfig();
  if (!config.dataLifecycleEndpoint) throw new Error("Data lifecycle adapter is not configured");
  await snowflake().execute(`UPDATE PM_CONTROL.DELETION_REQUEST SET STATE='executing',APPROVED_BY=COALESCE(APPROVED_BY,?),APPROVED_AT=COALESCE(APPROVED_AT,CURRENT_TIMESTAMP()),EXECUTION_ATTEMPTS=COALESCE(EXECUTION_ATTEMPTS,0)+1,LAST_ERROR=NULL WHERE TENANT_ID=? AND DELETION_REQUEST_ID=?`, [identity.subject,identity.tenantId,requestId]);
  try {
    const response = await fetch(`${config.dataLifecycleEndpoint.replace(/\/$/,"")}/delete`, { method:"POST", headers:{"content-type":"application/json",...bearer(config.dataLifecycleToken)}, body:JSON.stringify({ tenantId:identity.tenantId, requestId, scope:request.scope }), cache:"no-store" });
    if (!response.ok) throw new Error(`Lifecycle adapter rejected deletion (${response.status})`);
    const evidence = await response.json() as { evidence?: unknown };
    await snowflake().execute(`UPDATE PM_CONTROL.DELETION_REQUEST SET STATE='completed',COMPLETED_AT=CURRENT_TIMESTAMP(),COMPLETION_EVIDENCE=PARSE_JSON(?) WHERE TENANT_ID=? AND DELETION_REQUEST_ID=?`, [JSON.stringify(evidence.evidence ?? {adapterStatus:"completed"}),identity.tenantId,requestId]);
    return evidence.evidence ?? { adapterStatus: "completed" };
  } catch (error) {
    await snowflake().execute(`UPDATE PM_CONTROL.DELETION_REQUEST SET STATE='retryable',LAST_ERROR=? WHERE TENANT_ID=? AND DELETION_REQUEST_ID=?`, [error instanceof Error ? error.message : "unknown",identity.tenantId,requestId]);
    throw error;
  }
}

export async function generateControlEvidence(identity: RequestIdentity) {
  const evidenceId = randomUUID();
  const readiness = await platform().readiness();
  const counts = await snowflake().query(`SELECT
    (SELECT COUNT(*) FROM PM_CONTROL.AUDIT_EVENT WHERE TENANT_ID=?) AUDIT_EVENTS,
    (SELECT COUNT(*) FROM PM_CONTROL.PROCESSING_JOB WHERE TENANT_ID=? AND STATE IN ('failed','dead_letter')) FAILED_JOBS,
    (SELECT COUNT(*) FROM PM_CONTROL.DELETION_REQUEST WHERE TENANT_ID=? AND STATE='completed') COMPLETED_DELETIONS,
    (SELECT COUNT(*) FROM PM_CONSOLIDATED.FUND_PERIOD_SNAPSHOT WHERE TENANT_ID=? AND STATUS='published') PUBLISHED_SNAPSHOTS`, [identity.tenantId,identity.tenantId,identity.tenantId,identity.tenantId]);
  const payload = { readiness, counts: counts[0] ?? {}, generatedAt: new Date().toISOString() };
  const result = Object.values(readiness).every((value) => value === "configured") ? "pass" : "attention_required";
  await snowflake().execute(`INSERT INTO PM_CONTROL.CONTROL_EVIDENCE (TENANT_ID,EVIDENCE_ID,CONTROL_CODE,EVIDENCE_TYPE,EVIDENCE_PAYLOAD,RESULT,GENERATED_AT,GENERATED_BY) SELECT ?,?,'ENTERPRISE_RUNTIME','automated_runtime_snapshot',PARSE_JSON(?),?,CURRENT_TIMESTAMP(),?`, [identity.tenantId,evidenceId,JSON.stringify(payload),result,identity.subject]);
  return { evidenceId, result, payload };
}
