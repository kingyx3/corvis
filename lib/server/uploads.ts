import { createHash, randomUUID } from "crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { gcs, type GcsObject, type UploadObjectStore } from "./gcs.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";
import { logEvent } from "./telemetry.ts";
import { canAccessUpload } from "./upload-access.ts";
import { sealArtifactIntegrity } from "./upload-integrity.ts";

export type UploadRequestErrorCode =
  | "invalid_upload_request"
  | "unsupported_file_type"
  | "unsupported_media_type"
  | "invalid_file_size"
  | "upload_origin_not_allowed"
  | "upload_not_found"
  | "upload_idempotency_mismatch"
  | "upload_not_active"
  | "upload_expired"
  | "upload_incomplete"
  | "invalid_file_content"
  | "upload_integrity_failed"
  | "upload_conflict";

const UPLOAD_ERROR_STATUS: Record<UploadRequestErrorCode, number> = {
  invalid_upload_request: 400,
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
  upload_integrity_failed: 422,
  upload_conflict: 409,
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
  /** Workspace the upload was initiated from; absent on sessions created before #238. */
  workspaceId?: string;
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
  /** Why a rejected session (`contentValidated === false`) failed, so repeat completes report the same error. */
  rejection?: "invalid_file_content" | "upload_integrity_failed";
  malwareScanStatus?: "pending" | "clean" | "threat" | "error";
  releasedAt?: string;
  purgedAt?: string;
};

export type UploadLifecycleOptions = {
  now?: Date;
  limit?: number;
  abandonedAfterMs?: number;
  quarantineRetentionMs?: number;
  /** Resume a previous sweep: the `nextCursor` it returned. Sessions are visited in listing order. */
  cursor?: string;
};

