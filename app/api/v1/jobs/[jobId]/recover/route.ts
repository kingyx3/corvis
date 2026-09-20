import { createHash, randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { recoverDeadLetterProcessingJob } from "@/lib/server/processing-recovery";

type RecoveryCommand = {
  expectedVersion?: number;
  reasonCode?: string;
  note?: string;
};

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return json({ error: "idempotency_key_required", correlationId: id }, { status: 400 });
    }

    const { jobId } = await context.params;
    const command = await request.json() as RecoveryCommand;
    if (!jobId || !Number.isInteger(command.expectedVersion) || Number(command.expectedVersion) <= 0
      || !command.reasonCode?.trim() || command.reasonCode.trim().length > 100
      || (command.note !== undefined && command.note.length > 1000)) {
      return json({ error: "invalid_processing_recovery_command", correlationId: id }, { status: 400 });
    }

    const recoveryEventId = deterministicUuid([
      "corvis-processing-recovery",
      identity.tenantId,
      jobId,
      idempotencyKey,
    ].join(":"));
    const result = await recoverDeadLetterProcessingJob({
      identity,
      jobId,
      expectedVersion: Number(command.expectedVersion),
      recoveryEventId,
      reasonCode: command.reasonCode.trim(),
      note: command.note?.trim() || undefined,
    });

    if (!result.ok) {
      if (result.reason === "not_terminal_dead_letter") {
        return json({ error: "job_not_terminal_dead_letter", correlationId: id }, { status: 409 });
      }
      if (result.reason === "not_exhausted") {
        return json({ error: "normal_retry_still_available", correlationId: id }, { status: 409 });
      }
      if (result.reason === "missing_delivery_evidence") {
        return json({ error: "recovery_evidence_missing", correlationId: id }, { status: 409 });
      }
      return json({ error: "job_not_found_or_version_conflict", correlationId: id }, { status: 409 });
    }

    await platform().audit({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      tenantId: identity.tenantId,
      workspaceId: identity.workspaceId,
      actorSubject: identity.subject,
      sessionId: identity.sessionId,
      action: "processing_job.recover_dead_letter",
      targetType: "processing_job",
      targetId: jobId,
      outcome: "success",
      correlationId: id,
      metadata: {
        recoveryEventId: result.recoveryEventId,
        recoveryCount: result.recoveryCount,
        reasonCode: command.reasonCode.trim(),
      },
    });

    return json({
      data: {
        jobId,
        state: "queued",
        version: result.version,
        recoveryCount: result.recoveryCount,
        recoveryEventId: result.recoveryEventId,
      },
      correlationId: id,
    }, { status: 202 });
  } catch (error) {
    return apiError(error, id);
  }
}
