import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { sourceConnectorSecretStore } from "@/lib/server/source-connector-runtime";
import {
  assertSourceConnectionId,
  getSourceConnection,
  reauthorizeSourceConnection,
  type SourceConnection,
} from "@/lib/server/source-connectors";

function toResponse(connection: SourceConnection): Omit<SourceConnection, "secretReference"> {
  const { secretReference, ...rest } = connection;
  void secretReference;
  return rest;
}

/**
 * Replaces the credential behind an existing connection (for example after a
 * customer rotates a token, or after the customer resolves a
 * `reauthorization_required` state) without losing its run/acquisition
 * history. The new secret material never appears in this response.
 */
export async function POST(request: Request, context: { params: Promise<{ sourceConnectionId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { sourceConnectionId } = await context.params;
    const body = (await request.json() ?? {}) as { secret?: unknown };
    if (!body.secret || typeof body.secret !== "object" || Array.isArray(body.secret)) {
      return json({ error: "secret_required", correlationId: id }, { status: 400 });
    }
    assertSourceConnectionId(sourceConnectionId);

    await reauthorizeSourceConnection(identity, sourceConnectionId, body.secret as Record<string, unknown>, { secrets: sourceConnectorSecretStore() });
    const data = await getSourceConnection(identity, sourceConnectionId);
    await platform().audit({
      id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
      actorSubject: identity.subject, sessionId: identity.sessionId, action: "source_connection.reauthorize",
      targetType: "source_connection", targetId: sourceConnectionId, outcome: "success", correlationId: id,
    });
    return json({ data: toResponse(data), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
