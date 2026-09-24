import { randomUUID } from "crypto";
import { assertDocumentAccess, assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { getSourceReference } from "@/lib/server/operations";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";

// Source reference ids are uuids; anything else can never match and must not reach the
// `::uuid` cast, which would fail the query and surface as a 500.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ sourceReferenceId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "sources:read");
    const { sourceReferenceId } = await context.params;
    const row = UUID_PATTERN.test(sourceReferenceId) ? await getSourceReference(identity, sourceReferenceId) : undefined;
    if (!row) return json({ error: "source_reference_not_found", correlationId: id }, { status: 404 });
    const documentId = String(row.document_id || "");
    assertDocumentAccess(identity, documentId, true);
    await platform().audit({ id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject, sessionId: identity.sessionId, action: "source_reference.read", targetType: "source_reference", targetId: sourceReferenceId, outcome: "success", correlationId: id });
    return json({ data: {
      sourceReferenceId: String(row.source_reference_id), documentId,
      page: row.page_number == null ? undefined : Number(row.page_number),
      sheetName: row.sheet_name == null ? undefined : String(row.sheet_name),
      cellRange: row.cell_range == null ? undefined : String(row.cell_range),
      bbox: row.bbox ?? undefined,
      excerpt: row.excerpt == null ? undefined : String(row.excerpt),
    }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
