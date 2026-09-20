import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import {
  configuredRepresentationProducerConfig,
  createRepresentedDocumentStageHandler,
  GcpRepresentationObjectVerifier,
  HttpDocumentRepresentationProducer,
  PostgresDocumentRepresentationRepository,
  representationIdentity,
  type DocumentRepresentationProducer,
  type DocumentRepresentationRecord,
  type DocumentRepresentationRepository,
  type ProducedRepresentation,
  type RepresentedSourceRecord,
  type RepresentationObjectVerifier,
} from "./processing-represented-stage.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const artifactVersionId = "33333333-3333-4333-8333-333333333333";
const sourceSha256 = "a".repeat(64);
const representationSha256 = "b".repeat(64);
const outputBucket = "corvis-test-documents";

const base: ProcessingStageEffectInput = {
  tenantId,
  documentId,
  jobId: `represented:${documentId}`,
  stage: "represented",
  payload: {
    jobId: `represented:${documentId}`,
    predecessorJobId: `registered:${documentId}`,
    predecessorResult: {
      artifactVersionId,
      ingestionId: "ingestion-a",
      storageGeneration: "1740000000000000",
      sha256: sourceSha256,
      sizeBytes: 4096,
    },
  },
  idempotencyKey: "effect-key-represented",
  attempt: 1,
};

const source: RepresentedSourceRecord = {
  artifactVersionId,
  ingestionId: "ingestion-a",
  objectUri: "gs://corvis-test-documents/uploads/source/report.pdf",
  storageGeneration: "1740000000000000",
  sha256: sourceSha256,
  sizeBytes: 4096,
  mediaType: "application/pdf",
  malwareScanStatus: "clean",
  quarantineStatus: "released",
};

function producedFor(uri: string): ProducedRepresentation {
  return {
    representationType: "document_interpretation_v1",
    objectUri: uri,
    storageGeneration: "1740000000000999",
    contentSha256: representationSha256,
    sizeBytes: 8192,
    producer: "corvis-representation-worker",
    producerVersion: "2026-09-20.1",
    method: "hybrid",
  };
}

class FakeRepository implements DocumentRepresentationRepository {
  source: RepresentedSourceRecord | undefined = { ...source };
  readonly saved = new Map<string, DocumentRepresentationRecord>();
  findCalls = 0;
  saveCalls = 0;

  async findSource(): Promise<RepresentedSourceRecord | undefined> {
    this.findCalls += 1;
    return this.source;
  }

  async saveReady(input: { representation: DocumentRepresentationRecord }): Promise<DocumentRepresentationRecord> {
    this.saveCalls += 1;
    const existing = this.saved.get(input.representation.representationId);
    if (existing) return existing;
    this.saved.set(input.representation.representationId, { ...input.representation });
    return input.representation;
  }
}

class FakeProducer implements DocumentRepresentationProducer {
  readonly calls: Array<Parameters<DocumentRepresentationProducer["produce"]>[0]> = [];
  override?: ProducedRepresentation;

  async produce(input: Parameters<DocumentRepresentationProducer["produce"]>[0]): Promise<ProducedRepresentation> {
    this.calls.push(input);
    return this.override ?? producedFor(input.outputObjectUri);
  }
}

class FakeVerifier implements RepresentationObjectVerifier {
  readonly calls: Array<Parameters<RepresentationObjectVerifier["verify"]>[0]> = [];
  error?: Error;

  async verify(input: Parameters<RepresentationObjectVerifier["verify"]>[0]): Promise<void> {
    this.calls.push(input);
    if (this.error) throw this.error;
  }
}

function handler(overrides: {
  repository?: FakeRepository;
  producer?: FakeProducer;
  verifier?: FakeVerifier;
} = {}) {
  const repository = overrides.repository ?? new FakeRepository();
  const producer = overrides.producer ?? new FakeProducer();
  const verifier = overrides.verifier ?? new FakeVerifier();
  return {
    repository,
    producer,
    verifier,
    execute: createRepresentedDocumentStageHandler({ repository, producer, verifier, outputBucket }),
  };
}

test("representation identity is deterministic for the exact source artifact and contract", () => {
  const first = representationIdentity({ tenantId, documentId, artifactVersionId, outputBucket });
  const second = representationIdentity({ tenantId, documentId, artifactVersionId, outputBucket });
  assert.deepEqual(first, second);
  assert.match(first.representationId, /^[0-9a-f-]{36}$/);
  assert.equal(
    first.objectUri,
    `gs://${outputBucket}/representations/${tenantId}/${documentId}/${artifactVersionId}/${first.representationId}.json`,
  );
});

