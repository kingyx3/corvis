import { createHash, randomUUID } from "crypto";
import { documents, fundSnapshots, observations, portfolioValueFacts } from "../../adapters/demo/catalog.ts";
import type { DocumentRecord, FundSnapshot, ObservationRecord } from "../../core/contracts.ts";
import type { PortfolioValueFact } from "../../core/workspace-summary.ts";
import {
  assertRedistributionAllowed,
  type AuditEvent,
  type ExportManifest,
  type ProcessingJob,
  type ReconciliationException,
  type ReconciliationExceptionType,
  type ReconciliationResolutionAction,
  type ReconciliationResolutionCommand,
  type ReconciliationResolutionOutcome,
  type ReconciliationSourceReference,
  type RequestIdentity,
  type ResearchAnswer,
  type ReviewDecision,
  type ReviewOutcome,
  type SnapshotPublication,
} from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import type { KeysetPage } from "./pagination.ts";
import {
  PostgresOperationsRepository,
  PostgresReviewPublicationRepository,
  PostgresWorkspaceRepository,
  SNAPSHOT_VERSION_KEY_WIDTH,
} from "./platform-repositories.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";
import { evaluatePublicationGate } from "./publication-policy.ts";
import { researchService, type ResearchExecutionOptions } from "./research.ts";

/**
 * The list methods take an optional keyset `page`. Without it they return the
 * legacy (capped) list. With it, an implementation may return only the rows
 * whose pagination key sorts strictly after `page.afterKey`, at least
 * `page.limit + 1` of them when that many exist; it may also ignore `page`
 * and return everything (the demo platform does). Callers always run
 * `paginate()` over the result, so either way the page is correct.
 */
export interface PlatformPort {
  listDocuments(identity: RequestIdentity, page?: KeysetPage): Promise<DocumentRecord[]>;
  listObservations(identity: RequestIdentity, page?: KeysetPage): Promise<ObservationRecord[]>;
  listSnapshots(identity: RequestIdentity, page?: KeysetPage): Promise<FundSnapshot[]>;
  listReconciliationExceptions(identity: RequestIdentity, snapshotId: string, snapshotVersion: number): Promise<ReconciliationException[]>;
  /** Summed nav/fair_value facts of every entitled snapshot whose current version is published. */
  portfolioValueFacts(identity: RequestIdentity): Promise<PortfolioValueFact[]>;
  review(identity: RequestIdentity, decision: ReviewDecision): Promise<ReviewOutcome>;
  resolveReconciliation(identity: RequestIdentity, command: ReconciliationResolutionCommand): Promise<ReconciliationResolutionOutcome>;
  publish(identity: RequestIdentity, command: SnapshotPublication): Promise<{ accepted: true; publicationEventId: string }>;
  research(identity: RequestIdentity, question: string, options?: ResearchExecutionOptions): Promise<ResearchAnswer>;
  audit(event: AuditEvent): Promise<void>;
  readiness(): Promise<Record<string, "configured" | "missing" | "demo">>;
  export(identity: RequestIdentity, format: ExportManifest["format"]): Promise<ExportManifest>;
  jobs(identity: RequestIdentity, page?: KeysetPage): Promise<ProcessingJob[]>;
}

function text(row: PostgresRow, key: string, fallback = ""): string { const value = row[key]; return value == null ? fallback : String(value); }
/** Timestamps arrive from pg as Date objects; normalize them to ISO-8601 so clients can parse them. */
function isoText(row: PostgresRow, key: string): string | undefined {
  const value = row[key];
  if (value == null || value === "") return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}
function num(row: PostgresRow, key: string, fallback = 0): number { const value = Number(row[key]); return Number.isFinite(value) ? value : fallback; }
function displaySize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B","KB","MB","GB","TB"]; let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
function documentStatus(value: string): DocumentRecord["status"] {
  const status = value.toLowerCase();
  if (status === "published") return "Published";
  if (status.includes("review")) return "Review";
  if (["represented","extracting","extracted","canonicalized","reconciled","consolidated","running"].some((needle) => status.includes(needle))) return "Extracting";
  return "Queued";
}
function quality(value: string): DocumentRecord["quality"] { const q = value.toLowerCase(); return q === "high" ? "High" : q === "medium" ? "Medium" : "Pending"; }
function reviewState(value: string): ObservationRecord["state"] {
  const state = value.toLowerCase();
  if (state === "approved") return "Approved";
  if (state === "rejected") return "Rejected";
  return "Needs review";
}
function checksum(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { return {}; }
  }
  return {};
}
function objectArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
    } catch { return []; }
  }
  return [];
}
/**
 * Snapshot states a transition may not start from. Publication requires a
 * draft (mirroring assert_snapshot_publishable, so the refusal is a 409 instead
 * of a raised database exception); withdraw and supersede only apply to a
 * published snapshot, so a draft cannot be "withdrawn" and a withdrawn or
 * superseded version cannot be transitioned again.
 */
