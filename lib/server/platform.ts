import { createHash, randomUUID } from "crypto";
import { documents, fundSnapshots, observations } from "@/adapters/demo/catalog";
import type { DocumentRecord, FundSnapshot, ObservationRecord } from "@/core/contracts";
import type { AuditEvent, ExportManifest, ProcessingJob, RequestIdentity, ResearchAnswer, ReviewDecision, SnapshotPublication } from "@/core/enterprise";
import { getServerConfig } from "@/lib/server/config";
import { evaluatePublicationGate } from "@/lib/server/publication-policy";
import { researchService } from "@/lib/server/research";
import { s3 } from "@/lib/server/s3";
import { snowflake, type SnowflakeRow, type SnowflakeSqlApi } from "@/lib/server/snowflake";

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

function text(row: SnowflakeRow, key: string, fallback = ""): string { const value = row[key]; return value == null ? fallback : String(value); }
function num(row: SnowflakeRow, key: string, fallback = 0): number { const value = Number(row[key]); return Number.isFinite(value) ? value : fallback; }
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
  async readiness() { return { identity: "demo", objectStore: "demo", snowflake: "demo", orchestration: "demo", retrieval: "demo", ai: "demo", observability: "demo" } as const; }
  async export(identity: RequestIdentity, format: ExportManifest["format"]): Promise<ExportManifest> {
    return { exportId: randomUUID(), tenantId: identity.tenantId, generatedAt: new Date().toISOString(), schemaVersion: "v1", taxonomyVersion: "v1", snapshotIds: [], format, rowCounts: {}, checksumSha256: "demo" };
  }
  async jobs() { return []; }
}

export class SnowflakeProductionPlatform implements PlatformPort {
  constructor(private readonly db: SnowflakeSqlApi = snowflake()) {}

  async listDocuments(identity: RequestIdentity): Promise<DocumentRecord[]> {
    const rows = await this.db.query(`SELECT * FROM PM_SERVING.DOCUMENTS WHERE TENANT_ID=? ORDER BY CREATED_AT DESC LIMIT 1000`, [identity.tenantId]);
    return rows.map((row) => ({
      id: text(row,"document_id"), name: text(row,"display_name","Untitled document"), fund: text(row,"fund_name","Unclassified"), period: text(row,"report_period","Detecting…"),
      type: text(row,"document_type","Source document"), pages: num(row,"page_count"), size: displaySize(num(row,"size_bytes")), status: documentStatus(text(row,"status","queued")),
      progress: text(row,"processing_state") === "running" ? 50 : undefined, uploaded: text(row,"created_at","—"), quality: quality(text(row,"quality","pending")), observations: num(row,"observation_count"),
    }));
  }

  async listObservations(identity: RequestIdentity): Promise<ObservationRecord[]> {
    const rows = await this.db.query(`SELECT * FROM PM_SERVING.OBSERVATIONS WHERE TENANT_ID=? ORDER BY UPDATED_AT DESC LIMIT 5000`, [identity.tenantId]);
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
    const rows = await this.db.query(`SELECT S.*, (SELECT COUNT(*) FROM PM_FACTS.HOLDING H WHERE H.TENANT_ID=S.TENANT_ID AND H.FUND_ID=S.FUND_ID) HOLDING_COUNT FROM PM_SERVING.FUND_PERIOD_SNAPSHOTS S WHERE S.TENANT_ID=? ORDER BY S.CREATED_AT DESC LIMIT 1000`, [identity.tenantId]);
    return rows.map((row) => ({
      id: text(row,"snapshot_id"), version: num(row,"version",1), fund: text(row,"fund_name",text(row,"fund_id","Unknown fund")), period: text(row,"report_period"),
      status: text(row,"status").toLowerCase() === "published" ? "Published" : "Review", holdings: num(row,"holding_count"), facts: num(row,"fact_count"),
      changed: text(row,"published_at") || text(row,"created_at"), blockingExceptions: num(row,"blocking_exception_count"),
    }));
  }

