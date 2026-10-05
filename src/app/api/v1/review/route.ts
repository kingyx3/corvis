import { randomUUID } from "crypto";
import { assertPermission, type ReviewDecision } from "@/shared/domain/enterprise";
import { runAuditedMutation } from "@/modules/governance/server/audited-mutation";
import { PostgresProductionPlatform, platform } from "@/platform/data/platform";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/http";
import { isNonEmptyString, MAX_VERSION } from "@/platform/http/request-validation";

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
