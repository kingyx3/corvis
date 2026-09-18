import { createUploadDocument } from "@/application/upload-document";
import { createHttpMultipartUploadPort } from "@/adapters/upload/http-multipart-upload";
import { createMockUploadPort } from "@/adapters/upload/mock-upload";

const apiBase = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "");
const useMock = !apiBase || process.env.NEXT_PUBLIC_CORVIS_MOCK_API === "true";

export const uploadPort = useMock
  ? createMockUploadPort()
  : createHttpMultipartUploadPort({ apiBase: apiBase! });

export const uploadDocument = createUploadDocument(uploadPort);
export const uploadRuntime = uploadPort.runtime;
