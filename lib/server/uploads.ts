import { createHash, randomUUID } from "crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { gcs, type GcsObject, type UploadObjectStore } from "./gcs.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";

export type UploadRequestErrorCode =
  | "unsupported_file_type"
  | "unsupported_media_type"
  | "invalid_file_size"
  | "upload_origin_not_allowed"
  | "upload_not_found"
  | "upload_idempotency_mismatch"
  | "upload_not_active"
  | "upload_expired"
  | "upload_incomplete"
  | "invalid_file_content";

const UPLOAD_ERROR_STATUS: Record<UploadRequestErrorCode, number> = {
  unsupported_file_type: 415,
  unsupported_media_type: 415,
  invalid_file_size: 400,
  upload_origin_not_allowed: 403,
  upload_not_found: 404,
  upload_idempotency_mismatch: 409,
  upload_not_active: 409,
  upload_expired: 410,
  upload_incomplete: 409,
  invalid_file_content: 422,
};

/** Client-attributable upload failure with a stable code and HTTP status (see apiError). */
export class UploadRequestError extends Error {
  readonly code: UploadRequestErrorCode;
  readonly status: number;
  constructor(code: UploadRequestErrorCode, message: string) {
    super(message);
    this.name = "UploadRequestError";
    this.code = code;
    this.status = UPLOAD_ERROR_STATUS[code];
  }
}

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
  chunkSize: number;
  state: "initiated" | "uploading" | "quarantined" | "complete" | "aborted";
  checksumSha256?: string;
  storageChecksumCrc32c?: string;
  storageChecksumMd5?: string;
  idempotencyKey: string;
  createdAt: string;
  objectKey?: string;
  resumableUploadUrl?: string;
  storageVersionId?: string;
  contentValidated?: boolean;
  malwareScanStatus?: "pending" | "clean" | "threat" | "error";
  releasedAt?: string;
  purgedAt?: string;
};

export type UploadLifecycleOptions = {
  now?: Date;
  limit?: number;
  abandonedAfterMs?: number;
  quarantineRetentionMs?: number;
};

export type UploadLifecycleSweep = {
  scanned: number;
  abandoned: number;
  quarantinePurged: number;
  retained: number;
  skipped: number;
};

export interface UploadSessionPort {
  initiate(identity: RequestIdentity, input: {
    fileName: string;
    contentType: string;
    sizeBytes: number;
    lastModified?: number;
    checksumSha256?: string;
    idempotencyKey: string;
    origin?: string;
  }): Promise<UploadSession>;
  get(identity: RequestIdentity, uploadId: string): Promise<UploadSession>;
  complete(identity: RequestIdentity, uploadId: string, idempotencyKey: string): Promise<UploadSession>;
  abort(identity: RequestIdentity, uploadId: string): Promise<void>;
  sweep(tenantId: string, options?: UploadLifecycleOptions): Promise<UploadLifecycleSweep>;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
/** An authorized resumable session may not be completed after this age. */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Quarantined bytes without a clean disposition are purged after this age. */
export const QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SWEEP_SESSIONS = 500;
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
function sessionPrefix(tenantId: string): string { return `_corvis/upload-sessions/tenant=${encodeURIComponent(tenantId)}/`; }
function sessionKey(tenantId: string, uploadId: string): string { return `${sessionPrefix(tenantId)}${uploadId}.json`; }
function idempotencyKey(tenantId: string, key: string): string { return `_corvis/upload-idempotency/tenant=${encodeURIComponent(tenantId)}/${keyHash(key)}.json`; }

export function validateSourceMagic(fileName: string, bytes: Buffer): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (/\.(xlsx|docx|pptx)$/i.test(lower)) return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
  if (lower.endsWith(".xls")) return bytes.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
  if (lower.endsWith(".csv")) return !bytes.includes(0x00);
  return false;
}

function emptySweep(): UploadLifecycleSweep {
  return { scanned: 0, abandoned: 0, quarantinePurged: 0, retained: 0, skipped: 0 };
}

function ageMs(session: UploadSession, now: number): number {
  const createdAt = Date.parse(session.createdAt);
  return Number.isFinite(createdAt) ? now - createdAt : Number.POSITIVE_INFINITY;
}

/** Object identity the initiating call bound to the resumable session. */
export function expectedObjectMetadata(session: UploadSession): Record<string, string> {
  const expected: Record<string, string> = {
    tenant: session.tenantId,
    document: session.documentId,
    artifact: session.artifactVersionId,
    ingestion: session.ingestionId,
  };
  if (session.checksumSha256) expected.sha256 = session.checksumSha256;
  return expected;
}

