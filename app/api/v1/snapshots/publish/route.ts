import { randomUUID } from "crypto";
import { assertPermission, type SnapshotPublication } from "@/core/enterprise";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "snapshots:publish");
    const command = await request.json() as SnapshotPublication;
    if (!command.snapshotId || !["publish","withdraw","supersede"].includes(command.action) || !Number.isInteger(command.expectedVersion)) {
      return json({ error: "invalid_snapshot_command", correlationId: id }, { status: 400 });
    }
    const data = await platform().publish(identity, command);
    await platform().audit({ id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject, sessionId: identity.sessionId, action: `snapshot.${command.action}`, targetType: "fund_period_snapshot", targetId: command.snapshotId, outcome: "success", correlationId: id });
    return json({ data, correlationId: id }, { status: 202 });
  } catch (error) { return apiError(error, id); }
}
