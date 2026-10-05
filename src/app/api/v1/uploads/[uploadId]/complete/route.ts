import { assertPermission } from "@/shared/domain/enterprise";
import { uploadIdempotencyKey, uploads } from "@/modules/sources/server/uploads";
import { canAccessUpload } from "@/modules/sources/server/upload-access";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/http";

export async function POST(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "documents:write");
    const { uploadId } = await context.params;
    const current = await uploads().get(identity, uploadId);
    if (!canAccessUpload(identity, current)) {
      return json({ error: "upload_not_found", correlationId: id }, { status: 404 });
    }
    // The body is optional: the key may come from the Idempotency-Key header instead.
    const raw = await request.text();
    const body = (raw.trim() ? JSON.parse(raw) : null) as { idempotencyKey?: string } | null;
    const clientKey = body?.idempotencyKey || request.headers.get("idempotency-key");
    if (clientKey !== null && clientKey !== undefined && (typeof clientKey !== "string" || clientKey.length > 256)) return json({ error: "invalid_upload_request", correlationId: id }, { status: 400 });
    // A client that never supplied a key at initiate was given a server-generated one it cannot know, so an
    // absent key means "the session's own key": the caller is already authorised for this exact session.
    const session = await uploads().complete(identity, uploadId, clientKey ? uploadIdempotencyKey(identity, clientKey) : current.idempotencyKey);
    return json({ data: { uploadId: session.uploadId, documentId: session.documentId, artifactVersionId: session.artifactVersionId, ingestionId: session.ingestionId, state: session.state }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
