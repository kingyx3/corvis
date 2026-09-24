import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { runAuditedMutation } from "@/lib/server/audited-mutation";
import { apiError, correlationId, json } from "@/lib/server/http";
import { retryProcessingJobCommand } from "@/lib/server/processing-retry";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { jobId } = await context.params;
    const result = await runAuditedMutation({
      mutate: (db) => retryProcessingJobCommand(identity, jobId, db),
      audit: (outcome) => ({
        id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
        actorSubject: identity.subject, sessionId: identity.sessionId, action: "processing_job.retry",
        targetType: "processing_job", targetId: jobId, outcome: "success", correlationId: id,
        metadata: outcome.ok ? { version: outcome.version } : { accepted: false },
      }),
    });
    if (!result.ok) {
      if (result.reason === "not_found") return json({ error: "job_not_found", correlationId: id }, { status: 404 });
      if (result.reason === "not_retryable") return json({ error: "job_not_retryable", correlationId: id }, { status: 409 });
      if (result.reason === "attempts_exhausted") return json({ error: "job_attempts_exhausted", correlationId: id }, { status: 409 });
      return json({ error: "job_version_conflict", correlationId: id }, { status: 409 });
    }
    return json({ data: { jobId, state: "queued", version: result.version }, correlationId: id }, { status: 202 });
  } catch (error) { return apiError(error, id); }
}
