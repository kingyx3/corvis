import type { UploadCallbacks, UploadPort, UploadResult } from "@/core/contracts";
import { assertDemoModuleAvailable, demoCustomerJourneyStore } from "@/adapters/demo/customer-journey-store";

const CHUNK_SIZE = 8 * 1024 * 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMockUploadPort(): UploadPort {
  return {
    runtime: { mode: "mock", transport: "mock", chunkSize: CHUNK_SIZE },
    async upload(file: File, callbacks: UploadCallbacks = {}, signal?: AbortSignal): Promise<UploadResult> {
      assertDemoModuleAvailable("upload");
      const documentId = `doc_${crypto.randomUUID().slice(0, 8)}`;
      let uploadedBytes = 0;
      callbacks.onProgress?.({ fileName: file.name, uploadedBytes, totalBytes: file.size, percent: 0, status: "uploading", documentId });

      const steps = 12;
      for (let step = 1; step <= steps; step += 1) {
        if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
        await sleep(35 + Math.random() * 40);
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

      await sleep(120);
      demoCustomerJourneyStore.completeUpload(file, documentId);
      callbacks.onProgress?.({ fileName: file.name, uploadedBytes: file.size, totalBytes: file.size, percent: 100, status: "complete", documentId });
      return { documentId };
    },
  };
}
