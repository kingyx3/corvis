export type Role = "admin" | "reviewer" | "analyst" | "api_client" | "read_only";
export type Permission =
  | "documents:read" | "documents:write" | "sources:read"
  | "observations:read" | "observations:review" | "snapshots:publish"
  | "research:query" | "exports:create" | "admin:manage";

/**
 * Canonical presentation labels for application roles.
 *
 * `reviewer` is retained as a stable machine identifier for backwards
 * compatibility with persisted memberships and identity integrations. It must
 * never be rendered to a user as "Reviewer"; the product persona is Review
 * Analyst. Corvis-operated extraction/quality review is a separate Data
 * Operations Reviewer function and is not represented by this tenant role.
 */
export const ROLE_DISPLAY_NAMES: Record<Role, string> = {
  admin: "Administrator",
  reviewer: "Review Analyst",
  analyst: "Analyst",
  api_client: "API Client",
  read_only: "Viewer",
};

export function roleDisplayName(role: Role): string {
  return ROLE_DISPLAY_NAMES[role];
}

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: ["documents:read","documents:write","sources:read","observations:read","observations:review","snapshots:publish","research:query","exports:create","admin:manage"],
  reviewer: ["documents:read","sources:read","observations:read","observations:review","research:query","exports:create"],
  analyst: ["documents:read","sources:read","observations:read","research:query","exports:create"],
  api_client: ["documents:read","observations:read","research:query","exports:create"],
  read_only: ["documents:read","observations:read"],
};

export type Entitlements = {
  workspaceIds: string[];
  fundIds?: string[];
  documentIds?: string[];
  sourceDocumentIds?: string[];
  sourceDocumentAccessAllowed: boolean;
  internalAnalyticsAllowed?: boolean;
  modelTrainingAllowed?: boolean;
  redistributionAllowed?: boolean;
};

/** Chrome-only per-workspace summary (e.g. an account/workspace switcher) — never for access decisions. */
export type WorkspaceMembershipSummary = {
  workspaceId: string;
  workspaceDisplayName?: string;
  roles: Role[];
};

export type RequestIdentity = {
  subject: string;
  /** Present only when supplied by a verified OIDC claim or trusted signed identity assertion. */
  authenticatedEmail?: string;
  emailVerified?: boolean;
  tenantId: string;
  workspaceId: string;
  roles: Role[];
  entitlements: Entitlements;
  authMethod: "oidc" | "saml" | "service_account" | "demo";
  sessionId: string;
  /**
   * Whether the subject holds the raw `tenant_admin` database role (as
   * opposed to `accountadmin`, a workspace-scoped administrator): both map to
   * the `admin` application Role above, but only a tenant_admin may grant
   * the tenant_admin role to anyone. Optional so existing fixtures that
   * never touch tenant-admin-only checks are unaffected; undefined is
   * treated as false (fail closed) by every caller that checks it.
   */
  isTenantAdmin?: boolean;
  /**
   * Human-readable tenant/workspace names for chrome (e.g. the sidebar),
   * never for access decisions. Only populated where the identity path
   * queries corvis_control.tenant/workspace directly (the authoritative
   * membership lookup, and demo mode); undefined elsewhere, and callers must
   * fall back to a placeholder rather than assume presence.
   */
  tenantDisplayName?: string;
  workspaceDisplayName?: string;
  /**
   * Every workspace the subject actively belongs to in this tenant (chrome
   * only, e.g. an account/workspace switcher — never for access decisions;
   * `entitlements.workspaceIds` remains the authoritative access-control
   * list). Populated only where the identity path resolves membership across
   * the whole tenant (the authoritative lookup, and demo mode, where it is a
   * single-item list); undefined elsewhere.
   */
  workspaceMemberships?: WorkspaceMembershipSummary[];
};

export function hasPermission(identity: RequestIdentity, permission: Permission): boolean {
  return identity.roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}

export function assertPermission(identity: RequestIdentity, permission: Permission): void {
  if (!hasPermission(identity, permission)) throw new AuthorizationError(permission);
}

export function assertWorkspace(identity: RequestIdentity, workspaceId: string): void {
  if (identity.workspaceId !== workspaceId || !identity.entitlements.workspaceIds.includes(workspaceId)) {
    throw new AuthorizationError("workspace:access");
  }
}

export function assertDocumentAccess(identity: RequestIdentity, documentId: string, source = false): void {
  if (source) {
    if (!identity.entitlements.sourceDocumentAccessAllowed) throw new AuthorizationError("sources:read");
    if (identity.entitlements.sourceDocumentIds !== undefined && !identity.entitlements.sourceDocumentIds.includes(documentId)) {
      throw new AuthorizationError("sources:read");
    }
  }
  if (identity.entitlements.documentIds !== undefined && !identity.entitlements.documentIds.includes(documentId)) {
    throw new AuthorizationError("documents:read");
  }
}

export function assertRedistributionAllowed(identity: RequestIdentity): void {
  if (identity.entitlements.redistributionAllowed !== true) throw new AuthorizationError("data_rights:redistribution");
}

export class AuthorizationError extends Error {
  readonly requiredPermission: string;

