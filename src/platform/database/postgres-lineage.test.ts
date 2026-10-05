import assert from "node:assert/strict";
import test from "node:test";
import { PostgresLineageRepository } from "./postgres-lineage.ts";
import type { PostgresRow } from "./postgres.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SNAPSHOT_ID = "00000000-0000-0000-0000-0000000000d1";
const FACT_ID = "00000000-0000-0000-0000-0000000000e1";
const OBSERVATION_ID = "00000000-0000-0000-0000-0000000000f1";
const REFERENCE_ID = "00000000-0000-0000-0000-000000000011";
const ARTIFACT_ID = "00000000-0000-0000-0000-000000000012";

type Fixture = {
  snapshot?: PostgresRow;
  publicationEvent?: PostgresRow;
  fact?: PostgresRow;
  observation?: PostgresRow;
  sourceReference?: PostgresRow;
  artifact?: PostgresRow;
  publishedSnapshots?: PostgresRow[];
};

type Wanted = Array<{ snapshot_id: string; version: number }>;

class FakeDb {
  private readonly fixture: Fixture;
  readonly queries: string[] = [];
  constructor(fixture: Fixture) { this.fixture = fixture; }

  async query(sql: string, parameters: unknown[] = []): Promise<PostgresRow[]> {
    this.queries.push(sql);
    // The batched hops receive a JSON array of wanted (snapshot_id, version) pairs.
    const wanted = (): Wanted => JSON.parse(String(parameters[1])) as Wanted;
    if (sql.includes("from corvis_consolidated.fund_period_snapshot")) {
      return this.fixture.snapshot ? wanted().map((pair) => ({ ...this.fixture.snapshot, snapshot_id: pair.snapshot_id, version: pair.version })) : [];
    }
    if (sql.includes("from corvis_consolidated.snapshot_publication_event")) {
      return this.fixture.publicationEvent ? wanted().map((pair) => ({ ...this.fixture.publicationEvent, snapshot_id: pair.snapshot_id, to_version: pair.version })) : [];
    }
    if (sql.includes("from corvis_consolidated.consolidated_fact")) return this.fixture.fact ? [this.fixture.fact] : [];
    if (sql.includes("from corvis_facts.observation")) return this.fixture.observation ? [this.fixture.observation] : [];
    if (sql.includes("from corvis_source.source_reference")) return this.fixture.sourceReference ? [this.fixture.sourceReference] : [];
    if (sql.includes("from corvis_source.document_artifact_version")) return this.fixture.artifact ? [this.fixture.artifact] : [];
    if (sql.includes("from corvis_serving.fund_period_snapshots")) return this.fixture.publishedSnapshots ?? [];
    return [];
  }
}

function completeFixture(overrides: Fixture = {}): Fixture {
  return {
    snapshot: { snapshot_id: SNAPSHOT_ID, version: 1, status: "published", fact_ids: [FACT_ID], published_at: new Date() },
    fact: { consolidated_fact_id: FACT_ID, source_observation_ids: [OBSERVATION_ID] },
    observation: { observation_id: OBSERVATION_ID, review_state: "approved", source_reference_id: REFERENCE_ID },
    sourceReference: { source_reference_id: REFERENCE_ID, document_artifact_version_id: ARTIFACT_ID },
    artifact: { document_artifact_version_id: ARTIFACT_ID, object_uri: "gs://bucket/object", sha256: "a".repeat(64) },
    ...overrides,
  };
}

test("a fully retained snapshot with version 1 is reproducible with no publication-event requirement", async () => {
  const repo = new PostgresLineageRepository(new FakeDb(completeFixture()));
  const report = await repo.reconcileSnapshot(TENANT, SNAPSHOT_ID, 1);
  assert.equal(report.status, "reproducible");
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.counts, { facts: 1, observations: 1, sourceReferences: 1, evidenceObjects: 1 });
});

test("a missing snapshot reports snapshot_missing and nothing else", async () => {
  const repo = new PostgresLineageRepository(new FakeDb({}));
  const report = await repo.reconcileSnapshot(TENANT, SNAPSHOT_ID, 1);
  assert.equal(report.status, "gap");
  assert.deepEqual(report.gaps.map((gap) => gap.kind), ["snapshot_missing"]);
});

test("a non-published snapshot is flagged but reconciliation still walks the rest of the lineage", async () => {
  const repo = new PostgresLineageRepository(new FakeDb(completeFixture({ snapshot: { snapshot_id: SNAPSHOT_ID, version: 1, status: "draft", fact_ids: [FACT_ID] } })));
  const report = await repo.reconcileSnapshot(TENANT, SNAPSHOT_ID, 1);
  assert.ok(report.gaps.some((gap) => gap.kind === "snapshot_not_published"));
  assert.equal(report.counts.facts, 1, "the rest of the lineage is still walked and counted");
});