export type UploadLifecycleSweep = {
  scanned: number;
  abandoned: number;
  quarantinePurged: number;
  retained: number;
  skipped: number;
  /** Present when more session objects remain; pass it as `options.cursor` to continue. */
  nextCursor?: string;
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
const MAX_FILE_NAME_LENGTH = 255;
const SHA256_HEX = /^[a-f0-9]{64}$/i;
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
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

/**
 * The session-level idempotency key for a client-supplied key. Bound to the caller's subject and
 * workspace (JSON-encoded, like idempotency.ts, so no subject/key pair can collide with another) and
 * shared by initiate and complete, which must derive it identically.
 */
export function uploadIdempotencyKey(identity: Pick<RequestIdentity, "subject" | "workspaceId">, clientKey: string): string {
  return JSON.stringify([identity.subject, identity.workspaceId, clientKey]);
}

/** A replay is only valid for the uploader and workspace that created the session. */
function assertSameUploader(identity: RequestIdentity, session: UploadSession): void {
  if (session.actorSubject !== identity.subject || session.workspaceId !== identity.workspaceId) {
    throw new UploadRequestError("upload_idempotency_mismatch", "Upload idempotency key belongs to a different uploader or workspace");
  }
}

/** An idempotent initiate replay must describe the same file as the original request. */
function assertSameInitiate(session: UploadSession, input: { fileName: string; contentType: string; sizeBytes: number; checksumSha256?: string }): void {
  if (session.fileName !== input.fileName || session.contentType !== input.contentType || session.sizeBytes !== input.sizeBytes
    || (session.checksumSha256 ?? undefined) !== (input.checksumSha256 ?? undefined)) {
    throw new UploadRequestError("upload_idempotency_mismatch", "Upload idempotency key was reused for a different file");
  }
}

/** The object delete failed, so the session is not purged and a later sweep must retry it. */
class ObjectPurgeError extends Error {
  constructor(cause: unknown) {
    super("Upload object could not be deleted; a later sweep retries the purge", { cause });
    this.name = "ObjectPurgeError";
  }
}

function sessionContext(session: UploadSession) {
  return { correlationId: session.uploadId, tenantId: session.tenantId, workspaceId: session.workspaceId, actorSubject: session.actorSubject, documentId: session.documentId };
}

/**
 * A session that ended rejected (bad signature, integrity failure) or infected. Only meaningful once
 * `complete` has run (state "quarantined"): a fresh session also has `contentValidated === false`.
 */
function isRejectedSession(session: UploadSession): boolean {
  return session.state === "quarantined" && (session.malwareScanStatus === "threat" || session.contentValidated === false);
}

/**
 * A quarantined session that was rejected (bad signature, integrity failure) or infected can never be
 * released. Every `complete` call reports that failure; only a still-pending scan is a successful poll.
 */
function assertNotRejected(session: UploadSession): void {
  if (session.malwareScanStatus === "threat") throw new UploadRequestError("invalid_file_content", "Uploaded file was rejected by malware scanning");
  if (session.contentValidated !== false) return;
  if (session.rejection === "upload_integrity_failed") throw new UploadRequestError("upload_integrity_failed", "Uploaded bytes do not match the declared SHA-256");
  throw new UploadRequestError("invalid_file_content", "File content does not match the permitted document type");
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function isConflict(error: unknown): boolean {
  return error instanceof UploadRequestError && error.code === "upload_conflict";
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

function validateInitiate(input: { fileName: string; contentType: string; sizeBytes: number; checksumSha256?: string; origin?: string }): void {
  // Request bodies are untyped JSON: a non-string name or checksum must be a
  // client error, never a TypeError or an unbounded value sent to GCS/Postgres.
  if (typeof input.fileName !== "string" || input.fileName.length > MAX_FILE_NAME_LENGTH) throw new UploadRequestError("invalid_upload_request", "Invalid file name");
  if (input.checksumSha256 !== undefined && (typeof input.checksumSha256 !== "string" || !SHA256_HEX.test(input.checksumSha256))) {
    throw new UploadRequestError("invalid_upload_request", "checksumSha256 must be a hex-encoded SHA-256 digest");
  }
  if (!input.fileName || !allowedExtensions.test(input.fileName)) throw new UploadRequestError("unsupported_file_type", "Unsupported file type");
  if (typeof input.contentType !== "string" || !allowedMime.has(input.contentType || "application/octet-stream")) throw new UploadRequestError("unsupported_media_type", "Unsupported media type");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_FILE_BYTES) throw new UploadRequestError("invalid_file_size", "Invalid file size");

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
      assertSameUploader(identity, existing);
      if (existing.state !== "aborted") { assertSameInitiate(existing, input); return existing; }
    }
    const config = getServerConfig();
    const session: UploadSession = {
      uploadId: randomUUID(), documentId: randomUUID(), artifactVersionId: randomUUID(), ingestionId: randomUUID(),
      tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject, fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes,
      chunkSize: config.gcsChunkSizeBytes, state: "initiated", checksumSha256: input.checksumSha256,
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
  async abort(identity: RequestIdentity, uploadId: string) {
    const s = await this.get(identity, uploadId);
    if (s.state === "complete") throw new UploadRequestError("upload_not_active", "Upload session has already completed");
    s.state = "aborted";
  }
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

  /**
   * Generation each session object was read (or last written) at. Writes are
   * conditional on it (`ifGenerationMatch`), so two racing load-modify-persist
   * flows cannot both win: the loser gets `upload_conflict` instead of silently
   * overwriting the other's state. Stores without the conditional surface (the
   * in-memory fakes) fall back to unconditional writes.
   */
  private readonly generations = new WeakMap<UploadSession, string>();

  private async persist(session: UploadSession): Promise<void> {
    const key = sessionKey(session.tenantId, session.uploadId);
    const generation = this.generations.get(session);
    if (this.store.putJsonIfGenerationMatch && generation !== undefined) {
      const result = await this.store.putJsonIfGenerationMatch(key, session, generation);
      if (!result.ok) throw new UploadRequestError("upload_conflict", "Upload session was modified concurrently; retry the request");
      this.generations.set(session, result.generation);
      return;
    }
    await this.store.putJson(key, session);
    this.generations.delete(session);
  }

  /** First write of a brand-new session: it must not already exist. */
  private async persistNew(session: UploadSession): Promise<void> {
    if (!this.store.putJsonIfGenerationMatch) { await this.persist(session); return; }
    const result = await this.store.putJsonIfGenerationMatch(sessionKey(session.tenantId, session.uploadId), session, "0");
    if (!result.ok) throw new UploadRequestError("upload_conflict", "Upload session already exists");
    this.generations.set(session, result.generation);
  }

  private async readSession(key: string): Promise<UploadSession | null> {
    if (this.store.getJsonWithGeneration) {
      const found = await this.store.getJsonWithGeneration<UploadSession>(key);
      if (!found) return null;
      this.generations.set(found.value, found.generation);
      return found.value;
    }
    return this.store.getJson<UploadSession>(key);
  }

  private async load(identity: RequestIdentity, uploadId: string): Promise<UploadSession> {
    // Upload ids are server-issued UUIDs; anything else never reaches an object key (#238).
    if (!UPLOAD_ID.test(uploadId)) throw new UploadRequestError("upload_not_found", "Upload not found");
    const session = await this.readSession(sessionKey(identity.tenantId, uploadId));
    if (!session || session.tenantId !== identity.tenantId) throw new UploadRequestError("upload_not_found", "Upload not found");
    return session;
  }

  private assertUploader(identity: RequestIdentity, session: UploadSession): void {
    if (!canAccessUpload(identity, session)) throw new UploadRequestError("upload_not_found", "Upload not found");
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

  /**
   * Applies a session transition and persists it. When the conditional write loses (or fails) the transition is
   * rolled back in memory: the caller then reports the winner's state, or, if the session object is gone, this
   * session as it still stands, and neither may claim a completion that was never recorded.
   */
  private async persistTransition(session: UploadSession, change: Pick<UploadSession, "state" | "malwareScanStatus" | "releasedAt">): Promise<void> {
    const before = { state: session.state, malwareScanStatus: session.malwareScanStatus, releasedAt: session.releasedAt };
    Object.assign(session, change);
    try {
      await this.persist(session);
    } catch (error) {
      Object.assign(session, before);
      throw error;
    }
  }

  private async release(session: UploadSession): Promise<void> {
    if (session.state === "complete") return;
    if (session.objectKey) {
      const seal = await sealArtifactIntegrity(this.store, this.db, {
        tenantId: session.tenantId, artifactVersionId: session.artifactVersionId, documentId: session.documentId,
        objectKey: session.objectKey, generation: session.storageVersionId,
      });
      if (seal.outcome === "blocked" && seal.status === "threat") {
        // The scheduled scan poll recorded a threat this session never saw; reflect it instead of polling forever.
        session.malwareScanStatus = "threat";
        await this.persist(session);
        return;
      }
      if (seal.outcome === "blocked" && seal.status !== "integrity_failed" && seal.status !== "invalid_content") return;
      if (seal.outcome === "integrity_failed" || seal.outcome === "blocked") {
        // A blocked artifact can only be integrity_failed/invalid_content here: the scheduled path already
        // rejected the bytes, so report that failure rather than leaving the session quarantined forever.
        session.malwareScanStatus = "error";
        session.contentValidated = false;
        session.rejection = "upload_integrity_failed";
        await this.persist(session);
        throw new UploadRequestError("upload_integrity_failed", "Uploaded bytes do not match the declared SHA-256");
      }
      if (seal.outcome === "released") {
        // Another path (the scheduled release, or a concurrent poll) already
        // ran release_clean_artifact for this artifact. Calling it again would
        // unconditionally reset document.status back to 'queued' even if the
        // pipeline has since moved it past that stage, so just record the
        // session as complete without re-releasing.
        await this.persistTransition(session, { state: "complete", malwareScanStatus: "clean", releasedAt: session.releasedAt ?? new Date().toISOString() });
        return;
      }
    }
    // Claim the transition durably BEFORE the irreversible release. A concurrent abort claims
    // "aborted" the same way and then purges the bytes, so whichever conditional write lands first
    // wins and the loser stops (upload_conflict) instead of leaving purged bytes under a session
    // that says complete.
    await this.persistTransition(session, { state: "complete", malwareScanStatus: "clean", releasedAt: new Date().toISOString() });
    try {
      const rows = await this.db.query(`select corvis_source.release_clean_artifact($1::uuid,$2::uuid,$3::uuid,$4,$5) as job_id`,
        [session.tenantId,session.documentId,session.artifactVersionId,session.storageVersionId ?? null,session.ingestionId]);
      if (!rows[0]?.job_id) throw new Error("Artifact release did not create processing state");
    } catch (error) {
      // Nothing was released: reopen the session so the next poll (or the scheduled release) retries.
      session.state = "quarantined";
      session.releasedAt = undefined;
      await this.persist(session).catch(() => undefined);
      throw error;
    }
  }

  /** Re-reads a session after losing a conditional write, so a poll reports the winner's state. */
  private async reload(session: UploadSession): Promise<UploadSession> {
    return (await this.readSession(sessionKey(session.tenantId, session.uploadId))) ?? session;
  }

  /** Aborted/expired sessions can never be released: take them out of the scheduled release's queue. */
  private async markArtifactPurged(session: UploadSession): Promise<void> {
    await this.db.execute(`update corvis_source.document_artifact_version
      set quarantine_status='purged'
      where tenant_id=$1 and document_artifact_version_id=$2::uuid and quarantine_status in ('pending','quarantined')`,
    [session.tenantId,session.artifactVersionId]).catch((error) => {
      // Best effort: the session is already aborted, but an unmarked row stays in the scheduled release's queue.
      logEvent("warn", "upload.mark_artifact_purged_failed", sessionContext(session), { artifactVersionId: session.artifactVersionId, error: errorText(error) });
    });
  }

  /**
   * Atomically claims the registry row for purging before any bytes are destroyed. The scheduled release
   * (upload-release.ts) updates only the registry, so a session that still reads "quarantined" or "aborted" can
   * already describe a RELEASED artifact; its source bytes are evidence and must never be deleted. A claim that
   * matches no row is safe to proceed only when this purge already claimed the row (a retry after a failed
   * delete) or the row was never registered; anything else means a release won the race.
   */
  private async claimArtifactForPurge(session: UploadSession): Promise<"claimed" | "released" | "lost"> {
    try {
      return await this.claimArtifactRow(session);
    } catch (error) {
      // Best effort, as before: a registry outage must not stop an abort. The session is already aborted, and an
      // unmarked row stays in the scheduled release's queue until the next sweep claims it.
      logEvent("warn", "upload.mark_artifact_purged_failed", sessionContext(session), { artifactVersionId: session.artifactVersionId, error: errorText(error) });
      return "claimed";
    }
  }

  private async claimArtifactRow(session: UploadSession): Promise<"claimed" | "released" | "lost"> {
    const claimed = await this.db.query(`update corvis_source.document_artifact_version
      set quarantine_status='purged'
      where tenant_id=$1 and document_artifact_version_id=$2::uuid and quarantine_status in ('pending','quarantined')
      returning 1 as claimed`, [session.tenantId, session.artifactVersionId]);
    if (claimed.length > 0) return "claimed";
    const status = (await this.db.query(`select malware_scan_status, quarantine_status from corvis_source.document_artifact_version
      where tenant_id=$1 and document_artifact_version_id=$2::uuid`, [session.tenantId, session.artifactVersionId]))[0]?.quarantine_status;
    if (status === "released") return "released";
    return status === undefined || status === "purged" ? "claimed" : "lost";
  }

  /** Repairs a session whose bytes a concurrent release already registered, so no purge path ever targets it again. */
  private async restoreReleasedSession(session: UploadSession): Promise<void> {
    session.state = "complete";
    session.malwareScanStatus = "clean";
    session.releasedAt = session.releasedAt ?? new Date().toISOString();
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
      try {
        await this.release(session);
      } catch (error) {
        // Lost the race to a concurrent abort/release: report the winner's state rather than failing a read.
        if (isConflict(error)) return this.reload(session);
        throw error;
      }
    } else if (status === config.gcsMalwareThreatValue) {
      session.malwareScanStatus = "threat";
      await this.db.execute(`update corvis_source.document_artifact_version
        set malware_scan_status='threat',quarantine_status='quarantined'
        where tenant_id=$1 and document_artifact_version_id=$2::uuid`, [session.tenantId,session.artifactVersionId]);
      await this.db.execute(`update corvis_source.document set status='quarantined'
        where tenant_id=$1 and document_id=$2::uuid`, [session.tenantId,session.documentId]);
      try { await this.persist(session); } catch (error) { if (isConflict(error)) return this.reload(session); throw error; }
    }
    return session;
  }

  private async quarantineIntegrityFailure(session: UploadSession): Promise<void> {
    session.malwareScanStatus = "error";
    session.contentValidated = false;
    session.rejection = "upload_integrity_failed";
    await this.db.execute(`update corvis_source.document_artifact_version
      set malware_scan_status='integrity_failed',quarantine_status='quarantined'
      where tenant_id=$1 and document_artifact_version_id=$2::uuid`, [session.tenantId,session.artifactVersionId]);
    await this.db.execute(`update corvis_source.document set status='quarantined'
      where tenant_id=$1 and document_id=$2::uuid`, [session.tenantId,session.documentId]);
    await this.persist(session);
  }

  /**
   * Cancels the resumable session (best effort) and deletes the object. `purgedAt` is set only once
   * the delete succeeded (the store treats an already-missing object as success); a failed delete
   * returns its error with `purgedAt` unset, because sweep skips purged sessions and would never
   * retry the bytes. Callers persist their state first and then surface the failure.
   */
  private async purgeObject(session: UploadSession, now: number): Promise<ObjectPurgeError | undefined> {
    if (session.resumableUploadUrl) await this.store.cancelResumableUpload(session.resumableUploadUrl).catch(() => undefined);
    if (session.objectKey) {
      try {
        await this.store.deleteObject(session.objectKey);
      } catch (error) {
        logEvent("error", "upload.purge_failed", sessionContext(session), { objectKey: session.objectKey, error: errorText(error) });
        return new ObjectPurgeError(error);
      }
    }
    session.purgedAt = new Date(now).toISOString();
    return undefined;
  }

  private async expire(session: UploadSession): Promise<void> {
    // A failed delete leaves purgedAt unset; the caller is told the session expired either way and sweep retries the purge.
    await this.purgeObject(session, Date.now());
    session.state = "aborted";
    await this.markArtifactPurged(session);
    await this.db.execute(`update corvis_source.document set status='aborted'
      where tenant_id=$1 and document_id=$2::uuid`, [session.tenantId,session.documentId]).catch(() => undefined);
    await this.persist(session).catch((error) => { if (!isConflict(error)) throw error; });
  }

  private async readIdempotency(key: string): Promise<{ uploadId?: string; generation?: string } | null> {
    if (this.store.getJsonWithGeneration) {
      const found = await this.store.getJsonWithGeneration<{ uploadId?: string }>(key);
      return found ? { uploadId: found.value.uploadId, generation: found.generation } : null;
    }
    const found = await this.store.getJson<{ uploadId?: string }>(key);
    return found ? { uploadId: found.uploadId } : null;
  }

  /**
   * Binds the idempotency key to `uploadId`. With conditional writes this is an atomic
   * claim (the key must still be absent, or still hold the aborted or rejected record we replaced),
   * so two concurrent initiates with one key can never both create a document.
   */
  private async claimIdempotency(key: string, uploadId: string, priorGeneration: string | undefined): Promise<boolean> {
    if (!this.store.putJsonIfGenerationMatch) { await this.store.putJson(key, { uploadId }); return true; }
    return (await this.store.putJsonIfGenerationMatch(key, { uploadId }, priorGeneration ?? "0")).ok;
  }

  async initiate(identity: RequestIdentity, input: Parameters<UploadSessionPort["initiate"]>[1]): Promise<UploadSession> {
    validateInitiate(input);
    const idempotencyObject = idempotencyKey(identity.tenantId, input.idempotencyKey);
    // A lost claim means a concurrent initiate with the same key won; the next pass returns its session.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const prior = await this.readIdempotency(idempotencyObject);
      if (prior?.uploadId) {
        // Only "the prior session is gone" falls through to a fresh session. A transient storage or database
        // failure must propagate: minting a new session while the quarantined original is still releasable
        // would ingest the same file twice.
        const loaded = await this.load(identity, prior.uploadId).catch((error) => {
          if (error instanceof UploadRequestError && error.code === "upload_not_found") return null;
          throw error;
        });
        if (loaded) assertSameUploader(identity, loaded);
        const existing = loaded ? await this.refreshScanForReplay(identity, loaded) : null;
        // Aborted and rejected/infected sessions are terminal: replaying one would hand the client a session
        // with no upload URL forever, so the same file starts a fresh session (its sweep purges the old bytes).
        if (existing && existing.state !== "aborted" && !isRejectedSession(existing)) { assertSameInitiate(existing, input); return existing; }
      }
      const created = await this.createSession(identity, input, idempotencyObject, prior?.generation);
      if (created) return created;
    }
    throw new UploadRequestError("upload_conflict", "Concurrent uploads with the same idempotency key; retry the request");
  }

  /**
   * Refreshes the scan verdict for an idempotent replay. A rejection raised by the refresh itself (for example an
   * integrity failure, which persists the rejected state first) means the session is terminal, so the replay starts a
   * fresh one; any other failure, including transient infrastructure errors, is surfaced so the client retries.
   */
  private async refreshScanForReplay(identity: RequestIdentity, session: UploadSession): Promise<UploadSession | null> {
    try {
      return await this.refreshScan(session);
    } catch (error) {
      if (!(error instanceof UploadRequestError)) throw error;
      const current = await this.load(identity, session.uploadId);
      if (current.state === "aborted" || isRejectedSession(current)) return null;
      throw error;
    }
  }

  private async createSession(
    identity: RequestIdentity,
    input: Parameters<UploadSessionPort["initiate"]>[1],
    idempotencyObject: string,
    priorGeneration: string | undefined,
  ): Promise<UploadSession | undefined> {
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
      uploadId, documentId, artifactVersionId, ingestionId, tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject,
      fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes,
      chunkSize: config.gcsChunkSizeBytes, state: "initiated",
      checksumSha256: input.checksumSha256, idempotencyKey: input.idempotencyKey, createdAt: new Date().toISOString(),
      objectKey, resumableUploadUrl, contentValidated: false, malwareScanStatus: "pending",
    };
    try {
      await this.persistNew(session);
      if (!await this.claimIdempotency(idempotencyObject, uploadId, priorGeneration)) {
        // Lost the race: discard this attempt entirely (nothing was registered yet).
        await this.store.cancelResumableUpload(resumableUploadUrl).catch(() => undefined);
        session.state = "aborted";
        session.purgedAt = new Date().toISOString();
        await this.persist(session).catch(() => undefined);
        return undefined;
      }
      await this.registerInitiated(session);
      return session;
    } catch (error) {
      await this.store.cancelResumableUpload(resumableUploadUrl).catch(() => undefined);
      // The idempotency record may already point at this session: mark it dead so
      // a retry with the same key authorizes a fresh session instead of replaying
      // one whose resumable URL was cancelled and whose registry rows are missing.
      session.state = "aborted";
      session.purgedAt = new Date().toISOString();
      await this.persist(session).catch(() => undefined);
      throw error;
    }
  }

  async get(identity: RequestIdentity, uploadId: string): Promise<UploadSession> {
    const session = await this.load(identity, uploadId);
    // refreshScan persists scan verdicts and registry state: only an authorized caller may trigger that.
    this.assertUploader(identity, session);
    return this.refreshScan(session);
  }

  /** `refreshScan` for a completing caller: a session that is (or just turned out) rejected or infected is an error, not a poll. */
  private async refreshAccepted(session: UploadSession): Promise<UploadSession> {
    const refreshed = await this.refreshScan(session);
    if (refreshed.state === "quarantined") assertNotRejected(refreshed);
    return refreshed;
  }

  async complete(identity: RequestIdentity, uploadId: string, key: string): Promise<UploadSession> {
    const session = await this.load(identity, uploadId);
    this.assertUploader(identity, session);
    if (key !== session.idempotencyKey) throw new UploadRequestError("upload_idempotency_mismatch", "Upload completion idempotency key does not match session");
    if (session.state === "quarantined") { assertNotRejected(session); return this.refreshAccepted(session); }
    if (session.state === "complete") return session;
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
    if (!session.contentValidated) session.rejection = "invalid_file_content";
    await this.db.execute(`update corvis_source.document_artifact_version
      set storage_generation=$1,malware_scan_status=$2,quarantine_status='quarantined'
      where tenant_id=$3 and document_artifact_version_id=$4::uuid and quarantine_status in ('pending','quarantined')`,
    [session.storageVersionId ?? null,session.contentValidated ? "pending" : "invalid_content",session.tenantId,session.artifactVersionId]);
    // Only advance a document still in the states a completing upload can be in ('uploading', or already
    // quarantined/rejected by an earlier attempt whose session write failed): a concurrent abort or
    // release has moved it on ('aborted', 'queued', ...) and must not be overwritten.
    await this.db.execute(`update corvis_source.document set status=$1
      where tenant_id=$2 and document_id=$3::uuid and status in ('uploading','quarantined','rejected')`,
    [session.contentValidated ? "quarantined" : "rejected",session.tenantId,session.documentId]);
    await this.persist(session);
    assertNotRejected(session);
    return this.refreshAccepted(session);
  }

  async abort(identity: RequestIdentity, uploadId: string): Promise<void> {
    await this.abortAttempt(identity, uploadId, 0);
  }

  private async abortAttempt(identity: RequestIdentity, uploadId: string, attempt: number): Promise<void> {
    const session = await this.load(identity, uploadId);
    this.assertUploader(identity, session);
    if (session.state === "aborted") {
      // Durably aborted but the bytes were never confirmed deleted (a previous delete failed): retry it.
      if (!session.purgedAt) await this.finishAbort(session);
      return;
    }
    // Released source evidence is already queued for processing; aborting must
    // not relabel the registered document as aborted.
    if (session.state === "complete") throw new UploadRequestError("upload_not_active", "Upload session has already completed");
    // Claim the abort durably BEFORE destroying anything. A concurrent release claims "complete"
    // the same way; the loser of the conditional write re-reads and re-decides, so bytes are never
    // purged under a session that ends up complete.
    session.state = "aborted";
    try { await this.persist(session); } catch (error) {
      if (isConflict(error) && attempt < 2) return this.abortAttempt(identity, uploadId, attempt + 1);
      throw error;
    }
    await this.finishAbort(session);
  }

  /** Purges an aborted session's bytes and registry rows. Idempotent: also the retry for an abort whose delete failed. */
  private async finishAbort(session: UploadSession): Promise<void> {
    // The abort is already durable, but it must not outrun a release: claim the registry row first and stop
    // (before deleting bytes or relabelling the document) when the artifact was already released.
    const claim = await this.claimArtifactForPurge(session);
    if (claim === "released") {
      await this.restoreReleasedSession(session);
      throw new UploadRequestError("upload_not_active", "Upload session has already completed");
    }
    if (claim === "lost") throw new UploadRequestError("upload_conflict", "Upload session was released concurrently; retry the request");
    const purgeFailure = await this.purgeObject(session, Date.now());
    await this.db.execute(`update corvis_source.document set status='aborted'
      where tenant_id=$1 and document_id=$2::uuid`, [session.tenantId,session.documentId]).catch(() => undefined);
    // The aborted state is already durable, so a failed delete is surfaced (the client may retry the
    // abort, which re-runs this) and is otherwise left to sweep. Recording purgedAt is best effort.
    if (purgeFailure) throw purgeFailure;
    await this.persist(session).catch((error) => { if (!isConflict(error)) throw error; });
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

    // `limit` bounds the session objects visited per call; the cursor lets a caller walk past the
    // first page (a plain listing capped at `limit` could never see later keys).
    let keys: string[];
    if (this.store.listObjectPage) {
      const page = await this.store.listObjectPage(sessionPrefix(tenantId), { limit, pageToken: options.cursor });
      keys = page.names;
      if (page.nextPageToken) summary.nextCursor = page.nextPageToken;
    } else {
      keys = await this.store.listObjects(sessionPrefix(tenantId), limit);
    }
    for (const key of keys) {
      const session = await this.readSession(key);
      if (!session?.uploadId || session.tenantId !== tenantId) { summary.skipped += 1; continue; }
      summary.scanned += 1;
      try {
        await this.sweepSession(session, now, abandonedAfterMs, quarantineRetentionMs, summary);
      } catch (error) {
        // A concurrent request changed the session under us, or its object could not be deleted (already
        // logged; purgedAt stays unset): leave it to that request / the next sweep.
        if (!isConflict(error) && !(error instanceof ObjectPurgeError)) throw error;
        summary.skipped += 1;
      }
    }
    return summary;
  }

  private async sweepSession(session: UploadSession, now: number, abandonedAfterMs: number, quarantineRetentionMs: number, summary: UploadLifecycleSweep): Promise<void> {
    // Accepted source evidence is retained: never cancelled, never deleted.
    if (session.state === "complete") { summary.retained += 1; return; }
    if (session.purgedAt) { summary.skipped += 1; return; }

    if (session.state === "quarantined") {
      // The scheduled release (upload-release.ts) updates only the registry: its identity has read-only
      // bucket access, so it cannot rewrite this session object. A quarantined session can therefore
      // already describe a RELEASED artifact. Released source evidence is retained, never purged: repair
      // the session and stop before anything is deleted.
      const registry = (await this.db.query(`select malware_scan_status, quarantine_status from corvis_source.document_artifact_version
        where tenant_id=$1 and document_artifact_version_id=$2::uuid`, [session.tenantId, session.artifactVersionId]))[0];
      if (registry?.quarantine_status === "released") {
        session.state = "complete";
        session.malwareScanStatus = "clean";
        session.releasedAt = session.releasedAt ?? new Date(now).toISOString();
        await this.persist(session);
        summary.retained += 1;
        return;
      }
      const unreleasable = session.malwareScanStatus === "threat" || session.contentValidated === false;
      if (!unreleasable && ageMs(session, now) <= quarantineRetentionMs) { summary.skipped += 1; return; }
      // Claim the registry row first, atomically and only while it is still unreleased: that claim is
      // what excludes a concurrent release (release_clean_artifact refuses a purged artifact), so the
      // bytes are deleted only after the artifact can no longer be released.
      // A row this same purge already claimed (its byte delete failed earlier) only needs the delete retried.
      if (registry?.quarantine_status !== "purged") {
        const claimed = await this.db.query(`update corvis_source.document_artifact_version
          set quarantine_status='purged'
          where tenant_id=$1 and document_artifact_version_id=$2::uuid and quarantine_status in ('pending','quarantined')
          returning 1 as claimed`, [session.tenantId, session.artifactVersionId]);
        if (claimed.length === 0) { summary.skipped += 1; return; }
      }
      const purgeFailure = await this.purgeObject(session, now);
      if (purgeFailure) throw purgeFailure;
      await this.persist(session);
      summary.quarantinePurged += 1;
      return;
    }

    if (session.state === "aborted") {
      // An abort that lost to the scheduled release must not take the released bytes down with it.
      const claim = await this.claimArtifactForPurge(session);
      if (claim === "released") { await this.restoreReleasedSession(session); summary.retained += 1; return; }
      if (claim === "lost") { summary.skipped += 1; return; }
      const purgeFailure = await this.purgeObject(session, now);
      if (purgeFailure) throw purgeFailure;
      await this.persist(session);
      summary.abandoned += 1;
      return;
    }
    if (ageMs(session, now) <= abandonedAfterMs) { summary.skipped += 1; return; }

    const purgeFailure = await this.purgeObject(session, now);
    session.state = "aborted";
    await this.markArtifactPurged(session);
    await this.db.execute(`update corvis_source.document set status='aborted'
      where tenant_id=$1 and document_id=$2::uuid`, [session.tenantId,session.documentId]);
    // Persisted even when the delete failed: the session is aborted without purgedAt, so the next sweep retries it.
    await this.persist(session);
    if (purgeFailure) throw purgeFailure;
    summary.abandoned += 1;
  }
}

let singleton: UploadSessionPort | undefined;
export function uploads(): UploadSessionPort {
  if (!singleton) singleton = getServerConfig().demoMode ? new DemoUploadSessions() : new ProductionUploadSessions(gcs(), postgres(getServerConfig().postgresDsn));
  return singleton;
}
