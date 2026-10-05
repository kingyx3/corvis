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

/**
 * Every gate is written as the negation of its passing condition so a NaN or
 * missing count fails closed: any comparison with NaN is false, which would let
 * `x > 0` or `x < 1` style checks silently allow publication.
 */
export function evaluatePublicationGate(input: PublicationGateInput): PublicationGateResult {
  const reasons: string[] = [];
  if (!(input.blockingExceptions <= 0)) reasons.push("blocking_exceptions");
  if (!(input.needsReviewCount <= 0)) reasons.push("observations_need_review");
  if (!(input.independentlyReviewedCriticalCount >= input.criticalObservationCount)) reasons.push("critical_observations_require_independent_review");
  if (!(input.lineageCoverage >= 1)) reasons.push("incomplete_source_lineage");
  return { allowed: reasons.length === 0, reasons };
}
