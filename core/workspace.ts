import type { DocumentRecord, FundSnapshot, ObservationRecord } from "@/core/contracts";
import type {
  ReconciliationException,
  ReconciliationResolutionCommand,
  ReconciliationResolutionOutcome,
  ResearchAnswer,
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

export interface WorkspacePort {
  listDocuments(): Promise<DocumentRecord[]>;
  listObservations(): Promise<ObservationRecord[]>;
  listSnapshots(): Promise<FundSnapshot[]>;
  listReconciliationExceptions(snapshotId: string, snapshotVersion: number): Promise<ReconciliationException[]>;
  research(question: string): Promise<ResearchAnswer>;
  sourceEvidence(sourceReferenceId: string): Promise<SourceEvidence>;
  review(command: ReviewDecision): Promise<ReviewOutcome>;
  resolveReconciliation(command: ReconciliationResolutionCommand): Promise<ReconciliationResolutionOutcome>;
  publish(command: SnapshotPublication): Promise<void>;
}
