import { randomUUID } from "crypto";
import { assertPermission, type SnapshotPublication } from "@/shared/domain/enterprise";
import { runAuditedMutation } from "@/modules/governance/server/audited-mutation";
import { PostgresProductionPlatform, platform } from "@/platform/data/platform";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/http";
import { MAX_VERSION } from "@/platform/http/request-validation";
import { logEvent } from "@/platform/observability/telemetry";
import { bestEffortNotification, enqueuePinnedFundPublished } from "@/modules/notifications/server/notifications";

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
      mutate: async (db) => {
        if (!db) return platform().publish(identity, command);
        const published = await new PostgresProductionPlatform(db).publish(identity, command);
        if (command.action === "publish") {
          await bestEffortNotification(db, `pinned_fund_published:${command.snapshotId}`, () => enqueuePinnedFundPublished(db, { tenantId: identity.tenantId, snapshotId: command.snapshotId }), { inTransaction: true });
        }
        return published;
      },
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
