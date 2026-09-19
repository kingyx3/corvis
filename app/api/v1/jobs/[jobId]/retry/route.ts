import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { retryProcessingJob } from "@/lib/server/operations";
import { platform } from "@/lib/server/platform";
import { resolveRequestIdentity } from "@/lib/server/request-context";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { jobId } = await context.params;
    const result = await retryProcessingJob(identity, jobId);
    if (!result.ok) {
      if (result.reason === "not_found") return json({ error: "job_not_found", correlationId: id }, { status: 404 });
      if (result.reason === "not_retryable") return json({ error: "job_not_retryable", correlationId: id }, { status: 409 });
      if (result.reason === "attempts_exhausted") return json({ error: "job_attempts_exhausted", correlationId: id }, { status: 409 });
      return json({ error: "job_version_conflict", correlationId: id }, { status: 409 });
    }
    await platform().audit({ id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject, sessionId: identity.sessionId, action: "processing_job.retry", targetType: "processing_job", targetId: jobId, outcome: "success", correlationId: id });
    return json({ data: { jobId, state: "queued", version: result.version }, correlationId: id }, { status: 202 });
  } catch (error) { return apiError(error, id); }
}
