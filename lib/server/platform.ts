import { createHash, randomUUID } from "crypto";
import { documents, fundSnapshots, observations } from "../../adapters/demo/catalog.ts";
import type { DocumentRecord, FundSnapshot, ObservationRecord } from "../../core/contracts.ts";
import type { AuditEvent, ExportManifest, ProcessingJob, RequestIdentity, ResearchAnswer, ReviewDecision, SnapshotPublication } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { PostgresOperationsRepository, PostgresReviewPublicationRepository, PostgresWorkspaceRepository } from "./platform-repositories.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";
import { evaluatePublicationGate } from "./publication-policy.ts";
import { researchService } from "./research.ts";

export interface PlatformPort {
  listDocuments(identity: RequestIdentity): Promise<DocumentRecord[]>;
  listObservations(identity: RequestIdentity): Promise<ObservationRecord[]>;
  listSnapshots(identity: RequestIdentity): Promise<FundSnapshot[]>;
  review(identity: RequestIdentity, decision: ReviewDecision): Promise<{ accepted: true; reviewEventId: string }>;
  publish(identity: RequestIdentity, command: SnapshotPublication): Promise<{ accepted: true; publicationEventId: string }>;
  research(identity: RequestIdentity, question: string): Promise<ResearchAnswer>;
  audit(event: AuditEvent): Promise<void>;
  readiness(): Promise<Record<string, "configured" | "missing" | "demo">>;
  export(identity: RequestIdentity, format: ExportManifest["format"]): Promise<ExportManifest>;
  jobs(identity: RequestIdentity): Promise<ProcessingJob[]>;
}

function text(row: PostgresRow, key: string, fallback = ""): string { const value = row[key]; return value == null ? fallback : String(value); }
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
function reviewState(value: string): ObservationRecord["state"] { return value.toLowerCase() === "approved" ? "Approved" : "Needs review"; }
function checksum(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

class DemoPlatform implements PlatformPort {
  private auditEvents: AuditEvent[] = [];
  async listDocuments() { return documents; }
  async listObservations() { return observations; }
  async listSnapshots() { return fundSnapshots; }
  async review(identity: RequestIdentity, decision: ReviewDecision) { void identity; void decision; return { accepted: true as const, reviewEventId: randomUUID() }; }
  async publish(identity: RequestIdentity, command: SnapshotPublication) { void identity; void command; return { accepted: true as const, publicationEventId: randomUUID() }; }
  async research(identity: RequestIdentity, question: string): Promise<ResearchAnswer> {
    void identity;
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

  async listDocuments(identity: RequestIdentity): Promise<DocumentRecord[]> {
    const rows = await this.workspace.listDocuments(identity.tenantId);
    return rows.map((row) => ({
      id: text(row,"document_id"), name: text(row,"display_name","Untitled document"), fund: text(row,"fund_name","Unclassified"), period: text(row,"report_period","Detecting…"),
      type: text(row,"document_type","Source document"), pages: num(row,"page_count"), size: displaySize(num(row,"size_bytes")), status: documentStatus(text(row,"status","queued")),
      progress: text(row,"processing_state") === "running" ? 50 : undefined, uploaded: text(row,"created_at","—"), quality: quality(text(row,"quality","pending")), observations: num(row,"observation_count"),
    }));
  }

  async listObservations(identity: RequestIdentity): Promise<ObservationRecord[]> {
    const rows = await this.workspace.listObservations(identity.tenantId);
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
      };
    });
  }

  async listSnapshots(identity: RequestIdentity): Promise<FundSnapshot[]> {
    const rows = await this.workspace.listSnapshots(identity.tenantId);
    return rows.map((row) => ({
      id: text(row,"snapshot_id"), version: num(row,"version",1), fund: text(row,"fund_name",text(row,"fund_id","Unknown fund")), period: text(row,"report_period"),
      status: text(row,"status").toLowerCase() === "published" ? "Published" : "Review", holdings: num(row,"holding_count"), facts: num(row,"fact_count"),
      changed: text(row,"published_at") || text(row,"created_at"), blockingExceptions: num(row,"blocking_exception_count"),
    }));
  }

  async review(identity: RequestIdentity, decision: ReviewDecision): Promise<{ accepted: true; reviewEventId: string }> {
    const current = await this.reviewPublication.observation(identity.tenantId, decision.observationId);
    if (!current) throw new Error("Observation not found");
    if (num(current,"version") !== decision.expectedVersion) throw new ConflictError("observation_version_conflict");
    if (decision.decision === "correct" && !decision.correctedValue) throw new Error("Corrected value is required");
    const reviewEventId = randomUUID();
    if (!await this.reviewPublication.applyReview(identity, decision, reviewEventId)) throw new ConflictError("observation_version_conflict");
    return { accepted: true, reviewEventId };
  }

  async publish(identity: RequestIdentity, command: SnapshotPublication): Promise<{ accepted: true; publicationEventId: string }> {
    const snapshot = await this.reviewPublication.snapshot(identity.tenantId, command.snapshotId, command.expectedVersion);
    if (!snapshot) throw new ConflictError("snapshot_not_found_or_version_conflict");
    if (command.action === "publish") {
      const fundId = text(snapshot,"fund_id");
      const counts = await this.reviewPublication.publicationCounts(identity.tenantId, fundId);
      const total = num(counts,"total_count");
      const gate = evaluatePublicationGate({
        blockingExceptions: num(snapshot,"blocking_exception_count"),
        needsReviewCount: num(counts,"needs_review_count"),
        criticalObservationCount: num(counts,"critical_count"),
        independentlyReviewedCriticalCount: await this.reviewPublication.independentlyReviewedCriticalCount(identity.tenantId, fundId),
        lineageCoverage: total === 0 ? 0 : num(counts,"lineage_count") / total,
      });
      if (!gate.allowed) throw new PublicationGateError(gate.reasons);
    }
    const publicationEventId = randomUUID();
    if (!await this.reviewPublication.appendSnapshotTransition(identity, command, publicationEventId)) throw new ConflictError("snapshot_not_found_or_version_conflict");
    return { accepted: true, publicationEventId };
  }

  async research(identity: RequestIdentity, question: string): Promise<ResearchAnswer> { return researchService().answer(identity, question); }

  audit(event: AuditEvent): Promise<void> { return this.operations.audit(event); }

  async readiness(): Promise<Record<string, "configured" | "missing" | "demo">> {
    const config = getServerConfig();
    const result: Record<string,"configured"|"missing"|"demo"> = {
      identity: config.authIssuer && config.trustedAuthProxySecret ? "configured" : "missing",
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

  jobs(identity: RequestIdentity): Promise<ProcessingJob[]> { return this.operations.jobs(identity); }
}

export class ConflictError extends Error { constructor(public readonly code: string) { super(code); this.name = "ConflictError"; } }
export class PublicationGateError extends Error { constructor(public readonly reasons: string[]) { super("Publication blocked"); this.name = "PublicationGateError"; } }

let singleton: PlatformPort | undefined;
export function platform(): PlatformPort {
  if (!singleton) singleton = getServerConfig().demoMode ? new DemoPlatform() : new PostgresProductionPlatform();
  return singleton;
}
