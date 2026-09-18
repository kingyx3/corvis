import { createUploadDocument } from "@/application/upload-document";
import { createHttpMultipartUploadPort } from "@/adapters/upload/http-multipart-upload";
import { createMockUploadPort } from "@/adapters/upload/mock-upload";
import { createHttpPlatformPort } from "@/adapters/platform/http-platform";
import { createDemoPlatformPort } from "@/adapters/demo/platform";

const production = process.env.NODE_ENV === "production";
const demoRequested = process.env.NEXT_PUBLIC_CORVIS_MOCK_API === "true";
if (production && demoRequested) throw new Error("Corvis production builds cannot run with NEXT_PUBLIC_CORVIS_MOCK_API=true");

const useMock = !production && demoRequested;
const apiBase = (process.env.NEXT_PUBLIC_CORVIS_API_BASE || "/api/v1").replace(/\/$/, "");

export const uploadPort = useMock
  ? createMockUploadPort()
  : createHttpMultipartUploadPort({ apiBase });

export const platform = useMock
  ? createDemoPlatformPort()
  : createHttpPlatformPort({ apiBase });

export const uploadDocument = createUploadDocument(uploadPort);
export const uploadRuntime = uploadPort.runtime;
export const platformRuntime = { mode: useMock ? "demo" as const : "production" as const, apiBase };
