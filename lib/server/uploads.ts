import { createHash, randomUUID } from "crypto";
import type { RequestIdentity } from "@/core/enterprise";
import { getServerConfig } from "@/lib/server/config";
import { s3, type MultipartPart, type S3ControlClient } from "@/lib/server/s3";
import { snowflake, type SnowflakeSqlApi } from "@/lib/server/snowflake";

export type UploadSession = {
  uploadId: string;
  documentId: string;
  artifactVersionId: string;
  ingestionId: string;
  tenantId: string;
  actorSubject: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  partSize: number;
  state: "initiated" | "uploading" | "quarantined" | "complete" | "aborted";
  completedParts: { partNumber: number; etag: string }[];
  checksumSha256?: string;
  idempotencyKey: string;
  createdAt: string;
  objectKey?: string;
  multipartUploadId?: string;
  storageVersionId?: string;
  contentValidated?: boolean;
  malwareScanStatus?: "pending" | "clean" | "threat" | "error";
  releasedAt?: string;
};

export interface UploadSessionPort {
  initiate(identity: RequestIdentity, input: { fileName: string; contentType: string; sizeBytes: number; lastModified?: number; checksumSha256?: string; idempotencyKey: string }): Promise<UploadSession>;
  get(identity: RequestIdentity, uploadId: string): Promise<UploadSession>;
  presignPart(identity: RequestIdentity, uploadId: string, partNumber: number, contentLength: number): Promise<{ url: string; headers?: Record<string,string> }>;
  complete(identity: RequestIdentity, uploadId: string, parts: { partNumber: number; etag: string }[], idempotencyKey: string): Promise<UploadSession>;
  abort(identity: RequestIdentity, uploadId: string): Promise<void>;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const PART_SIZE = 32 * 1024 * 1024;
const allowedExtensions = /\.(pdf|xlsx|xls|docx|pptx|csv)$/i;
const allowedMime = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv",
  "application/csv",
  "application/octet-stream",
]);

function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180) || "document"; }
function keyHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sessionKey(tenantId: string, uploadId: string): string { return `_corvis/upload-sessions/tenant=${encodeURIComponent(tenantId)}/${uploadId}.json`; }
function idempotencyKey(tenantId: string, key: string): string { return `_corvis/upload-idempotency/tenant=${encodeURIComponent(tenantId)}/${keyHash(key)}.json`; }

export function validateSourceMagic(fileName: string, bytes: Buffer): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (/\.(xlsx|docx|pptx)$/i.test(lower)) return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
  if (lower.endsWith(".xls")) return bytes.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
  if (lower.endsWith(".csv")) return !bytes.includes(0x00);
  return false;
}

function validateInitiate(input: { fileName: string; contentType: string; sizeBytes: number }): void {
  if (!input.fileName || !allowedExtensions.test(input.fileName)) throw new Error("Unsupported file type");
  if (!allowedMime.has(input.contentType || "application/octet-stream")) throw new Error("Unsupported media type");
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_FILE_BYTES) throw new Error("Invalid file size");
}

function validateCompletedParts(session: UploadSession, parts: MultipartPart[]): MultipartPart[] {
  const expectedCount = Math.ceil(session.sizeBytes / session.partSize);
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  if (sorted.length !== expectedCount) throw new Error("Upload is missing one or more parts");
  if (sorted.some((part, index) => part.partNumber !== index + 1 || !part.etag)) throw new Error("Invalid completed parts");
  return sorted;
}

class DemoUploadSessions implements UploadSessionPort {
  private sessions = new Map<string, UploadSession>();
  private idempotency = new Map<string, string>();

