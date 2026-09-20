import { randomUUID } from "crypto";
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

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
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

    const gate = await recordCandidateReviewDecision({
      db: postgres(getServerConfig().postgresDsn),
      tenantId: identity.tenantId,
      documentId: command.documentId,
      extractionRunId: command.extractionRunId,
      decision: {
        reviewEventId: randomUUID(),
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
