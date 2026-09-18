import type { UploadCallbacks, UploadPort, UploadResult } from "@/core/contracts";

type CompletedPart = { partNumber: number; etag: string };
type InitiateResponse = { uploadId: string; documentId: string; partSize: number; alreadyUploadedParts?: CompletedPart[] };
type PartUrlResponse = { url: string; headers?: Record<string, string> };

type Options = {
  apiBase: string;
  partSize?: number;
  concurrency?: number;
  maxRetries?: number;
};

const DEFAULT_PART_SIZE = 32 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createJsonRequester(apiBase: string) {
  return async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers || {}) },
      credentials: "include",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { detail?: string };
      throw new Error(payload.detail || `Upload API error ${response.status}`);
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  };
}

async function uploadFingerprint(file: File): Promise<string> {
  const input = new TextEncoder().encode(`${file.name}\n${file.size}\n${file.lastModified}\n${file.type}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resumeKey(fingerprint: string): { idempotencyKey: string; clear: () => void } {
  const storageKey = `corvis:upload:${fingerprint}`;
  let token = "";
  try {
    token = window.localStorage.getItem(storageKey) || "";
    if (!token) {
      token = crypto.randomUUID();
      window.localStorage.setItem(storageKey, token);
    }
  } catch {
    token = crypto.randomUUID();
  }
  return {
    idempotencyKey: `${fingerprint}:${token}`,
    clear: () => { try { window.localStorage.removeItem(storageKey); } catch { /* browser storage can be unavailable */ } },
  };
}

function uploadPartWithProgress(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  onDelta: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastLoaded = 0;
    xhr.open("PUT", url);
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const delta = event.loaded - lastLoaded;
      lastLoaded = event.loaded;
      onDelta(delta);
    };
    xhr.onerror = () => reject(new Error("Network error while uploading part"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`Object storage rejected part (${xhr.status})`));
      const etag = xhr.getResponseHeader("etag")?.replaceAll('"', "");
      if (!etag) return reject(new Error("Object storage response did not expose an ETag; storage CORS must expose the ETag header"));
      resolve(etag);
    };
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener("abort", abort);
    xhr.send(blob);
  });
}

async function withRetry<T>(operation: () => Promise<T>, maxRetries: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt < maxRetries - 1) await sleep(500 * 2 ** attempt + Math.round(Math.random() * 250));
    }
  }
  throw lastError;
}

export function createHttpMultipartUploadPort(options: Options): UploadPort {
  const apiBase = options.apiBase.replace(/\/$/, "");
  const fallbackPartSize = options.partSize ?? DEFAULT_PART_SIZE;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const requestJson = createJsonRequester(apiBase);

  return {
    runtime: { mode: "direct", partSize: fallbackPartSize, concurrency },
    async upload(file: File, callbacks: UploadCallbacks = {}, signal?: AbortSignal): Promise<UploadResult> {
      if (file.size <= 0) throw new Error("Cannot upload an empty file");
      const fingerprint = await uploadFingerprint(file);
      const resume = resumeKey(fingerprint);
      const initiated = await requestJson<InitiateResponse>("/uploads/initiate", {
        method: "POST",
        headers: { "idempotency-key": resume.idempotencyKey },
        body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream", sizeBytes: file.size, lastModified: file.lastModified }),
      });
      const partSize = initiated.partSize || fallbackPartSize;
      if (!Number.isFinite(partSize) || partSize < 5 * 1024 * 1024) throw new Error("Upload API returned an invalid multipart part size");

      const partCount = Math.ceil(file.size / partSize);
      const completed = new Map<number, string>((initiated.alreadyUploadedParts || []).map((part) => [part.partNumber, part.etag.replaceAll('"', "")]));
      let uploadedBytes = Array.from(completed.keys()).reduce((sum, partNumber) => {
        const start = (partNumber - 1) * partSize;
        return sum + Math.max(0, Math.min(partSize, file.size - start));
      }, 0);
      let nextPart = 1;

      const report = (status: "uploading" | "finalizing" | "complete") => callbacks.onProgress?.({
        fileName: file.name,
        uploadedBytes: Math.min(uploadedBytes, file.size),
        totalBytes: file.size,
        percent: status === "complete" ? 100 : Math.min(99, Math.round((uploadedBytes / file.size) * 100)),
        status,
        documentId: initiated.documentId,
      });
      report("uploading");

      const worker = async () => {
        while (true) {
          const partNumber = nextPart++;
          if (partNumber > partCount) return;
          if (completed.has(partNumber)) continue;
          if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
          const start = (partNumber - 1) * partSize;
          const end = Math.min(start + partSize, file.size);
          const blob = file.slice(start, end);
          const partUrl = await requestJson<PartUrlResponse>(`/uploads/${initiated.uploadId}/parts`, {
            method: "POST",
            body: JSON.stringify({ partNumber, contentLength: blob.size }),
          });
          let partReported = 0;
          const etag = await withRetry(
            () => uploadPartWithProgress(partUrl.url, blob, partUrl.headers || {}, (delta) => {
              partReported += delta;
              uploadedBytes += delta;
              report("uploading");
            }, signal).catch((error) => {
              uploadedBytes = Math.max(0, uploadedBytes - partReported);
              partReported = 0;
              throw error;
            }),
            maxRetries,
          );
          completed.set(partNumber, etag);
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, () => worker()));
      uploadedBytes = file.size;
      report("finalizing");
      await requestJson(`/uploads/${initiated.uploadId}/complete`, {
        method: "POST",
        headers: { "idempotency-key": `${resume.idempotencyKey}:complete` },
        body: JSON.stringify({ parts: Array.from(completed, ([partNumber, etag]) => ({ partNumber, etag })).sort((a, b) => a.partNumber - b.partNumber) }),
      });
      resume.clear();
      report("complete");
      return { documentId: initiated.documentId };
    },
  };
}
