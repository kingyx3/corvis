import { randomUUID } from "crypto";
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
    const body = await request.json() as { idempotencyKey?: string };
    const session = await uploads().complete(identity, uploadId, body.idempotencyKey || request.headers.get("idempotency-key") || randomUUID());
    return json({ data: { uploadId: session.uploadId, documentId: session.documentId, artifactVersionId: session.artifactVersionId, ingestionId: session.ingestionId, state: session.state }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
