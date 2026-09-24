import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { transitionAuditedSourceConnection } from "@/lib/server/source-connector-governance";
import { apiError, correlationId, json } from "@/lib/server/http";
import { sourceConnectorSecretStore } from "@/lib/server/source-connector-runtime";
import {
  assertSourceConnectionId,
  getSourceConnection,
  type SourceConnection,
} from "@/lib/server/source-connectors";

/** Never returns the secret reference; it is an internal resource pointer, not customer-facing state. */
function toResponse(connection: SourceConnection): Omit<SourceConnection, "secretReference"> {
  const { secretReference, ...rest } = connection;
  void secretReference;
  return rest;
}

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
    const body = (await request.json() ?? {}) as { action?: unknown };
    if (body.action !== "pause" && body.action !== "resume" && body.action !== "revoke") {
      return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    }
    assertSourceConnectionId(sourceConnectionId);

    const data = await transitionAuditedSourceConnection(identity, sourceConnectionId, body.action, id, {
      secrets: sourceConnectorSecretStore(),
    });
    return json({ data: toResponse(data), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
