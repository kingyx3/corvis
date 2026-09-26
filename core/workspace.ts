import type { DocumentRecord, FundSnapshot, ObservationRecord } from "@/core/contracts";
import type { WorkspaceSummary } from "@/core/workspace-summary";
import type { CompanySectorAssignment, CompanySectorAssignmentOutcome, CompanySectorRecord } from "@/core/sector-taxonomy";
import type {
  Permission,
  ReconciliationException,
  ReconciliationResolutionCommand,
  ReconciliationResolutionOutcome,
  ResearchAnswer,
  ResearchPin,
  ResearchStreamEvent,
  ReviewDecision,
  ReviewOutcome,
  SnapshotPublication,
  WorkspaceMembershipSummary,
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
  tenantId?: string;
  workspaceId?: string;
  subject: string;
  tenantDisplayName?: string;
  workspaceDisplayName?: string;
  /** Presentation hint only. Every tenant-admin command re-checks server-side authorization. */
  tenantAdmin?: boolean;
};

export type TenantAccessSubject = {
  authMethod: "oidc" | "saml";
  subject: string;
};

export type TenantAccessMembership = {
  workspaceId: string;
  workspaceName: string;
  roleName: string;
};

export type TenantAccessEntitlement = {
  workspaceId: string;
  workspaceName: string;
  resourceType: string;
  resourceId: string;
  permission: string;
};

export type TenantAccessMember = {
  displayName?: string;
  userId: string;
  subjects: TenantAccessSubject[];
  memberships: TenantAccessMembership[];
  entitlements: TenantAccessEntitlement[];
  isCurrentUser: boolean;
};

export type DeactivateTenantAccessResult = {
  eventKey: string;
  operation: "sync" | "disable";
  subject: string;
  userId: string;
  activeMemberships: number;
  revokedMemberships: number;
  expiredEntitlements: number;
  disabledSubjects: number;
  disabledServiceGrants: number;
};

export type TenantInvitation = {
  invitationId: string;
  tenantId: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  roleName: "tenant_admin" | "workspace_admin" | "reviewer" | "analyst" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
};

export type TenantInvitationCreated = {
  invitation: TenantInvitation;
  /** One-time bearer secret. The API never returns it from list/read operations. */
  token: string;
};

export type AcceptedTenantInvitation = {
  invitationId: string;
  tenantId: string;
  workspaceId: string;
  userId: string;
  roleName: TenantInvitation["roleName"];
};

export type ChangeMemberRole = { userId: string; workspaceId: string; expectedRole: string; roleName: string | null; reason: string; confirmTenantAdmin: boolean };
export type MemberRoleReceipt = { auditEventId: string; userId: string; workspaceId: string; roleName: string | null };

export interface WorkspacePort {
  changeMemberRole(command: ChangeMemberRole): Promise<MemberRoleReceipt>;
  capabilities(): Promise<WorkspaceCapabilities>;
  whoAmI(): Promise<WorkspaceIdentity>;
  /** Every workspace the signed-in user belongs to (for an account/workspace switcher). */
  listMyWorkspaces(): Promise<WorkspaceMembershipSummary[]>;
  listDocuments(): Promise<DocumentRecord[]>;
  listObservations(): Promise<ObservationRecord[]>;
  listSnapshots(): Promise<FundSnapshot[]>;
  /** Overview rollup: published value trend, exposure, unified attention and freshness. */
  workspaceSummary(): Promise<WorkspaceSummary>;
  /** Entitled portfolio companies with their current governed sector (null when unclassified). */
  listCompanySectors(): Promise<CompanySectorRecord[]>;
  /** Review Analyst command; expectedVersion is the record's `version` (0 when unclassified). */
  assignCompanySector(command: CompanySectorAssignment): Promise<CompanySectorAssignmentOutcome>;
  /** Tenant-admin-only access inventory for governed offboarding. */
  listAccessMembers(): Promise<TenantAccessMember[]>;
  /** Tenant-admin-only C14 command; server authorization is authoritative. */
  deactivateAccessMember(command: { userId: string; reason: string }): Promise<DeactivateTenantAccessResult>;
  /** Issue an expiring, single-use, tenant-scoped invitation. */
  createAccessInvitation(command: { workspaceId: string; email: string; roleName: TenantInvitation["roleName"]; reason: string; confirmTenantAdmin: boolean }): Promise<TenantInvitationCreated>;
  listAccessInvitations(): Promise<TenantInvitation[]>;
  listReconciliationExceptions(snapshotId: string, snapshotVersion: number): Promise<ReconciliationException[]>;
  research(question: string, signal?: AbortSignal): Promise<ResearchAnswer>;
  researchStream(question: string, onEvent: (event: ResearchStreamEvent) => void, signal?: AbortSignal): Promise<ResearchAnswer>;
  /** Saved Ask Corvis answers for later reference (#182 D7), newest first. */
  listResearchPins(): Promise<ResearchPin[]>;
  /** Stores the exact answer already returned; the server never re-runs the question. */
  pinResearchAnswer(command: { question: string; answer: ResearchAnswer; askedAt: string }): Promise<ResearchPin>;
  unpinResearchAnswer(pinId: string): Promise<void>;
  sourceEvidence(sourceReferenceId: string): Promise<SourceEvidence>;
  review(command: ReviewDecision): Promise<ReviewOutcome>;
  resolveReconciliation(command: ReconciliationResolutionCommand): Promise<ReconciliationResolutionOutcome>;
  publish(command: SnapshotPublication): Promise<void>;
}
