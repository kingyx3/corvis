import { createHash } from "crypto";
import type { ProcessingStageHandler } from "./processing-stage-effects.ts";
import { ProcessingStageBlockedError, type ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

export const CANDIDATE_REVIEW_POLICY_VERSION = "candidate_review_v1";

// The authoritative extraction skill names these as critical facts. The current
// Postgres publication contract already requires two distinct reviewers for
// critical canonical observations, so the pre-canonical candidate gate applies
// the same four-eyes requirement rather than weakening it.
const CRITICAL_METRIC_CODES = new Set([
  "nav",
  "cost",
  "fair_value",
  "ownership_pct",
  "fully_diluted_ownership_pct",
  "gross_debt",
  "net_debt",
  "principal_balance",
  "revenue",
  "net_revenue",
  "ebitda",
  "adjusted_ebitda",
  "ebitdax",
  "adjusted_ebitdax",
  "gross_irr",
  "net_irr",
  "gross_moic",
  "net_moic",
  "tvpi",
  "dpi",
  "rvpi",
]);

const SYNTHETIC_EXCEPTION_CODE = "__candidate_exception__";
const REVIEW_EVENT_REUSED = "review event id was reused with different decision content";
const SHA256 = /^[0-9a-f]{64}$/i;

export type ExtractionReviewRun = {
  extractionRunId: string;
  documentId: string;
  artifactVersionId: string;
  representationId: string;
  candidateCount: number;
  candidateSetSha256: string;
  schemaVersion: string;
  skillId: string;
  skillVersion: string;
  status: string;
};

export type ReviewCandidate = {
  candidateId: string;
  candidateKey: string;
  candidateType: string;
  payload: Record<string, unknown>;
  confidence: Record<string, unknown>;
  provenance: Record<string, unknown>;
  exceptionCodes: string[];
  sourceReferenceCount: number;
};

export type CandidateReviewRequirement = {
  candidateId: string;
  candidateFingerprintSha256: string;
  riskTier: "standard" | "critical";
  requiredApprovals: number;
  requiresExceptionResolution: boolean;
  blockingReasons: string[];
};

export type CandidateReviewDecision = {
  reviewEventId: string;
  candidateId: string;
  actorSubject: string;
  decision: "approve" | "reject" | "correct" | "resolve_exception";
  reasonCode: string;
  correctionPayload?: Record<string, unknown>;
  resolvedExceptionCodes?: string[];
};

export type StoredCandidateReviewEvent = CandidateReviewDecision & {
  sequence: number;
};

export type CandidateGateState = {
  candidateId: string;
  ready: boolean;
  approvalCount: number;
  requiredApprovals: number;
  rejected: boolean;
  unresolvedExceptionCodes: string[];
};

export type ExtractionReviewGate = {
  extractionRunId: string;
  candidateSetSha256: string;
  decisionSetSha256: string;
  status: "pending" | "ready";
  candidateCount: number;
  blockingCandidateCount: number;
  criticalCandidateCount: number;
  exceptionCandidateCount: number;
  candidates: CandidateGateState[];
};

type ExtractionPredecessorResult = {
  extractionRunId: string;
  representationId: string;
  artifactVersionId: string;
  candidateCount: number;
  candidateSetSha256: string;
  schemaVersion: string;
  skillId: string;
  skillVersion: string;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { return value; }
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  const parsed = object(parsedJson(value));
  if (!parsed) throw new Error(`reviewed stage requires ${field} object`);
  return parsed;
}

function stringArray(value: unknown, field: string): string[] {
  const parsed = parsedJson(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`reviewed stage requires ${field} string array`);
  }
  return parsed.map((entry) => String(entry).trim());
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`reviewed stage requires ${field}`);
  return value.trim();
}

function requiredCount(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`reviewed stage requires valid ${field}`);
  return parsed;
}