  async review(identity: RequestIdentity, decision: ReviewDecision): Promise<{ accepted: true; reviewEventId: string }> {
    const rows = await this.db.query(`SELECT OBSERVATION_ID, VERSION, REVIEW_STATE, VALUE_NUMBER, VALUE_STRING, RISK_TIER FROM PM_FACTS.OBSERVATION WHERE TENANT_ID=? AND OBSERVATION_ID=? LIMIT 1`, [identity.tenantId, decision.observationId]);
    const current = rows[0];
    if (!current) throw new Error("Observation not found");
    if (num(current,"version") !== decision.expectedVersion) throw new ConflictError("observation_version_conflict");
    if (decision.decision === "correct" && !decision.correctedValue) throw new Error("Corrected value is required");
    const reviewEventId = randomUUID();
    const before = { valueNumber: current.value_number, valueString: current.value_string, reviewState: current.review_state };
    const after = decision.decision === "correct" ? { valueString: decision.correctedValue, reviewState: "review_required" } : { valueNumber: current.value_number, valueString: current.value_string, reviewState: decision.decision === "reject" ? "rejected" : "approved" };
    await this.db.execute(`INSERT INTO PM_FACTS.REVIEW_EVENT (TENANT_ID,REVIEW_EVENT_ID,OBSERVATION_ID,ACTOR_SUBJECT,DECISION,REASON_CODE,BEFORE_VALUE,AFTER_VALUE,OBSERVATION_VERSION,CREATED_AT) SELECT ?,?,?,?,?,?,PARSE_JSON(?),PARSE_JSON(?),?,CURRENT_TIMESTAMP()`, [identity.tenantId,reviewEventId,decision.observationId,identity.subject,decision.decision,decision.reasonCode,JSON.stringify(before),JSON.stringify(after),decision.expectedVersion]);

    let nextState = decision.decision === "reject" ? "rejected" : decision.decision === "correct" ? "review_required" : "approved";
    if (decision.decision === "approve" && text(current,"risk_tier","normal").toLowerCase() === "critical") {
      const reviewers = await this.db.query(`SELECT COUNT(DISTINCT ACTOR_SUBJECT) REVIEWER_COUNT FROM PM_FACTS.REVIEW_EVENT WHERE TENANT_ID=? AND OBSERVATION_ID=? AND DECISION='approve'`, [identity.tenantId, decision.observationId]);
      if (num(reviewers[0] ?? {},"reviewer_count") < 2) nextState = "review_required";
    }
    if (decision.decision === "correct") {
      await this.db.execute(`UPDATE PM_FACTS.OBSERVATION SET VALUE_STRING=?, VALUE_NUMBER=NULL, REVIEW_STATE=?, VERSION=VERSION+1, UPDATED_AT=CURRENT_TIMESTAMP() WHERE TENANT_ID=? AND OBSERVATION_ID=? AND VERSION=?`, [decision.correctedValue,nextState,identity.tenantId,decision.observationId,decision.expectedVersion]);
    } else {
      await this.db.execute(`UPDATE PM_FACTS.OBSERVATION SET REVIEW_STATE=?, VERSION=VERSION+1, UPDATED_AT=CURRENT_TIMESTAMP() WHERE TENANT_ID=? AND OBSERVATION_ID=? AND VERSION=?`, [nextState,identity.tenantId,decision.observationId,decision.expectedVersion]);
    }
    const verify = await this.db.query(`SELECT VERSION FROM PM_FACTS.OBSERVATION WHERE TENANT_ID=? AND OBSERVATION_ID=?`, [identity.tenantId, decision.observationId]);
    if (num(verify[0] ?? {},"version") !== decision.expectedVersion + 1) throw new ConflictError("observation_version_conflict");
    return { accepted: true, reviewEventId };
  }

