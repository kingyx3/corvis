import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import {
  createProductionProcessingStageEffectRouter,
  createRegisteredArtifactStageHandler,
  type RegisteredArtifactRecord,
  type RegisteredArtifactRepository,
} from "./processing-registered-stage.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";

const base: ProcessingStageEffectInput = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  documentId: "22222222-2222-4222-8222-222222222222",
  jobId: "registered:22222222-2222-4222-8222-222222222222",
  stage: "registered",
  payload: {
    artifactVersionId: "33333333-3333-4333-8333-333333333333",
    ingestionId: "ingestion-a",
  },
  idempotencyKey: "effect-key-a",
  attempt: 1,
};

const releasedArtifact: RegisteredArtifactRecord = {
  artifactVersionId: "33333333-3333-4333-8333-333333333333",
  ingestionId: "ingestion-a",
  objectUri: "gs://corvis-source/document-a/report.pdf",
  storageGeneration: "1740000000000000",
  sha256: "a".repeat(64),
  sizeBytes: 4096,
  malwareScanStatus: "clean",
  quarantineStatus: "released",
};

class FakePostgres implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  readonly executions: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  rows: PostgresRow[] = [{
    document_artifact_version_id: releasedArtifact.artifactVersionId,
    ingestion_id: releasedArtifact.ingestionId,
    object_uri: releasedArtifact.objectUri,
    storage_generation: releasedArtifact.storageGeneration,
    sha256: releasedArtifact.sha256,
    size_bytes: releasedArtifact.sizeBytes,
    malware_scan_status: releasedArtifact.malwareScanStatus,
    quarantine_status: releasedArtifact.quarantineStatus,
  }];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    return this.rows;
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.executions.push({ sql, parameters });
  }

  async health(): Promise<boolean> {
    return true;
  }
}

class FakeRepository implements RegisteredArtifactRepository {
  calls = 0;
  artifact: RegisteredArtifactRecord | undefined = releasedArtifact;

  async findReleasedArtifact(): Promise<RegisteredArtifactRecord | undefined> {
    this.calls += 1;
    return this.artifact;
  }
}

test("production router validates the authoritative registered artifact and returns stable lineage", async () => {
  const db = new FakePostgres();
  const router = createProductionProcessingStageEffectRouter(db);

  const first = await router.execute(base);
  const second = await router.execute(base);

  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    artifactVersionId: releasedArtifact.artifactVersionId,
    ingestionId: releasedArtifact.ingestionId,
    storageGeneration: releasedArtifact.storageGeneration,
    sha256: releasedArtifact.sha256,
    sizeBytes: releasedArtifact.sizeBytes,
  });
  assert.equal(db.queries.length, 2);
  assert.equal(db.executions.length, 0);
  assert.deepEqual(db.queries[0]?.parameters, [
    base.tenantId,
    base.documentId,
    releasedArtifact.artifactVersionId,
    releasedArtifact.ingestionId,
  ]);
  assert.match(db.queries[0]?.sql ?? "", /tenant_id=\$1::uuid/);
  assert.match(db.queries[0]?.sql ?? "", /document_id=\$2::uuid/);
  assert.match(db.queries[0]?.sql ?? "", /document_artifact_version_id=\$3::uuid/);
  assert.match(db.queries[0]?.sql ?? "", /ingestion_id=\$4/);
});

test("registered handler fails before persistence when durable event identity is incomplete", async () => {
  const repository = new FakeRepository();
  const handler = createRegisteredArtifactStageHandler(repository);

  await assert.rejects(
    handler({ ...base, payload: { ingestionId: "ingestion-a" } }, new AbortController().signal),
    /requires artifactVersionId/,
  );
  assert.equal(repository.calls, 0);
});

test("registered handler fails closed when the exact artifact cannot be resolved", async () => {
  const repository = new FakeRepository();
  repository.artifact = undefined;
  const handler = createRegisteredArtifactStageHandler(repository);

  await assert.rejects(handler(base, new AbortController().signal), /artifact was not found/);
});

test("registered handler requires clean released immutable GCS evidence", async (t) => {
  const cases: Array<{ name: string; artifact: RegisteredArtifactRecord; error: RegExp }> = [
    {
      name: "malware scan",
      artifact: { ...releasedArtifact, malwareScanStatus: "pending" },
      error: /not clean and released/,
    },
    {
      name: "quarantine release",
      artifact: { ...releasedArtifact, quarantineStatus: "quarantined" },
      error: /not clean and released/,
    },
    {
      name: "GCS authority",
      artifact: { ...releasedArtifact, objectUri: "https://example.invalid/report.pdf" },
      error: /authoritative GCS evidence/,
    },
    {
      name: "storage generation",
      artifact: { ...releasedArtifact, storageGeneration: "" },
      error: /immutable GCS generation/,
    },
    {
      name: "content hash",
      artifact: { ...releasedArtifact, sha256: "" },
      error: /SHA-256 lineage/,
    },
    {
      name: "artifact size",
      artifact: { ...releasedArtifact, sizeBytes: -1 },
      error: /invalid size/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const repository = new FakeRepository();
      repository.artifact = item.artifact;
      const handler = createRegisteredArtifactStageHandler(repository);
      await assert.rejects(handler(base, new AbortController().signal), item.error);
    });
  }
});

test("production router leaves unimplemented business stages fail closed", async () => {
  const router = createProductionProcessingStageEffectRouter(new FakePostgres());
  await assert.rejects(
    router.execute({ ...base, stage: "extracted" }),
    /extracted has no configured effect handler/,
  );
});

test("registered handler honors an already-aborted stage execution", async () => {
  const repository = new FakeRepository();
  const handler = createRegisteredArtifactStageHandler(repository);
  const controller = new AbortController();
  controller.abort(new Error("worker timeout"));

  await assert.rejects(handler(base, controller.signal), /worker timeout/);
  assert.equal(repository.calls, 0);
});
