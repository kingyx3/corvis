import { assertPermission, type RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { ServiceAccountValidationError } from "../../domain/service-account.ts";
import { resolveAuthorizedRequestIdentity } from "../request/authorized-request.ts";
import { apiError, json } from "../../../../platform/http/api/http.ts";
import { ServiceAccountError, assertCanManageServiceAccounts } from "./service-account.ts";

/**
 * The one entry point for every service-account route (F6, #262): authenticates, requires `admin:manage`, and then the
 * Organization Admin role explicitly, held by a person (a denial is the same 403 `tenant_admin_required` the other
 * access routes answer).
 */
export async function resolveServiceAccountAdmin(request: Request): Promise<RequestIdentity> {
  const identity = await resolveAuthorizedRequestIdentity(request);
  assertPermission(identity, "admin:manage");
  assertCanManageServiceAccounts(identity);
  return identity;
}

/** Typed failures keep their stable code and status; everything else goes through the shared API error mapper. */
export function serviceAccountErrorResponse(error: unknown, correlationId: string): Response {
  if (error instanceof ServiceAccountError || error instanceof ServiceAccountValidationError) {
    return json({ error: error.code, correlationId }, { status: error.status });
  }
  return apiError(error, correlationId);
}
