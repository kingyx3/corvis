import type { UploadPort } from "@/core/contracts";
import { createUploadDocument } from "@/application/upload-document";
import { createHttpGcsResumableUploadPort } from "@/adapters/upload/http-gcs-resumable-upload";
import { lazyPort } from "@/runtime/lazy-port";

const apiBase = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "") || "";

// Mirrors src/adapters/upload/mock-upload.ts (which is only loaded in demo builds).
const DEMO_UPLOAD_RUNTIME: UploadPort["runtime"] = { mode: "mock", transport: "mock", chunkSize: 8 * 1024 * 1024 };

// The demo flag is compared inline (not through a const or helper) so the bundler folds the
// condition and drops the dynamic import, and with it every demo fixture, from production builds.
export const uploadPort: UploadPort = process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true"
  ? ((demo: UploadPort): UploadPort => ({ runtime: DEMO_UPLOAD_RUNTIME, upload: (file, callbacks, signal) => demo.upload(file, callbacks, signal) }))(
    lazyPort<UploadPort>(async () => (await import("@/adapters/upload/mock-upload")).createMockUploadPort()),
  )
  : createHttpGcsResumableUploadPort({ apiBase });

export const uploadDocument = createUploadDocument(uploadPort);
export const uploadRuntime = uploadPort.runtime;
