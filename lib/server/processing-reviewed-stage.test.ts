import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CANDIDATE_REVIEW_POLICY_VERSION,
  evaluateCandidateReview,
  evaluateExtractionReviewGate,
  reviewRequirementFor,
  type CandidateReviewRequirement,
  type ExtractionReviewRun,
  type ReviewCandidate,
  type StoredCandidateReviewEvent,
} from "./processing-reviewed-stage.ts";

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
  assert.match(sql, /old\.stage='reviewed'.+new\.state='succeeded'/s);
  assert.match(sql, new RegExp(CANDIDATE_REVIEW_POLICY_VERSION));
  assert.equal(/update\s+corvis_source\.extraction_candidate\s+set/i.test(sql), false);
});
