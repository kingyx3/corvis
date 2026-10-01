import { assertPermission, AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import { resolveAuthorizedRequestIdentity } from "./authorized-request.ts";

/**
 * Fails closed unless the identity holds the raw `tenant_admin` role. `accountadmin` maps to the same
 * application `admin` role (and so passes `admin:manage`) but must never reach tenant-wide admin routes.
 * Only a literal `true` passes: a missing or malformed flag is a denial.
 */
export function assertTenantAdminIdentity(identity: RequestIdentity): void {
  if (identity.isTenantAdmin !== true) throw new AuthorizationError("admin:tenant_manage");
}

/**
 * The one entry point for every `app/api/v1/admin/**` handler. Besides authenticating, it requires
 * `admin:manage` and the tenant-admin role explicitly at the route layer, independent of the path-based
 * scope check inside `resolveAuthorizedRequestIdentity` (defense in depth: a route moved or reached
 * through a path that check does not recognise is still refused). Tenant-admin is checked first so a
 * denial is the same 403 `admin:tenant_manage` the path-scope check raises.
 */
export async function resolveAdminRequestIdentity(
  request: Request,
  options?: Parameters<typeof resolveAuthorizedRequestIdentity>[1],
): Promise<RequestIdentity> {
  const identity = await resolveAuthorizedRequestIdentity(request, options);
  assertTenantAdminIdentity(identity);
  assertPermission(identity, "admin:manage");
  return identity;
}

/**
 * Reads an admin command body. Only a JSON object is a valid command: a literal
 * `null`, an array, a primitive or malformed JSON yields `undefined` so the
 * route answers 400 instead of throwing a TypeError on the first field access.
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  return body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}