const DISALLOWED_SNAPSHOT_SOURCE_STATUSES: Record<SnapshotPublication["action"], readonly string[]> = {
  publish: ["blocked", "published", "withdrawn", "superseded"],
  withdraw: ["draft", "blocked", "withdrawn", "superseded"],
  supersede: ["draft", "blocked", "withdrawn", "superseded"],
};

function allowedActions(type: ReconciliationExceptionType): ReconciliationResolutionAction[] {
  if (type === "source_authority") return ["select_source"];
  if (type === "materiality") return ["mark_immaterial"];
  return ["accept_reconciliation"];
}

/**
 * Cursor key for `/snapshots` pagination. Every publish/withdraw/supersede transition appends a
 * new row under the same snapshot id (the primary key is tenant + snapshot id + version), so the
 * id alone is not unique: a page boundary between two versions of one snapshot would skip the
 * remaining versions. The zero-padded version keeps the string order numeric. A snapshot without
 * an id (demo composition) falls back to fund/period/version, which is stable within one listing.
 * PostgresWorkspaceRepository.listSnapshots keyset-pages in SQL in exactly this order.
 */
export function snapshotPaginationKey(snapshot: FundSnapshot): string {
  const version = String(snapshot.version ?? 0).padStart(SNAPSHOT_VERSION_KEY_WIDTH, "0");
  return snapshot.id ? `${snapshot.id}\u0000${version}` : `${snapshot.fund}\u0000${snapshot.period}\u0000${version}`;
}

class DemoPlatform implements PlatformPort {
  private auditEvents: AuditEvent[] = [];
  async listDocuments() { return documents; }
  async listObservations() { return observations; }
  async listSnapshots() { return fundSnapshots; }
  async listReconciliationExceptions() { return []; }
  async portfolioValueFacts() { return portfolioValueFacts; }
  async review(identity: RequestIdentity, decision: ReviewDecision): Promise<ReviewOutcome> {
    void identity;
    return {
      accepted: true,
      reviewEventId: randomUUID(),
      newVersion: decision.expectedVersion + 1,
      nextState: decision.decision === "approve" ? "approved" : decision.decision === "reject" ? "rejected" : "review_required",
    };
  }
  async resolveReconciliation(identity: RequestIdentity, command: ReconciliationResolutionCommand): Promise<ReconciliationResolutionOutcome> {
    void identity;
    return { accepted: true, resolutionEventId: randomUUID(), newVersion: command.expectedVersion + 1, status: "resolved" };
  }
  async publish(identity: RequestIdentity, command: SnapshotPublication) { void identity; void command; return { accepted: true as const, publicationEventId: randomUUID() }; }
  async research(identity: RequestIdentity, question: string, options: ResearchExecutionOptions = {}): Promise<ResearchAnswer> {
    void identity;
    options.signal?.throwIfAborted();
    options.onProgress?.("planning");
    options.signal?.throwIfAborted();
    options.onProgress?.("retrieval");
    options.signal?.throwIfAborted();
    options.onProgress?.("generation");
    options.signal?.throwIfAborted();
    return { answer: `Demo-mode response for: ${question}.`, citations: [], semanticQueryIds: [], uncertainty: "Demo mode does not execute production semantic queries." };
  }
  async audit(event: AuditEvent) { this.auditEvents.push(event); }
  async readiness() { return { identity: "demo", objectStore: "demo", postgres: "demo", orchestration: "demo", retrieval: "demo", ai: "demo", observability: "demo" } as const; }
  async export(identity: RequestIdentity, format: ExportManifest["format"]): Promise<ExportManifest> {
    return { exportId: randomUUID(), tenantId: identity.tenantId, generatedAt: new Date().toISOString(), schemaVersion: "v1", taxonomyVersion: "v1", snapshotIds: [], format, rowCounts: {}, checksumSha256: "demo" };
  }
  async jobs() { return []; }
}

