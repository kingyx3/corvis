import { assertPermission, type RequestIdentity } from "../../core/enterprise.ts";
import { TenantExportValidationError } from "../../core/tenant-export.ts";
import { resolveAuthorizedRequestIdentity } from "./authorized-request.ts";
import { apiError, json } from "./http.ts";

/**
 * Shared by the customer-facing data governance surface (F10, #266): the retention view and the full tenant export.
 * Both are for Organization Admins (`tenant_admin`) only.
 */

/** A request the caller cannot make (403), names nothing visible (404) or lost a race and is safe to retry (409). */
export class DataGovernanceError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409;
  constructor(code: string, status: 400 | 403 | 404 | 409) {
    super(code);
    this.name = "DataGovernanceError";
    this.code = code;
    this.status = status;
  }
}

/** Only a literal `true` passes: `accountadmin` shares the `admin` application role but never this authority. */
export function assertOrganizationAdmin(identity: RequestIdentity): void {
  if (identity.isTenantAdmin !== true) throw new DataGovernanceError("tenant_admin_required", 403);
}

/**
 * The one entry point for every data governance route: authenticates, requires `admin:manage`, and then the Organization
 * Admin role explicitly (a denial is the same 403 `tenant_admin_required` the other access routes answer).
 */
export async function resolveOrganizationAdmin(request: Request): Promise<RequestIdentity> {
  const identity = await resolveAuthorizedRequestIdentity(request);
  assertPermission(identity, "admin:manage");
  assertOrganizationAdmin(identity);
  return identity;
}

/** Typed failures keep their stable code and status; everything else goes through the shared API error mapper. */
export function dataGovernanceErrorResponse(error: unknown, correlationId: string): Response {
  if (error instanceof DataGovernanceError || error instanceof TenantExportValidationError) {
    return json({ error: error.code, correlationId }, { status: error.status });
  }
  return apiError(error, correlationId);
}
