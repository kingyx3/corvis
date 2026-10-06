import { getServerConfig } from "@/platform/config/config";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { postgres } from "@/platform/database/postgres";
import { AuthenticationError } from "@/modules/identity-access/server/request/request-context";
import { enforceServiceAccountExchangeClientLimit, exchangeServiceAccountCredential, serviceAccountBearer } from "@/modules/identity-access/server/service-accounts/service-account-exchange";

/**
 * Exchanges a Corvis-issued service-account credential for a five-minute signed identity assertion.
 * The long-lived credential is never accepted as application authorization: subsequent API calls
 * still re-resolve the service account's current role, entitlements and data rights from Postgres.
 */
export async function POST(request: Request): Promise<Response> {
  const id = correlationId(request);
  try {
    const config = getServerConfig();
    enforceServiceAccountExchangeClientLimit(request);
    const credential = serviceAccountBearer(request);
    if (!credential) throw new AuthenticationError("Service-account credential required");
    if (!config.trustedAuthProxySecret) throw new AuthenticationError("Service-account authentication is unavailable");

    const exchanged = await exchangeServiceAccountCredential(
      credential,
      postgres(config.databaseDsn),
      config.trustedAuthProxySecret,
    );
    if (!exchanged) throw new AuthenticationError("Service-account credential rejected");

    return json({
      data: {
        accessToken: exchanged.assertion,
        tokenType: "Corvis-Identity-Assertion",
        expiresIn: exchanged.expiresIn,
      },
      correlationId: id,
    });
  } catch (error) {
    return apiError(error, id);
  }
}