export class PostgresProductionPlatform implements PlatformPort {
  private readonly db: PostgresSqlApi;
  private readonly workspace: PostgresWorkspaceRepository;
  private readonly reviewPublication: PostgresReviewPublicationRepository;
  private readonly operations: PostgresOperationsRepository;

  constructor(db?: PostgresSqlApi) {
    this.db = db ?? postgres(getServerConfig().postgresDsn);
    this.workspace = new PostgresWorkspaceRepository(this.db);
    this.reviewPublication = new PostgresReviewPublicationRepository(this.db);
    this.operations = new PostgresOperationsRepository(this.db);
  }

  async listDocuments(identity: RequestIdentity, page?: KeysetPage): Promise<DocumentRecord[]> {
    const rows = await this.workspace.listDocuments(identity, page);
    return rows.map((row) => ({
      id: text(row,"document_id"), name: text(row,"display_name","Untitled document"), fund: text(row,"fund_name","Unclassified"), period: text(row,"report_period","Detecting…"),
      type: text(row,"document_type","Source document"), pages: num(row,"page_count"), size: displaySize(num(row,"size_bytes")), status: documentStatus(text(row,"status","queued")),
      progress: text(row,"processing_state") === "running" ? 50 : undefined, uploaded: text(row,"created_at","—"), quality: quality(text(row,"quality","pending")), observations: num(row,"observation_count"),
      processingState: text(row,"processing_state") || undefined, processingUpdatedAt: isoText(row,"processing_updated_at"),
    }));
  }

  async listObservations(identity: RequestIdentity, page?: KeysetPage): Promise<ObservationRecord[]> {
    const rows = await this.workspace.listObservations(identity, page);
    return rows.map((row) => {
      const rawConfidence = num(row,"confidence_score");
      const confidence = rawConfidence > 0 && rawConfidence <= 1 ? Math.round(rawConfidence * 100) : Math.round(rawConfidence);
      const valueString = text(row,"value_string") || (row.value_number != null ? `${text(row,"currency")} ${text(row,"value_number")}`.trim() : "—");
      const page = num(row,"page_number");
      const source = page ? `p. ${page}` : text(row,"sheet_name") || text(row,"cell_range") || "Source reference";
      return {
        id: text(row,"observation_id"), company: text(row,"company_name",text(row,"company_id","Unknown company")), metric: text(row,"metric_code"), value: valueString,
        period: text(row,"economic_period") || text(row,"report_date"), source, sourceReferenceId: text(row,"source_reference_id") || undefined,
        confidence, state: reviewState(text(row,"review_state")), delta: text(row,"delta_display","—"), version: num(row,"version",1),
        fund: text(row,"fund_name") || undefined, fundId: text(row,"fund_id") || undefined,
        companyId: text(row,"company_id") || undefined, holdingId: text(row,"holding_id") || undefined,
      };
    });
  }

  async listSnapshots(identity: RequestIdentity, page?: KeysetPage): Promise<FundSnapshot[]> {
    const rows = await this.workspace.listSnapshots(identity, page);
    return rows.map((row) => ({
      id: text(row,"snapshot_id"), version: num(row,"version",1), fund: text(row,"fund_name",text(row,"fund_id","Unknown fund")), period: text(row,"report_period"),
      status: text(row,"status").toLowerCase() === "published" ? "Published" : "Review", holdings: num(row,"holding_count"), facts: num(row,"fact_count"),
      changed: text(row,"published_at") || text(row,"created_at"), blockingExceptions: num(row,"blocking_exception_count"),
      publishedAt: isoText(row,"published_at"),
    }));
  }

