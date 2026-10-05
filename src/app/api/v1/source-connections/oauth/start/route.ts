import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/http";
import { oauthRedirectUri, parseOAuthStartRequest, usesSecureCookies } from "@/modules/sources/server/source-connect-http";
import { enforceSourceConnectAttemptLimit } from "@/modules/sources/server/source-connect-limits";
import { sourceConnectionService } from "@/modules/sources/server/source-connection-service";
import { sourceConnectorSecretStore } from "@/modules/sources/server/source-connector-runtime";
import { ConnectorGovernanceError } from "@/modules/sources/server/source-connectors";
import { attemptCookie, startOAuthAttempt } from "@/modules/sources/server/source-oauth";
import { oauthProviderForConnection, type ApprovedSourceProvider } from "@/modules/sources/server/source-providers";

/**
 * Starts the OAuth authorization-code leg, either for a new connection (`providerKey`, `connectionLabel`,
 * `scopeConfirmed: true`, and optionally `selectedScopeIds`, the folders to read, checked against the provider's declaration and kept with the pending attempt) or to renew an existing one (`sourceConnectionId`, which is all that is sent: provider and
 * scope were confirmed and recorded when it was created). State and the PKCE verifier are generated and kept
 * server-side; the browser receives only the provider consent URL and an HttpOnly cookie pointing at the pending
 * attempt. Nothing is created or changed until the provider redirects back and the attempt is completed. Each attempt
 * spends one of the administrator's connect attempts for the window, a new connection is refused when the workspace is
 * already connected to the provider, and the start is audited as `source_connection.oauth_start`.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const parsed = parseOAuthStartRequest(await request.json() as unknown);
    enforceSourceConnectAttemptLimit(identity);
    const service = sourceConnectionService();

    let provider: ApprovedSourceProvider;
    let attempt: { providerKey: string; connectionLabel: string; reauthorizeConnectionId?: string; scopeIds?: string[] };
    if (parsed.kind === "reauthorize") {
      const connection = await service.get(identity, parsed.sourceConnectionId);
      if (connection.status === "revoked") throw new ConnectorGovernanceError("connection_revoked");
      // Only an authorization-code connection is renewed by signing in again; any other credential is replaced directly.
      if (connection.credentialType !== "oauth_authorization_code") throw new ConnectorGovernanceError("invalid_request");
      const renewing = oauthProviderForConnection(connection.providerKey);
      if (!renewing) throw new ConnectorGovernanceError("unregistered_provider");
      provider = renewing;
      attempt = { providerKey: connection.providerKey, connectionLabel: connection.connectionLabel, reauthorizeConnectionId: connection.sourceConnectionId };
    } else {
      provider = parsed.parsed.provider;
      await service.assertNotConnected(identity, provider.providerKey);
      attempt = { providerKey: provider.providerKey, connectionLabel: parsed.parsed.connectionLabel, ...(parsed.parsed.scopeIds ? { scopeIds: parsed.parsed.scopeIds } : {}) };
    }
    const started = await startOAuthAttempt(identity, { ...attempt, client: provider.oauth!, redirectUri: oauthRedirectUri(request) }, { secrets: sourceConnectorSecretStore() });
    await service.auditOAuth(identity, { action: "source_connection.oauth_start", targetId: attempt.reauthorizeConnectionId ?? attempt.providerKey, providerKey: attempt.providerKey }, id);
    return json({ data: { authorizationUrl: started.authorizationUrl }, correlationId: id }, {
      headers: { "set-cookie": attemptCookie(started.attemptReference, usesSecureCookies(request)) },
    });
  } catch (error) { return apiError(error, id); }
}