function predecessorResult(effect: ProcessingStageEffectInput): ExtractionPredecessorResult {
  const predecessor = object(effect.payload.predecessorResult);
  if (!predecessor) throw new Error("reviewed stage requires predecessorResult");
  const candidateSetSha256 = requiredText(predecessor.candidateSetSha256, "predecessorResult.candidateSetSha256").toLowerCase();
  if (!SHA256.test(candidateSetSha256)) throw new Error("reviewed stage requires valid predecessorResult.candidateSetSha256");
  return {
    extractionRunId: requiredText(predecessor.extractionRunId, "predecessorResult.extractionRunId"),
    representationId: requiredText(predecessor.representationId, "predecessorResult.representationId"),
    artifactVersionId: requiredText(predecessor.artifactVersionId, "predecessorResult.artifactVersionId"),
    candidateCount: requiredCount(predecessor.candidateCount, "predecessorResult.candidateCount"),
    candidateSetSha256,
    schemaVersion: requiredText(predecessor.schemaVersion, "predecessorResult.schemaVersion"),
    skillId: requiredText(predecessor.skillId, "predecessorResult.skillId"),
    skillVersion: requiredText(predecessor.skillVersion, "predecessorResult.skillVersion"),
  };
}

function metricCode(candidate: ReviewCandidate): string | undefined {
  if (candidate.candidateType !== "metric_observation") return undefined;
  const value = candidate.payload.metricCode ?? candidate.payload.metric_code;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function exceptionUniverse(candidate: ReviewCandidate): string[] {
  const codes = new Set(candidate.exceptionCodes);
  if (candidate.candidateType === "exception") codes.add(SYNTHETIC_EXCEPTION_CODE);
  return [...codes].sort();
}

export function reviewRequirementFor(candidate: ReviewCandidate): CandidateReviewRequirement {
  const critical = CRITICAL_METRIC_CODES.has(metricCode(candidate) ?? "");
  const exceptions = exceptionUniverse(candidate);
  const blockingReasons = ["independent_review_required"];
  if (critical) blockingReasons.push("critical_fact_four_eyes");
  if (exceptions.length > 0) blockingReasons.push("exception_resolution_required");

  // Straight-through approval is deliberately not activated here. Confluence allows
  // it only after statistically credible evidence exists for the relevant template,
  // metric, extraction method and semantic dimensions; no such activation decision
  // exists in the current governed baseline. Requiring review for every candidate
  // therefore also covers low-confidence candidates without inventing a threshold.
  return {
    candidateId: candidate.candidateId,
    candidateFingerprintSha256: sha256({
      candidateKey: candidate.candidateKey,
      candidateType: candidate.candidateType,
      payload: candidate.payload,
      confidence: candidate.confidence,
      provenance: candidate.provenance,
      exceptionCodes: candidate.exceptionCodes,
      sourceReferenceCount: candidate.sourceReferenceCount,
    }),
    riskTier: critical ? "critical" : "standard",
    requiredApprovals: critical ? 2 : 1,
    requiresExceptionResolution: exceptions.length > 0,
    blockingReasons,
  };
}

export function evaluateCandidateReview(
  candidate: ReviewCandidate,
  requirement: CandidateReviewRequirement,
  events: StoredCandidateReviewEvent[],
): CandidateGateState {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const latestCorrection = [...ordered].reverse().find((event) => event.decision === "correct");
  const epoch = ordered.filter((event) => event.sequence > (latestCorrection?.sequence ?? 0));
  const rejected = epoch.some((event) => event.decision === "reject");
  const approvers = new Set(epoch.filter((event) => event.decision === "approve").map((event) => event.actorSubject));
  const resolved = new Set<string>();
  for (const event of epoch) {
    if (event.decision !== "resolve_exception") continue;
    for (const code of event.resolvedExceptionCodes ?? []) resolved.add(code);
  }
  const unresolvedExceptionCodes = exceptionUniverse(candidate).filter((code) => !resolved.has(code));
  const approvalCount = approvers.size;
  return {
    candidateId: candidate.candidateId,
    ready: !rejected && approvalCount >= requirement.requiredApprovals && unresolvedExceptionCodes.length === 0,
    approvalCount,
    requiredApprovals: requirement.requiredApprovals,
    rejected,
    unresolvedExceptionCodes,
  };
}

export function evaluateExtractionReviewGate(input: {
  run: ExtractionReviewRun;
  candidates: ReviewCandidate[];
  requirements: CandidateReviewRequirement[];
  events: StoredCandidateReviewEvent[];
}): ExtractionReviewGate {
  const requirementByCandidate = new Map(input.requirements.map((requirement) => [requirement.candidateId, requirement]));
  const eventsByCandidate = new Map<string, StoredCandidateReviewEvent[]>();
  for (const event of input.events) {
    const existing = eventsByCandidate.get(event.candidateId) ?? [];
    existing.push(event);
    eventsByCandidate.set(event.candidateId, existing);
  }
  const candidates = [...input.candidates].sort((left, right) => left.candidateKey.localeCompare(right.candidateKey));
  const states = candidates.map((candidate) => {
    const requirement = requirementByCandidate.get(candidate.candidateId);
    if (!requirement) throw new Error(`review requirement missing for candidate ${candidate.candidateId}`);
    return evaluateCandidateReview(candidate, requirement, eventsByCandidate.get(candidate.candidateId) ?? []);
  });
  const eventDigest = [...input.events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => ({
      reviewEventId: event.reviewEventId,
      sequence: event.sequence,
      candidateId: event.candidateId,
      actorSubject: event.actorSubject,
      decision: event.decision,
      reasonCode: event.reasonCode,
      correctionPayload: event.correctionPayload,
      resolvedExceptionCodes: event.resolvedExceptionCodes ?? [],
    }));
  const blockingCandidateCount = states.filter((state) => !state.ready).length;
  return {
    extractionRunId: input.run.extractionRunId,
    candidateSetSha256: input.run.candidateSetSha256,
    decisionSetSha256: sha256(eventDigest),
    status: blockingCandidateCount === 0 ? "ready" : "pending",
    candidateCount: candidates.length,
    blockingCandidateCount,
    criticalCandidateCount: input.requirements.filter((requirement) => requirement.riskTier === "critical").length,
    exceptionCandidateCount: input.requirements.filter((requirement) => requirement.requiresExceptionResolution).length,
    candidates: states,
  };
}

export class PostgresCandidateReviewRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async findReadyRun(input: { tenantId: string; documentId: string; extractionRunId: string }): Promise<ExtractionReviewRun | undefined> {
    const rows = await this.db.query(`select extraction_run_id,document_id,document_artifact_version_id,
        representation_id,candidate_count,candidate_set_sha256,schema_version,skill_id,skill_version,status
      from corvis_source.extraction_run
      where tenant_id=$1::uuid and document_id=$2::uuid and extraction_run_id=$3::uuid
      limit 1`, [input.tenantId, input.documentId, input.extractionRunId]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      extractionRunId: text(row, "extraction_run_id"),
      documentId: text(row, "document_id"),
      artifactVersionId: text(row, "document_artifact_version_id"),
      representationId: text(row, "representation_id"),
      candidateCount: Number(row.candidate_count ?? -1),
      candidateSetSha256: text(row, "candidate_set_sha256").toLowerCase(),
      schemaVersion: text(row, "schema_version"),
      skillId: text(row, "skill_id"),
      skillVersion: text(row, "skill_version"),
      status: text(row, "status"),
    };
  }

  async listCandidates(input: { tenantId: string; extractionRunId: string }): Promise<ReviewCandidate[]> {
    const rows = await this.db.query(`select candidate_id,candidate_key,candidate_type,payload,confidence,
        provenance,exception_codes,source_reference_count
      from corvis_source.extraction_candidate
      where tenant_id=$1::uuid and extraction_run_id=$2::uuid
      order by candidate_key`, [input.tenantId, input.extractionRunId]);
    return rows.map((row) => ({
      candidateId: text(row, "candidate_id"),
      candidateKey: text(row, "candidate_key"),
      candidateType: text(row, "candidate_type"),
      payload: jsonObject(row.payload, "candidate payload"),
      confidence: jsonObject(row.confidence, "candidate confidence"),
      provenance: jsonObject(row.provenance, "candidate provenance"),
      exceptionCodes: stringArray(row.exception_codes ?? [], "candidate exception codes"),
      sourceReferenceCount: Number(row.source_reference_count ?? -1),
    }));
  }

  async ensureRequirement(input: {
    tenantId: string;
    extractionRunId: string;
    requirement: CandidateReviewRequirement;
  }): Promise<void> {
    const requirement = input.requirement;
    const params: PostgresPrimitive[] = [
      input.tenantId,input.extractionRunId,requirement.candidateId,CANDIDATE_REVIEW_POLICY_VERSION,
      requirement.candidateFingerprintSha256,requirement.riskTier,requirement.requiredApprovals,
      requirement.requiresExceptionResolution,JSON.stringify(requirement.blockingReasons),
    ];
    await this.db.query(`insert into corvis_review.candidate_review_requirement (
        tenant_id,extraction_run_id,candidate_id,review_policy_version,candidate_fingerprint_sha256,
        risk_tier,required_approvals,requires_exception_resolution,blocking_reasons
      ) values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb)
      on conflict (tenant_id,extraction_run_id,candidate_id,review_policy_version) do nothing`, params);
    const rows = await this.db.query(`select candidate_fingerprint_sha256,risk_tier,required_approvals,
        requires_exception_resolution,blocking_reasons
      from corvis_review.candidate_review_requirement
      where tenant_id=$1::uuid and extraction_run_id=$2::uuid and candidate_id=$3::uuid and review_policy_version=$4
      limit 1`, [input.tenantId,input.extractionRunId,requirement.candidateId,CANDIDATE_REVIEW_POLICY_VERSION]);
    const row = rows[0];
    if (!row) throw new Error("reviewed stage could not persist candidate review requirement");
    const actual = {
      candidateFingerprintSha256: text(row, "candidate_fingerprint_sha256"),
      riskTier: text(row, "risk_tier"),
      requiredApprovals: Number(row.required_approvals ?? -1),
      requiresExceptionResolution: row.requires_exception_resolution === true || row.requires_exception_resolution === "true",
      blockingReasons: stringArray(row.blocking_reasons, "persisted blocking reasons"),
    };
    const expected = {
      candidateFingerprintSha256: requirement.candidateFingerprintSha256,
      riskTier: requirement.riskTier,
      requiredApprovals: requirement.requiredApprovals,
      requiresExceptionResolution: requirement.requiresExceptionResolution,
      blockingReasons: requirement.blockingReasons,
    };
    if (stable(actual) !== stable(expected)) throw new Error("existing candidate review requirement conflicts with immutable review policy");
  }

  async listEvents(input: { tenantId: string; extractionRunId: string }): Promise<StoredCandidateReviewEvent[]> {
    const rows = await this.db.query(`select review_event_id,event_sequence,candidate_id,actor_subject,decision,
        reason_code,correction_payload,resolved_exception_codes
      from corvis_review.candidate_review_event
      where tenant_id=$1::uuid and extraction_run_id=$2::uuid and review_policy_version=$3
      order by event_sequence`, [input.tenantId,input.extractionRunId,CANDIDATE_REVIEW_POLICY_VERSION]);
    return rows.map((row) => ({
      reviewEventId: text(row, "review_event_id"),
      sequence: Number(row.event_sequence ?? -1),
      candidateId: text(row, "candidate_id"),
      actorSubject: text(row, "actor_subject"),
      decision: text(row, "decision") as CandidateReviewDecision["decision"],
      reasonCode: text(row, "reason_code"),
      correctionPayload: row.correction_payload == null ? undefined : jsonObject(row.correction_payload, "review correction payload"),
      resolvedExceptionCodes: stringArray(row.resolved_exception_codes ?? [], "resolved exception codes"),
    }));
  }

  async appendDecision(input: {
    tenantId: string;
    extractionRunId: string;
    decision: CandidateReviewDecision;
  }): Promise<void> {
    const decision = input.decision;
    await this.db.query(`insert into corvis_review.candidate_review_event (
        tenant_id,review_event_id,extraction_run_id,candidate_id,review_policy_version,
        actor_subject,decision,reason_code,correction_payload,resolved_exception_codes
      ) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
      on conflict (tenant_id,review_event_id) do nothing`, [
      input.tenantId,decision.reviewEventId,input.extractionRunId,decision.candidateId,
      CANDIDATE_REVIEW_POLICY_VERSION,decision.actorSubject,decision.decision,decision.reasonCode,
      decision.correctionPayload ? JSON.stringify(decision.correctionPayload) : null,
      JSON.stringify(decision.resolvedExceptionCodes ?? []),
    ]);
    const rows = await this.db.query(`select extraction_run_id,candidate_id,review_policy_version,actor_subject,
        decision,reason_code,correction_payload,resolved_exception_codes
      from corvis_review.candidate_review_event
      where tenant_id=$1::uuid and review_event_id=$2::uuid limit 1`, [input.tenantId,decision.reviewEventId]);
    const row = rows[0];
    if (!row) throw new Error("candidate review decision was not persisted");
    const actual = {
      extractionRunId: text(row, "extraction_run_id"),
      candidateId: text(row, "candidate_id"),
      reviewPolicyVersion: text(row, "review_policy_version"),
      actorSubject: text(row, "actor_subject"),
      decision: text(row, "decision"),
      reasonCode: text(row, "reason_code"),
      correctionPayload: row.correction_payload == null ? undefined : jsonObject(row.correction_payload, "persisted correction payload"),
      resolvedExceptionCodes: stringArray(row.resolved_exception_codes ?? [], "persisted resolved exception codes"),
    };
    const expected = {
      extractionRunId: input.extractionRunId,
      candidateId: decision.candidateId,
      reviewPolicyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
      actorSubject: decision.actorSubject,
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      correctionPayload: decision.correctionPayload,
      resolvedExceptionCodes: decision.resolvedExceptionCodes ?? [],
    };
    if (stable(actual) !== stable(expected)) throw new Error(REVIEW_EVENT_REUSED);
  }

  async saveGate(input: { tenantId: string; gate: ExtractionReviewGate }): Promise<void> {
    const gate = input.gate;
    await this.db.query(`insert into corvis_review.extraction_review_gate (
        tenant_id,extraction_run_id,review_policy_version,candidate_set_sha256,decision_set_sha256,
        status,candidate_count,blocking_candidate_count,critical_candidate_count,exception_candidate_count,evaluated_at
      ) values ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,now())
      on conflict (tenant_id,extraction_run_id,review_policy_version) do update set
        candidate_set_sha256=excluded.candidate_set_sha256,
        decision_set_sha256=excluded.decision_set_sha256,
        status=excluded.status,
        candidate_count=excluded.candidate_count,
        blocking_candidate_count=excluded.blocking_candidate_count,
        critical_candidate_count=excluded.critical_candidate_count,
        exception_candidate_count=excluded.exception_candidate_count,
        evaluated_at=now()`, [
      input.tenantId,gate.extractionRunId,CANDIDATE_REVIEW_POLICY_VERSION,gate.candidateSetSha256,
      gate.decisionSetSha256,gate.status,gate.candidateCount,gate.blockingCandidateCount,
      gate.criticalCandidateCount,gate.exceptionCandidateCount,
    ]);
  }

  async resumeReviewedStage(input: { tenantId: string; documentId: string; extractionRunId: string }): Promise<boolean> {
    const rows = await this.db.query(`select * from corvis_control.resume_blocked_reviewed_stage(
      $1::uuid,$2,$3::uuid,$4)`, [
      input.tenantId,`reviewed:${input.documentId}`,input.extractionRunId,CANDIDATE_REVIEW_POLICY_VERSION,
    ]);
    const row = rows[0];
    return row?.resumed === true || row?.resumed === "true";
  }
}

