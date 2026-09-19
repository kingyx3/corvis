import { randomUUID } from "crypto";
import { assertPermission, type ReviewDecision } from "@/core/enterprise";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
    const command = await request.json() as ReviewDecision;
    if (!command.observationId || !["approve","reject","correct"].includes(command.decision) || !command.reasonCode || !Number.isInteger(command.expectedVersion)) {
      return json({ error: "invalid_review_command", correlationId: id }, { status: 400 });
    }
    const data = await platform().review(identity, command);
    await platform().audit({ id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject, sessionId: identity.sessionId, action: `observation.${command.decision}`, targetType: "observation", targetId: command.observationId, outcome: "success", correlationId: id });
    return json({ data, correlationId: id }, { status: 202 });
  } catch (error) { return apiError(error, id); }
}
