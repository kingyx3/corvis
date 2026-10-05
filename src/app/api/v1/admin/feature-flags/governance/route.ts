import { resolveAdminRequestIdentity } from "@/platform/http/identity/admin-request";
import { listFeatureFlagGovernance } from "@/modules/admin/server/feature-flags";
import { apiError, correlationId, json } from "@/platform/http/api/http";

/**
 * Authoritative flag-governance report: every registered flag's rollout,
 * ownership and retirement state, plus which flags are stale (past their
 * retire-by date) or retired. This is the cross-channel source of truth
 * `evaluateFeatureFlag` also reads for kill-switch and emergency-stop state.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    return json({ data: await listFeatureFlagGovernance(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