/**
 * Fail closed unless the stored object is still exactly the object this session
 * authorized: declared size, bound lineage metadata and, once verified, the same
 * generation and storage checksums.
 */
export function assertObjectMatchesSession(session: UploadSession, object: GcsObject): void {
  const storedSize = Number(object.size ?? 0);
  if (!Number.isFinite(storedSize) || storedSize !== session.sizeBytes) {
    throw new Error("Uploaded object size does not match the authorized upload session");
  }
  for (const [key, value] of Object.entries(expectedObjectMetadata(session))) {
    const declared = object.metadata?.[key];
    if (declared !== undefined && declared !== value) {
      throw new Error("Uploaded object lineage does not match the authorized upload session");
    }
  }
  if (session.storageVersionId && object.generation !== session.storageVersionId) {
    throw new Error("Uploaded object generation changed after verification");
  }
  if (session.storageChecksumCrc32c && object.crc32c !== session.storageChecksumCrc32c) {
    throw new Error("Uploaded object checksum changed after verification");
  }
  if (session.storageChecksumMd5 && object.md5Hash !== session.storageChecksumMd5) {
    throw new Error("Uploaded object checksum changed after verification");
  }
}

function validateInitiate(input: { fileName: string; contentType: string; sizeBytes: number; origin?: string }): void {
  if (!input.fileName || !allowedExtensions.test(input.fileName)) throw new UploadRequestError("unsupported_file_type", "Unsupported file type");
  if (!allowedMime.has(input.contentType || "application/octet-stream")) throw new UploadRequestError("unsupported_media_type", "Unsupported media type");
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_FILE_BYTES) throw new UploadRequestError("invalid_file_size", "Invalid file size");

  const config = getServerConfig();
  if (config.environment === "production") {
    if (!input.origin || !config.uploadAllowedOrigins.includes(input.origin)) throw new UploadRequestError("upload_origin_not_allowed", "Upload origin is not allowed");
  } else if (input.origin && config.uploadAllowedOrigins.length && !config.uploadAllowedOrigins.includes(input.origin)) {
    throw new UploadRequestError("upload_origin_not_allowed", "Upload origin is not allowed");
  }
}

class DemoUploadSessions implements UploadSessionPort {
  private sessions = new Map<string, UploadSession>();
  private idempotency = new Map<string, string>();

  async initiate(identity: RequestIdentity, input: Parameters<UploadSessionPort["initiate"]>[1]) {
    validateInitiate(input);
    const existingId = this.idempotency.get(`${identity.tenantId}:${input.idempotencyKey}`);
    if (existingId) {
      const existing = await this.get(identity, existingId);
      if (existing.state !== "aborted") return existing;
    }
    const config = getServerConfig();
    const session: UploadSession = {
      uploadId: randomUUID(), documentId: randomUUID(), artifactVersionId: randomUUID(), ingestionId: randomUUID(),
      tenantId: identity.tenantId, actorSubject: identity.subject, fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes,
      chunkSize: config.gcsChunkSizeBytes ?? 8 * 1024 * 1024, state: "initiated", checksumSha256: input.checksumSha256,
      idempotencyKey: input.idempotencyKey, createdAt: new Date().toISOString(), malwareScanStatus: "clean", contentValidated: true,
      resumableUploadUrl: `/api/v1/uploads/${randomUUID()}/demo`,
    };
    this.sessions.set(session.uploadId, session);
    this.idempotency.set(`${identity.tenantId}:${input.idempotencyKey}`, session.uploadId);
    return session;
  }
  async get(identity: RequestIdentity, uploadId: string) {
    const session = this.sessions.get(uploadId);
    if (!session || session.tenantId !== identity.tenantId) throw new UploadRequestError("upload_not_found", "Upload not found");
    return session;
  }
  async complete(identity: RequestIdentity, uploadId: string, key: string) {
    const session = await this.get(identity, uploadId);
    if (key !== session.idempotencyKey) throw new UploadRequestError("upload_idempotency_mismatch", "Upload completion idempotency key does not match session");
    if (session.state === "complete") return session;
    session.state = "complete";
    session.releasedAt = new Date().toISOString();
    return session;
  }
  async abort(identity: RequestIdentity, uploadId: string) { const s = await this.get(identity, uploadId); s.state = "aborted"; }
  async sweep(tenantId: string, options: UploadLifecycleOptions = {}): Promise<UploadLifecycleSweep> {
    const now = (options.now ?? new Date()).getTime();
    const abandonedAfterMs = options.abandonedAfterMs ?? UPLOAD_SESSION_TTL_MS;
    const summary = emptySweep();
    for (const session of this.sessions.values()) {
      if (session.tenantId !== tenantId) continue;
      summary.scanned += 1;
      if (session.state === "complete") { summary.retained += 1; continue; }
      if (session.state === "aborted" || session.purgedAt || ageMs(session, now) <= abandonedAfterMs) { summary.skipped += 1; continue; }
      session.state = "aborted";
      session.purgedAt = new Date(now).toISOString();
      summary.abandoned += 1;
    }
    return summary;
  }
}

