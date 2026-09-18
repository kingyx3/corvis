import { randomUUID } from "node:crypto";
import { getConfig } from "@/server/config";
import type { Session } from "@/server/security";
import { sha256Hex } from "@/server/security";
import { cortexSearch, execute, query, tenantRole } from "@/server/snowflake";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  copyObject,
  createMultipartUpload,
  deleteObject,
  getObjectRange,
  listMultipartParts,
  presignGet,
  presignUploadPart,
  putObject,
  type CompletedPart,
} from "@/server/storage";
import { documents as demoDocuments, fundSnapshots as demoSnapshots, observations as demoObservations, recentActivity as demoActivity, researchSuggestions as demoSuggestions } from "@/adapters/demo/catalog";

export type AuditInput = {
  action: string;
  resourceType: string;
  resourceId?: string;
  outcome?: "success" | "denied" | "error";
  metadata?: Record<string, unknown>;
  requestId?: string;
};

export type UploadRecord = {
  upload_id: string;
  document_id: string;
  artifact_version_id: string;
  ingestion_id: string;
  tenant_id: string;
  object_key: string;
  final_object_key: string;
  s3_upload_id: string;
  file_name: string;
  content_type: string;
  size_bytes: string;
  last_modified: string | null;
  part_size: string;
  status: string;
  idempotency_key: string;
  created_at?: string;
};

const supportedExtensions: Record<string, string[]> = {
  pdf: ["application/pdf", "application/octet-stream", ""],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream", ""],
  xls: ["application/vnd.ms-excel", "application/octet-stream", ""],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream", ""],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/octet-stream", ""],
  csv: ["text/csv", "application/csv", "text/plain", "application/octet-stream", ""],
};

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "document";
  return base.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/\s+/g, " ").trim().slice(0, 180) || "document";
}

function extension(name: string): string { return name.toLowerCase().split(".").pop() || ""; }

function validateUploadInput(input: { fileName: string; contentType?: string; sizeBytes: number }): void {
  const config = getConfig();
  if (!input.fileName || input.fileName.length > 255) throw Object.assign(new Error("Invalid file name"), { status: 400, code: "FILE_NAME_INVALID" });
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > config.storage.maxFileBytes) throw Object.assign(new Error(`File size must be between 1 byte and ${config.storage.maxFileBytes} bytes`), { status: 400, code: "FILE_SIZE_INVALID" });
  const ext = extension(input.fileName);
  const allowed = supportedExtensions[ext];
  if (!allowed) throw Object.assign(new Error("Unsupported file type"), { status: 415, code: "FILE_TYPE_UNSUPPORTED" });
  const type = input.contentType || "";
  if (!allowed.includes(type)) throw Object.assign(new Error("File extension and content type do not match"), { status: 415, code: "CONTENT_TYPE_MISMATCH" });
}

function expectedPartCount(sizeBytes: number, partSize: number): number { return Math.ceil(sizeBytes / partSize); }
function ids(): { documentId: string; artifactVersionId: string; ingestionId: string; uploadId: string } {
  return { documentId: `doc_${randomUUID()}`, artifactVersionId: `dav_${randomUUID()}`, ingestionId: `ing_${randomUUID()}`, uploadId: `upl_${randomUUID()}` };
}

export async function audit(session: Session, input: AuditInput): Promise<void> {
  if (getConfig().demoMode) return;
  await execute(
    `INSERT INTO PM_CONTROL.AUDIT_EVENT
      (audit_event_id, tenant_id, actor_subject, actor_email, roles, action, resource_type, resource_id, outcome, request_id, metadata, occurred_at)
     SELECT ?, ?, ?, ?, PARSE_JSON(?), ?, ?, ?, ?, ?, PARSE_JSON(?), CURRENT_TIMESTAMP()`,
    [`aud_${randomUUID()}`, session.tenantId, session.subject, session.email || null, JSON.stringify(session.roles), input.action, input.resourceType, input.resourceId || null, input.outcome || "success", input.requestId || null, JSON.stringify(input.metadata || {})],
    { admin: true },
  );
}

