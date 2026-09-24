import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { testAuditedSourceConnection } from "@/lib/server/source-connector-governance";
import { apiError, correlationId, json } from "@/lib/server/http";
import { sourceConnectorDrivers, sourceConnectorSecretStore } from "@/lib/server/source-connector-runtime";
import { assertSourceConnectionId } from "@/lib/server/source-connectors";

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
    assertSourceConnectionId(sourceConnectionId);
    const result = await testAuditedSourceConnection(identity, sourceConnectionId, id, {
      secrets: sourceConnectorSecretStore(),
      drivers: sourceConnectorDrivers(),
    });
    return json({ data: result, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