export class ProductionUploadSessions implements UploadSessionPort {
  private readonly store: UploadObjectStore;
  private readonly db: PostgresSqlApi;

  constructor(store: UploadObjectStore, db: PostgresSqlApi) {
    this.store = store;
    this.db = db;
  }

  private async persist(session: UploadSession): Promise<void> {
    await this.store.putJson(sessionKey(session.tenantId, session.uploadId), session);
  }

  private async load(identity: RequestIdentity, uploadId: string): Promise<UploadSession> {
    const session = await this.store.getJson<UploadSession>(sessionKey(identity.tenantId, uploadId));
    if (!session || session.tenantId !== identity.tenantId) throw new UploadRequestError("upload_not_found", "Upload not found");
    return session;
  }

  private assertUploader(identity: RequestIdentity, session: UploadSession): void {
    if (session.actorSubject !== identity.subject && !identity.roles.includes("admin")) throw new UploadRequestError("upload_not_found", "Upload not found");
  }

  private async registerInitiated(session: UploadSession): Promise<void> {
    const objectUri = `gs://${this.store.bucket}/${session.objectKey}`;
    await this.db.execute(`insert into corvis_source.document
        (tenant_id,document_id,display_name,media_type,status,created_at,created_by)
      values ($1,$2::uuid,$3,$4,'uploading',$5::timestamptz,$6)
      on conflict (tenant_id,document_id) do nothing`,
    [session.tenantId,session.documentId,session.fileName,session.contentType,session.createdAt,session.actorSubject]);
    await this.db.execute(`insert into corvis_source.document_artifact_version
        (tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,size_bytes,sha256,malware_scan_status,quarantine_status,created_at)
      values ($1,$2::uuid,$3::uuid,$4,$5,$6,$7,'pending','pending',$8::timestamptz)
      on conflict (tenant_id,document_artifact_version_id) do nothing`,
    [session.tenantId,session.artifactVersionId,session.documentId,session.ingestionId,objectUri,session.sizeBytes,session.checksumSha256 ?? null,session.createdAt]);
  }

  private async release(session: UploadSession): Promise<void> {
    if (session.state === "complete") return;
    session.state = "complete";
    session.malwareScanStatus = "clean";
    session.releasedAt = new Date().toISOString();
    const rows = await this.db.query(`select corvis_source.release_clean_artifact($1::uuid,$2::uuid,$3::uuid,$4,$5) as job_id`,
      [session.tenantId,session.documentId,session.artifactVersionId,session.storageVersionId ?? null,session.ingestionId]);
    if (!rows[0]?.job_id) throw new Error("Artifact release did not create processing state");
    await this.persist(session);
  }

  private async refreshScan(session: UploadSession): Promise<UploadSession> {
    if (session.state !== "quarantined" || !session.objectKey) return session;
    // A rejected signature or purged bytes can never become releasable later.
    if (!session.contentValidated || session.purgedAt) return session;
    const config = getServerConfig();
    const object = await this.store.getObjectMetadata(session.objectKey);
    if (!object) return session;
    const status = object.metadata?.[config.gcsMalwareMetadataKey];
    if (status === config.gcsMalwareCleanValue) {
      try {
        assertObjectMatchesSession(session, object);
      } catch (error) {
        await this.quarantineIntegrityFailure(session);
        throw error;
      }
      await this.release(session);
    } else if (status === config.gcsMalwareThreatValue) {
      session.malwareScanStatus = "threat";
      await this.db.execute(`update corvis_source.document_artifact_version
        set malware_scan_status='threat',quarantine_status='quarantined'
        where tenant_id=$1 and document_artifact_version_id=$2::uuid`, [session.tenantId,session.artifactVersionId]);
      await this.db.execute(`update corvis_source.document set status='quarantined'
        where tenant_id=$1 and document_id=$2::uuid`, [session.tenantId,session.documentId]);
      await this.persist(session);
    }
    return session;
  }

