import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { resolveRequestIdentity } from "@/lib/server/request-context";
import { snowflake } from "@/lib/server/snowflake";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { jobId } = await context.params;
    const rows = await snowflake().query(`SELECT STATE,ATTEMPT,MAX_ATTEMPTS,VERSION FROM PM_CONTROL.PROCESSING_JOB WHERE TENANT_ID=? AND JOB_ID=? LIMIT 1`, [identity.tenantId, jobId]);
    const job = rows[0];
    if (!job) return json({ error: "job_not_found", correlationId: id }, { status: 404 });
    const state = String(job.state || "");
    const attempt = Number(job.attempt || 0); const maxAttempts = Number(job.max_attempts || 0); const version = Number(job.version || 0);
    if (!["retryable","failed","dead_letter"].includes(state)) return json({ error: "job_not_retryable", correlationId: id }, { status: 409 });
    if (attempt >= maxAttempts) return json({ error: "job_attempts_exhausted", correlationId: id }, { status: 409 });
    await snowflake().execute(`UPDATE PM_CONTROL.PROCESSING_JOB SET STATE='queued', LAST_ERROR=NULL, VERSION=VERSION+1, UPDATED_AT=CURRENT_TIMESTAMP() WHERE TENANT_ID=? AND JOB_ID=? AND VERSION=?`, [identity.tenantId, jobId, version]);
    await snowflake().execute(`INSERT INTO PM_CONTROL.OUTBOX_EVENT (TENANT_ID,EVENT_ID,EVENT_TYPE,AGGREGATE_TYPE,AGGREGATE_ID,PAYLOAD,CREATED_AT) SELECT ?,?,'ProcessingJobRetryRequested','processing_job',?,PARSE_JSON(?),CURRENT_TIMESTAMP()`, [identity.tenantId,randomUUID(),jobId,JSON.stringify({ jobId, requestedBy: identity.subject })]);
    await platform().audit({ id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject, sessionId: identity.sessionId, action: "processing_job.retry", targetType: "processing_job", targetId: jobId, outcome: "success", correlationId: id });
    return json({ data: { jobId, state: "queued", version: version + 1 }, correlationId: id }, { status: 202 });
  } catch (error) { return apiError(error, id); }
}
