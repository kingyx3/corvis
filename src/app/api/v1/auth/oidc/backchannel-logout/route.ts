import { handleBackchannelLogout } from "@/lib/server/backchannel-logout";
import { correlationId } from "@/lib/server/http";

/**
 * OpenID Connect Back-Channel Logout 1.0 receiver (F7c, #336). Called by the identity provider, not by a person or a
 * Corvis client, so it has its own authentication: the signed `logout_token` form field is the only credential, verified
 * against a provider Corvis trusts (see src/lib/server/backchannel-logout.ts). `200` once a valid token was applied, `400` for
 * anything else, `429`/`503` when the sender should back off or retry. Register this URL as the client's
 * `backchannel_logout_uri` at the identity provider.
 */
export async function POST(request: Request): Promise<Response> {
  return handleBackchannelLogout(request, { correlationId: correlationId(request) });
}
