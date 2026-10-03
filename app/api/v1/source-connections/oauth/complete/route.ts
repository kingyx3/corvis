import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { oauthRedirectUri, redactedConnection, usesSecureCookies } from "@/lib/server/source-connect-http";
import { sourceConnectionService } from "@/lib/server/source-connection-service";
import { sourceConnectorSecretStore } from "@/lib/server/source-connector-runtime";
import { ConnectorGovernanceError } from "@/lib/server/source-connectors";
import { clearedAttemptCookie, consumeOAuthAttempt, discardOAuthAttempt, readAttemptCookie } from "@/lib/server/source-oauth";
import { approvedSourceProvider } from "@/lib/server/source-providers";
import { logEvent } from "@/lib/server/telemetry";

/**
 * Finishes the OAuth leg after the provider redirected the administrator back to the app. The browser passes the
 * one-time `code` and `state` it received (or `denied: true` when the provider reported a refusal); the pending
 * attempt named by the HttpOnly cookie is validated, bound to this administrator, and destroyed whatever the outcome.
 * On success the code is exchanged server-side with the PKCE verifier, the resulting credential goes straight to the
 * secret store, and the first connectivity test runs. The response carries no token and no secret reference.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const body = await request.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ConnectorGovernanceError("invalid_request");
    const { code, state, denied } = body as { code?: unknown; state?: unknown; denied?: unknown };
    const secrets = sourceConnectorSecretStore();
    const attemptReference = readAttemptCookie(request);
    const headers = { "set-cookie": clearedAttemptCookie(usesSecureCookies(request)) };

    if (denied === true) {
      await discardOAuthAttempt(identity, attemptReference, { secrets });
      return json({ data: { outcome: "denied" }, correlationId: id }, { headers });
    }
    if (typeof code !== "string" || !code || typeof state !== "string" || !state) throw new ConnectorGovernanceError("oauth_attempt_invalid");

    const attempt = await consumeOAuthAttempt(identity, { attemptReference, state }, { secrets });
    const provider = approvedSourceProvider(attempt.providerKey);
    if (!provider?.oauth) throw new ConnectorGovernanceError("unregistered_provider");
    let secret;
    try {
      secret = await provider.oauth.exchangeCode({ code, codeVerifier: attempt.codeVerifier, redirectUri: oauthRedirectUri(request) });
    } catch (error) {
      // A provider that refuses the code leaves nothing behind. Only the error name is logged: never its message.
      logEvent("warn", "source_connection.oauth_exchange_failed", { correlationId: id }, { providerKey: provider.providerKey, errorName: error instanceof Error ? error.name : "unknown" });
      throw new ConnectorGovernanceError("oauth_attempt_invalid");
    }
    const result = await sourceConnectionService().connect(identity, { provider, connectionLabel: attempt.connectionLabel, secret }, id);
    return json({ data: { outcome: "connected", connection: redactedConnection(result.connection), test: result.test }, correlationId: id }, { status: 201, headers });
  } catch (error) { return apiError(error, id); }
}
