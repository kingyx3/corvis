import type { EvidenceSourceDefinition } from "./control-evidence-registry.ts";

/**
 * Deterministic freshness/expiry/escalation evaluation for one evidence source.
 *
 * This mirrors, in JavaScript, the currency semantics the Postgres promotion
 * gate (`corvis_control.promote_control_implementation`) enforces server-side:
 * a source is only "current" while `now` falls inside its latest passing
 * record's validity window. Everything else is a graduated, testable signal
 * of drift so stale or missing evidence is detected and escalated instead of
 * silently treated as still valid.
 */
export type EvidenceLifecycleState =
  | "current"
  | "due_soon"
  | "stale"
  | "expired"
  | "failing"
  | "missing"
  | "not_collectable";

export type EscalationLevel = "none" | "notice" | "warning" | "breach";

export type LatestEvidenceRecord = {
  result: "pass" | "fail";
  collectedAt: Date;
  validThrough: Date;
};

export type EvidenceLifecycleEvaluation = {
  sourceKey: string;
  controlCode: string;
  state: EvidenceLifecycleState;
  escalation: EscalationLevel;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluate one source's currency against `now`. `latest` is the most recent
 * revision for that source, or `undefined` when no evidence has ever been
 * recorded — `missing` and `not_collectable` are distinct so a provider-gated
 * gap is never confused with a broken automated collector.
 */
export function evaluateSourceLifecycle(
  source: EvidenceSourceDefinition,
  latest: LatestEvidenceRecord | undefined,
  now: Date,
): EvidenceLifecycleEvaluation {
  const base = { sourceKey: source.sourceKey, controlCode: source.controlCode };

  if (source.collection === "provider_gated") {
    return { ...base, state: "not_collectable", escalation: source.mandatory ? "notice" : "none" };
  }

  if (!latest) {
    return { ...base, state: "missing", escalation: source.mandatory ? "breach" : "warning" };
  }

  if (latest.result === "fail") {
    return { ...base, state: "failing", escalation: "breach" };
  }

  const graceMs = Math.max(0, source.graceDays) * DAY_MS;
  const dueSoonMs = Math.max(1, source.graceDays) * DAY_MS;
  const nowMs = now.getTime();
  const validThroughMs = latest.validThrough.getTime();

  if (nowMs > validThroughMs + graceMs) return { ...base, state: "expired", escalation: "breach" };
  if (nowMs > validThroughMs) return { ...base, state: "stale", escalation: "warning" };
  if (nowMs > validThroughMs - dueSoonMs) return { ...base, state: "due_soon", escalation: "notice" };
  return { ...base, state: "current", escalation: "none" };
}

/**
 * A mandatory source can never count toward promotion or a clean report while
 * it is anything other than `current`. A `not_applicable`/optional source in
 * `not_collectable` or `due_soon` does not by itself block anything.
 */
export function blocksControlPromotion(evaluation: EvidenceLifecycleEvaluation, mandatory: boolean): boolean {
  if (!mandatory) return false;
  return evaluation.state !== "current";
}

/** A control can be promoted only when none of its mandatory sources are blocked. */
export function canPromoteControl(evaluations: readonly { evaluation: EvidenceLifecycleEvaluation; mandatory: boolean }[]): boolean {
  const mandatoryEvaluations = evaluations.filter((entry) => entry.mandatory);
  if (mandatoryEvaluations.length === 0) return false;
  return mandatoryEvaluations.every((entry) => !blocksControlPromotion(entry.evaluation, true));
}