  async listReconciliationExceptions(identity: RequestIdentity, snapshotId: string, snapshotVersion: number): Promise<ReconciliationException[]> {
    const rows = await this.reviewPublication.reconciliationExceptions(identity, snapshotId, snapshotVersion);
    return rows.map((row) => {
      const type = text(row,"exception_type") as ReconciliationExceptionType;
      const sourceReferences: ReconciliationSourceReference[] = objectArray(row.source_references).map((source) => ({
        sourceReferenceId: String(source.sourceReferenceId ?? ""),
        documentId: String(source.documentId ?? ""),
        page: source.page == null ? undefined : Number(source.page),
        sheetName: source.sheetName == null ? undefined : String(source.sheetName),
        cellRange: source.cellRange == null ? undefined : String(source.cellRange),
        excerpt: source.excerpt == null ? undefined : String(source.excerpt),
      })).filter((source) => source.sourceReferenceId && source.documentId);
      return {
        exceptionId: text(row,"exception_id"),
        snapshotId: text(row,"snapshot_id"),
        snapshotVersion: num(row,"snapshot_version",1),
        fundId: text(row,"fund_id"),
        reportPeriod: text(row,"report_period"),
        type,
        subjectType: text(row,"subject_type") || undefined,
        subjectId: text(row,"subject_id") || undefined,
        metricCode: text(row,"metric_code") || undefined,
        summary: text(row,"summary","Reconciliation exception"),
        materiality: text(row,"materiality","unknown") as ReconciliationException["materiality"],
        context: objectValue(row.context),
        status: text(row,"status","open") as ReconciliationException["status"],
        version: num(row,"version",1),
        allowedActions: allowedActions(type),
        sourceReferences,
        createdAt: text(row,"created_at"),
        resolvedAt: text(row,"resolved_at") || undefined,
      };
    });
  }

  async portfolioValueFacts(identity: RequestIdentity): Promise<PortfolioValueFact[]> {
    const rows = await this.workspace.portfolioValueFacts(identity);
    return rows.flatMap((row) => {
      const metricCode = text(row,"metric_code");
      const value = Number(row.total_value);
      if ((metricCode !== "nav" && metricCode !== "fair_value") || !Number.isFinite(value)) return [];
      return [{
        snapshotId: text(row,"snapshot_id"), fundId: text(row,"fund_id"), fund: text(row,"fund_name",text(row,"fund_id")),
        period: text(row,"report_period"), publishedAt: isoText(row,"published_at") ?? null, metricCode,
        currency: text(row,"currency") || null, value, factCount: num(row,"fact_count"),
      }];
    });
  }

  async review(identity: RequestIdentity, decision: ReviewDecision): Promise<ReviewOutcome> {
    const current = await this.reviewPublication.observation(identity, decision.observationId);
    // Unknown, out-of-entitlement and malformed ids all answer the same way,
    // like the reconciliation and snapshot paths, instead of a generic 500.
    if (!current) throw new ConflictError("observation_not_found_or_version_conflict");
    if (num(current,"version") !== decision.expectedVersion) throw new ConflictError("observation_version_conflict");
    if (decision.decision === "correct" && !decision.correctedValue) throw new Error("Corrected value is required");
    const reviewEventId = randomUUID();
    const applied = await this.reviewPublication.applyReview(identity, decision, reviewEventId);
    if (!applied || num(applied,"new_version") !== decision.expectedVersion + 1) throw new ConflictError("observation_version_conflict");
    return {
      accepted: true,
      reviewEventId,
      newVersion: num(applied,"new_version"),
      nextState: text(applied,"next_state") as ReviewOutcome["nextState"],
    };
  }

  async resolveReconciliation(identity: RequestIdentity, command: ReconciliationResolutionCommand): Promise<ReconciliationResolutionOutcome> {
    if (!command.reasonCode) throw new Error("Resolution reason is required");
    const current = await this.reviewPublication.reconciliationExceptionForResolution(identity, command);
    if (!current) throw new ConflictError("reconciliation_exception_not_found_or_version_conflict");
    const type = text(current,"exception_type") as ReconciliationExceptionType;
    if (!allowedActions(type).includes(command.action)) throw new ConflictError("reconciliation_resolution_not_allowed");
    const resolutionEventId = randomUUID();
    const applied = await this.reviewPublication.applyReconciliationResolution(identity, command, resolutionEventId);
    if (!applied || num(applied,"new_version") !== command.expectedVersion + 1) {
      throw new ConflictError("reconciliation_exception_not_found_or_version_conflict");
    }
    return { accepted: true, resolutionEventId, newVersion: num(applied,"new_version"), status: "resolved" };
  }

