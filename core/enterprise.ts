export type Role = "admin" | "reviewer" | "analyst" | "api_client" | "read_only";
export type Permission =
  | "documents:read" | "documents:write" | "sources:read"
  | "observations:read" | "observations:review" | "snapshots:publish"
  | "research:query" | "exports:create" | "admin:manage";

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
  sourceDocumentAccessAllowed: boolean;
  internalAnalyticsAllowed?: boolean;
  modelTrainingAllowed?: boolean;
  redistributionAllowed?: boolean;
};

export type RequestIdentity = {
  subject: string;
  tenantId: string;
  workspaceId: string;
  roles: Role[];
  entitlements: Entitlements;
  authMethod: "oidc" | "saml" | "service_account" | "demo";
  sessionId: string;
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
  if (source && !identity.entitlements.sourceDocumentAccessAllowed) throw new AuthorizationError("sources:read");
  if (identity.entitlements.documentIds !== undefined && !identity.entitlements.documentIds.includes(documentId)) {
    throw new AuthorizationError("documents:read");
  }
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
  state: "queued" | "running" | "retryable" | "failed" | "dead_letter" | "succeeded";
  attempt: number; maxAttempts: number; correlationId: string; version: number;
  createdAt: string; updatedAt: string; lastError?: string;
};

export type ReviewDecision = {
  observationId: string;
  decision: "approve" | "reject" | "correct";
  reasonCode: string;
  correctedValue?: string;
  expectedVersion: number;
};

export type SnapshotPublication = {
  snapshotId: string;
  action: "publish" | "withdraw" | "supersede";
  expectedVersion: number;
  reason?: string;
};

export type SourceCitation = { sourceReferenceId: string; documentId: string; page?: number; label: string };
export type ResearchAnswer = { answer: string; citations: SourceCitation[]; semanticQueryIds: string[]; modelVersion?: string; uncertainty?: string };

export type ExportManifest = {
  exportId: string; tenantId: string; generatedAt: string; schemaVersion: string; taxonomyVersion: string;
  snapshotIds: string[]; format: "parquet" | "csv" | "xlsx"; rowCounts: Record<string, number>; checksumSha256: string;
};