function runMatches(run: ExtractionReviewRun, predecessor: ExtractionPredecessorResult): boolean {
  return run.status === "ready"
    && run.extractionRunId === predecessor.extractionRunId
    && run.artifactVersionId === predecessor.artifactVersionId
    && run.representationId === predecessor.representationId
    && run.candidateCount === predecessor.candidateCount
    && run.candidateSetSha256 === predecessor.candidateSetSha256
    && run.schemaVersion === predecessor.schemaVersion
    && run.skillId === predecessor.skillId
    && run.skillVersion === predecessor.skillVersion;
}

async function loadGateState(input: {
  repository: PostgresCandidateReviewRepository;
  tenantId: string;
  documentId: string;
  extractionRunId: string;
  predecessor?: ExtractionPredecessorResult;
  /** An already-loaded run for this same tenant/document/run id. */
  run?: ExtractionReviewRun;
  /** Candidates already loaded, validated and whose requirements were already ensured in this request. */
  candidates?: ReviewCandidate[];
}): Promise<{ run: ExtractionReviewRun; candidates: ReviewCandidate[]; gate: ExtractionReviewGate }> {
  const run = input.run ?? await input.repository.findReadyRun({
    tenantId: input.tenantId,
    documentId: input.documentId,
    extractionRunId: input.extractionRunId,
  });
  if (!run || run.status !== "ready") throw new Error("reviewed stage requires finalized ready extraction run");
  if (input.predecessor && !runMatches(run, input.predecessor)) {
    throw new Error("reviewed stage extraction lineage no longer matches the extracted stage result");
  }
  const candidates = input.candidates ?? await input.repository.listCandidates({ tenantId: input.tenantId, extractionRunId: run.extractionRunId });
  if (candidates.length !== run.candidateCount) throw new Error("reviewed stage candidate count no longer matches finalized extraction run");
  const requirements = candidates.map(reviewRequirementFor);
  if (!input.candidates) {
    for (const requirement of requirements) {
      await input.repository.ensureRequirement({ tenantId: input.tenantId, extractionRunId: run.extractionRunId, requirement });
    }
  }
  const events = await input.repository.listEvents({ tenantId: input.tenantId, extractionRunId: run.extractionRunId });
  const gate = evaluateExtractionReviewGate({ run, candidates, requirements, events });
  await input.repository.saveGate({ tenantId: input.tenantId, gate });
  return { run, candidates, gate };
}

