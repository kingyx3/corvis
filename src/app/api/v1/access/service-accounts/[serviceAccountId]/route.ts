import { parseServiceAccountCommand } from "@/modules/identity-access/domain/service-account";
import { readJsonObject } from "@/platform/http/identity/admin-request";
import { correlationId, json } from "@/platform/http/api/http";
import { resolveServiceAccountAdmin, serviceAccountErrorResponse } from "@/modules/identity-access/server/service-accounts/service-account-http";
import { serviceAccountService } from "@/modules/identity-access/server/service-accounts/service-account-service";

/** One service account with its credential history. */
export async function GET(request: Request, context: { params: Promise<{ serviceAccountId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveServiceAccountAdmin(request);
    const { serviceAccountId } = await context.params;
    return json({ data: await serviceAccountService().get(identity, serviceAccountId), correlationId: id });
  } catch (error) { return serviceAccountErrorResponse(error, id); }
}

/**
 * `{ action }` manages the account's credential and lifecycle:
 * - `issue` (`credentialExpiresInDays?`) issues a credential to an account that has none in use; `409` otherwise.
 * - `rotate` (`credentialExpiresInDays?`, `overlapMinutes?` 0 to 1440, default 60) issues a new credential and leaves the
 *   current one valid for the overlap, then not at all.
 * - `revoke` (`reason`) revokes every credential in use, effective immediately.
 * - `disable` (`reason`) deactivates the account everywhere: identity, memberships, entitlements and credentials.
 * - `grant_entitlement` (`resourceType` `fund` or `document`, `resourceId`, `reason`) gives the account read access to one fund or
 *   document in its own workspace, only when the organization owns it AND holds an effective client-visible data right for it
 *   (`422 entitlement_outside_data_rights` otherwise, one code for every such case). `revoke_entitlement` (same fields) ends
 *   everything the account holds on that resource, and is never refused for a data-right reason.
 * `issue` and `rotate` return `{ serviceAccount, credential }`, where `credential.secret` is shown ONCE; the others return
 * `{ serviceAccount }`.
 */
export async function POST(request: Request, context: { params: Promise<{ serviceAccountId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveServiceAccountAdmin(request);
    const { serviceAccountId } = await context.params;
    const command = parseServiceAccountCommand(await readJsonObject(request));
    return json({ data: await serviceAccountService().act(identity, serviceAccountId, command, id), correlationId: id });
  } catch (error) { return serviceAccountErrorResponse(error, id); }
}
