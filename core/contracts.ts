export type View = "overview" | "documents" | "review" | "delivery" | "research";

export type DocumentStatus = "Published" | "Review" | "Extracting" | "Queued";
export type DocumentQuality = "High" | "Medium" | "Pending";

export type DocumentRecord = {
  id: string;
  name: string;
  fund: string;
  period: string;
  type: string;
  pages: number;
  size: string;
  status: DocumentStatus;
  progress?: number;
  uploaded: string;
  quality: DocumentQuality;
  observations: number;
};

export type ObservationRecord = {
  id: string;
  snapshotId?: string;
  fund?: string;
  company: string;
  metric: string;
  value: string;
  period: string;
  source: string;
  sourceReferenceId?: string;
  confidence: number;
  state: "Approved" | "Needs review" | "Rejected";
  delta: string;
  version?: number;
};

export type FundSnapshot = {
  id?: string;
  version?: number;
  fund: string;
  period: string;
  status: "Published" | "Review";
  holdings: number;
  facts: number;
  changed: string;
  blockingExceptions?: number;
};

export type ActivityRecord = {
  title: string;
  detail: string;
  time: string;
};

export type UploadStatus = "queued" | "uploading" | "finalizing" | "complete" | "error";

export type UploadProgress = {
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  status: UploadStatus;
  documentId?: string;
  error?: string;
};

export type UploadCallbacks = {
  onProgress?: (progress: UploadProgress) => void;
};

export type UploadResult = { documentId: string };

export type UploadRuntime = {
  mode: "mock" | "direct";
  transport: "mock" | "gcs-resumable";
  chunkSize: number;
};

export interface UploadPort {
  readonly runtime: UploadRuntime;
  upload(file: File, callbacks?: UploadCallbacks, signal?: AbortSignal): Promise<UploadResult>;
}