export function createReviewedStageHandler(repository: PostgresCandidateReviewRepository): ProcessingStageHandler {
  return async (effect, signal) => {
    if (effect.stage !== "reviewed") throw new Error(`reviewed handler cannot execute stage ${effect.stage}`);
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("reviewed stage execution aborted");
    const predecessor = predecessorResult(effect);
    const { run, gate } = await loadGateState({
      repository,
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      extractionRunId: predecessor.extractionRunId,
      predecessor,
    });
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("reviewed stage execution aborted");
    if (gate.status !== "ready") {
      throw new ProcessingStageBlockedError("review_required", {
        extractionRunId: run.extractionRunId,
        reviewPolicyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
        blockingCandidateCount: gate.blockingCandidateCount,
        criticalCandidateCount: gate.criticalCandidateCount,
        exceptionCandidateCount: gate.exceptionCandidateCount,
      });
    }
    return {
      extractionRunId: run.extractionRunId,
      candidateSetSha256: run.candidateSetSha256,
      reviewPolicyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
      decisionSetSha256: gate.decisionSetSha256,
      candidateCount: gate.candidateCount,
      criticalCandidateCount: gate.criticalCandidateCount,
      exceptionCandidateCount: gate.exceptionCandidateCount,
      canonicalizationReady: true,
    };
  };
}

