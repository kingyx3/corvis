import type { DocumentRecord, FundSnapshot, ObservationRecord } from "@/core/contracts";
import type { ResearchAnswer, ReviewDecision, SnapshotPublication } from "@/core/enterprise";

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
  research(question: string): Promise<ResearchAnswer>;
  sourceEvidence(sourceReferenceId: string): Promise<SourceEvidence>;
  review(command: ReviewDecision): Promise<void>;
  publish(command: SnapshotPublication): Promise<void>;
}