  constructor(requiredPermission: string) {
    super("Access denied");
    this.name = "AuthorizationError";
    this.requiredPermission = requiredPermission;
  }
}

export type AuditEvent = {
  id: string;
  occurredAt: string;
  tenantId: string;
  workspaceId: string;
  actorSubject: string;
  sessionId: string;
  action: string;
  targetType: string;
  targetId?: string;
  outcome: "success" | "denied" | "failure";
  correlationId: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type ProcessingStage = "registered" | "represented" | "extracted" | "reviewed" | "canonicalized" | "reconciled" | "consolidated" | "published";
export type ProcessingJob = {
  id: string; documentId: string; tenantId: string; stage: ProcessingStage;
  state: "queued" | "running" | "blocked" | "retryable" | "failed" | "dead_letter" | "succeeded";
  attempt: number; maxAttempts: number; correlationId: string; version: number;
  createdAt: string; updatedAt: string;
  blockedReason?: string;
  nextAttemptAt?: string;
  recoveryCount?: number;
  lastRecoveryAt?: string;
  lastRecoveryReasonCode?: string;
  lastError?: string;
};

export type ReviewDecision = {
  observationId: string;
  decision: "approve" | "reject" | "correct";
  reasonCode: string;
  correctedValue?: string;
  expectedVersion: number;
};

export type ReviewOutcome = {
  accepted: true;
  reviewEventId: string;
  newVersion: number;
  nextState: "approved" | "review_required" | "rejected";
};

export type ReconciliationExceptionType = "source_authority" | "materiality" | "reconciliation_conflict";
export type ReconciliationResolutionAction = "select_source" | "mark_immaterial" | "accept_reconciliation";
export type ReconciliationSourceReference = {
  sourceReferenceId: string;
  documentId: string;
  page?: number;
  sheetName?: string;
  cellRange?: string;
  excerpt?: string;
};
export type ReconciliationException = {
  exceptionId: string;
  snapshotId: string;
  snapshotVersion: number;
  fundId: string;
  reportPeriod: string;
  type: ReconciliationExceptionType;
  subjectType?: string;
  subjectId?: string;
  metricCode?: string;
  summary: string;
  materiality: "unknown" | "immaterial" | "material";
  context: Record<string, unknown>;
  status: "open" | "resolved";
  version: number;
  allowedActions: ReconciliationResolutionAction[];
  sourceReferences: ReconciliationSourceReference[];
  createdAt: string;
  resolvedAt?: string;
};
export type ReconciliationResolutionCommand = {
  exceptionId: string;
  expectedVersion: number;
  action: ReconciliationResolutionAction;
  reasonCode: string;
  selectedSourceReferenceId?: string;
  note?: string;
};
export type ReconciliationResolutionOutcome = {
  accepted: true;
  resolutionEventId: string;
  newVersion: number;
  status: "resolved";
};

export type SnapshotPublication = {
  snapshotId: string;
  action: "publish" | "withdraw" | "supersede";
  expectedVersion: number;
  reason?: string;
};

export type SourceCitation = {
  sourceReferenceId: string;
  documentId: string;
  page?: number;
  label: string;
  /** The reviewed observation this citation's source document produced, when the two are linked. */
  observationId?: string;
  /** True when this citation's source document is part of a currently open reconciliation exception. */
  hasOpenReconciliation?: boolean;
};
export type SemanticComputedResult = {
  semanticQueryId: string;
  status: "executed" | "unresolved" | "unsupported";
  metricCode?: string;
  operation: "values" | "sum" | "average" | "minimum" | "maximum" | "count";
  rows: Array<Record<string, unknown>>;
  reason?: string;
};
export type ResearchAnswer = {
  answer: string;
  citations: SourceCitation[];
  semanticQueryIds: string[];
  computedResults?: SemanticComputedResult[];
  modelVersion?: string;
  uncertainty?: string;
};
export type ResearchProgressPhase = "planning" | "retrieval" | "generation";
export type ResearchStreamEvent =
  | { type: "progress"; phase: ResearchProgressPhase }
  | { type: "result"; data: ResearchAnswer }
  | { type: "error"; code: "research_timeout" | "research_cancelled" | "research_provider_error" | "research_failed" };

/**
 * A saved/pinned Ask Corvis answer (#182 D7). `askedAt` is the as-of moment
 * the answer was originally generated; reopening a pin always redisplays
 * this stored payload rather than silently re-running the question.
 */
export type ResearchPin = {
  pinId: string;
  question: string;
  answer: ResearchAnswer;
  askedAt: string;
  pinnedAt: string;
};

export type ExportManifest = {
  exportId: string; tenantId: string; generatedAt: string; schemaVersion: string; taxonomyVersion: string;
  snapshotIds: string[]; format: "parquet" | "csv" | "xlsx"; rowCounts: Record<string, number>; checksumSha256: string;
  /** Which product surface requested this export; optional only because exports created before this field existed lack it. */
  source?: "delivery" | "review";
  /**
   * Per-snapshot review/reconciliation state at the moment of export (#182 D16):
   * the published snapshot version and count of still-open reconciliation
   * exceptions each exported snapshot carried. Optional only because exports
   * created before this field existed lack it.
   */
  snapshotState?: { snapshotId: string; version: number; openExceptionCount: number }[];
};
