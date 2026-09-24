import { createHash, randomUUID } from "crypto";
import { assertDocumentAccess, assertPermission } from "@/core/enterprise";
import { runAuditedMutation } from "@/lib/server/audited-mutation";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres } from "@/lib/server/postgres";
import {
  CandidateReviewRequestError,
  recordCandidateReviewDecision,
  type CandidateReviewDecision,
} from "@/lib/server/processing-reviewed-stage";

type CandidateReviewRequest = {
  documentId?: unknown;
  extractionRunId?: unknown;
  candidateId?: unknown;
  decision?: unknown;
  reasonCode?: unknown;
  correctionPayload?: unknown;
  resolvedExceptionCodes?: unknown;
};

const DECISIONS = new Set<CandidateReviewDecision["decision"]>([
  "approve",
  "reject",
  "correct",
  "resolve_exception",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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

    const body = await request.json() as unknown;
    if (!isPlainObject(body)) {
      return json({ error: "invalid_candidate_review_command", correlationId: id }, { status: 400 });
    }
    const command = body as CandidateReviewRequest;
    if (!isUuid(command.documentId) || !isUuid(command.extractionRunId) || !isUuid(command.candidateId)
      || typeof command.decision !== "string" || !DECISIONS.has(command.decision as CandidateReviewDecision["decision"])
      || typeof command.reasonCode !== "string" || !command.reasonCode.trim()) {
      return json({ error: "invalid_candidate_review_command", correlationId: id }, { status: 400 });
    }
    const documentId = command.documentId;
    const extractionRunId = command.extractionRunId;
    const candidateId = command.candidateId;
    const reasonCode = command.reasonCode.trim();
    const decision = command.decision as CandidateReviewDecision["decision"];
    if (decision === "correct" && !isPlainObject(command.correctionPayload)) {
      return json({ error: "correction_payload_required", correlationId: id }, { status: 400 });
    }
    if (decision !== "correct" && command.correctionPayload !== undefined && command.correctionPayload !== null) {
      return json({ error: "invalid_candidate_review_command", correlationId: id }, { status: 400 });
    }
    const resolvedExceptionCodes = command.resolvedExceptionCodes;
    if (decision === "resolve_exception"
      && (!Array.isArray(resolvedExceptionCodes) || resolvedExceptionCodes.length === 0
        || resolvedExceptionCodes.some((code) => typeof code !== "string" || !code.trim()))) {
      return json({ error: "resolved_exception_codes_required", correlationId: id }, { status: 400 });
    }
    if (decision !== "resolve_exception" && resolvedExceptionCodes !== undefined
      && !(Array.isArray(resolvedExceptionCodes) && resolvedExceptionCodes.length === 0)) {
      return json({ error: "resolved_exception_codes_not_allowed", correlationId: id }, { status: 400 });
    }

    assertDocumentAccess(identity, documentId);

    const reviewEventId = deterministicUuid([
      "corvis-candidate-review-event",
      identity.tenantId,
      extractionRunId,
      candidateId,
      identity.subject,
      idempotencyKey,
    ].join(":"));
    const gate = await runAuditedMutation({
      mutate: (db) => recordCandidateReviewDecision({
        db: db ?? postgres(getServerConfig().postgresDsn),
        tenantId: identity.tenantId,
        documentId,
        extractionRunId,
        decision: {
          reviewEventId,
          candidateId,
          actorSubject: identity.subject,
          decision,
          reasonCode,
          correctionPayload: decision === "correct" ? command.correctionPayload as Record<string, unknown> : undefined,
          resolvedExceptionCodes: decision === "resolve_exception" ? (resolvedExceptionCodes as string[]).map((code) => code.trim()) : undefined,
        },
      }),
      audit: (result) => ({
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        actorSubject: identity.subject,
        sessionId: identity.sessionId,
        action: `extraction_candidate.${decision}`,
        targetType: "extraction_candidate",
        targetId: candidateId,
        outcome: "success",
        correlationId: id,
        metadata: {
          extractionRunId,
          reviewEventId,
          reviewPolicyVersion: "candidate_review_v1",
          gateStatus: result.status,
          blockingCandidateCount: result.blockingCandidateCount,
        },
      }),
    });

    return json({ data: gate, correlationId: id }, { status: 202 });
  } catch (error) {
    if (error instanceof CandidateReviewRequestError) {
      return json({ error: error.code, correlationId: id }, { status: error.status });
    }
    return apiError(error, id);
  }
}
