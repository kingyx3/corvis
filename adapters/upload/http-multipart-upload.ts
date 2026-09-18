import type { UploadCallbacks, UploadPort, UploadResult } from "@/core/contracts";

type InitiateResponse = { uploadId: string; documentId: string; partSize: number };
type PartUrlResponse = { url: string; headers?: Record<string, string> };
type CompletedPart = { partNumber: number; etag: string };

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
    if (!response.ok) throw new Error(`Upload API error ${response.status}`);
    return response.json() as Promise<T>;
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
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Object storage rejected part (${xhr.status})`));
        return;
      }
      const etag = xhr.getResponseHeader("etag")?.replaceAll('"', "");
      if (!etag) {
        reject(new Error("Object storage response did not expose an ETag"));
        return;
      }
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
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt < maxRetries - 1) await sleep(500 * 2 ** attempt);
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

      const initiated = await requestJson<InitiateResponse>("/uploads/initiate", {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream", sizeBytes: file.size, lastModified: file.lastModified }),
      });
      const partSize = initiated.partSize || fallbackPartSize;
      if (!Number.isFinite(partSize) || partSize <= 0) throw new Error("Upload API returned an invalid part size");

      const partCount = Math.ceil(file.size / partSize);
      let uploadedBytes = 0;
      let nextPart = 1;
      const completedParts: CompletedPart[] = [];

      callbacks.onProgress?.({ fileName: file.name, uploadedBytes: 0, totalBytes: file.size, percent: 0, status: "uploading", documentId: initiated.documentId });

      const worker = async () => {
        while (true) {
          const partNumber = nextPart++;
          if (partNumber > partCount) return;
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
              callbacks.onProgress?.({
                fileName: file.name,
                uploadedBytes: Math.min(uploadedBytes, file.size),
                totalBytes: file.size,
                percent: Math.min(99, Math.round((uploadedBytes / file.size) * 100)),
                status: "uploading",
                documentId: initiated.documentId,
              });
            }, signal).catch((error) => {
              uploadedBytes -= partReported;
              partReported = 0;
              throw error;
            }),
            maxRetries,
          );
          completedParts.push({ partNumber, etag });
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, () => worker()));
      callbacks.onProgress?.({ fileName: file.name, uploadedBytes: file.size, totalBytes: file.size, percent: 100, status: "finalizing", documentId: initiated.documentId });
      await requestJson(`/uploads/${initiated.uploadId}/complete`, {
        method: "POST",
        body: JSON.stringify({ parts: completedParts.sort((a, b) => a.partNumber - b.partNumber) }),
      });
      callbacks.onProgress?.({ fileName: file.name, uploadedBytes: file.size, totalBytes: file.size, percent: 100, status: "complete", documentId: initiated.documentId });
      return { documentId: initiated.documentId };
    },
  };
}
