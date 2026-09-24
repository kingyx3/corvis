import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CANDIDATE_REVIEW_POLICY_VERSION,
  CandidateReviewRequestError,
  evaluateCandidateReview,
  evaluateExtractionReviewGate,
  PostgresCandidateReviewRepository,
  recordCandidateReviewDecision,
  reviewRequirementFor,
  type CandidateReviewDecision,
  type CandidateReviewRequirement,
  type ExtractionReviewRun,
  type ReviewCandidate,
  type StoredCandidateReviewEvent,
} from "./processing-reviewed-stage.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const run: ExtractionReviewRun = {
  extractionRunId: "11111111-1111-4111-8111-111111111111",
  documentId: "22222222-2222-4222-8222-222222222222",
  artifactVersionId: "33333333-3333-4333-8333-333333333333",
  representationId: "44444444-4444-4444-8444-444444444444",
  candidateCount: 1,
  candidateSetSha256: "a".repeat(64),
  schemaVersion: "1.2",
  skillId: "quarterly_fund_report_extraction",
  skillVersion: "1.6",
  status: "ready",
};

function candidate(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    candidateId: "55555555-5555-4555-8555-555555555555",
    candidateKey: "metric:revenue:2026-06-30",
    candidateType: "metric_observation",
    payload: { metricCode: "revenue", valueNumeric: "125400000", currency: "USD" },
    confidence: { value: 0.99, currency: 0.85, period: 0.99 },
    provenance: { extractionRunId: run.extractionRunId, modelProvider: "replaceable-model" },
    exceptionCodes: [],
    sourceReferenceCount: 1,
    ...overrides,
  };
}

function event(sequence: number, overrides: Partial<StoredCandidateReviewEvent> = {}): StoredCandidateReviewEvent {
  return {
    reviewEventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sequence,
    candidateId: candidate().candidateId,
    actorSubject: `reviewer-${sequence}`,
    decision: "approve",
    reasonCode: "SOURCE_VERIFIED",
    resolvedExceptionCodes: [],
    ...overrides,
  };
}

test("review policy does not invent confidence thresholds or straight-through approval", () => {
  const veryHighConfidence = candidate({ confidence: { value: 1, currency: 1, period: 1 } });
  const lowConfidence = candidate({
    candidateId: "66666666-6666-4666-8666-666666666666",
    candidateKey: "company:name",
    candidateType: "company",
    confidence: { entity: 0.15 },
  });

  const highRequirement = reviewRequirementFor(veryHighConfidence);
  const lowRequirement = reviewRequirementFor(lowConfidence);

  assert.equal(highRequirement.requiredApprovals, 2, "governed critical revenue remains four-eyes even at confidence 1.0");
  assert.equal(lowRequirement.requiredApprovals, 1, "non-critical candidates still require independent review without an invented cutoff");
  assert.ok(highRequirement.blockingReasons.includes("independent_review_required"));
  assert.ok(lowRequirement.blockingReasons.includes("independent_review_required"));
});

test("critical metric candidate requires two distinct reviewers", () => {
  const row = candidate();
  const requirement = reviewRequirementFor(row);
  assert.equal(requirement.riskTier, "critical");
  assert.equal(requirement.requiredApprovals, 2);

  const one = evaluateCandidateReview(row, requirement, [event(1, { actorSubject: "alice" })]);
  assert.equal(one.ready, false);
  assert.equal(one.approvalCount, 1);

  const duplicateActor = evaluateCandidateReview(row, requirement, [
    event(1, { actorSubject: "alice" }),
    event(2, { actorSubject: "alice" }),
  ]);
  assert.equal(duplicateActor.ready, false);
  assert.equal(duplicateActor.approvalCount, 1);

  const two = evaluateCandidateReview(row, requirement, [
    event(1, { actorSubject: "alice" }),
    event(2, { actorSubject: "bob" }),
  ]);
  assert.equal(two.ready, true);
  assert.equal(two.approvalCount, 2);
});

