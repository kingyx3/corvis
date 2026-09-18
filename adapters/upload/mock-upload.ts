import type { UploadCallbacks, UploadPort, UploadResult } from "@/core/contracts";

const PART_SIZE = 32 * 1024 * 1024;
const CONCURRENCY = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMockUploadPort(): UploadPort {
  return {
    runtime: { mode: "mock", partSize: PART_SIZE, concurrency: CONCURRENCY },
    async upload(file: File, callbacks: UploadCallbacks = {}, signal?: AbortSignal): Promise<UploadResult> {
      const documentId = `doc_${crypto.randomUUID().slice(0, 8)}`;
      let uploadedBytes = 0;
      callbacks.onProgress?.({ fileName: file.name, uploadedBytes, totalBytes: file.size, percent: 0, status: "uploading", documentId });

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
      callbacks.onProgress?.({ fileName: file.name, uploadedBytes: file.size, totalBytes: file.size, percent: 100, status: "complete", documentId });
      return { documentId };
    },
  };
}
