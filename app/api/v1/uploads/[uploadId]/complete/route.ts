import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { uploads } from "@/lib/server/uploads";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function POST(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "documents:write");
    const { uploadId } = await context.params;
    const current = await uploads().get(identity, uploadId);
    if (current.actorSubject !== identity.subject && !identity.roles.includes("admin")) {
      return json({ error: "upload_not_found", correlationId: id }, { status: 404 });
    }
    const body = await request.json() as { idempotencyKey?: string };
    const clientKey = body.idempotencyKey || request.headers.get("idempotency-key") || randomUUID();
    const session = await uploads().complete(identity, uploadId, `${identity.subject}:${clientKey}`);
    return json({ data: { uploadId: session.uploadId, documentId: session.documentId, artifactVersionId: session.artifactVersionId, ingestionId: session.ingestionId, state: session.state }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
