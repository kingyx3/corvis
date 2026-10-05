import { randomUUID } from "crypto";
import { setFeatureFlagKillSwitch } from "@/modules/admin/server/feature-flags";
import { readJsonObject, resolveAdminRequestIdentity } from "@/platform/http/admin-request";
import { getServerConfig } from "@/platform/config/config";
import { apiError, correlationId, json } from "@/platform/http/http";
import { PostgresOperationsRepository } from "@/platform/data/platform-repositories";
import { postgres, withTransaction } from "@/platform/database/postgres";

/**
 * Emergency single-flag stop. Engaging a kill switch denies the flag on every
 * channel on its very next evaluation, independent of the flag's own rollout
 * configuration; a reason is mandatory so the action is always attributable.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    const body = await readJsonObject(request) as { key?: string; engaged?: boolean; reason?: string } | undefined;
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    if (typeof body.key !== "string" || !body.key || typeof body.engaged !== "boolean") return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const key = body.key;
    const engaged = body.engaged;
    // The kill switch write and its audit event must commit or roll back
    // together, so a failed audit insert never leaves an unaudited kill
    // switch change in place.
    await withTransaction(postgres(getServerConfig().databaseDsn), async (tx) => {
      await setFeatureFlagKillSwitch(identity, key, engaged, body.reason, tx);
      await new PostgresOperationsRepository(tx).audit({
        id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
        actorSubject: identity.subject, sessionId: identity.sessionId, action: "feature_flag.kill_switch",
        targetType: "feature_flag", targetId: key, outcome: "success", correlationId: id,
        metadata: { engaged, reason: body.reason ?? null },
      });
    });
    return json({ data: { key: body.key, engaged: body.engaged }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