  async initiate(identity: RequestIdentity, input: Parameters<UploadSessionPort["initiate"]>[1]) {
    validateInitiate(input);
    const existingId = this.idempotency.get(`${identity.tenantId}:${input.idempotencyKey}`);
    if (existingId) return this.get(identity, existingId);
    const session: UploadSession = {
      uploadId: randomUUID(), documentId: randomUUID(), artifactVersionId: randomUUID(), ingestionId: randomUUID(),
      tenantId: identity.tenantId, actorSubject: identity.subject, fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes,
      partSize: PART_SIZE, state: "initiated", completedParts: [], checksumSha256: input.checksumSha256,
      idempotencyKey: input.idempotencyKey, createdAt: new Date().toISOString(), malwareScanStatus: "clean", contentValidated: true,
    };
    this.sessions.set(session.uploadId, session);
    this.idempotency.set(`${identity.tenantId}:${input.idempotencyKey}`, session.uploadId);
    return session;
  }
  async get(identity: RequestIdentity, uploadId: string) {
    const session = this.sessions.get(uploadId);
    if (!session || session.tenantId !== identity.tenantId) throw new Error("Upload not found");
    return session;
  }
  async presignPart(identity: RequestIdentity, uploadId: string, partNumber: number, contentLength: number) {
    const session = await this.get(identity, uploadId);
    if (!Number.isInteger(partNumber) || partNumber < 1 || contentLength <= 0 || contentLength > session.partSize) throw new Error("Invalid upload part");
    return { url: `/api/v1/uploads/${uploadId}/demo-parts/${partNumber}`, headers: { "x-corvis-demo-upload": "true" } };
  }
  async complete(identity: RequestIdentity, uploadId: string, parts: { partNumber: number; etag: string }[], key: string) {
    const session = await this.get(identity, uploadId);
    if (key !== session.idempotencyKey) throw new Error("Upload completion idempotency key does not match session");
    if (session.state === "complete") return session;
    session.completedParts = validateCompletedParts(session, parts);
    session.state = "complete";
    session.releasedAt = new Date().toISOString();
    return session;
  }
  async abort(identity: RequestIdentity, uploadId: string) { const s = await this.get(identity, uploadId); s.state = "aborted"; }
}

class ProductionUploadSessions implements UploadSessionPort {
  constructor(private readonly store: S3ControlClient, private readonly db: SnowflakeSqlApi) {}

  private async persist(session: UploadSession): Promise<void> {
    await this.store.putJson(sessionKey(session.tenantId, session.uploadId), session);
  }

  private async load(identity: RequestIdentity, uploadId: string): Promise<UploadSession> {
    const session = await this.store.getJson<UploadSession>(sessionKey(identity.tenantId, uploadId));
    if (!session || session.tenantId !== identity.tenantId) throw new Error("Upload not found");
    return session;
  }

  private async registerInitiated(session: UploadSession): Promise<void> {
    const objectUri = `s3://${this.store.bucket}/${session.objectKey}`;
    await this.db.execute(`MERGE INTO PM_SOURCE.DOCUMENT t USING (SELECT ? TENANT_ID, ? DOCUMENT_ID) s ON t.TENANT_ID=s.TENANT_ID AND t.DOCUMENT_ID=s.DOCUMENT_ID WHEN NOT MATCHED THEN INSERT (TENANT_ID,DOCUMENT_ID,DISPLAY_NAME,MEDIA_TYPE,STATUS,CREATED_AT,CREATED_BY) VALUES (?,?,?,?, 'uploading', TO_TIMESTAMP_TZ(?), ?)`, [session.tenantId,session.documentId,session.tenantId,session.documentId,session.fileName,session.contentType,session.createdAt,session.actorSubject]);
    await this.db.execute(`MERGE INTO PM_SOURCE.DOCUMENT_ARTIFACT_VERSION t USING (SELECT ? TENANT_ID, ? DOCUMENT_ARTIFACT_VERSION_ID) s ON t.TENANT_ID=s.TENANT_ID AND t.DOCUMENT_ARTIFACT_VERSION_ID=s.DOCUMENT_ARTIFACT_VERSION_ID WHEN NOT MATCHED THEN INSERT (TENANT_ID,DOCUMENT_ARTIFACT_VERSION_ID,DOCUMENT_ID,INGESTION_ID,OBJECT_URI,SIZE_BYTES,SHA256,MALWARE_SCAN_STATUS,QUARANTINE_STATUS,CREATED_AT) VALUES (?,?,?,?,?,?,?,'pending','pending',TO_TIMESTAMP_TZ(?))`, [session.tenantId,session.artifactVersionId,session.tenantId,session.artifactVersionId,session.documentId,session.ingestionId,objectUri,session.sizeBytes,session.checksumSha256 ?? null,session.createdAt]);
  }