test("represented stage persists verified GCS lineage and redelivery reuses one logical representation", async () => {
  const fixture = handler();
  const signal = new AbortController().signal;

  const first = await fixture.execute(base, signal);
  const second = await fixture.execute({ ...base, attempt: 2 }, signal);

  assert.deepEqual(first, second);
  assert.equal(fixture.repository.saved.size, 1);
  assert.equal(fixture.repository.saveCalls, 2);
  assert.equal(fixture.producer.calls.length, 2, "crash/redelivery may re-invoke a retry-safe provider");
  assert.equal(fixture.producer.calls[0]?.idempotencyKey, base.idempotencyKey);
  assert.equal(fixture.producer.calls[1]?.idempotencyKey, base.idempotencyKey);
  assert.equal(fixture.producer.calls[0]?.outputObjectUri, fixture.producer.calls[1]?.outputObjectUri);
  assert.equal(fixture.verifier.calls.length, 2);
  assert.deepEqual(first, {
    representationId: fixture.producer.calls[0]?.representationId,
    artifactVersionId,
    representationType: "document_interpretation_v1",
    storageGeneration: "1740000000000999",
    contentSha256: representationSha256,
    sizeBytes: 8192,
    producer: "corvis-representation-worker",
    producerVersion: "2026-09-20.1",
    method: "hybrid",
  });
});

test("represented stage fails before provider work when predecessor lineage is absent or changed", async (t) => {
  await t.test("missing predecessor result", async () => {
    const fixture = handler();
    await assert.rejects(
      fixture.execute({ ...base, payload: {} }, new AbortController().signal),
      /requires predecessorResult/,
    );
    assert.equal(fixture.producer.calls.length, 0);
  });

  await t.test("changed artifact lineage", async () => {
    const repository = new FakeRepository();
    repository.source = { ...source, storageGeneration: "different" };
    const fixture = handler({ repository });
    await assert.rejects(
      fixture.execute(base, new AbortController().signal),
      /lineage no longer matches/,
    );
    assert.equal(fixture.producer.calls.length, 0);
    assert.equal(repository.saved.size, 0);
  });
});

test("represented stage rejects provider output outside deterministic GCS identity", async () => {
  const producer = new FakeProducer();
  producer.override = producedFor("gs://corvis-test-documents/representations/wrong.json");
  const fixture = handler({ producer });
  await assert.rejects(
    fixture.execute(base, new AbortController().signal),
    /outside the deterministic object identity/,
  );
  assert.equal(fixture.verifier.calls.length, 0);
  assert.equal(fixture.repository.saved.size, 0);
});

test("represented stage does not persist metadata when immutable GCS verification fails", async () => {
  const verifier = new FakeVerifier();
  verifier.error = new Error("representation GCS source hash mismatch");
  const fixture = handler({ verifier });
  await assert.rejects(
    fixture.execute(base, new AbortController().signal),
    /source hash mismatch/,
  );
  assert.equal(fixture.repository.saved.size, 0);
});

test("represented stage honors stage cancellation before provider work", async () => {
  const fixture = handler();
  const controller = new AbortController();
  controller.abort(new Error("worker timeout"));
  await assert.rejects(fixture.execute(base, controller.signal), /worker timeout/);
  assert.equal(fixture.repository.findCalls, 0);
  assert.equal(fixture.producer.calls.length, 0);
});

test("representation provider configuration is optional and bounded", () => {
  assert.equal(configuredRepresentationProducerConfig({}), undefined);
  assert.deepEqual(configuredRepresentationProducerConfig({
    CORVIS_REPRESENTATION_ENDPOINT: "https://representation.example/",
    CORVIS_OBJECT_STORE_BUCKET: outputBucket,
    CORVIS_REPRESENTATION_TIMEOUT_MS: "999999",
  }), {
    endpoint: "https://representation.example/",
    audience: "https://representation.example/",
    outputBucket,
    timeoutMs: 25_000,
  });
  assert.throws(() => configuredRepresentationProducerConfig({
    CORVIS_REPRESENTATION_ENDPOINT: "https://representation.example",
  }), /CORVIS_OBJECT_STORE_BUCKET/);
});

