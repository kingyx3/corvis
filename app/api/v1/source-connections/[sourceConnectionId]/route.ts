import { randomUUID } from "crypto";
import { assertPermission, type RequestIdentity } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { sourceConnectorSecretStore } from "@/lib/server/source-connector-runtime";
import {
  assertSourceConnectionId,
  getSourceConnection,
  pauseSourceConnection,
  resumeSourceConnection,
  revokeSourceConnection,
  type SourceConnection,
} from "@/lib/server/source-connectors";

/** Never returns the secret reference; it is an internal resource pointer, not customer-facing state. */
function toResponse(connection: SourceConnection): Omit<SourceConnection, "secretReference"> {
  const { secretReference, ...rest } = connection;
  void secretReference;
  return rest;
}

const ACTIONS: Record<string, (identity: RequestIdentity, sourceConnectionId: string) => Promise<void>> = {
  pause: (identity, sourceConnectionId) => pauseSourceConnection(identity, sourceConnectionId),
  resume: (identity, sourceConnectionId) => resumeSourceConnection(identity, sourceConnectionId),
  revoke: (identity, sourceConnectionId) => revokeSourceConnection(identity, sourceConnectionId, { secrets: sourceConnectorSecretStore() }),
};

export async function GET(request: Request, context: { params: Promise<{ sourceConnectionId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { sourceConnectionId } = await context.params;
    const connection = await getSourceConnection(identity, sourceConnectionId);
    return json({ data: toResponse(connection), correlationId: id });
  } catch (error) { return apiError(error, id); }
}

export async function PATCH(request: Request, context: { params: Promise<{ sourceConnectionId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { sourceConnectionId } = await context.params;
    const body = (await request.json() ?? {}) as { action?: string };
    // Own keys only: an inherited name such as "constructor" must not resolve to an Object.prototype function.
    const transition = typeof body.action === "string" && Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : undefined;
    if (!transition) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    assertSourceConnectionId(sourceConnectionId);

    await transition(identity, sourceConnectionId);
    const data = await getSourceConnection(identity, sourceConnectionId);
    await platform().audit({
      id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
      actorSubject: identity.subject, sessionId: identity.sessionId, action: `source_connection.${body.action}`,
      targetType: "source_connection", targetId: sourceConnectionId, outcome: "success", correlationId: id,
    });
    return json({ data: toResponse(data), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
