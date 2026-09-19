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

class FakeDb {
  private readonly fixture: Fixture;
  constructor(fixture: Fixture) { this.fixture = fixture; }

  async query(sql: string): Promise<PostgresRow[]> {
    if (sql.includes("from corvis_consolidated.fund_period_snapshot")) return this.fixture.snapshot ? [this.fixture.snapshot] : [];
    if (sql.includes("from corvis_consolidated.snapshot_publication_event")) return this.fixture.publicationEvent ? [this.fixture.publicationEvent] : [];
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
