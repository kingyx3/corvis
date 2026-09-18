import { assertPermission } from "@/core/enterprise";
import { uploads } from "@/lib/server/uploads";
import { resolveRequestIdentity } from "@/lib/server/request-context";
import { apiError, correlationId, json } from "@/lib/server/http";

function canAccessUpload(identity: ReturnType<typeof resolveRequestIdentity>, actorSubject: string): boolean {
  return actorSubject === identity.subject || identity.roles.includes("admin");
}

export async function GET(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "documents:write");
    const { uploadId } = await context.params;
    const session = await uploads().get(identity, uploadId);
    if (!canAccessUpload(identity, session.actorSubject)) return json({ error: "upload_not_found", correlationId: id }, { status: 404 });
    return json({ data: {
      uploadId: session.uploadId,
      documentId: session.documentId,
      artifactVersionId: session.artifactVersionId,
      ingestionId: session.ingestionId,
      chunkSize: session.chunkSize,
      state: session.state,
      uploadUrl: ["initiated", "uploading"].includes(session.state) ? session.resumableUploadUrl : undefined,
    }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}

export async function DELETE(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "documents:write");
    const { uploadId } = await context.params;
    const session = await uploads().get(identity, uploadId);
    if (!canAccessUpload(identity, session.actorSubject)) return json({ error: "upload_not_found", correlationId: id }, { status: 404 });
    await uploads().abort(identity, uploadId);
    return new Response(null, { status: 204 });
  } catch (error) { return apiError(error, id); }
}
