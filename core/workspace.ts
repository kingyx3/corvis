import type { DocumentRecord, FundSnapshot, ObservationRecord } from "@/core/contracts";
import type { ResearchAnswer, ReviewDecision, SnapshotPublication } from "@/core/enterprise";

export interface WorkspacePort {
  listDocuments(): Promise<DocumentRecord[]>;
  listObservations(): Promise<ObservationRecord[]>;
  listSnapshots(): Promise<FundSnapshot[]>;
  research(question: string): Promise<ResearchAnswer>;
  review(command: ReviewDecision): Promise<void>;
  publish(command: SnapshotPublication): Promise<void>;
}
