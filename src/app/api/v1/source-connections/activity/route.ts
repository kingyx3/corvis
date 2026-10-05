import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/identity/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { sourceConnectionService } from "@/modules/sources/server/connections/source-connection-service";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    return json({ data: await sourceConnectionService().activity(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