test("correction creates a new approval epoch and leaves candidate evidence immutable", () => {
  const row = candidate();
  const original = structuredClone(row);
  const requirement = reviewRequirementFor(row);
  const events: StoredCandidateReviewEvent[] = [
    event(1, { actorSubject: "alice" }),
    event(2, { actorSubject: "bob" }),
    event(3, {
      actorSubject: "carol",
      decision: "correct",
      reasonCode: "SOURCE_VALUE_CORRECTION",
      correctionPayload: { valueNumeric: "126000000" },
    }),
    event(4, { actorSubject: "alice" }),
  ];
  const state = evaluateCandidateReview(row, requirement, events);
  assert.equal(state.ready, false);
  assert.equal(state.approvalCount, 1, "approvals before correction cannot satisfy the new epoch");
  assert.deepEqual(row, original, "review decisions must not rewrite extraction payload/confidence/provenance");

  const ready = evaluateCandidateReview(row, requirement, [...events, event(5, { actorSubject: "bob" })]);
  assert.equal(ready.ready, true);
});

test("candidate exceptions require explicit resolution in addition to approval", () => {
  const row = candidate({
    candidateId: "77777777-7777-4777-8777-777777777777",
    candidateKey: "metric:unmapped",
    candidateType: "metric_observation",
    payload: { metricCode: "unknown_metric" },
    exceptionCodes: ["TAXONOMY_EXTENSION_REQUIRED"],
  });
  const requirement = reviewRequirementFor(row);
  assert.equal(requirement.requiresExceptionResolution, true);
  assert.ok(requirement.blockingReasons.includes("exception_resolution_required"));

  const approvedOnly = evaluateCandidateReview(row, requirement, [event(1, {
    candidateId: row.candidateId,
    actorSubject: "alice",
  })]);
  assert.equal(approvedOnly.ready, false);
  assert.deepEqual(approvedOnly.unresolvedExceptionCodes, ["TAXONOMY_EXTENSION_REQUIRED"]);

  const resolved = evaluateCandidateReview(row, requirement, [
    event(1, { candidateId: row.candidateId, actorSubject: "alice" }),
    event(2, {
      candidateId: row.candidateId,
      actorSubject: "steward",
      decision: "resolve_exception",
      reasonCode: "GOVERNED_EXCEPTION_RESOLUTION",
      resolvedExceptionCodes: ["TAXONOMY_EXTENSION_REQUIRED"],
    }),
  ]);
  assert.equal(resolved.ready, true);
});

test("exception candidates never become ready from approval alone", () => {
  const row = candidate({
    candidateId: "88888888-8888-4888-8888-888888888888",
    candidateKey: "exception:scope",
    candidateType: "exception",
    payload: { code: "SCOPE_AMBIGUITY" },
  });
  const requirement = reviewRequirementFor(row);
  const approved = evaluateCandidateReview(row, requirement, [event(1, { candidateId: row.candidateId })]);
  assert.equal(approved.ready, false);
  assert.equal(approved.unresolvedExceptionCodes.length, 1);
});

test("extraction gate is ready only when every candidate satisfies its requirement", () => {
  const critical = candidate();
  const standard = candidate({
    candidateId: "99999999-9999-4999-8999-999999999999",
    candidateKey: "company:acme",
    candidateType: "company",
    payload: { name: "Acme" },
  });
  const requirements: CandidateReviewRequirement[] = [reviewRequirementFor(critical), reviewRequirementFor(standard)];
  const gate = evaluateExtractionReviewGate({
    run: { ...run, candidateCount: 2 },
    candidates: [standard, critical],
    requirements,
    events: [
      event(1, { candidateId: critical.candidateId, actorSubject: "alice" }),
      event(2, { candidateId: critical.candidateId, actorSubject: "bob" }),
      event(3, { candidateId: standard.candidateId, actorSubject: "alice" }),
    ],
  });
  assert.equal(gate.status, "ready");
  assert.equal(gate.blockingCandidateCount, 0);
  assert.equal(gate.criticalCandidateCount, 1);
  assert.match(gate.decisionSetSha256, /^[0-9a-f]{64}$/);
});

