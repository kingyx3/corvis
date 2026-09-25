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

/**
 * Product composition is orthogonal to authorization. Permissions/data rights
 * answer what the caller may do with entitled data; feature capabilities
 * answer which optional product modules this tenant has enabled. A capability
 * never grants access to a fund/document/observation on its own.
 */
export type WorkspaceFeatures = {
  portfolioAttribution: boolean;
};

export type WorkspaceCapabilities = {
  permissions: Permission[];
  sourceDocumentAccessAllowed: boolean;
  redistributionAllowed: boolean;
  /** Optional for backward-compatible/demo adapters; absence fails closed. */
  features?: WorkspaceFeatures;
};

/** Chrome-only identity (e.g. the sidebar) — never for access decisions. */
export type WorkspaceIdentity = {
  subject: string;
  tenantDisplayName?: string;
  workspaceDisplayName?: string;
};

export interface WorkspacePort {
  capabilities(): Promise<WorkspaceCapabilities>;
  whoAmI(): Promise<WorkspaceIdentity>;
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
