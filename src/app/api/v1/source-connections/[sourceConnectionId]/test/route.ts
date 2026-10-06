import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/modules/identity-access/server/request/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { sourceConnectionService } from "@/modules/sources/server/connections/source-connection-service";
import { assertSourceConnectionId } from "@/modules/sources/server/connectors/source-connectors";

/**
 * A scoped connectivity check: reads the credential and calls the driver's
 * `testConnection`, without discovering or downloading any document. This is
 * the "Corvis performs a scoped connectivity test and shows the customer the
 * result" step of the connect flow in docs/features/SOURCE_CONNECTORS.md, not a full
 * sync run. The response is `{ ok, errorClass? }`: the class drives the
 * plain-language reason in the UI, and no driver detail text reaches the browser.
 */
export async function POST(request: Request, context: { params: Promise<{ sourceConnectionId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { sourceConnectionId } = await context.params;
    assertSourceConnectionId(sourceConnectionId);
    const result = await sourceConnectionService().test(identity, sourceConnectionId, id);
    return json({ data: result, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