  async publish(identity: RequestIdentity, command: SnapshotPublication): Promise<{ accepted: true; publicationEventId: string }> {
    const snapshot = await this.reviewPublication.snapshot(identity, command.snapshotId, command.expectedVersion);
    if (!snapshot) throw new ConflictError("snapshot_not_found_or_version_conflict");
    const currentStatus = text(snapshot,"status").toLowerCase();
    if (currentStatus && DISALLOWED_SNAPSHOT_SOURCE_STATUSES[command.action]?.includes(currentStatus)) {
      throw new ConflictError("snapshot_transition_not_allowed");
    }
    if (command.action === "publish") {
      const fundId = text(snapshot,"fund_id");
      const [counts, independentlyReviewedCriticalCount] = await Promise.all([
        this.reviewPublication.publicationCounts(identity.tenantId, fundId),
        this.reviewPublication.independentlyReviewedCriticalCount(identity.tenantId, fundId),
      ]);
      const total = num(counts,"total_count");
      const gate = evaluatePublicationGate({
        blockingExceptions: num(snapshot,"blocking_exception_count"),
        needsReviewCount: num(counts,"needs_review_count"),
        criticalObservationCount: num(counts,"critical_count"),
        independentlyReviewedCriticalCount,
        lineageCoverage: total === 0 ? 0 : num(counts,"lineage_count") / total,
      });
      if (!gate.allowed) throw new PublicationGateError(gate.reasons);
    }
    const publicationEventId = randomUUID();
    let appended: boolean;
    try {
      appended = await this.reviewPublication.appendSnapshotTransition(identity, command, publicationEventId);
    } catch (error) {
      // assert_snapshot_publishable re-checks the publication invariants at the
      // persistence boundary and raises (SQLSTATE P0001) when one fails that the
      // application preflight did not see, e.g. an active data-correction
      // incident. That is a blocked publication, not a server fault.
      if (command.action === "publish" && (error as { code?: unknown } | null)?.code === "P0001") {
        throw new PublicationGateError(["publication_invariant_failed"]);
      }
      throw error;
    }
    if (!appended) throw new ConflictError("snapshot_not_found_or_version_conflict");
    return { accepted: true, publicationEventId };
  }

  async research(identity: RequestIdentity, question: string, options: ResearchExecutionOptions = {}): Promise<ResearchAnswer> {
    return researchService().answer(identity, question, options);
  }

  audit(event: AuditEvent): Promise<void> { return this.operations.audit(event); }

  async readiness(): Promise<Record<string, "configured" | "missing" | "demo">> {
    const config = getServerConfig();
    const result: Record<string,"configured"|"missing"|"demo"> = {
      // Production verifies OIDC bearer tokens directly (issuer + audience);
      // the signed trusted-proxy assertion remains an optional alternative.
      identity: (config.authIssuer && config.authAudience) || config.trustedAuthProxySecret ? "configured" : "missing",
      objectStore: config.objectStoreBucket && config.uploadAllowedOrigins.length ? "configured" : "missing",
      postgres: "missing",
      orchestration: "configured",
      retrieval: config.searchEndpoint ? "configured" : "missing",
      ai: config.aiEndpoint ? "configured" : "missing",
      observability: config.observabilityEndpoint ? "configured" : "missing",
    };
    if (await this.db.health()) result.postgres = "configured";
    return result;
  }

  async export(identity: RequestIdentity, format: ExportManifest["format"]): Promise<ExportManifest> {
    assertRedistributionAllowed(identity);
    const { snapshots, observationCount } = await this.operations.exportManifest(identity);
    const exportId = randomUUID();
    const generatedAt = new Date().toISOString();
    const manifestBase = {
      exportId, tenantId: identity.tenantId, generatedAt,
      schemaVersion: snapshots.length ? text(snapshots[0],"schema_version","v1") : "v1",
      taxonomyVersion: snapshots.length ? text(snapshots[0],"taxonomy_version","v1") : "v1",
      snapshotIds: snapshots.map((row) => text(row,"snapshot_id")), format,
      rowCounts: { observations: observationCount, snapshots: snapshots.length },
    };
    const manifest: ExportManifest = { ...manifestBase, checksumSha256: checksum(manifestBase) };
    await this.operations.enqueueExport(identity, manifest);
    return manifest;
  }

  jobs(identity: RequestIdentity, page?: KeysetPage): Promise<ProcessingJob[]> { return this.operations.jobs(identity, page); }
}

export class ConflictError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ConflictError";
    this.code = code;
  }
}

export class PublicationGateError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super("Publication blocked");
    this.name = "PublicationGateError";
    this.reasons = reasons;
  }
}

let singleton: PlatformPort | undefined;
export function platform(): PlatformPort {
  if (!singleton) singleton = getServerConfig().demoMode ? new DemoPlatform() : new PostgresProductionPlatform();
  return singleton;
}