  async publish(identity: RequestIdentity, command: SnapshotPublication): Promise<{ accepted: true; publicationEventId: string }> {
    const rows = await this.db.query(`SELECT * FROM PM_CONSOLIDATED.FUND_PERIOD_SNAPSHOT WHERE TENANT_ID=? AND SNAPSHOT_ID=? AND VERSION=? LIMIT 1`, [identity.tenantId,command.snapshotId,command.expectedVersion]);
    const snapshot = rows[0];
    if (!snapshot) throw new ConflictError("snapshot_not_found_or_version_conflict");
    if (command.action === "publish") {
      const counts = await this.db.query(`SELECT
        COUNT_IF(REVIEW_STATE='review_required') NEEDS_REVIEW_COUNT,
        COUNT_IF(RISK_TIER='critical') CRITICAL_COUNT,
        COUNT_IF(SOURCE_REFERENCE_ID IS NOT NULL) LINEAGE_COUNT,
        COUNT(*) TOTAL_COUNT
        FROM PM_FACTS.OBSERVATION WHERE TENANT_ID=? AND FUND_ID=?`, [identity.tenantId,text(snapshot,"fund_id")]);
      const reviewed = await this.db.query(`SELECT COUNT(*) INDEPENDENTLY_REVIEWED FROM (
        SELECT O.OBSERVATION_ID
        FROM PM_FACTS.OBSERVATION O JOIN PM_FACTS.REVIEW_EVENT R ON R.TENANT_ID=O.TENANT_ID AND R.OBSERVATION_ID=O.OBSERVATION_ID
        WHERE O.TENANT_ID=? AND O.FUND_ID=? AND O.RISK_TIER='critical' AND R.DECISION='approve'
        GROUP BY O.OBSERVATION_ID HAVING COUNT(DISTINCT R.ACTOR_SUBJECT)>=2
      )`, [identity.tenantId,text(snapshot,"fund_id")]);
      const c = counts[0] ?? {};
      const total = num(c,"total_count");
      const gate = evaluatePublicationGate({
        blockingExceptions: num(snapshot,"blocking_exception_count"), needsReviewCount: num(c,"needs_review_count"), criticalObservationCount: num(c,"critical_count"),
        independentlyReviewedCriticalCount: num(reviewed[0] ?? {},"independently_reviewed"), lineageCoverage: total === 0 ? 0 : num(c,"lineage_count") / total,
      });
      if (!gate.allowed) throw new PublicationGateError(gate.reasons);
    }
    const nextStatus = command.action === "publish" ? "published" : command.action === "withdraw" ? "withdrawn" : "superseded";
    await this.db.execute(`UPDATE PM_CONSOLIDATED.FUND_PERIOD_SNAPSHOT SET STATUS=?, VERSION=VERSION+1, PUBLISHED_AT=IFF(?='published',CURRENT_TIMESTAMP(),PUBLISHED_AT) WHERE TENANT_ID=? AND SNAPSHOT_ID=? AND VERSION=?`, [nextStatus,nextStatus,identity.tenantId,command.snapshotId,command.expectedVersion]);
    const eventId = randomUUID();
    await this.db.execute(`INSERT INTO PM_CONTROL.OUTBOX_EVENT (TENANT_ID,EVENT_ID,EVENT_TYPE,AGGREGATE_TYPE,AGGREGATE_ID,PAYLOAD,CREATED_AT) SELECT ?,?,'SnapshotPublicationChanged','fund_period_snapshot',?,PARSE_JSON(?),CURRENT_TIMESTAMP()`, [identity.tenantId,eventId,command.snapshotId,JSON.stringify({ action: command.action, actor: identity.subject, reason: command.reason ?? null })]);
    return { accepted: true, publicationEventId: eventId };
  }

  async research(identity: RequestIdentity, question: string): Promise<ResearchAnswer> { return researchService().answer(identity, question); }

  async audit(event: AuditEvent): Promise<void> {
    await this.db.execute(`INSERT INTO PM_CONTROL.AUDIT_EVENT (TENANT_ID,AUDIT_EVENT_ID,OCCURRED_AT,WORKSPACE_ID,ACTOR_SUBJECT,SESSION_ID,ACTION,TARGET_TYPE,TARGET_ID,OUTCOME,CORRELATION_ID,METADATA) SELECT ?,?,TO_TIMESTAMP_TZ(?),?,?,?,?,?,?,?,?,PARSE_JSON(?)`, [event.tenantId,event.id,event.occurredAt,event.workspaceId,event.actorSubject,event.sessionId,event.action,event.targetType,event.targetId ?? null,event.outcome,event.correlationId,JSON.stringify(event.metadata ?? {})]);
  }

  async readiness(): Promise<Record<string, "configured" | "missing" | "demo">> {
    const config = getServerConfig();
    const result: Record<string,"configured"|"missing"|"demo"> = {
      identity: config.authIssuer && config.trustedAuthProxySecret ? "configured" : "missing",
      objectStore: config.objectStoreBucket && config.s3Region && config.s3KmsKeyId ? "configured" : "missing",
      snowflake: "missing",
      orchestration: "configured",
      retrieval: config.searchEndpoint ? "configured" : "missing",
      ai: config.aiEndpoint ? "configured" : "missing",
      observability: config.observabilityEndpoint ? "configured" : "missing",
    };
    if (await this.db.health()) result.snowflake = "configured";
    try { await s3().getJson("_corvis/health/nonexistent-probe.json"); } catch { result.objectStore = "missing"; }
    return result;
  }

