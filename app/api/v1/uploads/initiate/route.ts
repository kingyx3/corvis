import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { uploads } from "@/lib/server/uploads";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { durationMetric } from "@/lib/server/telemetry";

export async function POST(request: Request) {
  const id = correlationId(request);
  const startedAt = Date.now();
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "documents:write");
    const body = await request.json() as { fileName?: string; contentType?: string; sizeBytes?: number; lastModified?: number; checksumSha256?: string; idempotencyKey?: string };
    if (!body.fileName || !body.contentType || !body.sizeBytes) return json({ error: "invalid_upload_request", correlationId: id }, { status: 400 });
    const clientKey = body.idempotencyKey || request.headers.get("idempotency-key") || randomUUID();
    const session = await uploads().initiate(identity, {
      fileName: body.fileName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      lastModified: body.lastModified,
      checksumSha256: body.checksumSha256,
      idempotencyKey: `${identity.subject}:${clientKey}`,
      origin: request.headers.get("origin") || undefined,
    });
    durationMetric("upload.initiation", startedAt, {
      correlationId: id,
      tenantId: identity.tenantId,
      workspaceId: identity.workspaceId,
      actorSubject: identity.subject,
      documentId: session.documentId,
    }, { outcome: "success" });
    return json({
      uploadId: session.uploadId,
      documentId: session.documentId,
      artifactVersionId: session.artifactVersionId,
      ingestionId: session.ingestionId,
      chunkSize: session.chunkSize,
      uploadUrl: session.resumableUploadUrl,
      state: session.state,
    }, { status: 201 });
  } catch (error) {
    durationMetric("upload.initiation", startedAt, { correlationId: id }, { outcome: "failure" });
    return apiError(error, id);
  }
}