  private async quarantineIntegrityFailure(session: UploadSession): Promise<void> {
    session.malwareScanStatus = "error";
    session.contentValidated = false;
    await this.db.execute(`update corvis_source.document_artifact_version
      set malware_scan_status='integrity_failed',quarantine_status='quarantined'
      where tenant_id=$1 and document_artifact_version_id=$2::uuid`, [session.tenantId,session.artifactVersionId]);
    await this.db.execute(`update corvis_source.document set status='quarantined'
      where tenant_id=$1 and document_id=$2::uuid`, [session.tenantId,session.documentId]);
    await this.persist(session);
  }

  private async purgeObject(session: UploadSession, now: number): Promise<void> {
    if (session.resumableUploadUrl) await this.store.cancelResumableUpload(session.resumableUploadUrl).catch(() => undefined);
    if (session.objectKey) await this.store.deleteObject(session.objectKey).catch(() => undefined);
    session.purgedAt = new Date(now).toISOString();
  }

  private async expire(session: UploadSession): Promise<void> {
    await this.purgeObject(session, Date.now());
    session.state = "aborted";
    await this.db.execute(`update corvis_source.document set status='aborted'
      where tenant_id=$1 and document_id=$2::uuid`, [session.tenantId,session.documentId]).catch(() => undefined);
    await this.persist(session);
  }

  async initiate(identity: RequestIdentity, input: Parameters<UploadSessionPort["initiate"]>[1]): Promise<UploadSession> {
    validateInitiate(input);
    const prior = await this.store.getJson<{ uploadId: string }>(idempotencyKey(identity.tenantId, input.idempotencyKey));
    if (prior?.uploadId) {
      const existing = await this.get(identity, prior.uploadId).catch(() => null);
      if (existing && existing.state !== "aborted") return existing;
    }

    const config = getServerConfig();
    const uploadId = randomUUID(); const documentId = randomUUID(); const artifactVersionId = randomUUID(); const ingestionId = randomUUID();
    const objectKey = `tenant=${safeName(identity.tenantId)}/document=${documentId}/artifact=${artifactVersionId}/original/${safeName(input.fileName)}`;
    const resumableUploadUrl = await this.store.createResumableUpload({
      key: objectKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      origin: input.origin,
      metadata: {
        tenant: identity.tenantId, document: documentId, artifact: artifactVersionId, ingestion: ingestionId,
        ...(input.checksumSha256 ? { sha256: input.checksumSha256 } : {}),
      },
    });
    const session: UploadSession = {
      uploadId, documentId, artifactVersionId, ingestionId, tenantId: identity.tenantId, actorSubject: identity.subject,
      fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes,
      chunkSize: config.gcsChunkSizeBytes ?? 8 * 1024 * 1024, state: "initiated",
      checksumSha256: input.checksumSha256, idempotencyKey: input.idempotencyKey, createdAt: new Date().toISOString(),
      objectKey, resumableUploadUrl, contentValidated: false, malwareScanStatus: "pending",
    };
    try {
      await this.persist(session);
      await this.store.putJson(idempotencyKey(identity.tenantId, input.idempotencyKey), { uploadId });
      await this.registerInitiated(session);
      return session;
    } catch (error) {
      await this.store.cancelResumableUpload(resumableUploadUrl).catch(() => undefined);
      throw error;
    }
  }

  async get(identity: RequestIdentity, uploadId: string): Promise<UploadSession> {
    return this.refreshScan(await this.load(identity, uploadId));
  }

