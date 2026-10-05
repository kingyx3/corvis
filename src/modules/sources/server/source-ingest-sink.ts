import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { getServerConfig } from "../../../platform/config.ts";
import type { IngestInput, IngestResult, IngestSink } from "./source-connectors.ts";
import { UploadRequestError, uploadIdempotencyKey, uploads, type UploadSessionPort } from "./uploads.ts";

/**
 * The seam from source connectors into the one ingestion path: the same resumable-upload session, byte transfer,
 * content/integrity check, malware quarantine and release the direct customer upload uses (src/modules/sources/server/uploads.ts).
 * There is no second pipeline. A collected document is an upload made by the scheduler's own system identity for the
 * connection's workspace, so it is quarantined until scanned and enters the normal processing lifecycle once released.
 *
 * Idempotent per remote document version: the upload idempotency key is the connection's acquisition key (remote id,
 * version and content hash), so ingesting the same version again, for example after a run that stopped before it could
 * record the result, finds the existing session and never creates a second document.
 */

/** The subject every collected document is uploaded under. A system actor, never a customer user. */
export const SOURCE_SYNC_SUBJECT = "system:source-sync";
const UPLOAD_PUT_TIMEOUT_MS = 10 * 60 * 1000;

/** Upload errors that are about this one document (and so are a rejection, not a failed run). Anything else is an infrastructure fault and propagates. */
const DOCUMENT_REJECTIONS: ReadonlySet<string> = new Set([
  "invalid_upload_request", "unsupported_file_type", "unsupported_media_type", "invalid_file_size", "invalid_file_content", "upload_integrity_failed",
]);

/** The system identity a connection's collected documents are uploaded as. It holds no role: it can only act on uploads it started. */
export function sourceSyncIdentity(tenantId: string, workspaceId: string): RequestIdentity {
  return {
    subject: SOURCE_SYNC_SUBJECT,
    tenantId,
    workspaceId,
    roles: [],
    entitlements: { workspaceIds: [workspaceId], sourceDocumentAccessAllowed: false },
    authMethod: "service_account",
    sessionId: `source-sync:${workspaceId}`,
  };
}

/** Sends the document's bytes to the session's resumable upload URL in one request. */
export async function putResumableBytes(uploadUrl: string, bytes: Buffer, contentType: string): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType, "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}` },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(UPLOAD_PUT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`source document upload failed (${response.status})`);
}

export type UploadIngestDependencies = {
  uploads?: UploadSessionPort;
  /** Transfers the bytes into the session's object. The default is the real transfer; demo mode has no object store to send to. */
  putBytes?: (uploadUrl: string, bytes: Buffer, contentType: string) => Promise<void>;
};

export function uploadIngestSink(dependencies: UploadIngestDependencies = {}): IngestSink {
  return {
    async ingest(input: IngestInput): Promise<IngestResult> {
      const port = dependencies.uploads ?? uploads();
      const putBytes = dependencies.putBytes ?? (getServerConfig().demoMode ? async () => undefined : putResumableBytes);
      const identity = sourceSyncIdentity(input.tenantId, input.workspaceId);
      const clientKey = `${input.sourceConnectionId}:${input.acquisitionKey}`;
      const idempotencyKey = uploadIdempotencyKey(identity, clientKey);
      try {
        const session = await port.initiate(identity, {
          fileName: input.fileName,
          contentType: input.contentType,
          sizeBytes: input.bytes.length,
          checksumSha256: input.contentSha256,
          idempotencyKey,
          origin: getServerConfig().uploadAllowedOrigins[0],
        });
        // A replayed session that already received its bytes (or is past that) is only completed again, never re-sent.
        if (session.state === "initiated" || session.state === "uploading") await putBytes(session.resumableUploadUrl!, input.bytes, input.contentType);
        const completed = await port.complete(identity, session.uploadId, idempotencyKey);
        return { accepted: true, documentId: completed.documentId, documentArtifactVersionId: completed.artifactVersionId };
      } catch (error) {
        if (error instanceof UploadRequestError && DOCUMENT_REJECTIONS.has(error.code)) {
          return { accepted: false, reason: error.code, quarantined: error.code === "upload_integrity_failed" };
        }
        throw error;
      }
    },
  };
}
