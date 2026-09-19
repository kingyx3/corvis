import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

/**
 * Historical-snapshot reproducibility and lineage reconciliation.
 *
 * A published fund-period snapshot must still resolve, from retained state
 * alone, to consolidated facts, to the approved canonical observations behind
 * them, to source references, and finally to retained GCS artifact evidence.
 * Every broken hop is reported as an explicit gap; nothing is inferred and no
 * missing hop is allowed to pass silently.
 */

export type LineageGapKind =
  | "snapshot_missing"
  | "snapshot_not_published"
  | "snapshot_without_facts"
  | "publication_event_missing"
  | "fact_missing"
  | "fact_without_observations"
  | "observation_missing"
  | "observation_not_approved"
  | "source_reference_missing"
  | "evidence_missing";

export type LineageGap = { kind: LineageGapKind; entity: string; id: string; detail: string };

export type SnapshotLineageReport = {
  schemaVersion: "corvis.snapshot-lineage-reconciliation.v1";
  tenantId: string;
  snapshotId: string;
  version: number;
  status: "reproducible" | "gap";
  counts: {
    facts: number;
    observations: number;
    sourceReferences: number;
    evidenceObjects: number;
  };
  gaps: LineageGap[];
};

export type TenantLineageReport = {
  schemaVersion: "corvis.tenant-lineage-reconciliation.v1";
  tenantId: string;
  status: "reconciled" | "gap";
  snapshotsChecked: number;
  reproducibleCount: number;
  gapCount: number;
  snapshots: SnapshotLineageReport[];
};

type ReadOnlySqlApi = Pick<PostgresSqlApi, "query">;

const uuidArrayPredicate = "any(array(select jsonb_array_elements_text($2::jsonb)::uuid))";

export class PostgresLineageRepository {
  private readonly db: ReadOnlySqlApi;
  constructor(db: ReadOnlySqlApi) { this.db = db; }