  async complete(identity: RequestIdentity, uploadId: string, key: string): Promise<UploadSession> {
    const session = await this.load(identity, uploadId);
    this.assertUploader(identity, session);
    if (key !== session.idempotencyKey) throw new UploadRequestError("upload_idempotency_mismatch", "Upload completion idempotency key does not match session");
    if (session.state === "complete" || session.state === "quarantined") return this.refreshScan(session);
    if (session.state === "aborted") throw new UploadRequestError("upload_not_active", "Upload session is no longer active");
    if (ageMs(session, Date.now()) > UPLOAD_SESSION_TTL_MS) {
      await this.expire(session);
      throw new UploadRequestError("upload_expired", "Upload session has expired");
    }
    if (!session.objectKey) throw new Error("Upload storage state is incomplete");

    const object = await this.store.getObjectMetadata(session.objectKey);
    if (!object) throw new UploadRequestError("upload_incomplete", "GCS upload has not completed");
    assertObjectMatchesSession(session, object);

    session.storageVersionId = object.generation;
    session.storageChecksumCrc32c = object.crc32c;
    session.storageChecksumMd5 = object.md5Hash;
    const prefix = await this.store.getObjectPrefix(session.objectKey, 64);
    session.contentValidated = validateSourceMagic(session.fileName, prefix);
    session.state = "quarantined";
    session.malwareScanStatus = session.contentValidated ? "pending" : "error";
    await this.db.execute(`update corvis_source.document_artifact_version
      set storage_generation=$1,malware_scan_status=$2,quarantine_status='quarantined'
      where tenant_id=$3 and document_artifact_version_id=$4::uuid`,
    [session.storageVersionId ?? null,session.contentValidated ? "pending" : "invalid_content",session.tenantId,session.artifactVersionId]);
    await this.db.execute(`update corvis_source.document set status=$1
      where tenant_id=$2 and document_id=$3::uuid`, [session.contentValidated ? "quarantined" : "rejected",session.tenantId,session.documentId]);
    await this.persist(session);
    if (!session.contentValidated) throw new UploadRequestError("invalid_file_content", "File content does not match the permitted document type");
    return this.refreshScan(session);
  }

  async abort(identity: RequestIdentity, uploadId: string): Promise<void> {
    const session = await this.load(identity, uploadId);
    this.assertUploader(identity, session);
    if (!["complete","aborted"].includes(session.state)) await this.purgeObject(session, Date.now());
    session.state = "aborted";
    await this.db.execute(`update corvis_source.document set status='aborted'
      where tenant_id=$1 and document_id=$2::uuid`, [session.tenantId,session.documentId]).catch(() => undefined);
    await this.persist(session);
  }

  /**
   * Bounded lifecycle maintenance for one tenant: abandoned resumable sessions
   * and quarantined bytes without a clean disposition are purged deterministically
   * and idempotently, while released source evidence and every registry row are
   * retained.
   */
  async sweep(tenantId: string, options: UploadLifecycleOptions = {}): Promise<UploadLifecycleSweep> {
    const now = (options.now ?? new Date()).getTime();
    const limit = Math.min(Math.max(1, options.limit ?? 100), MAX_SWEEP_SESSIONS);
    const abandonedAfterMs = options.abandonedAfterMs ?? UPLOAD_SESSION_TTL_MS;
    const quarantineRetentionMs = options.quarantineRetentionMs ?? QUARANTINE_RETENTION_MS;
    const summary = emptySweep();

    for (const key of await this.store.listObjects(sessionPrefix(tenantId), limit)) {
      const session = await this.store.getJson<UploadSession>(key);
      if (!session?.uploadId || session.tenantId !== tenantId) { summary.skipped += 1; continue; }
      summary.scanned += 1;

      // Accepted source evidence is retained: never cancelled, never deleted.
      if (session.state === "complete") { summary.retained += 1; continue; }
      if (session.purgedAt) { summary.skipped += 1; continue; }

      if (session.state === "quarantined") {
        const unreleasable = session.malwareScanStatus === "threat" || session.contentValidated === false;
        if (!unreleasable && ageMs(session, now) <= quarantineRetentionMs) { summary.skipped += 1; continue; }
        await this.purgeObject(session, now);
        await this.db.execute(`update corvis_source.document_artifact_version
          set quarantine_status='purged'
          where tenant_id=$1 and document_artifact_version_id=$2::uuid`, [session.tenantId,session.artifactVersionId]);
        await this.persist(session);
        summary.quarantinePurged += 1;
        continue;
      }

      if (session.state === "aborted") { await this.purgeObject(session, now); await this.persist(session); summary.abandoned += 1; continue; }
      if (ageMs(session, now) <= abandonedAfterMs) { summary.skipped += 1; continue; }

      await this.purgeObject(session, now);
      session.state = "aborted";
      await this.db.execute(`update corvis_source.document set status='aborted'
        where tenant_id=$1 and document_id=$2::uuid`, [session.tenantId,session.documentId]);
      await this.persist(session);
      summary.abandoned += 1;
    }
    return summary;
  }
}

let singleton: UploadSessionPort | undefined;
export function uploads(): UploadSessionPort {
  if (!singleton) singleton = getServerConfig().demoMode ? new DemoUploadSessions() : new ProductionUploadSessions(gcs(), postgres(getServerConfig().postgresDsn));
  return singleton;
}