  async export(identity: RequestIdentity, format: ExportManifest["format"]): Promise<ExportManifest> {
    const snapshotRows = await this.db.query(`SELECT SNAPSHOT_ID, SCHEMA_VERSION, TAXONOMY_VERSION FROM PM_SERVING.FUND_PERIOD_SNAPSHOTS WHERE TENANT_ID=? AND STATUS='published' ORDER BY PUBLISHED_AT DESC`, [identity.tenantId]);
    const observationRows = await this.db.query(`SELECT COUNT(*) ROW_COUNT FROM PM_SERVING.OBSERVATIONS WHERE TENANT_ID=? AND REVIEW_STATE='approved'`, [identity.tenantId]);
    const exportId = randomUUID(); const generatedAt = new Date().toISOString();
    const manifestBase = {
      exportId, tenantId: identity.tenantId, generatedAt,
      schemaVersion: snapshotRows.length ? text(snapshotRows[0],"schema_version","v1") : "v1",
      taxonomyVersion: snapshotRows.length ? text(snapshotRows[0],"taxonomy_version","v1") : "v1",
      snapshotIds: snapshotRows.map((row) => text(row,"snapshot_id")), format,
      rowCounts: { observations: num(observationRows[0] ?? {},"row_count"), snapshots: snapshotRows.length },
    };
    const manifest: ExportManifest = { ...manifestBase, checksumSha256: checksum(manifestBase) };
    await this.db.execute(`INSERT INTO PM_SERVING.EXPORT_JOB (TENANT_ID,EXPORT_ID,REQUESTED_BY,FORMAT,SNAPSHOT_IDS,STATE,CHECKSUM_SHA256,MANIFEST,CREATED_AT) SELECT ?,?,?,?,PARSE_JSON(?),'queued',?,PARSE_JSON(?),CURRENT_TIMESTAMP()`, [identity.tenantId,exportId,identity.subject,format,JSON.stringify(manifest.snapshotIds),manifest.checksumSha256,JSON.stringify(manifest)]);
    await this.db.execute(`INSERT INTO PM_CONTROL.OUTBOX_EVENT (TENANT_ID,EVENT_ID,EVENT_TYPE,AGGREGATE_TYPE,AGGREGATE_ID,PAYLOAD,CREATED_AT) SELECT ?,?,'ExportRequested','export',?,PARSE_JSON(?),CURRENT_TIMESTAMP()`, [identity.tenantId,randomUUID(),exportId,JSON.stringify(manifest)]);
    return manifest;
  }

  async jobs(identity: RequestIdentity): Promise<ProcessingJob[]> {
    const rows = await this.db.query(`SELECT * FROM PM_CONTROL.PROCESSING_JOB WHERE TENANT_ID=? ORDER BY UPDATED_AT DESC LIMIT 1000`, [identity.tenantId]);
    return rows.map((row) => ({
      id: text(row,"job_id"), documentId: text(row,"document_id"), tenantId: identity.tenantId, stage: text(row,"stage") as ProcessingJob["stage"], state: text(row,"state") as ProcessingJob["state"],
      attempt: num(row,"attempt"), maxAttempts: num(row,"max_attempts"), correlationId: text(row,"correlation_id"), version: num(row,"version",1), createdAt: text(row,"created_at"), updatedAt: text(row,"updated_at"), lastError: text(row,"last_error") || undefined,
    }));
  }
}

export class ConflictError extends Error { constructor(public readonly code: string) { super(code); this.name = "ConflictError"; } }
export class PublicationGateError extends Error { constructor(public readonly reasons: string[]) { super("Publication blocked"); this.name = "PublicationGateError"; } }

let singleton: PlatformPort | undefined;
export function platform(): PlatformPort {
  if (!singleton) singleton = getServerConfig().demoMode ? new DemoPlatform() : new SnowflakeProductionPlatform();
  return singleton;
}
