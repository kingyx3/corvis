import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { parseConnectRequest, parseSecret, redactedConnection } from "@/lib/server/source-connect-http";
import { sourceConnectionService } from "@/lib/server/source-connection-service";

/**
 * Connects an approved provider with a credential the administrator typed (the wizard's direct-credential path).
 * The secret goes straight to the secret store and only its reference is kept; the response is the redacted
 * connection plus the result of the connectivity test that runs straight after. Only a passing test activates
 * the connection, so a failed test leaves scheduled sync blocked. The credential is never echoed or logged.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { parsed, object } = parseConnectRequest(await request.json() as unknown, "credential");
    const secret = parseSecret(object.secret);
    const result = await sourceConnectionService().connect(identity, { ...parsed, secret }, id);
    return json({ data: { connection: redactedConnection(result.connection), test: result.test }, correlationId: id }, { status: 201 });
  } catch (error) { return apiError(error, id); }
}