test("HTTP producer uses keyless GCP identity and passes deterministic provider idempotency", async () => {
  const identity = representationIdentity({ tenantId, documentId, artifactVersionId, outputBucket });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("http://metadata.google.internal/")) return new Response("oidc-token", { status: 200 });
    return new Response(JSON.stringify(producedFor(identity.objectUri)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const producer = new HttpDocumentRepresentationProducer({
    endpoint: "https://representation.example",
    audience: "https://representation.example",
    timeoutMs: 5_000,
  }, fakeFetch);
  const result = await producer.produce({
    tenantId,
    documentId,
    artifactVersionId,
    sourceObjectUri: source.objectUri,
    sourceStorageGeneration: source.storageGeneration,
    sourceSha256: source.sha256,
    sourceMediaType: source.mediaType,
    representationId: identity.representationId,
    representationType: "document_interpretation_v1",
    outputObjectUri: identity.objectUri,
    idempotencyKey: base.idempotencyKey,
    signal: new AbortController().signal,
  });
  assert.equal(result.objectUri, identity.objectUri);
  assert.equal(calls.length, 2);
  const provider = calls[1];
  assert.equal(new Headers(provider?.init.headers).get("authorization"), "Bearer oidc-token");
  assert.equal(new Headers(provider?.init.headers).get("x-corvis-idempotency-key"), base.idempotencyKey);
  const body = JSON.parse(String(provider?.init.body)) as Record<string, unknown>;
  assert.equal(body.representationId, identity.representationId);
  assert.deepEqual(body.output, { objectUri: identity.objectUri, contentType: "application/json" });
});

test("GCS verifier requires exact generation, hashes and source identity metadata", async () => {
  const identity = representationIdentity({ tenantId, documentId, artifactVersionId, outputBucket });
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    assert.match(String(input), /storage\.googleapis\.com\/storage\/v1\/b\/corvis-test-documents\/o\//);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer local-token");
    return new Response(JSON.stringify({
      generation: "1740000000000999",
      size: "8192",
      metadata: {
        "corvis-content-sha256": representationSha256,
        "corvis-representation-id": identity.representationId,
        "corvis-representation-type": "document_interpretation_v1",
        "corvis-source-artifact-version-id": artifactVersionId,
        "corvis-source-generation": source.storageGeneration,
        "corvis-source-sha256": source.sha256,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const verifier = new GcpRepresentationObjectVerifier(outputBucket, { fetchImpl: fakeFetch, accessToken: "local-token" });
  await verifier.verify({
    objectUri: identity.objectUri,
    storageGeneration: "1740000000000999",
    sizeBytes: 8192,
    contentSha256: representationSha256,
    representationId: identity.representationId,
    representationType: "document_interpretation_v1",
    artifactVersionId,
    sourceStorageGeneration: source.storageGeneration,
    sourceSha256: source.sha256,
    signal: new AbortController().signal,
  });
});

class FakePostgres implements PostgresSqlApi {
  readonly calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  rows: PostgresRow[] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return this.rows;
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("Postgres representation repository scopes source reads to tenant, document and artifact", async () => {
  const db = new FakePostgres();
  db.rows = [{
    document_artifact_version_id: artifactVersionId,
    ingestion_id: source.ingestionId,
    object_uri: source.objectUri,
    storage_generation: source.storageGeneration,
    sha256: source.sha256,
    size_bytes: source.sizeBytes,
    media_type: source.mediaType,
    malware_scan_status: "clean",
    quarantine_status: "released",
  }];
  const repository = new PostgresDocumentRepresentationRepository(db);
  const result = await repository.findSource({ tenantId, documentId, artifactVersionId });
  assert.equal(result?.artifactVersionId, artifactVersionId);
  assert.deepEqual(db.calls[0]?.parameters, [tenantId, documentId, artifactVersionId]);
  assert.match(db.calls[0]?.sql ?? "", /a\.tenant_id=\$1::uuid/);
  assert.match(db.calls[0]?.sql ?? "", /a\.document_id=\$2::uuid/);
  assert.match(db.calls[0]?.sql ?? "", /a\.document_artifact_version_id=\$3::uuid/);
});

test("migration makes representation metadata forced-RLS and carries committed predecessor results", async () => {
  const sql = (await readFile("db/postgres/migrations/023_document_representations.sql", "utf8")).toLowerCase();
  assert.match(sql, /create table if not exists corvis_source\.document_representation/);
  assert.match(sql, /primary key \(tenant_id, representation_id\)/);
  assert.match(sql, /unique \(tenant_id, document_artifact_version_id, representation_type\)/);
  assert.match(sql, /alter table corvis_source\.document_representation enable row level security/);
  assert.match(sql, /alter table corvis_source\.document_representation force row level security/);
  assert.equal(/create policy[^;]+document_representation/.test(sql), false);
  assert.match(sql, /new\.event_type = 'processingstageready'/);
  assert.match(sql, /e\.state = 'complete'/);
  assert.match(sql, /\{predecessorresult\}/);
});