test("review migration is forced-RLS, append-only, resumable, and persistence-blocks canonicalization", async () => {
  const sql = (await readFile("db/postgres/migrations/025_review_quality_gate.sql", "utf8")).toLowerCase();
  assert.match(sql, /create table if not exists corvis_review\.candidate_review_event/);
  assert.match(sql, /alter table corvis_review\.candidate_review_event force row level security/);
  assert.match(sql, /alter table corvis_review\.candidate_review_requirement force row level security/);
  assert.match(sql, /alter table corvis_review\.extraction_review_gate force row level security/);
  assert.equal(/create policy[^;]+corvis_review/.test(sql), false);
  assert.match(sql, /create or replace function corvis_control\.block_processing_stage_delivery/);
  assert.match(sql, /set state='blocked'/);
  assert.match(sql, /create or replace function corvis_control\.resume_blocked_reviewed_stage/);
  assert.match(sql, /g\.status='ready'/);
  assert.match(sql, /review gate blocks canonicalization/);
  assert.match(sql, /old\.stage='reviewed'[\s\S]+new\.state='succeeded'/);
  assert.match(sql, new RegExp(CANDIDATE_REVIEW_POLICY_VERSION));
  assert.equal(/update\s+corvis_source\.extraction_candidate\s+set/i.test(sql), false);
});

test("review resume targets the blocked reviewed job of the extraction run's own correlation, not the primary job id", async () => {
  const calls: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  const responses: PostgresRow[][] = [
    [{ job_id: `correction:incident-1:reviewed:${run.documentId}` }],
    [{ resumed: true, resume_event_id: "77777777-7777-4777-8777-777777777777", job_version: 4 }],
  ];
  const db: PostgresSqlApi = {
    async query(sql: string, parameters: PostgresPrimitive[] = []) { calls.push({ sql, parameters }); return responses.shift() ?? []; },
    async execute() {},
    async health() { return true; },
  };
  const resumed = await new PostgresCandidateReviewRepository(db).resumeReviewedStage({
    tenantId: "88888888-8888-4888-8888-888888888888",
    documentId: run.documentId,
    extractionRunId: run.extractionRunId,
  });
  assert.equal(resumed, true);
  assert.match(calls[0]!.sql, /j\.stage='reviewed' and j\.state='blocked'/);
  assert.match(calls[0]!.sql, /e\.result ->> 'extractionRunId'=\$3[\s\S]*extracted\.correlation_id=j\.correlation_id/);
  assert.deepEqual(calls[0]!.parameters, ["88888888-8888-4888-8888-888888888888", run.documentId, run.extractionRunId]);
  assert.match(calls[1]!.sql, /resume_blocked_reviewed_stage/);
  assert.equal(calls[1]!.parameters[1], `correction:incident-1:reviewed:${run.documentId}`);
});

