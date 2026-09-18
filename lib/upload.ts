export type UploadProgress = {
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  status: "queued" | "uploading" | "finalizing" | "complete" | "error";
  documentId?: string;
  error?: string;
};

export type UploadCallbacks = {
  onProgress?: (progress: UploadProgress) => void;
};

type InitiateResponse = {
  uploadId: string;
  documentId: string;
  partSize: number;
};

type PartUrlResponse = {
  url: string;
  headers?: Record<string, string>;
};

type CompletedPart = {
  partNumber: number;
  etag: string;
};

const apiBase = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "");
const mockMode = !apiBase || process.env.NEXT_PUBLIC_CORVIS_MOCK_API === "true";
const DEFAULT_PART_SIZE = 32 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 3;
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Upload API error ${response.status}`);
  }
  return response.json() as Promise<T>;
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
      resolve(xhr.getResponseHeader("etag")?.replaceAll('"', "") || `part-${crypto.randomUUID()}`);
    };

    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener("abort", abort);
    xhr.send(blob);
  });
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt < MAX_RETRIES - 1) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function mockUpload(file: File, callbacks: UploadCallbacks, signal?: AbortSignal) {
  const documentId = `doc_${crypto.randomUUID().slice(0, 8)}`;
  let uploadedBytes = 0;
  callbacks.onProgress?.({
    fileName: file.name,
    uploadedBytes,
    totalBytes: file.size,
    percent: 0,
    status: "uploading",
    documentId,
  });

  const steps = 24;
  for (let step = 1; step <= steps; step += 1) {
    if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
    await sleep(55 + Math.random() * 70);
    uploadedBytes = Math.min(file.size, Math.round((file.size * step) / steps));
    callbacks.onProgress?.({
      fileName: file.name,
      uploadedBytes,
      totalBytes: file.size,
      percent: Math.round((uploadedBytes / file.size) * 100),
      status: step === steps ? "finalizing" : "uploading",
      documentId,
    });
  }
  await sleep(350);
  callbacks.onProgress?.({
    fileName: file.name,
    uploadedBytes: file.size,
    totalBytes: file.size,
    percent: 100,
    status: "complete",
    documentId,
  });
  return { documentId };
}

export async function uploadDocument(
  file: File,
  callbacks: UploadCallbacks = {},
  signal?: AbortSignal,
) {
  if (mockMode) return mockUpload(file, callbacks, signal);

  const initiated = await requestJson<InitiateResponse>("/uploads/initiate", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      lastModified: file.lastModified,
    }),
  });

  const partSize = initiated.partSize || DEFAULT_PART_SIZE;
  const partCount = Math.ceil(file.size / partSize);
  let uploadedBytes = 0;
  const completedParts: CompletedPart[] = [];
  let nextPart = 1;

  callbacks.onProgress?.({
    fileName: file.name,
    uploadedBytes: 0,
    totalBytes: file.size,
    percent: 0,
    status: "uploading",
    documentId: initiated.documentId,
  });

  const worker = async () => {
    while (true) {
      const partNumber = nextPart;
      nextPart += 1;
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
      const etag = await withRetry(() =>
        uploadPartWithProgress(
          partUrl.url,
          blob,
          partUrl.headers || {},
          (delta) => {
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
          },
          signal,
        ).catch((error) => {
          uploadedBytes -= partReported;
          partReported = 0;
          throw error;
        }),
      );
      completedParts.push({ partNumber, etag });
    }
  };

  await Promise.all(Array.from({ length: Math.min(DEFAULT_CONCURRENCY, partCount) }, () => worker()));

  callbacks.onProgress?.({
    fileName: file.name,
    uploadedBytes: file.size,
    totalBytes: file.size,
    percent: 100,
    status: "finalizing",
    documentId: initiated.documentId,
  });

  await requestJson(`/uploads/${initiated.uploadId}/complete`, {
    method: "POST",
    body: JSON.stringify({ parts: completedParts.sort((a, b) => a.partNumber - b.partNumber) }),
  });

  callbacks.onProgress?.({
    fileName: file.name,
    uploadedBytes: file.size,
    totalBytes: file.size,
    percent: 100,
    status: "complete",
    documentId: initiated.documentId,
  });

  return { documentId: initiated.documentId };
}

export const uploadRuntime = {
  mockMode,
  partSize: DEFAULT_PART_SIZE,
  concurrency: DEFAULT_CONCURRENCY,
};
