import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { oauthRedirectUri, parseConnectRequest, usesSecureCookies } from "@/lib/server/source-connect-http";
import { sourceConnectorSecretStore } from "@/lib/server/source-connector-runtime";
import { attemptCookie, startOAuthAttempt } from "@/lib/server/source-oauth";

/**
 * Starts the OAuth authorization-code leg for an approved provider whose connect method is OAuth. State and the PKCE
 * verifier are generated and kept server-side; the browser receives only the provider consent URL and an HttpOnly
 * cookie pointing at the pending attempt. Nothing is created until the provider redirects back and the attempt is completed.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const { parsed } = parseConnectRequest(await request.json() as unknown, "oauth");
    const started = await startOAuthAttempt(identity, {
      providerKey: parsed.provider.providerKey,
      connectionLabel: parsed.connectionLabel,
      client: parsed.provider.oauth!,
      redirectUri: oauthRedirectUri(request),
    }, { secrets: sourceConnectorSecretStore() });
    return json({ data: { authorizationUrl: started.authorizationUrl }, correlationId: id }, {
      headers: { "set-cookie": attemptCookie(started.attemptReference, usesSecureCookies(request)) },
    });
  } catch (error) { return apiError(error, id); }
}
