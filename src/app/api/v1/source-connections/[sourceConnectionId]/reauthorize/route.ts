import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/http";
import { sourceConnectionService } from "@/modules/sources/server/source-connection-service";
import { ConflictError } from "@/platform/platform";
import { assertSourceConnectionId, type SourceConnection } from "@/modules/sources/server/source-connectors";

function toResponse(connection: SourceConnection): Omit<SourceConnection, "secretReference"> {
  const { secretReference, ...rest } = connection;
  void secretReference;
  return rest;
}

/**
 * Replaces the credential behind an existing connection (for example after a
 * customer rotates a token, or after the customer resolves a
 * `reauthorization_required` state) without losing its run/acquisition
 * history. The new secret material never appears in this response. A connection
 * that signs in with OAuth (`oauth_authorization_code`) is renewed only through
 * the sign-in leg (`POST /oauth/start` with its id, then `/oauth/complete`), never
 * by posting a token here: `409 oauth_reauthorization_required`.
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

    const service = sourceConnectionService();
    if ((await service.get(identity, sourceConnectionId)).credentialType === "oauth_authorization_code") throw new ConflictError("oauth_reauthorization_required");
    const data = await service.reauthorize(identity, sourceConnectionId, body.secret as Record<string, unknown>, id);
    return json({ data: toResponse(data), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
