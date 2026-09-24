import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { setFeatureFlagEmergencyStop } from "@/lib/server/feature-flags";
import { readJsonObject } from "@/lib/server/admin-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { PostgresOperationsRepository } from "@/lib/server/platform-repositories";
import { postgres, withTransaction } from "@/lib/server/postgres";
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
    const body = await readJsonObject(request) as { engaged?: boolean; reason?: string } | undefined;
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    if (typeof body.engaged !== "boolean") return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const engaged = body.engaged;
    // A tenant-wide emergency stop and its audit event must commit or roll
    // back together: a failed audit insert must never leave an unaudited
    // engage/release of the stop in place.
    await withTransaction(postgres(getServerConfig().postgresDsn), async (tx) => {
      await setFeatureFlagEmergencyStop(identity, engaged, body.reason, tx);
      await new PostgresOperationsRepository(tx).audit({
        id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
        actorSubject: identity.subject, sessionId: identity.sessionId, action: "feature_flag.emergency_stop",
        targetType: "tenant", targetId: identity.tenantId, outcome: "success", correlationId: id,
        metadata: { engaged, reason: body.reason ?? null },
      });
    });
    return json({ data: { engaged: body.engaged }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
