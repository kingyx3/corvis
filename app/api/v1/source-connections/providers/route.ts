import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { approvedSourceProviders, providerDescriptor } from "@/lib/server/source-providers";

/**
 * The approved providers the "Connect source" wizard may offer, each with the plain-language access description
 * it shows before anything is authorized. Empty until a provider integration is certified (docs/SOURCE_CONNECTORS.md);
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
