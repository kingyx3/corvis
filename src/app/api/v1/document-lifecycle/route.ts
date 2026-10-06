import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/modules/identity-access/server/request/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { listDocumentLifecycles } from "@/modules/sources/server/connectors/source-lifecycle";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "documents:read");
    return json({ data: await listDocumentLifecycles(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
