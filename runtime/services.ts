import { createUploadDocument } from "@/application/upload-document";
import { createHttpGcsResumableUploadPort } from "@/adapters/upload/http-gcs-resumable-upload";
import { createMockUploadPort } from "@/adapters/upload/mock-upload";

const apiBase = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "") || "";
const demoMode = process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true";

export const uploadPort = demoMode
  ? createMockUploadPort()
  : createHttpGcsResumableUploadPort({ apiBase });

export const uploadDocument = createUploadDocument(uploadPort);
export const uploadRuntime = uploadPort.runtime;
