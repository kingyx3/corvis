import { assertPermission } from "@/core/enterprise";
import { listFeatureFlagGovernance } from "@/lib/server/feature-flags";
import { apiError, correlationId, json } from "@/lib/server/http";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";

/**
 * Authoritative flag-governance report: every registered flag's rollout,
 * ownership and retirement state, plus which flags are stale (past their
 * retire-by date) or retired. This is the cross-channel source of truth
 * `evaluateFeatureFlag` also reads for kill-switch and emergency-stop state.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    return json({ data: await listFeatureFlagGovernance(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