export async function bootstrapWorkspace(session: Session): Promise<Record<string, unknown>> {
  if (getConfig().demoMode) {
    return {
      session: { name: session.name, email: session.email, tenantId: session.tenantId, workspaceName: session.workspaceName, roles: session.roles },
      documents: demoDocuments,
      observations: demoObservations,
      fundSnapshots: demoSnapshots,
      recentActivity: demoActivity,
      researchSuggestions: demoSuggestions,
      featureFlags: { research: true, exports: true, review: true, administration: true },
    };
  }
  const [documents, observations, snapshots, activity] = await Promise.all([
    listDocuments(session),
    listObservations(session),
    query<Record<string, string | null>>(
      `SELECT fund_period_snapshot_id AS id, fund_name AS fund, report_period AS period, status,
              holdings_count AS holdings, facts_count AS facts, TO_VARCHAR(updated_at, 'YYYY-MM-DD HH24:MI') AS changed
       FROM PM_SERVING.FUND_PERIOD_SNAPSHOTS_V WHERE tenant_id = ? ORDER BY report_period DESC, fund_name LIMIT 50`,
      [session.tenantId], { tenantId: session.tenantId },
    ),
    query<Record<string, string | null>>(
      `SELECT action AS title, resource_type || COALESCE(' · ' || resource_id, '') AS detail,
              TO_VARCHAR(occurred_at, 'YYYY-MM-DD HH24:MI') AS time
       FROM PM_SERVING.RECENT_ACTIVITY_V WHERE tenant_id = ? ORDER BY occurred_at DESC LIMIT 12`,
      [session.tenantId], { tenantId: session.tenantId },
    ),
  ]);
  return {
    session: { name: session.name, email: session.email, tenantId: session.tenantId, workspaceName: session.workspaceName, roles: session.roles },
    documents, observations, fundSnapshots: snapshots, recentActivity: activity,
    researchSuggestions: ["What changed in my portfolio this quarter?", "Which holdings have leverage above 5.0x?", "Show me companies with declining EBITDA and their source evidence.", "Which fund reports still need review?"],
    featureFlags: { research: true, exports: true, review: true, administration: session.roles.includes("admin") },
  };
}

export async function listDocuments(session: Session): Promise<Record<string, string | number | null>[]> {
  if (getConfig().demoMode) return demoDocuments as unknown as Record<string, string | number | null>[];
  return query(
    `SELECT document_id AS id, file_name AS name, COALESCE(fund_name, 'Classifying…') AS fund,
            COALESCE(report_period, 'Detecting…') AS period, document_type AS type, page_count AS pages,
            size_display AS size, status, progress_percent AS progress, uploaded_display AS uploaded,
            quality, observation_count AS observations
     FROM PM_SERVING.DOCUMENTS_V WHERE tenant_id = ? ORDER BY uploaded_at DESC LIMIT 500`,
    [session.tenantId], { tenantId: session.tenantId },
  );
}

export async function listObservations(session: Session): Promise<Record<string, string | number | null>[]> {
  if (getConfig().demoMode) return demoObservations as unknown as Record<string, string | number | null>[];
  const rows = await query<Record<string, string | number | null>>(
    `SELECT observation_id AS id, company_name AS company, metric_label AS metric, display_value AS value,
            period_label AS period, source_label AS source, confidence_percent AS confidence,
            review_state AS state, delta_display AS delta, source_reference_id, fund_period_snapshot_id, materiality
     FROM PM_SERVING.OBSERVATIONS_V WHERE tenant_id = ? ORDER BY company_name, metric_label LIMIT 5000`,
    [session.tenantId], { tenantId: session.tenantId },
  );
  return rows.map((row) => ({
    id: row.id, company: row.company, metric: row.metric, value: row.value, period: row.period, source: row.source,
    confidence: row.confidence, state: row.state, delta: row.delta,
    sourceReferenceId: row.source_reference_id, snapshotId: row.fund_period_snapshot_id, materiality: row.materiality,
  }));
}

async function findOpenUpload(session: Session, idempotencyKey: string): Promise<UploadRecord | undefined> {
  if (getConfig().demoMode) return undefined;
  const rows = await query<UploadRecord>(
    `SELECT upload_id, document_id, artifact_version_id, ingestion_id, tenant_id, object_key, final_object_key,
            s3_upload_id, file_name, content_type, size_bytes, last_modified, part_size, status, idempotency_key,
            TO_VARCHAR(created_at) AS created_at
     FROM PM_SOURCE.DOCUMENT_UPLOAD
     WHERE tenant_id = ? AND idempotency_key = ? AND status IN ('UPLOADING', 'FINALIZING')
     ORDER BY created_at DESC LIMIT 1`,
    [session.tenantId, idempotencyKey], { tenantId: session.tenantId },
  );
  return rows[0];
}

