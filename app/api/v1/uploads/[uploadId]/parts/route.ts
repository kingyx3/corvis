import { assertPermission } from "@/core/enterprise";
import { uploads } from "@/lib/server/uploads";
import { resolveRequestIdentity } from "@/lib/server/request-context";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function POST(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "documents:write");
    const { uploadId } = await context.params;
    const body = await request.json() as { partNumber?: number; contentLength?: number };
    if (!Number.isInteger(body.partNumber) || !body.contentLength) return json({ error: "invalid_part_request", correlationId: id }, { status: 400 });
    const data = await uploads().presignPart(identity, uploadId, body.partNumber!, body.contentLength);
    return json(data);
  } catch (error) { return apiError(error, id); }
}
