import type { UploadCallbacks, UploadPort } from "@/shared/domain/contracts";

export function createUploadDocument(port: UploadPort) {
  return (file: File, callbacks: UploadCallbacks = {}, signal?: AbortSignal) =>
    port.upload(file, callbacks, signal);
}