export async function initiateUpload(session: Session, input: { fileName: string; contentType?: string; sizeBytes: number; lastModified?: number }, idempotencyKey: string, requestId?: string): Promise<Record<string, unknown>> {
  validateUploadInput(input);
  if (!idempotencyKey || idempotencyKey.length > 200) throw Object.assign(new Error("Idempotency-Key is required"), { status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  const config = getConfig();
  if (config.demoMode) return { uploadId: `upl_demo_${randomUUID()}`, documentId: `doc_demo_${randomUUID()}`, partSize: config.storage.partSize, alreadyUploadedParts: [] };
  const existing = await findOpenUpload(session, idempotencyKey);
  if (existing) {
    const parts = await listMultipartParts(existing.object_key, existing.s3_upload_id);
    return { uploadId: existing.upload_id, documentId: existing.document_id, partSize: Number(existing.part_size), alreadyUploadedParts: parts };
  }

  const created = ids();
  const name = safeFileName(input.fileName);
  const quarantineKey = `quarantine/tenant=${encodeURIComponent(session.tenantId)}/document=${created.documentId}/artifact=${created.artifactVersionId}/${name}`;
  const finalKey = `source/tenant=${encodeURIComponent(session.tenantId)}/document=${created.documentId}/artifact=${created.artifactVersionId}/original/${name}`;
  const storageUploadId = await createMultipartUpload(quarantineKey, { tenant_id: session.tenantId, document_id: created.documentId, artifact_version_id: created.artifactVersionId, ingestion_id: created.ingestionId }, input.contentType || "application/octet-stream");
  try {
    await execute(`INSERT INTO PM_SOURCE.DOCUMENT (document_id, tenant_id, logical_status, created_by, created_at, updated_at) VALUES (?, ?, 'REGISTERED', ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`, [created.documentId, session.tenantId, session.subject], { tenantId: session.tenantId });
    await execute(
      `INSERT INTO PM_SOURCE.DOCUMENT_UPLOAD
        (upload_id, document_id, artifact_version_id, ingestion_id, tenant_id, object_key, final_object_key, s3_upload_id,
         file_name, content_type, size_bytes, last_modified, part_size, status, idempotency_key, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADING', ?, ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
      [created.uploadId, created.documentId, created.artifactVersionId, created.ingestionId, session.tenantId, quarantineKey, finalKey, storageUploadId, name, input.contentType || "application/octet-stream", input.sizeBytes, input.lastModified || null, config.storage.partSize, idempotencyKey, session.subject], { tenantId: session.tenantId },
    );
  } catch (error) {
    await abortMultipartUpload(quarantineKey, storageUploadId).catch(() => undefined);
    throw error;
  }
  await audit(session, { action: "document.upload.initiated", resourceType: "document", resourceId: created.documentId, requestId, metadata: { fileName: name, sizeBytes: input.sizeBytes } });
  return { uploadId: created.uploadId, documentId: created.documentId, partSize: config.storage.partSize, alreadyUploadedParts: [] };
}

async function loadUpload(session: Session, uploadId: string): Promise<UploadRecord> {
  if (getConfig().demoMode) throw Object.assign(new Error("Demo uploads do not persist server-side"), { status: 404, code: "UPLOAD_NOT_FOUND" });
  const rows = await query<UploadRecord>(
    `SELECT upload_id, document_id, artifact_version_id, ingestion_id, tenant_id, object_key, final_object_key,
            s3_upload_id, file_name, content_type, size_bytes, last_modified, part_size, status, idempotency_key
     FROM PM_SOURCE.DOCUMENT_UPLOAD WHERE tenant_id = ? AND upload_id = ? LIMIT 1`,
    [session.tenantId, uploadId], { tenantId: session.tenantId },
  );
  if (!rows[0]) throw Object.assign(new Error("Upload not found"), { status: 404, code: "UPLOAD_NOT_FOUND" });
  return rows[0];
}

export async function uploadStatus(session: Session, uploadId: string): Promise<Record<string, unknown>> {
  const upload = await loadUpload(session, uploadId);
  const parts = upload.status === "UPLOADING" ? await listMultipartParts(upload.object_key, upload.s3_upload_id) : [];
  return { uploadId: upload.upload_id, documentId: upload.document_id, status: upload.status, partSize: Number(upload.part_size), sizeBytes: Number(upload.size_bytes), uploadedParts: parts };
}

export async function createPartUrl(session: Session, uploadId: string, partNumber: number, contentLength: number): Promise<Record<string, unknown>> {
  const upload = await loadUpload(session, uploadId);
  if (upload.status !== "UPLOADING") throw Object.assign(new Error("Upload is not accepting parts"), { status: 409, code: "UPLOAD_NOT_ACTIVE" });
  const size = Number(upload.size_bytes); const partSize = Number(upload.part_size); const count = expectedPartCount(size, partSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) throw Object.assign(new Error("Invalid part number"), { status: 400, code: "PART_NUMBER_INVALID" });
  const expectedLength = partNumber === count ? size - (count - 1) * partSize : partSize;
  if (contentLength !== expectedLength) throw Object.assign(new Error("Part length does not match upload plan"), { status: 400, code: "PART_LENGTH_INVALID" });
  return { url: presignUploadPart(upload.object_key, upload.s3_upload_id, partNumber), headers: {} };
}

function validateMagic(fileName: string, bytes: Buffer): void {
  const ext = extension(fileName); const hex = bytes.subarray(0, 8).toString("hex").toLowerCase(); const text = bytes.subarray(0, 8).toString("utf8");
  const zipBased = ["xlsx", "docx", "pptx"].includes(ext);
  const valid = ext === "pdf" ? text.startsWith("%PDF-") : zipBased ? hex.startsWith("504b0304") || hex.startsWith("504b0506") || hex.startsWith("504b0708") : ext === "xls" ? hex.startsWith("d0cf11e0a1b11ae1") : ext === "csv";
  if (!valid) throw Object.assign(new Error("Stored object signature does not match the declared file type"), { status: 415, code: "MAGIC_BYTE_MISMATCH" });
}

type ScanResult = { clean: boolean; sha256: string; sizeBytes: number; detectedContentType?: string; findings?: string[] };
async function scanObject(upload: UploadRecord): Promise<ScanResult> {
  const config = getConfig();
  if (config.demoMode) return { clean: true, sha256: sha256Hex(upload.file_name), sizeBytes: Number(upload.size_bytes) };
  const response = await fetch(config.scanner.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(config.scanner.token ? { authorization: `Bearer ${config.scanner.token}` } : {}) },
    body: JSON.stringify({ url: presignGet(upload.object_key, 900), fileName: upload.file_name, expectedSizeBytes: Number(upload.size_bytes) }),
    cache: "no-store", signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Malware scanner failed (${response.status})`);
  const result = await response.json() as ScanResult;
  if (typeof result.clean !== "boolean" || !/^[a-f0-9]{64}$/i.test(result.sha256 || "") || !Number.isSafeInteger(result.sizeBytes)) throw new Error("Malware scanner returned an invalid result");
  return result;
}

export async function completeUpload(session: Session, uploadId: string, submittedParts: CompletedPart[], requestId?: string): Promise<Record<string, unknown>> {
  const upload = await loadUpload(session, uploadId);
  if (upload.status === "COMPLETED") return { documentId: upload.document_id, status: "complete" };
  if (upload.status !== "UPLOADING" && upload.status !== "FINALIZING") throw Object.assign(new Error("Upload cannot be completed from its current state"), { status: 409, code: "UPLOAD_STATE_INVALID" });
  await execute(`UPDATE PM_SOURCE.DOCUMENT_UPLOAD SET status = 'FINALIZING', updated_at = CURRENT_TIMESTAMP() WHERE tenant_id = ? AND upload_id = ?`, [session.tenantId, uploadId], { tenantId: session.tenantId });
  const actualParts = await listMultipartParts(upload.object_key, upload.s3_upload_id);
  const expectedCount = expectedPartCount(Number(upload.size_bytes), Number(upload.part_size));
  if (actualParts.length !== expectedCount || submittedParts.length !== expectedCount) throw Object.assign(new Error("Multipart upload is incomplete"), { status: 409, code: "UPLOAD_INCOMPLETE" });
  const submitted = new Map(submittedParts.map((part) => [part.partNumber, part.etag.replaceAll('"', "")]));
  for (const part of actualParts) if (submitted.get(part.partNumber) !== part.etag.replaceAll('"', "")) throw Object.assign(new Error(`ETag mismatch for part ${part.partNumber}`), { status: 409, code: "PART_ETAG_MISMATCH" });
  await completeMultipartUpload(upload.object_key, upload.s3_upload_id, actualParts);
  validateMagic(upload.file_name, await getObjectRange(upload.object_key, 0, 15));
  const scan = await scanObject(upload);
  if (scan.sizeBytes !== Number(upload.size_bytes)) throw Object.assign(new Error("Scanned object size does not match registered upload"), { status: 409, code: "OBJECT_SIZE_MISMATCH" });
  if (!scan.clean) {
    await execute(`UPDATE PM_SOURCE.DOCUMENT_UPLOAD SET status = 'QUARANTINED', scan_result = PARSE_JSON(?), updated_at = CURRENT_TIMESTAMP() WHERE tenant_id = ? AND upload_id = ?`, [JSON.stringify(scan), session.tenantId, uploadId], { tenantId: session.tenantId });
    await audit(session, { action: "document.upload.quarantined", resourceType: "document", resourceId: upload.document_id, outcome: "denied", requestId, metadata: { findings: scan.findings || [] } });
    throw Object.assign(new Error("Uploaded file was quarantined by security scanning"), { status: 422, code: "FILE_QUARANTINED" });
  }

  const duplicate = await query<{ artifact_version_id: string }>(`SELECT artifact_version_id FROM PM_SOURCE.DOCUMENT_ARTIFACT_VERSION WHERE tenant_id = ? AND sha256 = ? LIMIT 1`, [session.tenantId, scan.sha256.toLowerCase()], { tenantId: session.tenantId });
  await copyObject(upload.object_key, upload.final_object_key, { tenant_id: session.tenantId, document_id: upload.document_id, artifact_version_id: upload.artifact_version_id, sha256: scan.sha256.toLowerCase() }, upload.content_type);
  await deleteObject(upload.object_key);
  await execute(
    `INSERT INTO PM_SOURCE.DOCUMENT_ARTIFACT_VERSION
      (artifact_version_id, document_id, tenant_id, object_key, file_name, content_type, size_bytes, sha256, duplicate_of_artifact_version_id, scan_status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CLEAN', ?, CURRENT_TIMESTAMP())`,
    [upload.artifact_version_id, upload.document_id, session.tenantId, upload.final_object_key, upload.file_name, upload.content_type, Number(upload.size_bytes), scan.sha256.toLowerCase(), duplicate[0]?.artifact_version_id || null, session.subject], { tenantId: session.tenantId },
  );
  await execute(`UPDATE PM_SOURCE.DOCUMENT_UPLOAD SET status = 'COMPLETED', sha256 = ?, scan_result = PARSE_JSON(?), updated_at = CURRENT_TIMESTAMP() WHERE tenant_id = ? AND upload_id = ?`, [scan.sha256.toLowerCase(), JSON.stringify(scan), session.tenantId, uploadId], { tenantId: session.tenantId });
  await execute(`UPDATE PM_SOURCE.DOCUMENT SET logical_status = 'QUEUED', updated_at = CURRENT_TIMESTAMP() WHERE tenant_id = ? AND document_id = ?`, [session.tenantId, upload.document_id], { tenantId: session.tenantId });
  await enqueueJob(session.tenantId, "INTERPRET_DOCUMENT", { documentId: upload.document_id, artifactVersionId: upload.artifact_version_id }, upload.document_id);
  await audit(session, { action: "document.upload.completed", resourceType: "document", resourceId: upload.document_id, requestId, metadata: { sha256: scan.sha256.toLowerCase(), duplicateOf: duplicate[0]?.artifact_version_id || null } });
  return { documentId: upload.document_id, artifactVersionId: upload.artifact_version_id, sha256: scan.sha256.toLowerCase(), status: "complete" };
}

export async function abortUpload(session: Session, uploadId: string, requestId?: string): Promise<void> {
  const upload = await loadUpload(session, uploadId);
  if (upload.status === "UPLOADING" || upload.status === "FINALIZING") await abortMultipartUpload(upload.object_key, upload.s3_upload_id).catch(() => undefined);
  await execute(`UPDATE PM_SOURCE.DOCUMENT_UPLOAD SET status = 'ABORTED', updated_at = CURRENT_TIMESTAMP() WHERE tenant_id = ? AND upload_id = ?`, [session.tenantId, uploadId], { tenantId: session.tenantId });
  await audit(session, { action: "document.upload.aborted", resourceType: "document", resourceId: upload.document_id, requestId });
}

export async function reviewObservation(session: Session, observationId: string, input: { decision: "approve" | "reject" | "correct"; correctedValue?: string; reason?: string }, requestId?: string): Promise<void> {
  const rows = await query<{ observation_id: string; review_state: string; display_value: string }>(`SELECT observation_id, review_state, display_value FROM PM_SERVING.OBSERVATIONS_V WHERE tenant_id = ? AND observation_id = ? LIMIT 1`, [session.tenantId, observationId], { tenantId: session.tenantId });
  if (!rows[0]) throw Object.assign(new Error("Observation not found"), { status: 404, code: "OBSERVATION_NOT_FOUND" });
  if (input.decision === "correct" && !input.correctedValue?.trim()) throw Object.assign(new Error("Corrected value is required"), { status: 400, code: "CORRECTED_VALUE_REQUIRED" });
  const nextState = input.decision === "reject" ? "Rejected" : "Approved";
  await execute(`INSERT INTO PM_CONTROL.REVIEW_EVENT (review_event_id, tenant_id, observation_id, reviewer_subject, decision, previous_value, corrected_value, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP())`, [`rev_${randomUUID()}`, session.tenantId, observationId, session.subject, input.decision, rows[0].display_value, input.correctedValue || null, input.reason || null], { tenantId: session.tenantId });
  await execute(`UPDATE PM_CANONICAL.OBSERVATION SET review_state = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(), corrected_display_value = COALESCE(?, corrected_display_value), updated_at = CURRENT_TIMESTAMP() WHERE tenant_id = ? AND observation_id = ?`, [nextState, session.subject, input.correctedValue || null, session.tenantId, observationId], { tenantId: session.tenantId });
  await audit(session, { action: `observation.review.${input.decision}`, resourceType: "observation", resourceId: observationId, requestId, metadata: { reason: input.reason || null } });
}

export async function publishSnapshot(session: Session, snapshotId: string, requestId?: string): Promise<void> {
  const blockers = await query<{ blocker_count: string }>(`SELECT COUNT(*) AS blocker_count FROM PM_SERVING.OBSERVATIONS_V WHERE tenant_id = ? AND fund_period_snapshot_id = ? AND review_state IN ('Needs review', 'Rejected') AND materiality = 'material'`, [session.tenantId, snapshotId], { tenantId: session.tenantId });
  if (Number(blockers[0]?.blocker_count || 0) > 0) throw Object.assign(new Error("Snapshot has unresolved material review exceptions"), { status: 409, code: "SNAPSHOT_BLOCKED" });
  await execute(`UPDATE PM_CURATED.FUND_PERIOD_SNAPSHOT SET status = 'Published', published_by = ?, published_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP() WHERE tenant_id = ? AND fund_period_snapshot_id = ?`, [session.subject, session.tenantId, snapshotId], { tenantId: session.tenantId });
  await audit(session, { action: "snapshot.published", resourceType: "fund_period_snapshot", resourceId: snapshotId, requestId });
}

export async function getSourceReference(session: Session, sourceReferenceId: string, requestId?: string): Promise<Record<string, unknown>> {
  const rows = await query<Record<string, string | null>>(`SELECT source_reference_id, document_id, artifact_version_id, object_key, page_number, page_label, bounding_box, excerpt, source_document_access_allowed FROM PM_SERVING.SOURCE_REFERENCES_V WHERE tenant_id = ? AND source_reference_id = ? AND source_document_access_allowed = TRUE LIMIT 1`, [session.tenantId, sourceReferenceId], { tenantId: session.tenantId });
  if (!rows[0]) {
    await audit(session, { action: "source.read", resourceType: "source_reference", resourceId: sourceReferenceId, outcome: "denied", requestId });
    throw Object.assign(new Error("Source reference not found or not entitled"), { status: 404, code: "SOURCE_NOT_FOUND" });
  }
  await audit(session, { action: "source.read", resourceType: "source_reference", resourceId: sourceReferenceId, requestId });
  return { ...rows[0], documentUrl: presignGet(String(rows[0].object_key), 300) };
}

export async function createExport(session: Session, input: { snapshotId: string; format?: "csv" | "json" }, requestId?: string): Promise<Record<string, unknown>> {
  const format = input.format || "csv";
  const rows = await query<Record<string, string | null>>(`SELECT company_name, metric_code, metric_label, display_value, period_label, review_state, source_reference_id FROM PM_SERVING.OBSERVATIONS_V WHERE tenant_id = ? AND fund_period_snapshot_id = ? ORDER BY company_name, metric_code`, [session.tenantId, input.snapshotId], { tenantId: session.tenantId });
  const manifest = { tenantId: session.tenantId, snapshotId: input.snapshotId, generatedAt: new Date().toISOString(), schemaVersion: "2026-09-18", rowCount: rows.length, format, reviewPolicy: "published-or-current-review-state" };
  const body = format === "json" ? JSON.stringify({ manifest, rows }, null, 2) : [["company_name", "metric_code", "metric_label", "display_value", "period_label", "review_state", "source_reference_id"], ...rows.map((row) => [row.company_name, row.metric_code, row.metric_label, row.display_value, row.period_label, row.review_state, row.source_reference_id])].map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const exportId = `exp_${randomUUID()}`; const key = `exports/tenant=${encodeURIComponent(session.tenantId)}/${exportId}/snapshot-${encodeURIComponent(input.snapshotId)}.${format}`; const checksum = sha256Hex(body);
  await putObject(key, body, format === "json" ? "application/json" : "text/csv; charset=utf-8", { tenant_id: session.tenantId, export_id: exportId, sha256: checksum });
  await execute(`INSERT INTO PM_CONTROL.EXPORT_EVENT (export_id, tenant_id, snapshot_id, format, object_key, sha256, manifest, created_by, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, PARSE_JSON(?), ?, CURRENT_TIMESTAMP(), DATEADD('day', ?, CURRENT_TIMESTAMP())`, [exportId, session.tenantId, input.snapshotId, format, key, checksum, JSON.stringify(manifest), session.subject, getConfig().retentionDays.exports], { tenantId: session.tenantId });
  await audit(session, { action: "export.created", resourceType: "export", resourceId: exportId, requestId, metadata: { snapshotId: input.snapshotId, format, rowCount: rows.length } });
  return { exportId, url: presignGet(key, 300), expiresInSeconds: 300, sha256: checksum, manifest };
}

export async function enqueueJob(tenantId: string, jobType: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<string> {
  const jobId = `job_${randomUUID()}`;
  await execute(`MERGE INTO PM_CONTROL.JOB target USING (SELECT ? AS tenant_id, ? AS job_type, ? AS idempotency_key, PARSE_JSON(?) AS payload) source ON target.tenant_id = source.tenant_id AND target.job_type = source.job_type AND target.idempotency_key = source.idempotency_key WHEN NOT MATCHED THEN INSERT (job_id, tenant_id, job_type, idempotency_key, payload, status, attempt_count, available_at, created_at, updated_at) VALUES (?, source.tenant_id, source.job_type, source.idempotency_key, source.payload, 'QUEUED', 0, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`, [tenantId, jobType, idempotencyKey, JSON.stringify(payload), jobId], { admin: true });
  return jobId;
}

export async function leaseJob(workerId: string): Promise<Record<string, unknown> | null> {
  const leaseToken = `lease_${randomUUID()}`;
  const candidates = await query<{ job_id: string }>(`SELECT job_id FROM PM_CONTROL.JOB WHERE status = 'QUEUED' AND available_at <= CURRENT_TIMESTAMP() AND (leased_until IS NULL OR leased_until < CURRENT_TIMESTAMP()) ORDER BY created_at LIMIT 1`, [], { admin: true });
  if (!candidates[0]?.job_id) return null;
  await execute(`UPDATE PM_CONTROL.JOB SET status = 'LEASED', leased_by = ?, lease_token = ?, leased_until = DATEADD('minute', 10, CURRENT_TIMESTAMP()), attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP() WHERE job_id = ? AND status = 'QUEUED' AND (leased_until IS NULL OR leased_until < CURRENT_TIMESTAMP())`, [workerId, leaseToken, candidates[0].job_id], { admin: true });
  const leased = await query<Record<string, string | null>>(`SELECT job_id, tenant_id, job_type, payload, lease_token FROM PM_CONTROL.JOB WHERE job_id = ? AND leased_by = ? AND lease_token = ? LIMIT 1`, [candidates[0].job_id, workerId, leaseToken], { admin: true });
  if (!leased[0]) return null;
  return { ...leased[0], payload: leased[0].payload ? JSON.parse(leased[0].payload) : {} };
}

export async function completeJob(jobId: string, input: { status: "SUCCEEDED" | "FAILED" | "RETRY"; error?: string }): Promise<void> {
  if (input.status === "RETRY") {
    await execute(`UPDATE PM_CONTROL.JOB SET status = 'QUEUED', last_error = ?, available_at = DATEADD('minute', LEAST(60, POW(2, attempt_count)), CURRENT_TIMESTAMP()), leased_by = NULL, lease_token = NULL, leased_until = NULL, updated_at = CURRENT_TIMESTAMP() WHERE job_id = ?`, [input.error || null, jobId], { admin: true });
    return;
  }
  await execute(`UPDATE PM_CONTROL.JOB SET status = ?, last_error = ?, completed_at = CURRENT_TIMESTAMP(), leased_by = NULL, lease_token = NULL, leased_until = NULL, updated_at = CURRENT_TIMESTAMP() WHERE job_id = ?`, [input.status, input.error || null, jobId], { admin: true });
}

export async function readiness(session: Session): Promise<Record<string, unknown>> {
  const config = getConfig();
  const controls = [
    { id: "auth", status: config.demoMode ? "demo" : "configured", detail: config.demoMode ? "Demo identity" : "OIDC + encrypted session" },
    { id: "tenant", status: config.demoMode ? "demo" : "configured", detail: config.demoMode ? "Demo tenant" : `Snowflake tenant role ${tenantRole(session.tenantId)}` },
    { id: "storage", status: config.demoMode ? "demo" : "configured", detail: config.demoMode ? "Demo transport" : "Quarantined S3 multipart ingestion" },
    { id: "scanner", status: config.demoMode ? "demo" : "configured", detail: config.demoMode ? "No scanner in demo" : "Mandatory malware/content scanner" },
    { id: "search", status: config.demoMode ? "demo" : "configured", detail: config.demoMode ? "Demo research" : "Tenant-filtered Cortex Search" },
    { id: "audit", status: config.demoMode ? "demo" : "configured", detail: "Tenant-scoped audit events" },
  ];
  return { environment: config.environment, demoMode: config.demoMode, tenantId: session.tenantId, controls };
}

export async function retentionDeleteDocument(session: Session, documentId: string, requestId?: string): Promise<void> {
  const artifacts = await query<{ object_key: string }>(`SELECT object_key FROM PM_SOURCE.DOCUMENT_ARTIFACT_VERSION WHERE tenant_id = ? AND document_id = ?`, [session.tenantId, documentId], { tenantId: session.tenantId });
  for (const artifact of artifacts) await deleteObject(artifact.object_key).catch(() => undefined);
  await execute(`UPDATE PM_SOURCE.DOCUMENT SET logical_status = 'DELETED', deleted_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP() WHERE tenant_id = ? AND document_id = ?`, [session.tenantId, documentId], { tenantId: session.tenantId });
  await execute(`UPDATE PM_SOURCE.DOCUMENT_ARTIFACT_VERSION SET deleted_at = CURRENT_TIMESTAMP() WHERE tenant_id = ? AND document_id = ?`, [session.tenantId, documentId], { tenantId: session.tenantId });
  await audit(session, { action: "document.deleted", resourceType: "document", resourceId: documentId, requestId });
}

export { cortexSearch };
