import type { DocumentRecord, FundSnapshot, ObservationRecord } from "@/core/contracts";
import type {
  Permission,
  ReconciliationException,
  ReconciliationResolutionCommand,
  ReconciliationResolutionOutcome,
  ResearchAnswer,
  ResearchStreamEvent,
  ReviewDecision,
  ReviewOutcome,
  SnapshotPublication,
} from "@/core/enterprise";

export type SourceEvidence = {
  sourceReferenceId: string;
  documentId: string;
  page?: number;
  sheetName?: string;
  cellRange?: string;
  bbox?: unknown;
  excerpt?: string;
};

export type WorkspaceCapabilities = {
  permissions: Permission[];
  /** Presentation-safe signal for tenant-wide control-plane UI; raw role names are never exposed. */
  tenantControlAllowed: boolean;
  sourceDocumentAccessAllowed: boolean;
  redistributionAllowed: boolean;
};

export interface WorkspacePort {
  capabilities(): Promise<WorkspaceCapabilities>;
  listDocuments(): Promise<DocumentRecord[]>;
  listObservations(): Promise<ObservationRecord[]>;
  listSnapshots(): Promise<FundSnapshot[]>;
  listReconciliationExceptions(snapshotId: string, snapshotVersion: number): Promise<ReconciliationException[]>;
  research(question: string, signal?: AbortSignal): Promise<ResearchAnswer>;
  researchStream(question: string, onEvent: (event: ResearchStreamEvent) => void, signal?: AbortSignal): Promise<ResearchAnswer>;
  sourceEvidence(sourceReferenceId: string): Promise<SourceEvidence>;
  review(command: ReviewDecision): Promise<ReviewOutcome>;
  resolveReconciliation(command: ReconciliationResolutionCommand): Promise<ReconciliationResolutionOutcome>;
  publish(command: SnapshotPublication): Promise<void>;
}
