import type { UploadCallbacks, UploadPort, UploadResult } from "@/core/contracts";

type UploadSession = {
  uploadId: string;
  documentId: string;
  chunkSize: number;
  state: string;
  uploadUrl?: string;
};
type InitiateResponse = UploadSession;
type StatusResponse = { data: UploadSession };
type CompleteResponse = { data: { uploadId: string; documentId: string; state: string } };
type Options = { apiBase: string; chunkSize?: number; maxRetries?: number };

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const DEFAULT_MAX_RETRIES = 4;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class ExpiredUploadSessionError extends Error {}

function createJsonRequester(apiBase: string) {
  return async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers || {}) },
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Upload API error ${response.status}`);
    return response.json() as Promise<T>;
  };
}

function parseCommittedRange(value: string | null): number {
  if (!value) return 0;
  const match = /bytes=0-(\d+)/i.exec(value);
  if (!match) return 0;
  const last = Number(match[1]);
  return Number.isFinite(last) ? last + 1 : 0;
}

function xhrRequest(input: {
  url: string;
  body?: Blob | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  onProgress?: (loaded: number) => void;
}): Promise<{ status: number; range: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", input.url);
    Object.entries(input.headers ?? {}).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = (event) => input.onProgress?.(event.loaded);
    xhr.onerror = () => reject(new Error("Network error while uploading to Google Cloud Storage"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    xhr.onload = () => resolve({ status: xhr.status, range: xhr.getResponseHeader("range") });
    const abort = () => xhr.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => input.signal?.removeEventListener("abort", abort);
    xhr.send(input.body ?? null);
  });
}

async function queryCommittedBytes(uploadUrl: string, totalBytes: number, signal?: AbortSignal): Promise<number> {
  const result = await xhrRequest({
    url: uploadUrl,
    headers: { "content-range": `bytes */${totalBytes}` },
    signal,
  });
  if (result.status === 200 || result.status === 201) return totalBytes;
  if (result.status === 308) return parseCommittedRange(result.range);
  if (result.status === 404 || result.status === 410) throw new ExpiredUploadSessionError("The resumable upload session expired");
  throw new Error(`Google Cloud Storage upload status check failed (${result.status})`);
}

async function uploadChunk(input: {
  uploadUrl: string;
  file: File;
  start: number;
  endExclusive: number;
  signal?: AbortSignal;
  onProgress: (absoluteBytes: number) => void;
}): Promise<number> {
  const blob = input.file.slice(input.start, input.endExclusive);
  const result = await xhrRequest({
    url: input.uploadUrl,
    body: blob,
    headers: {
      "content-range": `bytes ${input.start}-${input.endExclusive - 1}/${input.file.size}`,
    },
    signal: input.signal,
    onProgress: (loaded) => input.onProgress(Math.min(input.file.size, input.start + loaded)),
  });
  if (result.status === 200 || result.status === 201) return input.file.size;
  if (result.status === 308) return Math.max(input.endExclusive, parseCommittedRange(result.range));
  if (result.status === 404 || result.status === 410) throw new ExpiredUploadSessionError("The resumable upload session expired");
  throw new Error(`Google Cloud Storage rejected upload chunk (${result.status})`);
}

function fingerprint(file: File) { return `${file.name}:${file.size}:${file.lastModified}`; }
function storageKey(file: File) { return `corvis:upload:${fingerprint(file)}`; }

export function createHttpGcsResumableUploadPort(options: Options): UploadPort {
  const apiBase = options.apiBase.replace(/\/$/, "");
  const fallbackChunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const requestJson = createJsonRequester(apiBase);

  return {
    runtime: { mode: "direct", transport: "gcs-resumable", chunkSize: fallbackChunkSize },
    async upload(file: File, callbacks: UploadCallbacks = {}, signal?: AbortSignal): Promise<UploadResult> {
      if (file.size <= 0) throw new Error("Cannot upload an empty file");
      const localKey = storageKey(file);
      let session: UploadSession | undefined;

      const persisted = typeof window !== "undefined" ? window.localStorage.getItem(localKey) : null;
      if (persisted) {
        try {
          const saved = JSON.parse(persisted) as { uploadId: string };
          const status = await requestJson<StatusResponse>(`/api/v1/uploads/${saved.uploadId}`);
          if (status.data.state === "complete" || status.data.state === "quarantined") {
            window.localStorage.removeItem(localKey);
            callbacks.onProgress?.({ fileName: file.name, uploadedBytes: file.size, totalBytes: file.size, percent: 100, status: "complete", documentId: status.data.documentId });
            return { documentId: status.data.documentId };
          }
          if (status.data.state !== "aborted" && status.data.uploadUrl) session = status.data;
          else window.localStorage.removeItem(localKey);
        } catch {
          window.localStorage.removeItem(localKey);
        }
      }

      if (!session) {
        session = await requestJson<InitiateResponse>("/api/v1/uploads/initiate", {
          method: "POST",
          headers: { "idempotency-key": fingerprint(file) },
          body: JSON.stringify({
            fileName: file.name,
            contentType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            lastModified: file.lastModified,
            idempotencyKey: fingerprint(file),
          }),
        });
        window.localStorage.setItem(localKey, JSON.stringify({ uploadId: session.uploadId }));
      }

      if (!session.uploadUrl) throw new Error("Upload API did not return a GCS resumable session URL");
      const chunkSize = session.chunkSize || fallbackChunkSize;
      if (!Number.isFinite(chunkSize) || chunkSize <= 0 || chunkSize % (256 * 1024) !== 0) throw new Error("Upload API returned an invalid GCS chunk size");

      let offset: number;
      try {
        offset = await queryCommittedBytes(session.uploadUrl, file.size, signal);
      } catch (error) {
        if (error instanceof ExpiredUploadSessionError) {
          await fetch(`${apiBase}/api/v1/uploads/${session.uploadId}`, { method: "DELETE", credentials: "include" }).catch(() => undefined);
          window.localStorage.removeItem(localKey);
        }
        throw error;
      }

      callbacks.onProgress?.({
        fileName: file.name,
        uploadedBytes: offset,
        totalBytes: file.size,
        percent: Math.min(99, Math.round((offset / file.size) * 100)),
        status: "uploading",
        documentId: session.documentId,
      });

      while (offset < file.size) {
        if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
        const endExclusive = Math.min(file.size, offset + chunkSize);
        let attempt = 0;
        while (true) {
          try {
            const nextOffset = await uploadChunk({
              uploadUrl: session.uploadUrl,
              file,
              start: offset,
              endExclusive,
              signal,
              onProgress: (absoluteBytes) => callbacks.onProgress?.({
                fileName: file.name,
                uploadedBytes: absoluteBytes,
                totalBytes: file.size,
                percent: Math.min(99, Math.round((absoluteBytes / file.size) * 100)),
                status: "uploading",
                documentId: session!.documentId,
              }),
            });
            offset = Math.max(offset, nextOffset);
            break;
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            if (error instanceof ExpiredUploadSessionError) throw error;
            attempt += 1;
            if (attempt >= maxRetries) throw error;
            await sleep(400 * 2 ** (attempt - 1));
            offset = await queryCommittedBytes(session.uploadUrl, file.size, signal);
            if (offset >= endExclusive) break;
          }
        }
      }

      callbacks.onProgress?.({ fileName: file.name, uploadedBytes: file.size, totalBytes: file.size, percent: 100, status: "finalizing", documentId: session.documentId });
      const completed = await requestJson<CompleteResponse>(`/api/v1/uploads/${session.uploadId}/complete`, {
        method: "POST",
        headers: { "idempotency-key": fingerprint(file) },
        body: JSON.stringify({ idempotencyKey: fingerprint(file) }),
      });
      window.localStorage.removeItem(localKey);
      callbacks.onProgress?.({ fileName: file.name, uploadedBytes: file.size, totalBytes: file.size, percent: 100, status: "complete", documentId: completed.data.documentId });
      return { documentId: completed.data.documentId };
    },
  };
}
