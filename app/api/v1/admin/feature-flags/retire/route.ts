import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { retireFeatureFlag } from "@/lib/server/feature-flags";
import { readJsonObject } from "@/lib/server/admin-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { PostgresOperationsRepository } from "@/lib/server/platform-repositories";
import { postgres, withTransaction } from "@/lib/server/postgres";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";

/** Retirement is terminal: a retired flag can never be re-enabled or re-registered under the same key. */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const body = await readJsonObject(request) as { key?: string } | undefined;
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    if (typeof body.key !== "string" || !body.key || body.key.length > 128) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const key = body.key;
    // Retirement is terminal and its audit event must commit together with
    // it, so a failed audit insert never leaves an unaudited retirement in place.
    await withTransaction(postgres(getServerConfig().postgresDsn), async (tx) => {
      await retireFeatureFlag(identity, key, tx);
      await new PostgresOperationsRepository(tx).audit({
        id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
        actorSubject: identity.subject, sessionId: identity.sessionId, action: "feature_flag.retire",
        targetType: "feature_flag", targetId: key, outcome: "success", correlationId: id,
      });
    });
    return json({ data: { key: body.key, retired: true }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
