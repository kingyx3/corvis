import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/modules/identity-access/server/request/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { parseConnectRequest, parseSecret, redactedConnection } from "@/modules/sources/server/connections/source-connect-http";
import { enforceSourceConnectAttemptLimit } from "@/modules/sources/server/connections/source-connect-limits";
import { sourceConnectionService } from "@/modules/sources/server/connections/source-connection-service";

/**
 * Connects an approved provider with a credential the administrator typed (the wizard's direct-credential path).
 * The secret goes straight to the secret store and only its reference is kept; the response is the redacted
 * connection plus the result of the connectivity test that runs straight after. Only a passing test activates
 * the connection, so a failed test leaves scheduled sync blocked. The credential is never echoed or logged. An
 * attempt spends one of the administrator's connect attempts for the window, and a workspace that is already
 * connected to the provider is refused (`409 source_connection_already_exists`).
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { parsed, object } = parseConnectRequest(await request.json() as unknown, "credential");
    const secret = parseSecret(object.secret);
    enforceSourceConnectAttemptLimit(identity);
    const result = await sourceConnectionService().connect(identity, { ...parsed, secret }, id);
    return json({ data: { connection: redactedConnection(result.connection), test: result.test }, correlationId: id }, { status: 201 });
  } catch (error) { return apiError(error, id); }
}
