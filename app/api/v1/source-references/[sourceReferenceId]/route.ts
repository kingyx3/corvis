import { randomUUID } from "crypto";
import { assertDocumentAccess, assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { resolveRequestIdentity } from "@/lib/server/request-context";
import { snowflake } from "@/lib/server/snowflake";

export async function GET(request: Request, context: { params: Promise<{ sourceReferenceId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "sources:read");
    const { sourceReferenceId } = await context.params;
    const rows = await snowflake().query(`SELECT SOURCE_REFERENCE_ID,DOCUMENT_ID,PAGE_NUMBER,SHEET_NAME,CELL_RANGE,BBOX,EXCERPT FROM PM_SERVING.SOURCE_REFERENCES WHERE TENANT_ID=? AND SOURCE_REFERENCE_ID=? LIMIT 1`, [identity.tenantId, sourceReferenceId]);
    const row = rows[0];
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
