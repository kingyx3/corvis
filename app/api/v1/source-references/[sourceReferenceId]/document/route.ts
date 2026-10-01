import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { originalSourceDocument } from "@/lib/server/source-document";
export async function GET(request: Request, context: { params: Promise<{ sourceReferenceId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request); assertPermission(identity, "sources:read"); const { sourceReferenceId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceReferenceId)) return json({ error: "source_document_not_found", correlationId: id }, { status: 404 });
    const result = await originalSourceDocument(identity, sourceReferenceId, { correlationId: id });
    if (!result) return json({ error: "source_document_not_found", correlationId: id }, { status: 404 });
    return new Response(result.body, { headers: { "content-type": result.contentType, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-corvis-checksum-sha256": result.checksum, "x-correlation-id": id } });
  } catch (error) { return apiError(error, id); }
}
