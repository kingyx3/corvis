import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { setFeatureFlagEmergencyStop } from "@/lib/server/feature-flags";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";

/**
 * Tenant-wide emergency stop. Engaging it denies every flag on every channel
 * for the tenant without requiring a write to each individual flag row.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const body = await request.json() as { engaged?: boolean; reason?: string };
    if (typeof body.engaged !== "boolean") return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    await setFeatureFlagEmergencyStop(identity, body.engaged, body.reason);
    await platform().audit({
      id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
      actorSubject: identity.subject, sessionId: identity.sessionId, action: "feature_flag.emergency_stop",
      targetType: "tenant", targetId: identity.tenantId, outcome: "success", correlationId: id,
      metadata: { engaged: body.engaged, reason: body.reason ?? null },
    });
    return json({ data: { engaged: body.engaged }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
