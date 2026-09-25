export type View = "overview" | "analytics" | "documents" | "review" | "delivery" | "research" | "access";

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
  /** Latest processing-job state (queued, running, blocked, failed, dead_letter, ...), when known. */
  processingState?: string;
  /** ISO timestamp of the latest processing-job update, when known. */
  processingUpdatedAt?: string;
};

export type ObservationRecord = {
  id: string;
  snapshotId?: string;
  fund?: string;
  fundId?: string;
  companyId?: string;
  holdingId?: string;
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

export type StatementPeriodicity = "reported" | "quarterly" | "annual";

/**
 * Long-form wire contract for one disclosed financial-statement row/value.
 * It deliberately keeps source presentation fields alongside optional governed
 * metric mapping so unusual or unmapped GP/company line items remain deliverable.
 */
export type PositionFinancialStatementRow = {
  statementId: string;
  documentId: string;
  fundId: string;
  holdingId: string;
  companyId: string;
  statementType: string;
  statementKey: string;
  sourceTitle: string | null;
  reportPeriod: string;
  lineId: string;
  lineKey: string;
  semanticLineKey: string;
  sourceLabel: string;
  metricCode: string | null;
  lineRole: string;
  parentLineKey: string | null;
  displayOrder: number;
  depth: number;
  valueId: string | null;
  valueRaw: string | null;
  valueNumber: string | null;
  valueString: string | null;
  valueQualifier: string | null;
  currency: string | null;
  unit: string | null;
  reportedMultiplier: string | null;
  sourcePrecision: string | null;
  valueNature: string | null;
  periodType: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  asOfDate: string | null;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  sourceDocumentPeriodEnd: string | null;
  sourceColumnLabel: string | null;
  actuality: string | null;
  scenarioType: string | null;
  sourceVersionStatus: string | null;
  preliminary: boolean;
  isRestatement: boolean;
  isReReportedPriorPeriod: boolean;
  isDerived: boolean;
  derivationFormula: string | null;
  sourceReferenceIds: string[];
  sourcePage: number | null;
  sourceSheet: string | null;
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
