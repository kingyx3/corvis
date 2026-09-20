import { createHash, randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { postgres } from "@/lib/server/postgres";
import {
  recordCandidateReviewDecision,
  type CandidateReviewDecision,
} from "@/lib/server/processing-reviewed-stage";

type CandidateReviewRequest = {
  documentId?: string;
  extractionRunId?: string;
  candidateId?: string;
  decision?: CandidateReviewDecision["decision"];
  reasonCode?: string;
  correctionPayload?: Record<string, unknown>;
  resolvedExceptionCodes?: string[];
};

const DECISIONS = new Set<CandidateReviewDecision["decision"]>([
  "approve",
  "reject",
  "correct",
  "resolve_exception",
]);

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return json({ error: "idempotency_key_required", correlationId: id }, { status: 400 });
    }

    const command = await request.json() as CandidateReviewRequest;
    if (!command.documentId || !command.extractionRunId || !command.candidateId
      || !command.decision || !DECISIONS.has(command.decision)
      || !command.reasonCode?.trim()) {
      return json({ error: "invalid_candidate_review_command", correlationId: id }, { status: 400 });
    }
    if (command.decision === "correct"
      && (!command.correctionPayload || Array.isArray(command.correctionPayload))) {
      return json({ error: "correction_payload_required", correlationId: id }, { status: 400 });
    }
    if (command.decision === "resolve_exception"
      && (!Array.isArray(command.resolvedExceptionCodes) || command.resolvedExceptionCodes.length === 0)) {
      return json({ error: "resolved_exception_codes_required", correlationId: id }, { status: 400 });
    }

    const reviewEventId = deterministicUuid([
      "corvis-candidate-review-event",
      identity.tenantId,
      command.extractionRunId,
      command.candidateId,
      idempotencyKey,
    ].join(":"));
    const gate = await recordCandidateReviewDecision({
      db: postgres(getServerConfig().postgresDsn),
      tenantId: identity.tenantId,
      documentId: command.documentId,
      extractionRunId: command.extractionRunId,
      decision: {
        reviewEventId,
        candidateId: command.candidateId,
        actorSubject: identity.subject,
        decision: command.decision,
        reasonCode: command.reasonCode.trim(),
        correctionPayload: command.correctionPayload,
        resolvedExceptionCodes: command.resolvedExceptionCodes,
      },
    });

    await platform().audit({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      tenantId: identity.tenantId,
      workspaceId: identity.workspaceId,
      actorSubject: identity.subject,
      sessionId: identity.sessionId,
      action: `extraction_candidate.${command.decision}`,
      targetType: "extraction_candidate",
      targetId: command.candidateId,
      outcome: "success",
      correlationId: id,
      metadata: {
        extractionRunId: command.extractionRunId,
        reviewEventId,
        reviewPolicyVersion: "candidate_review_v1",
        gateStatus: gate.status,
        blockingCandidateCount: gate.blockingCandidateCount,
      },
    });

    return json({ data: gate, correlationId: id }, { status: 202 });
  } catch (error) {
    return apiError(error, id);
  }
}