test("version 2 or later requires an attributable publish event", async () => {
  const repo = new PostgresLineageRepository(new FakeDb(completeFixture()));
  const report = await repo.reconcileSnapshot(TENANT, SNAPSHOT_ID, 2);
  assert.ok(report.gaps.some((gap) => gap.kind === "publication_event_missing"));
});

test("version 2 with a recorded publish event carries no publication gap", async () => {
  const repo = new PostgresLineageRepository(new FakeDb(completeFixture({ publicationEvent: { publication_event_id: "x", actor_subject: "ops", created_at: new Date() } })));
  const report = await repo.reconcileSnapshot(TENANT, SNAPSHOT_ID, 2);
  assert.equal(report.gaps.some((gap) => gap.kind === "publication_event_missing"), false);
});

test("a snapshot referencing no consolidated facts is a gap, not silently reproducible", async () => {
  const repo = new PostgresLineageRepository(new FakeDb({ snapshot: { snapshot_id: SNAPSHOT_ID, version: 1, status: "published", fact_ids: [] } }));
  const report = await repo.reconcileSnapshot(TENANT, SNAPSHOT_ID, 1);
  assert.deepEqual(report.gaps.map((gap) => gap.kind), ["snapshot_without_facts"]);
});

test("a fact that no longer exists is reported without throwing", async () => {
  const repo = new PostgresLineageRepository(new FakeDb(completeFixture({ fact: undefined })));
  const report = await repo.reconcileSnapshot(TENANT, SNAPSHOT_ID, 1);
  assert.ok(report.gaps.some((gap) => gap.kind === "fact_missing"));
  assert.equal(report.status, "gap");
});

test("an observation behind a fact that is not approved is reported, not silently accepted", async () => {
  const repo = new PostgresLineageRepository(new FakeDb(completeFixture({ observation: { observation_id: OBSERVATION_ID, review_state: "review_required", source_reference_id: REFERENCE_ID } })));
  const report = await repo.reconcileSnapshot(TENANT, SNAPSHOT_ID, 1);
  assert.ok(report.gaps.some((gap) => gap.kind === "observation_not_approved"));
});

test("a source reference or evidence object that no longer exists breaks the lineage explicitly", async () => {
  const repo = new PostgresLineageRepository(new FakeDb(completeFixture({ sourceReference: undefined })));
  const report = await repo.reconcileSnapshot(TENANT, SNAPSHOT_ID, 1);
  assert.ok(report.gaps.some((gap) => gap.kind === "source_reference_missing"));
});

test("evidence missing a content hash cannot be verified on replay and is reported", async () => {
  const repo = new PostgresLineageRepository(new FakeDb(completeFixture({ artifact: { document_artifact_version_id: ARTIFACT_ID, object_uri: "gs://bucket/object", sha256: null } })));
  const report = await repo.reconcileSnapshot(TENANT, SNAPSHOT_ID, 1);
  assert.ok(report.gaps.some((gap) => gap.kind === "evidence_missing"));
  assert.equal(report.counts.evidenceObjects, 0);
});

test("reconcilePublishedSnapshots checks every published snapshot the serving view lists and aggregates the result", async () => {
  const db = new FakeDb({
    ...completeFixture(),
    publishedSnapshots: [{ snapshot_id: SNAPSHOT_ID, version: 1 }, { snapshot_id: SNAPSHOT_ID, version: 2 }],
  });
  const repo = new PostgresLineageRepository(db);
  const report = await repo.reconcilePublishedSnapshots(TENANT);
  assert.equal(report.snapshotsChecked, 2);
  // Version 2 has no recorded publish event in this fixture, so it is a gap
  // while version 1 is fully reproducible.
  assert.equal(report.status, "gap");
  assert.equal(report.reproducibleCount, 1);
  assert.equal(report.gapCount, 1);
});

// ---------------------------------------------------------------------------------------------
// Batching: reconcilePublishedSnapshots used to issue up to five sequential queries per snapshot
// (up to 50 snapshots). It now issues one query per lineage hop for the whole batch.
// ---------------------------------------------------------------------------------------------

/** N independent, fully retained snapshot chains whose ids are derived from their index. */
class ChainDb {
  readonly queries: string[] = [];
  private readonly count: number;
  private readonly broken: ReadonlySet<number>;
  constructor(count: number, broken: readonly number[] = []) { this.count = count; this.broken = new Set(broken); }

  static id(kind: number, index: number): string { return `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(index).padStart(12, "0")}`; }

