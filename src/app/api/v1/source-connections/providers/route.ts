import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/identity/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { approvedSourceProviders, providerDescriptor } from "@/modules/sources/server/connectors/source-providers";

/**
 * The approved providers the "Connect source" wizard may offer, each with the plain-language access description
 * it shows before anything is authorized. Empty until a provider integration is certified (docs/features/SOURCE_CONNECTORS.md);
 * in demo mode it also lists the labelled demo providers. Administrators only.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    return json({ data: approvedSourceProviders().map(providerDescriptor), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