  private async release(session: UploadSession): Promise<void> {
    if (session.state === "complete") return;
    const now = new Date().toISOString();
    session.state = "complete";
    session.malwareScanStatus = "clean";
    session.releasedAt = now;
    await this.db.execute(`UPDATE PM_SOURCE.DOCUMENT_ARTIFACT_VERSION SET STORAGE_VERSION=?, MALWARE_SCAN_STATUS='clean', QUARANTINE_STATUS='released' WHERE TENANT_ID=? AND DOCUMENT_ARTIFACT_VERSION_ID=?`, [session.storageVersionId ?? null, session.tenantId, session.artifactVersionId]);
    await this.db.execute(`UPDATE PM_SOURCE.DOCUMENT SET STATUS='queued' WHERE TENANT_ID=? AND DOCUMENT_ID=?`, [session.tenantId, session.documentId]);
    const jobId = `registered:${session.documentId}`;
    await this.db.execute(`MERGE INTO PM_CONTROL.PROCESSING_JOB t USING (SELECT ? TENANT_ID, ? JOB_ID) s ON t.TENANT_ID=s.TENANT_ID AND t.JOB_ID=s.JOB_ID WHEN NOT MATCHED THEN INSERT (TENANT_ID,JOB_ID,DOCUMENT_ID,STAGE,STATE,ATTEMPT,MAX_ATTEMPTS,CORRELATION_ID,VERSION,CREATED_AT,UPDATED_AT) VALUES (?,?,?,'registered','queued',0,5,?,1,TO_TIMESTAMP_TZ(?),TO_TIMESTAMP_TZ(?))`, [session.tenantId,jobId,session.tenantId,jobId,session.documentId,session.ingestionId,now,now]);
    const eventId = `document-registered:${session.documentId}`;
    await this.db.execute(`MERGE INTO PM_CONTROL.OUTBOX_EVENT t USING (SELECT ? TENANT_ID, ? EVENT_ID) s ON t.TENANT_ID=s.TENANT_ID AND t.EVENT_ID=s.EVENT_ID WHEN NOT MATCHED THEN INSERT (TENANT_ID,EVENT_ID,EVENT_TYPE,AGGREGATE_TYPE,AGGREGATE_ID,PAYLOAD,CREATED_AT) SELECT ?,?,'DocumentRegistered','document',?,PARSE_JSON(?),TO_TIMESTAMP_TZ(?)`, [session.tenantId,eventId,session.tenantId,eventId,session.documentId,JSON.stringify({ documentId: session.documentId, artifactVersionId: session.artifactVersionId, ingestionId: session.ingestionId }),now]);
    await this.persist(session);
  }

  private async refreshScan(session: UploadSession): Promise<UploadSession> {
    if (session.state !== "quarantined" || !session.objectKey) return session;
    const config = getServerConfig();
    const tags = await this.store.getTags(session.objectKey);
    const status = tags[config.malwareCleanTagKey ?? "GuardDutyMalwareScanStatus"];
    if (status === config.malwareCleanTagValue) {
      await this.release(session);
    } else if (status === config.malwareThreatTagValue) {
      session.malwareScanStatus = "threat";
      await this.db.execute(`UPDATE PM_SOURCE.DOCUMENT_ARTIFACT_VERSION SET MALWARE_SCAN_STATUS='threat', QUARANTINE_STATUS='quarantined' WHERE TENANT_ID=? AND DOCUMENT_ARTIFACT_VERSION_ID=?`, [session.tenantId, session.artifactVersionId]);
      await this.db.execute(`UPDATE PM_SOURCE.DOCUMENT SET STATUS='quarantined' WHERE TENANT_ID=? AND DOCUMENT_ID=?`, [session.tenantId, session.documentId]);
      await this.persist(session);
    }
    return session;
  }

  async initiate(identity: RequestIdentity, input: Parameters<UploadSessionPort["initiate"]>[1]): Promise<UploadSession> {
    validateInitiate(input);
    const prior = await this.store.getJson<{ uploadId: string }>(idempotencyKey(identity.tenantId, input.idempotencyKey));
    if (prior?.uploadId) return this.get(identity, prior.uploadId);
    const uploadId = randomUUID(); const documentId = randomUUID(); const artifactVersionId = randomUUID(); const ingestionId = randomUUID();
    const objectKey = `tenant=${safeName(identity.tenantId)}/document=${documentId}/artifact=${artifactVersionId}/original/${safeName(input.fileName)}`;
    const multipartUploadId = await this.store.createMultipartUpload(objectKey, { tenant: identity.tenantId, document: documentId, artifact: artifactVersionId, ingestion: ingestionId });
    const session: UploadSession = {
      uploadId, documentId, artifactVersionId, ingestionId, tenantId: identity.tenantId, actorSubject: identity.subject,
      fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes, partSize: PART_SIZE, state: "initiated",
      completedParts: [], checksumSha256: input.checksumSha256, idempotencyKey: input.idempotencyKey, createdAt: new Date().toISOString(),
      objectKey, multipartUploadId, contentValidated: false, malwareScanStatus: "pending",
    };
    try {
      await this.persist(session);
      await this.store.putJson(idempotencyKey(identity.tenantId, input.idempotencyKey), { uploadId });
      await this.registerInitiated(session);
      return session;
    } catch (error) {
      await this.store.abortMultipartUpload(objectKey, multipartUploadId).catch(() => undefined);
      throw error;
    }
  }

