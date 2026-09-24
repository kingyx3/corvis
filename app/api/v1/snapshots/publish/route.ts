import { randomUUID } from "crypto";
import { assertPermission, type SnapshotPublication } from "@/core/enterprise";
import { runAuditedMutation } from "@/lib/server/audited-mutation";
import { PostgresProductionPlatform, platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { logEvent } from "@/lib/server/telemetry";

/** Versions are Postgres `integer` columns; anything outside 1..2^31-1 is malformed input, not a conflict. */
const MAX_VERSION = 2_147_483_647;

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "snapshots:publish");
    const body = await request.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid_snapshot_command", correlationId: id }, { status: 400 });
    }
    const command = body as SnapshotPublication;
    if (typeof command.snapshotId !== "string" || !command.snapshotId || !["publish","withdraw","supersede"].includes(command.action)
      || !Number.isInteger(command.expectedVersion) || command.expectedVersion < 1 || command.expectedVersion > MAX_VERSION
      || (command.reason !== undefined && command.reason !== null && typeof command.reason !== "string")) {
      return json({ error: "invalid_snapshot_command", correlationId: id }, { status: 400 });
    }
    const data = await runAuditedMutation({
      mutate: (db) => db ? new PostgresProductionPlatform(db).publish(identity, command) : platform().publish(identity, command),
      audit: () => ({ id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject, sessionId: identity.sessionId, action: `snapshot.${command.action}`, targetType: "fund_period_snapshot", targetId: command.snapshotId, outcome: "success", correlationId: id }),
    });
    logEvent("info", "snapshot.publication_transition_succeeded", {
      correlationId: id,
      tenantId: identity.tenantId,
      workspaceId: identity.workspaceId,
      actorSubject: identity.subject,
    }, {
      snapshotId: command.snapshotId,
      expectedVersion: command.expectedVersion,
      action: command.action,
      publicationEventId: data.publicationEventId,
    });
    return json({ data, correlationId: id }, { status: 202 });
  } catch (error) { return apiError(error, id); }
}
