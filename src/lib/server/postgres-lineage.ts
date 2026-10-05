// Not on a runtime request path (#239): intentional pre-wiring for the replay/recovery proof in UAT
// (#79), which runs this reconciliation against retained state; exercised by its unit tests.
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

type LineageTarget = { snapshotId: string; version: number };

/** Working state for one snapshot while the retained-state hops are resolved a stage at a time. */
type Walk = {
  target: LineageTarget;
  gaps: LineageGap[];
  counts: SnapshotLineageReport["counts"];
  /** Set once a stage finds nothing further to follow (or the snapshot itself is missing). */
  finished: boolean;
  factIds: string[];
  observationIds: Set<string>;
  sourceReferenceIds: Set<string>;
  artifactIds: Set<string>;
};

function targetKey(snapshotId: string, version: number): string {
  return `${snapshotId.toLowerCase()}@${version}`;
}

function idKey(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

export class PostgresLineageRepository {
  private readonly db: ReadOnlySqlApi;
  constructor(db: ReadOnlySqlApi) { this.db = db; }

  async reconcileSnapshot(tenantId: string, snapshotId: string, version: number): Promise<SnapshotLineageReport> {
    return (await this.reconcileSnapshots(tenantId, [{ snapshotId, version }]))[0]!;
  }

  /**
   * Reconciles many snapshot versions with one query per lineage hop (snapshot, publication event,
   * facts, observations, source references, artifacts) instead of one round trip per hop per
   * snapshot. Each snapshot's report is identical to reconciling it alone: the batch only changes how
   * the retained rows are fetched, and a hop is only queried for ids that a still-walking snapshot
   * actually needs.
   */
  async reconcileSnapshots(tenantId: string, targets: readonly LineageTarget[]): Promise<SnapshotLineageReport[]> {
    const walks: Walk[] = targets.map((target) => ({
      target,
      gaps: [],
      counts: { facts: 0, observations: 0, sourceReferences: 0, evidenceObjects: 0 },
      finished: false,
      factIds: [],
      observationIds: new Set<string>(),
      sourceReferenceIds: new Set<string>(),
      artifactIds: new Set<string>(),
    }));
    if (walks.length === 0) return [];

    // Stage 1: the snapshot versions themselves.
    const wanted = new Map<string, { snapshot_id: string; version: number }>();
    for (const { target } of walks) wanted.set(targetKey(target.snapshotId, target.version), { snapshot_id: target.snapshotId, version: target.version });
    const snapshotRows = await this.db.query(`select s.snapshot_id, s.fund_id, s.report_period, s.version, s.status, s.fact_ids, s.published_at
      from corvis_consolidated.fund_period_snapshot s
      join jsonb_to_recordset($2::jsonb) as wanted(snapshot_id uuid, version integer)
        on s.snapshot_id=wanted.snapshot_id and s.version=wanted.version
      where s.tenant_id=$1`, [tenantId, JSON.stringify([...wanted.values()])]);
    const snapshots = new Map(snapshotRows.map((row) => [targetKey(String(row.snapshot_id ?? ""), Number(row.version)), row]));

    // Stage 2: attributable publication events for versions after the first.
    const needEvents = new Map<string, { snapshot_id: string; version: number }>();
    for (const { target } of walks) {
      const key = targetKey(target.snapshotId, target.version);
      if (snapshots.has(key) && target.version > 1) needEvents.set(key, { snapshot_id: target.snapshotId, version: target.version });
    }
    const events = new Set<string>();
    if (needEvents.size > 0) {
      const eventRows = await this.db.query(`select e.snapshot_id, e.to_version, e.publication_event_id, e.actor_subject, e.created_at
        from corvis_consolidated.snapshot_publication_event e
        join jsonb_to_recordset($2::jsonb) as wanted(snapshot_id uuid, version integer)
          on e.snapshot_id=wanted.snapshot_id and e.to_version=wanted.version
        where e.tenant_id=$1 and e.action='publish'`, [tenantId, JSON.stringify([...needEvents.values()])]);
      for (const row of eventRows) events.add(targetKey(String(row.snapshot_id ?? ""), Number(row.to_version)));
    }

    for (const walk of walks) {
      const { snapshotId, version } = walk.target;
      const id = `${snapshotId}@${version}`;
      const snapshot = snapshots.get(targetKey(snapshotId, version));
      if (!snapshot) {
        walk.finished = true;
        walk.gaps.push({ kind: "snapshot_missing", entity: "fund_period_snapshot", id, detail: "retained state no longer contains this snapshot version" });
        continue;
      }
      if (String(snapshot.status ?? "") !== "published") {
        walk.gaps.push({
          kind: "snapshot_not_published",
          entity: "fund_period_snapshot",
          id,
          detail: `expected a published snapshot version, found ${String(snapshot.status ?? "unknown")}`,
        });
      }
      if (version > 1 && !events.has(targetKey(snapshotId, version))) {
        walk.gaps.push({
          kind: "publication_event_missing",
          entity: "snapshot_publication_event",
          id,
          detail: "published version has no attributable publication transition",
        });
      }
      walk.factIds = identifiers(snapshot.fact_ids);
      if (walk.factIds.length === 0) {
        walk.finished = true;
        walk.gaps.push({
          kind: "snapshot_without_facts",
          entity: "fund_period_snapshot",
          id,
          detail: "published snapshot references no consolidated facts",
        });
      }
    }

    // Stage 3: consolidated facts.
    const facts = await this.fetchRows(tenantId, walks.filter((walk) => !walk.finished).flatMap((walk) => walk.factIds), `select consolidated_fact_id, source_observation_ids
      from corvis_consolidated.consolidated_fact
      where tenant_id=$1 and consolidated_fact_id = ${uuidArrayPredicate}`, "consolidated_fact_id");
    for (const walk of walks) {
      if (walk.finished) continue;
      walk.counts.facts = new Set(walk.factIds.map(idKey).filter((factId) => facts.has(factId))).size;
      for (const factId of walk.factIds) {
        const fact = facts.get(idKey(factId));
        if (!fact) {
          walk.gaps.push({ kind: "fact_missing", entity: "consolidated_fact", id: factId, detail: "snapshot fact is no longer retained" });
          continue;
        }
        const sources = identifiers(fact.source_observation_ids);
        if (sources.length === 0) {
          walk.gaps.push({ kind: "fact_without_observations", entity: "consolidated_fact", id: factId, detail: "consolidated fact records no source observations" });
          continue;
        }
        for (const observationId of sources) walk.observationIds.add(observationId);
      }
      if (walk.observationIds.size === 0) walk.finished = true;
    }

    // Stage 4: canonical observations.
    const observations = await this.fetchRows(tenantId, walks.filter((walk) => !walk.finished).flatMap((walk) => [...walk.observationIds]), `select observation_id, review_state, source_reference_id
      from corvis_facts.observation
      where tenant_id=$1 and observation_id = ${uuidArrayPredicate}`, "observation_id");
    for (const walk of walks) {
      if (walk.finished) continue;
      walk.counts.observations = [...walk.observationIds].filter((observationId) => observations.has(idKey(observationId))).length;
      for (const observationId of walk.observationIds) {
        const observation = observations.get(idKey(observationId));
        if (!observation) {
          walk.gaps.push({ kind: "observation_missing", entity: "observation", id: observationId, detail: "canonical observation behind a published fact is no longer retained" });
          continue;
        }
        if (String(observation.review_state ?? "") !== "approved") {
          walk.gaps.push({
            kind: "observation_not_approved",
            entity: "observation",
            id: observationId,
            detail: `published fact depends on a ${String(observation.review_state ?? "unknown")} observation`,
          });
        }
        const sourceReferenceId = String(observation.source_reference_id ?? "");
        if (!sourceReferenceId) {
          walk.gaps.push({ kind: "source_reference_missing", entity: "observation", id: observationId, detail: "observation carries no source reference" });
          continue;
        }
        walk.sourceReferenceIds.add(sourceReferenceId);
      }
      if (walk.sourceReferenceIds.size === 0) walk.finished = true;
    }

    // Stage 5: source references.
    const references = await this.fetchRows(tenantId, walks.filter((walk) => !walk.finished).flatMap((walk) => [...walk.sourceReferenceIds]), `select source_reference_id, document_artifact_version_id
      from corvis_source.source_reference
      where tenant_id=$1 and source_reference_id = ${uuidArrayPredicate}`, "source_reference_id");
    for (const walk of walks) {
      if (walk.finished) continue;
      walk.counts.sourceReferences = [...walk.sourceReferenceIds].filter((referenceId) => references.has(idKey(referenceId))).length;
      for (const sourceReferenceId of walk.sourceReferenceIds) {
        const reference = references.get(idKey(sourceReferenceId));
        if (!reference) {
          walk.gaps.push({ kind: "source_reference_missing", entity: "source_reference", id: sourceReferenceId, detail: "lineage hop to source evidence is no longer retained" });
          continue;
        }
        const artifactId = String(reference.document_artifact_version_id ?? "");
        if (!artifactId) {
          walk.gaps.push({ kind: "evidence_missing", entity: "source_reference", id: sourceReferenceId, detail: "source reference points at no artifact version" });
          continue;
        }
        walk.artifactIds.add(artifactId);
      }
      if (walk.artifactIds.size === 0) walk.finished = true;
    }

    // Stage 6: retained artifact evidence.
    const artifacts = await this.fetchRows(tenantId, walks.filter((walk) => !walk.finished).flatMap((walk) => [...walk.artifactIds]), `select document_artifact_version_id, object_uri, sha256
      from corvis_source.document_artifact_version
      where tenant_id=$1 and document_artifact_version_id = ${uuidArrayPredicate}`, "document_artifact_version_id");
    for (const walk of walks) {
      if (walk.finished) continue;
      for (const artifactId of walk.artifactIds) {
        const artifact = artifacts.get(idKey(artifactId));
        if (!artifact) {
          walk.gaps.push({ kind: "evidence_missing", entity: "document_artifact_version", id: artifactId, detail: "retained source evidence row is missing" });
          continue;
        }
        if (!String(artifact.object_uri ?? "")) {
          walk.gaps.push({ kind: "evidence_missing", entity: "document_artifact_version", id: artifactId, detail: "artifact version has no object reference" });
          continue;
        }
        if (!String(artifact.sha256 ?? "")) {
          walk.gaps.push({ kind: "evidence_missing", entity: "document_artifact_version", id: artifactId, detail: "artifact version has no content hash to verify replay against" });
          continue;
        }
        walk.counts.evidenceObjects += 1;
      }
    }

    return walks.map((walk) => report(tenantId, walk.target.snapshotId, walk.target.version, walk.counts, walk.gaps));
  }

  /** One query for the union of `ids` (skipped when empty); rows are keyed by their lower-cased id column. */
  private async fetchRows(tenantId: string, ids: readonly string[], sql: string, idColumn: string): Promise<Map<string, PostgresRow>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.query(sql, [tenantId, JSON.stringify(unique)]);
    return new Map(rows.map((row) => [idKey(row[idColumn]), row]));
  }

  async reconcilePublishedSnapshots(tenantId: string, limit = 50): Promise<TenantLineageReport> {
    const rows = await this.db.query(`select snapshot_id, version from corvis_serving.fund_period_snapshots
      where tenant_id=$1 and status='published' order by published_at desc limit $2`, [tenantId, limit]);
    const snapshots = await this.reconcileSnapshots(tenantId, rows.map((row) => ({ snapshotId: String(row.snapshot_id ?? ""), version: Number(row.version ?? 0) })));
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