/**
 * A customer review command that cannot be applied because of what it names
 * or the state it targets (as opposed to an internal/persistence failure).
 * `status` is the HTTP status the review route answers with.
 */
export class CandidateReviewRequestError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409;
  constructor(code: string, status: 400 | 404 | 409) {
    super(code);
    this.name = "CandidateReviewRequestError";
    this.code = code;
    this.status = status;
  }
}

function postgresErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export async function recordCandidateReviewDecision(input: {
  db: PostgresSqlApi;
  tenantId: string;
  documentId: string;
  extractionRunId: string;
  decision: CandidateReviewDecision;
}): Promise<ExtractionReviewGate> {
  const repository = new PostgresCandidateReviewRepository(input.db);
  const actorSubject = requiredText(input.decision.actorSubject, "review actor subject");
  const reasonCode = requiredText(input.decision.reasonCode, "review reason code");
  const decision = { ...input.decision, actorSubject, reasonCode };
  if (!["approve","reject","correct","resolve_exception"].includes(decision.decision)) {
    throw new Error("unsupported candidate review decision");
  }
  if (decision.decision === "correct" && !object(decision.correctionPayload)) {
    throw new Error("candidate correction requires correctionPayload object");
  }

  const run = await repository.findReadyRun({
    tenantId: input.tenantId,
    documentId: input.documentId,
    extractionRunId: input.extractionRunId,
  });
  if (!run) throw new CandidateReviewRequestError("extraction_run_not_found", 404);
  if (run.status !== "ready") throw new CandidateReviewRequestError("extraction_run_not_ready", 409);

  const initial = await loadGateState({
    repository,
    tenantId: input.tenantId,
    documentId: input.documentId,
    extractionRunId: input.extractionRunId,
    run,
  });
  const candidate = initial.candidates.find((entry) => entry.candidateId === decision.candidateId);
  if (!candidate) throw new CandidateReviewRequestError("candidate_not_found", 404);
  const allowedExceptions = new Set(exceptionUniverse(candidate));
  if (decision.decision === "resolve_exception") {
    const codes = decision.resolvedExceptionCodes ?? [];
    if (codes.length === 0 || codes.some((code) => !allowedExceptions.has(code))) {
      throw new CandidateReviewRequestError("unknown_candidate_exception_codes", 400);
    }
  } else if ((decision.resolvedExceptionCodes ?? []).length > 0) {
    throw new CandidateReviewRequestError("resolved_exception_codes_not_allowed", 400);
  }

  try {
    await repository.appendDecision({ tenantId: input.tenantId, extractionRunId: input.extractionRunId, decision });
  } catch (error) {
    // guard_review_event_lifecycle (migration 025) raises while the reviewed
    // stage is running and after it has succeeded: the review is closed.
    if (postgresErrorCode(error) === "P0001") throw new CandidateReviewRequestError("candidate_review_closed", 409);
    if (error instanceof Error && error.message === REVIEW_EVENT_REUSED) throw new CandidateReviewRequestError("idempotency_key_reused", 409);
    throw error;
  }
  // Requirements were ensured (and verified immutable) by the load above; the
  // re-evaluation only needs the new event, not another 2N requirement round trips.
  const evaluated = await loadGateState({
    repository,
    tenantId: input.tenantId,
    documentId: input.documentId,
    extractionRunId: input.extractionRunId,
    run,
    candidates: initial.candidates,
  });
  if (evaluated.gate.status === "ready") {
    await repository.resumeReviewedStage({
      tenantId: input.tenantId,
      documentId: input.documentId,
      extractionRunId: input.extractionRunId,
    });
  }
  return evaluated.gate;
}

export function createConfiguredReviewedStageHandler(db: PostgresSqlApi): ProcessingStageHandler {
  return createReviewedStageHandler(new PostgresCandidateReviewRepository(db));
}
