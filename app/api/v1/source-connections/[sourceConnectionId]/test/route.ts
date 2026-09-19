import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { sourceConnectorDrivers, sourceConnectorSecretStore } from "@/lib/server/source-connector-runtime";
import { testSourceConnection } from "@/lib/server/source-connectors";

/**
 * A scoped connectivity check: reads the credential and calls the driver's
 * `testConnection`, without discovering or downloading any document. This is
 * the "Corvis performs a scoped connectivity test and shows the customer the
 * result" step of the connect flow in docs/SOURCE_CONNECTORS.md, not a full
 * sync run.
 */
export async function POST(request: Request, context: { params: Promise<{ sourceConnectionId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { sourceConnectionId } = await context.params;
    const result = await testSourceConnection(identity, sourceConnectionId, {
      secrets: sourceConnectorSecretStore(),
      drivers: sourceConnectorDrivers(),
    });
    await platform().audit({
      id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
      actorSubject: identity.subject, sessionId: identity.sessionId, action: "source_connection.test",
      targetType: "source_connection", targetId: sourceConnectionId, outcome: result.ok ? "success" : "failure", correlationId: id,
      metadata: { errorClass: result.errorClass ?? null },
    });
    return json({ data: result, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