  async get(identity: RequestIdentity, uploadId: string): Promise<UploadSession> {
    const session = await this.load(identity, uploadId);
    if (session.multipartUploadId && session.objectKey && ["initiated","uploading"].includes(session.state)) {
      session.completedParts = await this.store.listParts(session.objectKey, session.multipartUploadId);
      if (session.completedParts.length) session.state = "uploading";
      await this.persist(session);
    }
    return this.refreshScan(session);
  }

  async presignPart(identity: RequestIdentity, uploadId: string, partNumber: number, contentLength: number) {
    const session = await this.load(identity, uploadId);
    if (!session.objectKey || !session.multipartUploadId || !["initiated","uploading"].includes(session.state)) throw new Error("Upload is not accepting parts");
    const expectedCount = Math.ceil(session.sizeBytes / session.partSize);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > expectedCount) throw new Error("Invalid upload part");
    const expectedLength = partNumber === expectedCount ? session.sizeBytes - (partNumber - 1) * session.partSize : session.partSize;
    if (contentLength !== expectedLength) throw new Error("Upload part length does not match session");
    session.state = "uploading";
    await this.persist(session);
    return { url: this.store.presignUploadPart(session.objectKey, session.multipartUploadId, partNumber) };
  }

  async complete(identity: RequestIdentity, uploadId: string, parts: MultipartPart[], key: string): Promise<UploadSession> {
    const session = await this.load(identity, uploadId);
    if (key !== session.idempotencyKey) throw new Error("Upload completion idempotency key does not match session");
    if (session.state === "complete" || session.state === "quarantined") return this.refreshScan(session);
    if (!session.objectKey || !session.multipartUploadId) throw new Error("Upload storage state is incomplete");
    const normalized = validateCompletedParts(session, parts);
    const completed = await this.store.completeMultipartUpload(session.objectKey, session.multipartUploadId, normalized);
    session.completedParts = normalized;
    session.storageVersionId = completed.versionId;
    const prefix = await this.store.getObjectPrefix(session.objectKey, 64);
    session.contentValidated = validateSourceMagic(session.fileName, prefix);
    session.state = "quarantined";
    session.malwareScanStatus = session.contentValidated ? "pending" : "error";
    await this.db.execute(`UPDATE PM_SOURCE.DOCUMENT_ARTIFACT_VERSION SET STORAGE_VERSION=?, MALWARE_SCAN_STATUS=?, QUARANTINE_STATUS='quarantined' WHERE TENANT_ID=? AND DOCUMENT_ARTIFACT_VERSION_ID=?`, [session.storageVersionId ?? null, session.contentValidated ? "pending" : "invalid_content", session.tenantId, session.artifactVersionId]);
    await this.db.execute(`UPDATE PM_SOURCE.DOCUMENT SET STATUS=? WHERE TENANT_ID=? AND DOCUMENT_ID=?`, [session.contentValidated ? "quarantined" : "rejected", session.tenantId, session.documentId]);
    await this.persist(session);
    if (!session.contentValidated) throw new Error("File content does not match the permitted document type");
    return this.refreshScan(session);
  }

  async abort(identity: RequestIdentity, uploadId: string): Promise<void> {
    const session = await this.load(identity, uploadId);
    if (session.objectKey && session.multipartUploadId && !["complete","aborted"].includes(session.state)) await this.store.abortMultipartUpload(session.objectKey, session.multipartUploadId);
    session.state = "aborted";
    await this.db.execute(`UPDATE PM_SOURCE.DOCUMENT SET STATUS='aborted' WHERE TENANT_ID=? AND DOCUMENT_ID=?`, [session.tenantId, session.documentId]).catch(() => undefined);
    await this.persist(session);
  }
}

let singleton: UploadSessionPort | undefined;
export function uploads(): UploadSessionPort {
  if (!singleton) singleton = getServerConfig().demoMode ? new DemoUploadSessions() : new ProductionUploadSessions(s3(), snowflake());
  return singleton;
}
