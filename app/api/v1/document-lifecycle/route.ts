import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { listDocumentLifecycles } from "@/lib/server/source-lifecycle";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "documents:read");
    return json({ data: await listDocumentLifecycles(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}
