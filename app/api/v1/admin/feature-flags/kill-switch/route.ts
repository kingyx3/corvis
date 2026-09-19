import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { setFeatureFlagKillSwitch } from "@/lib/server/feature-flags";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";

/**
 * Emergency single-flag stop. Engaging a kill switch denies the flag on every
 * channel on its very next evaluation, independent of the flag's own rollout
 * configuration; a reason is mandatory so the action is always attributable.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const body = await request.json() as { key?: string; engaged?: boolean; reason?: string };
    if (!body.key || typeof body.engaged !== "boolean") return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    await setFeatureFlagKillSwitch(identity, body.key, body.engaged, body.reason);
    await platform().audit({
      id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
      actorSubject: identity.subject, sessionId: identity.sessionId, action: "feature_flag.kill_switch",
      targetType: "feature_flag", targetId: body.key, outcome: "success", correlationId: id,
      metadata: { engaged: body.engaged, reason: body.reason ?? null },
    });
    return json({ data: { key: body.key, engaged: body.engaged }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