  async reconcileSnapshot(tenantId: string, snapshotId: string, version: number): Promise<SnapshotLineageReport> {
    const gaps: LineageGap[] = [];
    const counts = { facts: 0, observations: 0, sourceReferences: 0, evidenceObjects: 0 };

    const snapshotRows = await this.db.query(`select snapshot_id, fund_id, report_period, version, status, fact_ids, published_at
      from corvis_consolidated.fund_period_snapshot
      where tenant_id=$1 and snapshot_id=$2::uuid and version=$3 limit 1`, [tenantId, snapshotId, version]);
    const snapshot = snapshotRows[0];
    if (!snapshot) {
      return report(tenantId, snapshotId, version, counts, [{
        kind: "snapshot_missing",
        entity: "fund_period_snapshot",
        id: `${snapshotId}@${version}`,
        detail: "retained state no longer contains this snapshot version",
      }]);
    }
    if (String(snapshot.status ?? "") !== "published") {
      gaps.push({
        kind: "snapshot_not_published",
        entity: "fund_period_snapshot",
        id: `${snapshotId}@${version}`,
        detail: `expected a published snapshot version, found ${String(snapshot.status ?? "unknown")}`,
      });
    }

    if (version > 1) {
      const events = await this.db.query(`select publication_event_id, actor_subject, created_at
        from corvis_consolidated.snapshot_publication_event
        where tenant_id=$1 and snapshot_id=$2::uuid and to_version=$3 and action='publish' limit 1`, [tenantId, snapshotId, version]);
      if (!events[0]) {
        gaps.push({
          kind: "publication_event_missing",
          entity: "snapshot_publication_event",
          id: `${snapshotId}@${version}`,
          detail: "published version has no attributable publication transition",
        });
      }
    }

    const factIds = identifiers(snapshot.fact_ids);
    if (factIds.length === 0) {
      gaps.push({
        kind: "snapshot_without_facts",
        entity: "fund_period_snapshot",
        id: `${snapshotId}@${version}`,
        detail: "published snapshot references no consolidated facts",
      });
      return report(tenantId, snapshotId, version, counts, gaps);
    }

    const factRows = await this.db.query(`select consolidated_fact_id, source_observation_ids
      from corvis_consolidated.consolidated_fact
      where tenant_id=$1 and consolidated_fact_id = ${uuidArrayPredicate}`, [tenantId, JSON.stringify(factIds)]);
    const facts = new Map(factRows.map((row) => [String(row.consolidated_fact_id ?? ""), row]));
    counts.facts = facts.size;

    const observationIds = new Set<string>();
    for (const factId of factIds) {
      const fact = facts.get(factId);
      if (!fact) {
        gaps.push({ kind: "fact_missing", entity: "consolidated_fact", id: factId, detail: "snapshot fact is no longer retained" });
        continue;
      }
      const sources = identifiers(fact.source_observation_ids);
      if (sources.length === 0) {
        gaps.push({ kind: "fact_without_observations", entity: "consolidated_fact", id: factId, detail: "consolidated fact records no source observations" });
        continue;
      }
      for (const observationId of sources) observationIds.add(observationId);
    }
    if (observationIds.size === 0) return report(tenantId, snapshotId, version, counts, gaps);

    const observationRows = await this.db.query(`select observation_id, review_state, source_reference_id
      from corvis_facts.observation
      where tenant_id=$1 and observation_id = ${uuidArrayPredicate}`, [tenantId, JSON.stringify([...observationIds])]);
    const observations = new Map(observationRows.map((row) => [String(row.observation_id ?? ""), row]));
    counts.observations = observations.size;

    const sourceReferenceIds = new Set<string>();
    for (const observationId of observationIds) {
      const observation = observations.get(observationId);
      if (!observation) {
        gaps.push({ kind: "observation_missing", entity: "observation", id: observationId, detail: "canonical observation behind a published fact is no longer retained" });
        continue;
      }
      if (String(observation.review_state ?? "") !== "approved") {
        gaps.push({
          kind: "observation_not_approved",
          entity: "observation",
          id: observationId,
          detail: `published fact depends on a ${String(observation.review_state ?? "unknown")} observation`,
        });
      }
      const sourceReferenceId = String(observation.source_reference_id ?? "");
      if (!sourceReferenceId) {
        gaps.push({ kind: "source_reference_missing", entity: "observation", id: observationId, detail: "observation carries no source reference" });
        continue;
      }
      sourceReferenceIds.add(sourceReferenceId);
    }
    if (sourceReferenceIds.size === 0) return report(tenantId, snapshotId, version, counts, gaps);

    const referenceRows = await this.db.query(`select source_reference_id, document_artifact_version_id
      from corvis_source.source_reference
      where tenant_id=$1 and source_reference_id = ${uuidArrayPredicate}`, [tenantId, JSON.stringify([...sourceReferenceIds])]);
    const references = new Map(referenceRows.map((row) => [String(row.source_reference_id ?? ""), row]));
    counts.sourceReferences = references.size;

    const artifactIds = new Set<string>();
    for (const sourceReferenceId of sourceReferenceIds) {
      const reference = references.get(sourceReferenceId);
      if (!reference) {
        gaps.push({ kind: "source_reference_missing", entity: "source_reference", id: sourceReferenceId, detail: "lineage hop to source evidence is no longer retained" });
        continue;
      }
      const artifactId = String(reference.document_artifact_version_id ?? "");
      if (!artifactId) {
        gaps.push({ kind: "evidence_missing", entity: "source_reference", id: sourceReferenceId, detail: "source reference points at no artifact version" });
        continue;
      }
      artifactIds.add(artifactId);
    }
    if (artifactIds.size === 0) return report(tenantId, snapshotId, version, counts, gaps);

    const artifactRows = await this.db.query(`select document_artifact_version_id, object_uri, sha256
      from corvis_source.document_artifact_version
      where tenant_id=$1 and document_artifact_version_id = ${uuidArrayPredicate}`, [tenantId, JSON.stringify([...artifactIds])]);
    const artifacts = new Map(artifactRows.map((row) => [String(row.document_artifact_version_id ?? ""), row]));

    for (const artifactId of artifactIds) {
      const artifact = artifacts.get(artifactId);
      if (!artifact) {
        gaps.push({ kind: "evidence_missing", entity: "document_artifact_version", id: artifactId, detail: "retained source evidence row is missing" });
        continue;
      }
      if (!String(artifact.object_uri ?? "")) {
        gaps.push({ kind: "evidence_missing", entity: "document_artifact_version", id: artifactId, detail: "artifact version has no object reference" });
        continue;
      }
      if (!String(artifact.sha256 ?? "")) {
        gaps.push({ kind: "evidence_missing", entity: "document_artifact_version", id: artifactId, detail: "artifact version has no content hash to verify replay against" });
        continue;
      }
      counts.evidenceObjects += 1;
    }

    return report(tenantId, snapshotId, version, counts, gaps);
  }

  async reconcilePublishedSnapshots(tenantId: string, limit = 50): Promise<TenantLineageReport> {
    const rows = await this.db.query(`select snapshot_id, version from corvis_serving.fund_period_snapshots
      where tenant_id=$1 and status='published' order by published_at desc limit $2`, [tenantId, limit]);
    const snapshots: SnapshotLineageReport[] = [];
    for (const row of rows) {
      snapshots.push(await this.reconcileSnapshot(tenantId, String(row.snapshot_id ?? ""), Number(row.version ?? 0)));
    }
    const gapCount = snapshots.filter((snapshot) => snapshot.status === "gap").length;
    return {
      schemaVersion: "corvis.tenant-lineage-reconciliation.v1",
      tenantId,
      status: gapCount === 0 ? "reconciled" : "gap",
      snapshotsChecked: snapshots.length,
      reproducibleCount: snapshots.length - gapCount,
      gapCount,
      snapshots,
    };
  }
}

function report(
  tenantId: string,
  snapshotId: string,
  version: number,
  counts: SnapshotLineageReport["counts"],
  gaps: LineageGap[],
): SnapshotLineageReport {
  return {
    schemaVersion: "corvis.snapshot-lineage-reconciliation.v1",
    tenantId,
    snapshotId,
    version,
    status: gaps.length === 0 ? "reproducible" : "gap",
    counts,
    gaps,
  };
}

/** Postgres uuid[] columns arrive either as arrays or as a `{a,b}` literal. */
function identifiers(value: PostgresRow[string]): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value !== "string") return [];
  return value.replace(/^\{|\}$/g, "").split(",").map((entry) => entry.replace(/^"|"$/g, "").trim()).filter(Boolean);
}
