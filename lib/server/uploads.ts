import { randomUUID } from "crypto";
import type { RequestIdentity } from "@/core/enterprise";
import { getServerConfig } from "@/lib/server/config";

export type UploadSession = {
  uploadId: string;
  documentId: string;
  artifactVersionId: string;
  ingestionId: string;
  tenantId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  partSize: number;
  state: "initiated" | "uploading" | "quarantined" | "complete" | "aborted";
  completedParts: { partNumber: number; etag: string }[];
  checksumSha256?: string;
  idempotencyKey: string;
  createdAt: string;
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

class DemoUploadSessions implements UploadSessionPort {
  private sessions = new Map<string, UploadSession>();
  private idempotency = new Map<string, string>();

  async initiate(identity: RequestIdentity, input: Parameters<UploadSessionPort["initiate"]>[1]) {
    if (!input.fileName || !allowedExtensions.test(input.fileName)) throw new Error("Unsupported file type");
    if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_FILE_BYTES) throw new Error("Invalid file size");
    const existingId = this.idempotency.get(`${identity.tenantId}:${input.idempotencyKey}`);
    if (existingId) return this.get(identity, existingId);
    const session: UploadSession = {
      uploadId: randomUUID(), documentId: randomUUID(), artifactVersionId: randomUUID(), ingestionId: randomUUID(),
      tenantId: identity.tenantId, fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes,
      partSize: PART_SIZE, state: "initiated", completedParts: [], checksumSha256: input.checksumSha256,
      idempotencyKey: input.idempotencyKey, createdAt: new Date().toISOString(),
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
  async complete(identity: RequestIdentity, uploadId: string, parts: { partNumber: number; etag: string }[], idempotencyKey: string) {
    const session = await this.get(identity, uploadId);
    if (idempotencyKey !== session.idempotencyKey) throw new Error("Upload completion idempotency key does not match session");
    if (session.state === "complete") return session;
    const unique = new Set(parts.map((p) => p.partNumber));
    if (!parts.length || unique.size !== parts.length || parts.some((p) => !p.etag || p.partNumber < 1)) throw new Error("Invalid completed parts");
    session.completedParts = [...parts].sort((a,b) => a.partNumber - b.partNumber);
    session.state = "complete";
    return session;
  }
  async abort(identity: RequestIdentity, uploadId: string) { const s = await this.get(identity, uploadId); s.state = "aborted"; }
}

class UnboundProductionUploadSessions implements UploadSessionPort {
  private fail(): never { throw new Error("Production object-store upload adapter is not bound"); }
  async initiate(): Promise<UploadSession> { return this.fail(); }
  async get(): Promise<UploadSession> { return this.fail(); }
  async presignPart(): Promise<{ url: string; headers?: Record<string,string> }> { return this.fail(); }
  async complete(): Promise<UploadSession> { return this.fail(); }
  async abort(): Promise<void> { return this.fail(); }
}

let singleton: UploadSessionPort | undefined;
export function uploads(): UploadSessionPort {
  if (!singleton) singleton = getServerConfig().demoMode ? new DemoUploadSessions() : new UnboundProductionUploadSessions();
  return singleton;
}
