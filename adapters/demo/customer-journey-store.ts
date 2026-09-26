import type { DocumentRecord, FundSnapshot, ObservationRecord } from "@/core/contracts";
import type { ExportManifest, ResearchAnswer, ReviewDecision, SnapshotPublication } from "@/core/enterprise";
import type { SourceEvidence } from "@/core/workspace";
import { documents as seedDocuments, fundSnapshots as seedSnapshots, observations as seedObservations } from "@/adapters/demo/catalog";

function cloneDocument(value: DocumentRecord): DocumentRecord { return { ...value }; }
function cloneObservation(value: ObservationRecord): ObservationRecord { return { ...value }; }
function cloneSnapshot(value: FundSnapshot): FundSnapshot { return { ...value }; }
function nowLabel(): string { return "Just now"; }
function normalizeFundName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.(pdf|xlsx|xls|docx|pptx|csv)$/i, "");
  return withoutExtension.replace(/\s*[—–-]\s*(q[1-4]|quarter|investor report|report|schedule).*$/i, "").trim() || "Uploaded fund";
}
function reportingPeriod(): string {
  const date = new Date();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `Q${quarter} ${date.getUTCFullYear()}`;
}
function checksum(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

export type DemoModuleName = "documents" | "snapshots" | "observations" | "research" | "delivery" | "upload";

export function assertDemoModuleAvailable(module: DemoModuleName): void {
  if (typeof window === "undefined") return;
  if (window.sessionStorage.getItem(`corvis:demo:fail:${module}`) === "true") {
    throw new Error(`${module} module is intentionally unavailable in this demo session`);
  }
}

class DemoCustomerJourneyStore {
  private documents: DocumentRecord[] = seedDocuments.map(cloneDocument);
  private observations: ObservationRecord[] = seedObservations.map((row) => ({ ...cloneObservation(row), version: row.version ?? 1 }));
  private snapshots: FundSnapshot[] = seedSnapshots.map((row, index) => ({ ...cloneSnapshot(row), id: row.id ?? `seed-snapshot-${index + 1}`, version: row.version ?? 1 }));
  private evidence = new Map<string, SourceEvidence>();

  listDocuments(): DocumentRecord[] { return this.documents.map(cloneDocument); }
  listObservations(): ObservationRecord[] { return this.observations.map(cloneObservation); }
  listSnapshots(): FundSnapshot[] { return this.snapshots.map(cloneSnapshot); }

  completeUpload(file: File, documentId: string): { document: DocumentRecord; snapshot: FundSnapshot; observations: ObservationRecord[] } {
    const fund = normalizeFundName(file.name);
    const period = reportingPeriod();
    const snapshotId = `snapshot_${crypto.randomUUID().slice(0, 8)}`;
    const sourceReferenceId = `source_${crypto.randomUUID().slice(0, 8)}`;
    const document: DocumentRecord = {
      id: documentId,
      name: file.name,
      fund,
      period,
      type: "Quarterly report",
      pages: file.name.toLowerCase().endsWith(".pdf") ? 32 : 1,
      size: file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`,
      status: "Review",
      uploaded: nowLabel(),
      quality: "Medium",
      observations: 2,
    };
    const generated: ObservationRecord[] = [
      {
        id: `obs_${crypto.randomUUID().slice(0, 8)}`,
        snapshotId,
        fund,
        company: `${fund} Portfolio Company`,
        metric: "Revenue",
        value: "$128.4m",
        period,
        source: "p. 12 · Portfolio Company Summary",
        sourceReferenceId,
        confidence: 99,
        state: "Approved",
        delta: "+6.4%",
        version: 1,
      },
      {
        id: `obs_${crypto.randomUUID().slice(0, 8)}`,
        snapshotId,
        fund,
        company: `${fund} Portfolio Company`,
        metric: "Adjusted EBITDA",
        value: "$31.7m",
        period,
        source: "p. 12 · Portfolio Company Summary",
        sourceReferenceId,
        confidence: 91,
        state: "Needs review",
        delta: "+4.1%",
        version: 1,
      },
    ];
    const snapshot: FundSnapshot = {
      id: snapshotId,
      version: 1,
      fund,
      period,
      status: "Review",
      holdings: 1,
      facts: generated.length,
      changed: nowLabel(),
      blockingExceptions: 0,
    };

    this.documents = [document, ...this.documents.filter((item) => item.id !== documentId)];
    this.observations = [...generated, ...this.observations];
    this.snapshots = [snapshot, ...this.snapshots.filter((item) => item.id !== snapshotId)];
    this.evidence.set(sourceReferenceId, {
      sourceReferenceId,
      documentId,
      page: 12,
      excerpt: "Illustrative demo source evidence for the uploaded document. Production resolves the exact entitled source artifact and coordinates.",
    });
    return { document: cloneDocument(document), snapshot: cloneSnapshot(snapshot), observations: generated.map(cloneObservation) };
  }

  review(command: ReviewDecision): void {
    const row = this.observations.find((item) => item.id === command.observationId);
    if (!row) throw new Error("Observation not found");
    if ((row.version ?? 1) !== command.expectedVersion) throw new Error("observation_version_conflict");
    if (command.decision === "correct") {
      if (!command.correctedValue?.trim()) throw new Error("Corrected value is required");
      row.value = command.correctedValue;
      row.state = "Needs review";
    } else {
      row.state = command.decision === "approve" ? "Approved" : "Needs review";
    }
    row.version = (row.version ?? 1) + 1;
  }

  publish(command: SnapshotPublication): void {
    const snapshot = this.snapshots.find((item) => item.id === command.snapshotId);
    if (!snapshot) throw new Error("Snapshot not found");
    if ((snapshot.version ?? 1) !== command.expectedVersion) throw new Error("snapshot_version_conflict");
    const scoped = this.observations.filter((row) => row.snapshotId === snapshot.id);
    if (command.action === "publish" && scoped.some((row) => row.state !== "Approved")) throw new Error("Publication blocked: observations still require review");
    snapshot.status = command.action === "publish" ? "Published" : "Review";
    snapshot.version = (snapshot.version ?? 1) + 1;
    snapshot.changed = nowLabel();
    const document = this.documents.find((item) => item.fund === snapshot.fund && item.period === snapshot.period);
    if (document && command.action === "publish") {
      document.status = "Published";
      document.quality = "High";
    }
  }

  sourceEvidence(sourceReferenceId: string): SourceEvidence {
    return this.evidence.get(sourceReferenceId) ?? {
      sourceReferenceId,
      documentId: "demo-document",
      page: 18,
      excerpt: "Demo evidence is illustrative only; production resolves an entitled immutable source reference.",
    };
  }

  research(question: string): ResearchAnswer {
    // Illustrates the citation -> reviewed-observation link and open-reconciliation
    // flag (D2, #177): production resolves both from the entitled Postgres data,
    // demo mode just cites the first seed observation so the drill-through is
    // genuinely exercisable end to end.
    const cited = this.observations[0];
    const citations = cited ? [{
      sourceReferenceId: cited.sourceReferenceId ?? "demo-source-1",
      documentId: "demo-document",
      page: 12,
      label: `${cited.company} · ${cited.metric}`,
      observationId: cited.id,
      hasOpenReconciliation: true,
    }] : [];
    return { answer: `Demo response for: ${question}`, citations, semanticQueryIds: [], uncertainty: "Demo mode" };
  }

  createExport(format: ExportManifest["format"], snapshotId?: string, source: NonNullable<ExportManifest["source"]> = "delivery"): ExportManifest {
    const published = this.snapshots.filter((item) => item.status === "Published" && item.id);
    const scoped = snapshotId ? published.filter((item) => item.id === snapshotId) : published;
    // Mirrors the server: a scoped export (e.g. "export this view" from Review)
    // must resolve to exactly the requested, already-entitled snapshot.
    if (snapshotId && scoped.length === 0) throw new Error("export_snapshot_not_found");
    const manifestBase = {
      exportId: `export_${crypto.randomUUID().slice(0, 8)}`,
      tenantId: "demo-tenant",
      generatedAt: new Date().toISOString(),
      schemaVersion: "v1",
      taxonomyVersion: "v1",
      snapshotIds: scoped.map((item) => item.id as string),
      format,
      rowCounts: {
        observations: this.observations.filter((row) => row.state === "Approved" && (!snapshotId || row.snapshotId === snapshotId)).length,
        snapshots: scoped.length,
      },
      source,
    };
    return { ...manifestBase, checksumSha256: checksum(manifestBase) };
  }
}

export const demoCustomerJourneyStore = new DemoCustomerJourneyStore();
