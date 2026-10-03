import { parseCreateServiceAccount } from "@/core/service-account";
import { readJsonObject } from "@/lib/server/admin-request";
import { correlationId, json } from "@/lib/server/http";
import { resolveServiceAccountAdmin, serviceAccountErrorResponse } from "@/lib/server/service-account-http";
import { serviceAccountService } from "@/lib/server/service-account-service";

/**
 * Service accounts (F6, #262): non-human identities under the existing RBAC, entitlement and data-rights model, for
 * Organization Admins only. `GET` lists the organization's accounts (role, workspace, creator, last used, expiry, and
 * whether a credential is nearing expiry) with the workspaces a new account can be created in.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveServiceAccountAdmin(request);
    return json({ data: await serviceAccountService().list(identity), correlationId: id });
  } catch (error) { return serviceAccountErrorResponse(error, id); }
}

/**
 * `{ name, purpose, workspaceId, roleName, expiresInDays?, credentialExpiresInDays? }` creates an account and its first
 * credential. `201` with `{ serviceAccount, credential }`: `credential.secret` is the API credential, shown ONCE in this
 * response and never retrievable again (only a hash is stored). The role is one of `reviewer`, `analyst`, `viewer`.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveServiceAccountAdmin(request);
    const command = parseCreateServiceAccount(await readJsonObject(request));
    return json({ data: await serviceAccountService().create(identity, command, id), correlationId: id }, { status: 201 });
  } catch (error) { return serviceAccountErrorResponse(error, id); }
}
