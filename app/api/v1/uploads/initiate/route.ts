import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { uploads } from "@/lib/server/uploads";
import { resolveRequestIdentity } from "@/lib/server/request-context";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "documents:write");
    const body = await request.json() as { fileName?: string; contentType?: string; sizeBytes?: number; lastModified?: number; checksumSha256?: string; idempotencyKey?: string };
    if (!body.fileName || !body.contentType || !body.sizeBytes) return json({ error: "invalid_upload_request", correlationId: id }, { status: 400 });
    const session = await uploads().initiate(identity, {
      fileName: body.fileName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      lastModified: body.lastModified,
      checksumSha256: body.checksumSha256,
      idempotencyKey: body.idempotencyKey || request.headers.get("idempotency-key") || randomUUID(),
      origin: request.headers.get("origin") || undefined,
    });
    return json({
      uploadId: session.uploadId,
      documentId: session.documentId,
      artifactVersionId: session.artifactVersionId,
      ingestionId: session.ingestionId,
      chunkSize: session.chunkSize,
      uploadUrl: session.resumableUploadUrl,
      state: session.state,
    }, { status: 201 });
  } catch (error) { return apiError(error, id); }
}
