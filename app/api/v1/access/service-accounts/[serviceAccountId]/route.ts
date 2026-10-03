import { parseServiceAccountCommand } from "@/core/service-account";
import { readJsonObject } from "@/lib/server/admin-request";
import { correlationId, json } from "@/lib/server/http";
import { resolveServiceAccountAdmin, serviceAccountErrorResponse } from "@/lib/server/service-account-http";
import { serviceAccountService } from "@/lib/server/service-account-service";

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
