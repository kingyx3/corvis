import { assertPermission } from "@/core/enterprise";
import { platform } from "@/lib/server/platform";
import { resolveRequestIdentity } from "@/lib/server/request-context";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "documents:read");
    const data = await platform().listDocuments(identity);
    return json({ data, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
