export type View = "overview" | "documents" | "review" | "research" | "admin";

export type DocumentStatus = "Published" | "Review" | "Extracting" | "Queued" | "Registered" | "Failed" | "Deleted";
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
  company: string;
  metric: string;
  value: string;
  period: string;
  source: string;
  confidence: number;
  state: "Approved" | "Needs review" | "Rejected";
  delta: string;
  sourceReferenceId?: string;
  snapshotId?: string;
  materiality?: "material" | "normal";
};

export type FundSnapshot = {
  id?: string;
  fund: string;
  period: string;
  status: "Published" | "Review";
  holdings: number;
  facts: number;
  changed: string;
};

export type ActivityRecord = {
  title: string;
  detail: string;
  time: string;
};

export type WorkspaceSession = {
  name?: string;
  email?: string;
  tenantId: string;
  workspaceName?: string;
  roles: string[];
};

export type FeatureFlags = {
  research: boolean;
  exports: boolean;
  review: boolean;
  administration: boolean;
};

export type WorkspaceBootstrap = {
  session: WorkspaceSession;
  documents: DocumentRecord[];
  observations: ObservationRecord[];
  fundSnapshots: FundSnapshot[];
  recentActivity: ActivityRecord[];
  researchSuggestions: string[];
  featureFlags: FeatureFlags;
};

export type ResearchCitation = {
  type: "source" | "snapshot";
  id: string;
  label: string;
  documentId?: string;
  pageNumber?: number;
};

export type ResearchAnswer = {
  answer: string;
  citations: ResearchCitation[];
  toolTrace?: Array<{ tool: string; resultCount: number }>;
};

export type ReadinessControl = { id: string; status: string; detail: string };
export type ReadinessReport = { environment: string; demoMode: boolean; tenantId: string; controls: ReadinessControl[] };

export interface PlatformPort {
  bootstrap(signal?: AbortSignal): Promise<WorkspaceBootstrap>;
  ask(question: string, signal?: AbortSignal): Promise<ResearchAnswer>;
  reviewObservation(observationId: string, input: { decision: "approve" | "reject" | "correct"; correctedValue?: string; reason?: string }, signal?: AbortSignal): Promise<void>;
  publishSnapshot(snapshotId: string, signal?: AbortSignal): Promise<void>;
  createExport(snapshotId: string, format?: "csv" | "json", signal?: AbortSignal): Promise<{ url: string; sha256: string }>;
  openSource(sourceReferenceId: string, signal?: AbortSignal): Promise<{ documentUrl: string; page_number?: string | number; pageNumber?: number }>;
  readiness(signal?: AbortSignal): Promise<ReadinessReport>;
}

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
  partSize: number;
  concurrency: number;
};

export interface UploadPort {
  readonly runtime: UploadRuntime;
  upload(file: File, callbacks?: UploadCallbacks, signal?: AbortSignal): Promise<UploadResult>;
}
