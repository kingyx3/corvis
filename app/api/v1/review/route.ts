import { randomUUID } from "crypto";
import { assertPermission, type ReviewDecision } from "@/core/enterprise";
import { runAuditedMutation } from "@/lib/server/audited-mutation";
import { PostgresProductionPlatform, platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";

/** Versions are Postgres `integer` columns; anything outside 1..2^31-1 is malformed input, not a conflict. */
const MAX_VERSION = 2_147_483_647;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
    const body = await request.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid_review_command", correlationId: id }, { status: 400 });
    }
    const command = body as ReviewDecision;
    if (!isNonEmptyString(command.observationId) || !["approve","reject","correct"].includes(command.decision) || !isNonEmptyString(command.reasonCode)
      || !Number.isInteger(command.expectedVersion) || command.expectedVersion < 1 || command.expectedVersion > MAX_VERSION
      || (command.correctedValue !== undefined && typeof command.correctedValue !== "string")) {
      return json({ error: "invalid_review_command", correlationId: id }, { status: 400 });
    }
    if (command.decision === "correct" && !isNonEmptyString(command.correctedValue)) {
      return json({ error: "corrected_value_required", correlationId: id }, { status: 400 });
    }
    const data = await runAuditedMutation({
      mutate: (db) => db ? new PostgresProductionPlatform(db).review(identity, command) : platform().review(identity, command),
      audit: () => ({ id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject, sessionId: identity.sessionId, action: `observation.${command.decision}`, targetType: "observation", targetId: command.observationId, outcome: "success", correlationId: id }),
    });
    return json({ data, correlationId: id }, { status: 202 });
  } catch (error) { return apiError(error, id); }
}
