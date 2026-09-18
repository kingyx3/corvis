import { createUploadDocument } from "@/application/upload-document";
import { createHttpMultipartUploadPort } from "@/adapters/upload/http-multipart-upload";
import { createMockUploadPort } from "@/adapters/upload/mock-upload";

const apiBase = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "");
const demoMode = process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true";

if (!demoMode && !apiBase) {
  throw new Error("Corvis API base is required outside explicit demo mode. Set NEXT_PUBLIC_CORVIS_API_BASE or NEXT_PUBLIC_CORVIS_DEMO_MODE=true for local demos.");
}

export const uploadPort = demoMode
  ? createMockUploadPort()
  : createHttpMultipartUploadPort({ apiBase: apiBase! });

export const uploadDocument = createUploadDocument(uploadPort);
export const uploadRuntime = uploadPort.runtime;
