import { randomUUID } from "node:crypto";
import { assertDocumentAccess, assertPermission, type RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { getServerConfig } from "../../../platform/config/config.ts";
import { gcs } from "../../../platform/gcp/gcs.ts";
import { postgres, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { platform } from "../../../platform/data/platform.ts";
export async function originalSourceDocument(identity: RequestIdentity, referenceId: string, dependencies: { correlationId?: string; db?: PostgresSqlApi; store?: Pick<ReturnType<typeof gcs>, "bucket" | "getObjectStream">; audit?: ReturnType<typeof platform>["audit"] } = {}) {
  assertPermission(identity, "sources:read");
  const db = dependencies.db ?? postgres(getServerConfig().databaseDsn);
  const row = (await db.query(`select r.document_id,r.object_uri,r.storage_generation,d.media_type,d.display_name,a.sha256
    from corvis_serving.source_references r
    join corvis_source.document d on d.tenant_id=r.tenant_id and d.document_id=r.document_id
    join corvis_source.document_artifact_version a on a.tenant_id=r.tenant_id and a.document_artifact_version_id=r.document_artifact_version_id
    where r.tenant_id=$1::uuid and r.source_reference_id=$2::uuid and a.malware_scan_status='clean' and a.quarantine_status='released' limit 1`, [identity.tenantId, referenceId]))[0];
  if (!row) return null;
  assertDocumentAccess(identity, String(row.document_id), true);
  const store = dependencies.store ?? gcs(); const uri = String(row.object_uri); const prefix = `gs://${store.bucket}/tenant=${identity.tenantId}/document=${row.document_id}/`;
  if (!uri.startsWith(prefix) || !row.storage_generation || uri.includes("..")) throw new Error("invalid_source_object");
  const key = uri.slice(`gs://${store.bucket}/`.length);
  await (dependencies.audit ?? platform().audit.bind(platform()))({ id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject, sessionId: identity.sessionId, action: "source_document.read", targetType: "source_reference", targetId: referenceId, outcome: "success", correlationId: dependencies.correlationId ?? randomUUID() });
  const object = await store.getObjectStream(key, String(row.storage_generation));
  if (!object) return null;
  const contentType = ["application/pdf", "image/png", "image/jpeg"].includes(String(row.media_type)) ? String(row.media_type) : "application/octet-stream";
  return { ...object, contentType, name: String(row.display_name), checksum: String(row.sha256 ?? "") };
}