test("review requirements persist and verify in two round trips regardless of candidate count", async () => {
  const candidates = Array.from({ length: 50 }, (_, index) => candidate({
    candidateId: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
    candidateKey: `metric:revenue:${index}`,
  }));
  const requirements = candidates.map(reviewRequirementFor);
  const persisted = requirements.map((requirement) => ({
    candidate_id: requirement.candidateId,
    candidate_fingerprint_sha256: requirement.candidateFingerprintSha256,
    risk_tier: requirement.riskTier,
    required_approvals: requirement.requiredApprovals,
    requires_exception_resolution: requirement.requiresExceptionResolution,
    blocking_reasons: JSON.stringify(requirement.blockingReasons),
  }));
  const calls: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  let responses: PostgresRow[][] = [[], persisted];
  const db: PostgresSqlApi = {
    async query(sql: string, parameters: PostgresPrimitive[] = []) { calls.push({ sql, parameters }); return responses.shift() ?? []; },
    async execute() {},
    async health() { return true; },
  };
  const repository = new PostgresCandidateReviewRepository(db);
  const tenantId = "88888888-8888-4888-8888-888888888888";
  await repository.ensureRequirements({ tenantId, extractionRunId: run.extractionRunId, requirements });
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.sql, /jsonb_to_recordset\(\$4::jsonb\)[\s\S]*on conflict \(tenant_id,extraction_run_id,candidate_id,review_policy_version\) do nothing/);
  assert.equal((JSON.parse(String(calls[0]!.parameters[3])) as unknown[]).length, 50);

  // A persisted requirement that drifted from the immutable policy still fails closed.
  responses = [[], persisted.map((row, index) => index === 7 ? { ...row, required_approvals: 9 } : row)];
  await assert.rejects(
    repository.ensureRequirements({ tenantId, extractionRunId: run.extractionRunId, requirements }),
    /conflicts with immutable review policy/,
  );
  // A requirement that was not persisted at all fails closed.
  responses = [[], persisted.slice(1)];
  await assert.rejects(
    repository.ensureRequirements({ tenantId, extractionRunId: run.extractionRunId, requirements }),
    /could not persist candidate review requirement/,
  );
});


const TENANT = "66666666-6666-4666-8666-666666666666";

