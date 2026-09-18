export type PublicationGateInput = {
  blockingExceptions: number;
  needsReviewCount: number;
  criticalObservationCount: number;
  independentlyReviewedCriticalCount: number;
  lineageCoverage: number;
};

export type PublicationGateResult = {
  allowed: boolean;
  reasons: string[];
};

export function evaluatePublicationGate(input: PublicationGateInput): PublicationGateResult {
  const reasons: string[] = [];
  if (input.blockingExceptions > 0) reasons.push("blocking_exceptions");
  if (input.needsReviewCount > 0) reasons.push("observations_need_review");
  if (input.independentlyReviewedCriticalCount < input.criticalObservationCount) reasons.push("critical_observations_require_independent_review");
  if (input.lineageCoverage < 1) reasons.push("incomplete_source_lineage");
  return { allowed: reasons.length === 0, reasons };
}