  async query(sql: string, parameters: unknown[] = []): Promise<PostgresRow[]> {
    this.queries.push(sql);
    const ids = (): string[] => JSON.parse(String(parameters[1])) as string[];
    const indexOf = (id: string): number => Number(id.slice(-12));
    if (sql.includes("from corvis_serving.fund_period_snapshots")) {
      return Array.from({ length: this.count }, (_, index) => ({ snapshot_id: ChainDb.id(1, index), version: 1 }));
    }
    if (sql.includes("from corvis_consolidated.fund_period_snapshot")) {
      return (JSON.parse(String(parameters[1])) as Wanted).map((pair) => ({
        snapshot_id: pair.snapshot_id, version: pair.version, status: "published", fact_ids: [ChainDb.id(2, indexOf(pair.snapshot_id))],
      }));
    }
    if (sql.includes("from corvis_consolidated.consolidated_fact")) {
      return ids().map((id) => ({ consolidated_fact_id: id, source_observation_ids: [ChainDb.id(3, indexOf(id))] }));
    }
    if (sql.includes("from corvis_facts.observation")) {
      return ids().map((id) => ({ observation_id: id, review_state: this.broken.has(indexOf(id)) ? "review_required" : "approved", source_reference_id: ChainDb.id(4, indexOf(id)) }));
    }
    if (sql.includes("from corvis_source.source_reference")) {
      return ids().map((id) => ({ source_reference_id: id, document_artifact_version_id: ChainDb.id(5, indexOf(id)) }));
    }
    if (sql.includes("from corvis_source.document_artifact_version")) {
      return ids().map((id) => ({ document_artifact_version_id: id, object_uri: "gs://bucket/object", sha256: "b".repeat(64) }));
    }
    return [];
  }
}

test("reconcilePublishedSnapshots uses one query per lineage hop no matter how many snapshots it checks", async () => {
  const small = new ChainDb(1);
  await new PostgresLineageRepository(small).reconcilePublishedSnapshots(TENANT);
  const large = new ChainDb(50);
  const report = await new PostgresLineageRepository(large).reconcilePublishedSnapshots(TENANT, 50);

  assert.equal(report.snapshotsChecked, 50);
  assert.equal(report.status, "reconciled");
  assert.equal(large.queries.length, small.queries.length, "query count must not grow with the number of snapshots");
  assert.ok(large.queries.length <= 6, `expected list + snapshot/fact/observation/reference/artifact hops, ran ${large.queries.length} queries`);
});

test("a batched reconciliation reports each snapshot exactly as reconciling it alone would", async () => {
  const batchDb = new ChainDb(6, [2, 4]);
  const batch = await new PostgresLineageRepository(batchDb).reconcilePublishedSnapshots(TENANT, 50);
  assert.equal(batch.gapCount, 2);
  assert.deepEqual(batch.snapshots.map((snapshot) => snapshot.status), ["reproducible", "reproducible", "gap", "reproducible", "gap", "reproducible"]);

  for (let index = 0; index < 6; index += 1) {
    const alone = await new PostgresLineageRepository(new ChainDb(6, [2, 4])).reconcileSnapshot(TENANT, ChainDb.id(1, index), 1);
    assert.deepEqual(batch.snapshots[index], alone, `snapshot ${index} must be identical batched and alone`);
  }
  // Counts stay per snapshot, not per batch.
  assert.deepEqual(batch.snapshots[0]!.counts, { facts: 1, observations: 1, sourceReferences: 1, evidenceObjects: 1 });
});

test("later hops are only queried for snapshots that are still being walked", async () => {
  const db = new FakeDb({ snapshot: { snapshot_id: SNAPSHOT_ID, version: 1, status: "published", fact_ids: [] } });
  await new PostgresLineageRepository(db).reconcileSnapshot(TENANT, SNAPSHOT_ID, 1);
  assert.equal(db.queries.length, 1, "a snapshot without facts needs no further hop");

  const missing = new FakeDb({});
  await new PostgresLineageRepository(missing).reconcileSnapshot(TENANT, SNAPSHOT_ID, 3);
  assert.equal(missing.queries.length, 1, "a missing snapshot needs no publication-event lookup either");
});

test("snapshot ids are matched case-insensitively and an empty batch runs no query", async () => {
  const db = new FakeDb(completeFixture());
  const [reportForUpper] = await new PostgresLineageRepository(db).reconcileSnapshots(TENANT, [{ snapshotId: SNAPSHOT_ID.toUpperCase(), version: 1 }]);
  assert.equal(reportForUpper!.status, "reproducible");

  const empty = new FakeDb({});
  assert.deepEqual(await new PostgresLineageRepository(empty).reconcileSnapshots(TENANT, []), []);
  assert.equal(empty.queries.length, 0);
});