/** In-memory model of the candidate review tables, dispatching on the SQL the repository issues. */
class FakeReviewDb implements PostgresSqlApi {
  readonly calls: string[] = [];
  candidates: ReviewCandidate[] = [candidate()];
  reviewClosed = false;
  private readonly requirements = new Map<string, PostgresRow>();
  private readonly events = new Map<string, PostgresRow>();

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push(sql);
    if (sql.includes("from corvis_source.extraction_run")) {
      if (parameters[0] !== TENANT || parameters[1] !== run.documentId || parameters[2] !== run.extractionRunId) return [];
      return [{
        extraction_run_id: run.extractionRunId, document_id: run.documentId, document_artifact_version_id: run.artifactVersionId,
        representation_id: run.representationId, candidate_count: this.candidates.length, candidate_set_sha256: run.candidateSetSha256,
        schema_version: run.schemaVersion, skill_id: run.skillId, skill_version: run.skillVersion, status: "ready",
      }];
    }
    if (sql.includes("from corvis_source.extraction_candidate")) {
      return this.candidates.map((entry) => ({
        candidate_id: entry.candidateId, candidate_key: entry.candidateKey, candidate_type: entry.candidateType,
        payload: entry.payload, confidence: entry.confidence, provenance: entry.provenance,
        exception_codes: entry.exceptionCodes, source_reference_count: entry.sourceReferenceCount,
      }));
    }
    if (sql.includes("insert into corvis_review.candidate_review_requirement")) {
      for (const record of JSON.parse(String(parameters[3])) as PostgresRow[]) {
        const key = String(record.candidate_id);
        if (!this.requirements.has(key)) this.requirements.set(key, record);
      }
      return [];
    }
    if (sql.includes("from corvis_review.candidate_review_requirement")) {
      return [...this.requirements.values()];
    }
    if (sql.includes("insert into corvis_review.candidate_review_event")) {
      if (this.reviewClosed) throw Object.assign(new Error("Postgres query failed (SQLSTATE P0001)"), { code: "P0001" });
      const id = String(parameters[1]);
      if (!this.events.has(id)) {
        this.events.set(id, {
          review_event_id: id, event_sequence: this.events.size + 1, extraction_run_id: parameters[2], candidate_id: parameters[3],
          review_policy_version: parameters[4], actor_subject: parameters[5], decision: parameters[6], reason_code: parameters[7],
          correction_payload: parameters[8], resolved_exception_codes: parameters[9],
        });
      }
      return [];
    }
    if (sql.includes("from corvis_review.candidate_review_event") && sql.includes("review_event_id=$2")) {
      const row = this.events.get(String(parameters[1]));
      return row ? [row] : [];
    }
    if (sql.includes("from corvis_review.candidate_review_event")) return [...this.events.values()];
    if (sql.includes("resume_blocked_reviewed_stage")) return [{ resumed: true }];
    return [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { await this.query(sql, parameters); }
  async health(): Promise<boolean> { return true; }
}

function decisionInput(db: FakeReviewDb, overrides: Partial<CandidateReviewDecision> = {}, target: { documentId?: string; extractionRunId?: string } = {}) {
  return {
    db,
    tenantId: TENANT,
    documentId: target.documentId ?? run.documentId,
    extractionRunId: target.extractionRunId ?? run.extractionRunId,
    decision: {
      reviewEventId: "77777777-7777-4777-8777-777777777771",
      candidateId: candidate().candidateId,
      actorSubject: "reviewer-1",
      decision: "approve" as const,
      reasonCode: "SOURCE_VERIFIED",
      ...overrides,
    },
  };
}

function rejectsWith(code: string, status: number) {
  return (error: unknown) => error instanceof CandidateReviewRequestError && error.code === code && error.status === status;
}

test("candidate review of an unknown extraction run or candidate is a 404-class request error, not an internal failure", async () => {
  await assert.rejects(
    recordCandidateReviewDecision(decisionInput(new FakeReviewDb(), {}, { extractionRunId: "88888888-8888-4888-8888-888888888888" })),
    rejectsWith("extraction_run_not_found", 404),
  );
  await assert.rejects(
    recordCandidateReviewDecision(decisionInput(new FakeReviewDb(), { candidateId: "99999999-9999-4999-8999-999999999999" })),
    rejectsWith("candidate_not_found", 404),
  );
});

test("candidate review names invalid exception codes as a 400-class request error", async () => {
  const db = new FakeReviewDb();
  db.candidates = [candidate({ exceptionCodes: ["currency_mismatch"] })];
  await assert.rejects(
    recordCandidateReviewDecision(decisionInput(db, { decision: "resolve_exception", resolvedExceptionCodes: ["not_a_code"] })),
    rejectsWith("unknown_candidate_exception_codes", 400),
  );
  await assert.rejects(
    recordCandidateReviewDecision(decisionInput(db, { decision: "approve", resolvedExceptionCodes: ["currency_mismatch"] })),
    rejectsWith("resolved_exception_codes_not_allowed", 400),
  );
});

test("candidate review after the reviewed stage has closed the ledger is a 409 conflict", async () => {
  const db = new FakeReviewDb();
  db.reviewClosed = true;
  await assert.rejects(recordCandidateReviewDecision(decisionInput(db)), rejectsWith("candidate_review_closed", 409));
});

test("reusing a review event id with different decision content is a 409 idempotency conflict", async () => {
  const db = new FakeReviewDb();
  await recordCandidateReviewDecision(decisionInput(db));
  await assert.rejects(
    recordCandidateReviewDecision(decisionInput(db, { decision: "reject" })),
    rejectsWith("idempotency_key_reused", 409),
  );
});

test("recording one decision ensures candidate requirements in one batch, not once per gate evaluation", async () => {
  const db = new FakeReviewDb();
  db.candidates = Array.from({ length: 5 }, (_, index) => candidate({
    candidateId: `55555555-5555-4555-8555-00000000000${index}`,
    candidateKey: `metric:revenue:${index}`,
  }));
  const gate = await recordCandidateReviewDecision(decisionInput(db, { candidateId: db.candidates[0]!.candidateId }));
  assert.equal(gate.candidateCount, 5);
  assert.equal(db.calls.filter((sql) => sql.includes("insert into corvis_review.candidate_review_requirement")).length, 1);
  assert.equal(db.calls.filter((sql) => sql.includes("from corvis_source.extraction_run")).length, 1);
  assert.equal(db.calls.filter((sql) => sql.includes("from corvis_source.extraction_candidate")).length, 1);
});
