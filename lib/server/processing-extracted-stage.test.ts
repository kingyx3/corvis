import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import {
  configuredExtractionProviderConfig,
  createExtractedDocumentStageHandler,
  extractionCandidateSetSha256,
  extractionIdentity,
  GcpExtractionBundleReader,
  HttpExtractionProvider,
  parseExtractionCandidateBundle,
  PostgresExtractionCandidateRepository,
  type ExtractionBundleDescriptor,
  type ExtractionBundleReader,
  type ExtractionCandidate,
  type ExtractionCandidateRepository,
  type ExtractionProvider,
  type ExtractionRepresentationRecord,
} from "./processing-extracted-stage.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const artifactVersionId = "33333333-3333-4333-8333-333333333333";
const representationId = "44444444-4444-4444-8444-444444444444";
const representationSha256 = "b".repeat(64);
const bundleSha256 = "c".repeat(64);
const outputBucket = "corvis-test-documents";

const representation: ExtractionRepresentationRecord = {
  representationId,
  artifactVersionId,
  representationType: "document_interpretation_v1",
  objectUri: `gs://${outputBucket}/representations/source.json`,
  storageGeneration: "1740000000000999",
  contentSha256: representationSha256,
  sizeBytes: 8192,
  producer: "corvis-representation-worker",
  producerVersion: "2026-09-20.1",
  method: "hybrid",
  status: "ready",
};

const base: ProcessingStageEffectInput = {
  tenantId,
  documentId,
  jobId: `extracted:${documentId}`,
  stage: "extracted",
  payload: {
    predecessorJobId: `represented:${documentId}`,
    predecessorResult: {
      representationId,
      artifactVersionId,
      representationType: representation.representationType,
      storageGeneration: representation.storageGeneration,
      contentSha256: representation.contentSha256,
      sizeBytes: representation.sizeBytes,
      producer: representation.producer,
      producerVersion: representation.producerVersion,
      method: representation.method,
    },
  },
  idempotencyKey: "effect-key-extracted",
  attempt: 1,
};

function candidateLine(candidateKey = "metric:revenue:ltm-jun-26"): string {
  return JSON.stringify({
    candidateKey,
    candidateType: "metric_observation",
    payload: {
      metric_code: "revenue",
      metric_label_original: "LTM Revenue",
      value_raw: "$125.4m",
      value_numeric: "125400000",
      currency: "USD",
      period_type: "ltm",
      period_end: "2026-06-30",
      actuality: "actual",
    },
    confidence: {
      value: 0.99,
      currency: 0.85,
      period: 0.99,
      scenario: 0.99,
      entity: 0.98,
      metricMapping: 0.99,
    },
    provenance: {
      profileVersion: "gp-template-v3",
      extractionPass: "primary",
    },
    exceptionCodes: [],
    sourceReferences: [{
      referenceKey: "page-18:revenue:ltm-jun-26",
      pageNumber: 18,
      sectionTitle: "Portfolio Company Summary",
      tableTitle: "Operating Performance",
      rowLabel: "Revenue",
      columnLabel: "LTM Jun-26",
      sourceText: "$125.4m",
      extractionMethod: "table_parser",
    }],
  });
}

function bundleFor(objectUri: string): ExtractionBundleDescriptor {
  return {
    objectUri,
    storageGeneration: "1740000000001999",
    contentSha256: bundleSha256,
    sizeBytes: 2048,
    producer: "corvis-extraction-worker",
    producerVersion: "2026-09-20.1",
    modelProvider: "replaceable-model-provider",
    modelName: "private-markets-extractor",
    modelVersion: "2026-09-20",
  };
}

class FakeRepository implements ExtractionCandidateRepository {
  representation: ExtractionRepresentationRecord | undefined = { ...representation };
  readonly runs = new Map<string, { bundle: ExtractionBundleDescriptor; candidateCount?: number; candidateSetSha256?: string }>();
  readonly candidates = new Map<string, ExtractionCandidate>();
  findCalls = 0;
  beginCalls = 0;
  saveCalls = 0;
  finalizeCalls = 0;

  async findRepresentation(): Promise<ExtractionRepresentationRecord | undefined> {
    this.findCalls += 1;
    return this.representation;
  }

  async beginRun(input: { extractionRunId: string; bundle: ExtractionBundleDescriptor }): Promise<void> {
    this.beginCalls += 1;
    const existing = this.runs.get(input.extractionRunId);
    if (existing) {
      assert.deepEqual(existing.bundle, input.bundle);
      return;
    }
    this.runs.set(input.extractionRunId, { bundle: { ...input.bundle } });
  }

  async saveCandidate(input: { candidate: ExtractionCandidate }): Promise<void> {
    this.saveCalls += 1;
    const existing = this.candidates.get(input.candidate.candidateId);
    if (existing) {
      assert.deepEqual(existing, input.candidate);
      return;
    }
    this.candidates.set(input.candidate.candidateId, structuredClone(input.candidate));
  }

  async finalizeRun(input: { extractionRunId: string; candidateCount: number; candidateSetSha256: string }): Promise<void> {
    this.finalizeCalls += 1;
    const run = this.runs.get(input.extractionRunId);
    if (!run) throw new Error("missing run");
    if (run.candidateCount !== undefined) {
      assert.equal(run.candidateCount, input.candidateCount);
      assert.equal(run.candidateSetSha256, input.candidateSetSha256);
      return;
    }
    run.candidateCount = input.candidateCount;
    run.candidateSetSha256 = input.candidateSetSha256;
  }
}

class FakeProvider implements ExtractionProvider {
  readonly calls: Array<Parameters<ExtractionProvider["extract"]>[0]> = [];
  override?: ExtractionBundleDescriptor;

  async extract(input: Parameters<ExtractionProvider["extract"]>[0]): Promise<ExtractionBundleDescriptor> {
    this.calls.push(input);
    return this.override ?? bundleFor(input.outputObjectUri);
  }
}

class FakeBundleReader implements ExtractionBundleReader {
  readonly calls: Array<Parameters<ExtractionBundleReader["read"]>[0]> = [];
  jsonl = candidateLine();

  async read(input: Parameters<ExtractionBundleReader["read"]>[0]): Promise<string> {
    this.calls.push(input);
    return this.jsonl;
  }
}

function fixture(overrides: {
  repository?: FakeRepository;
  provider?: FakeProvider;
  bundleReader?: FakeBundleReader;
} = {}) {
  const repository = overrides.repository ?? new FakeRepository();
  const provider = overrides.provider ?? new FakeProvider();
  const bundleReader = overrides.bundleReader ?? new FakeBundleReader();
  return {
    repository,
    provider,
    bundleReader,
    execute: createExtractedDocumentStageHandler({ repository, provider, bundleReader, outputBucket }),
  };
}

test("extraction identity is deterministic for exact representation and governed contract", () => {
  const first = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  const second = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  assert.deepEqual(first, second);
  assert.match(first.extractionRunId, /^[0-9a-f-]{36}$/);
  assert.equal(first.objectUri, `gs://${outputBucket}/extractions/${tenantId}/${documentId}/${representationId}/${first.extractionRunId}.jsonl`);
});

test("candidate bundle produces deterministic evidence-backed candidate state", () => {
  const identity = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  const bundle = bundleFor(identity.objectUri);
  const candidates = parseExtractionCandidateBundle({
    jsonl: `${candidateLine("z-candidate")}\n${candidateLine("a-candidate")}\n`,
    extractionRunId: identity.extractionRunId,
    representation,
    bundle,
  });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.candidateKey, "a-candidate");
  assert.equal(candidates[1]?.candidateKey, "z-candidate");
  const candidate = candidates[0]!;
  assert.equal(candidate.candidateType, "metric_observation");
  assert.equal(candidate.confidence.value, 0.99);
  assert.equal(candidate.provenance.skillId, "quarterly_fund_report_extraction");
  assert.equal(candidate.provenance.skillVersion, "1.6");
  assert.equal(candidate.provenance.representationId, representationId);
  assert.equal(candidate.provenance.modelProvider, bundle.modelProvider);
  assert.equal(candidate.sourceReferences.length, 1);
  assert.equal(candidate.sourceReferences[0]?.pageNumber, 18);
  assert.equal(candidate.sourceReferences[0]?.sourceText, "$125.4m");
  assert.match(extractionCandidateSetSha256(candidates), /^[0-9a-f]{64}$/);
});

test("extracted stage persists candidates idempotently and redelivery reuses one logical run", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const first = await f.execute(base, signal);
  const second = await f.execute({ ...base, attempt: 2 }, signal);

  assert.deepEqual(first, second);
  assert.equal(f.repository.runs.size, 1);
  assert.equal(f.repository.candidates.size, 1);
  assert.equal(f.repository.beginCalls, 2);
  assert.equal(f.repository.saveCalls, 2);
  assert.equal(f.repository.finalizeCalls, 2);
  assert.equal(f.provider.calls.length, 2, "crash/redelivery may re-invoke a retry-safe extraction provider");
  assert.equal(f.provider.calls[0]?.idempotencyKey, base.idempotencyKey);
  assert.equal(f.provider.calls[1]?.idempotencyKey, base.idempotencyKey);
  assert.equal(f.provider.calls[0]?.outputObjectUri, f.provider.calls[1]?.outputObjectUri);
  assert.equal(f.bundleReader.calls.length, 2);
  assert.deepEqual(first, {
    extractionRunId: f.provider.calls[0]?.extractionRunId,
    representationId,
    artifactVersionId,
    candidateCount: 1,
    candidateSetSha256: f.repository.runs.values().next().value?.candidateSetSha256,
    schemaVersion: "1.2",
    skillId: "quarterly_fund_report_extraction",
    skillVersion: "1.6",
  });
});

test("extracted stage fails closed before provider work when committed representation lineage changed", async () => {
  const repository = new FakeRepository();
  repository.representation = { ...representation, contentSha256: "d".repeat(64) };
  const f = fixture({ repository });
  await assert.rejects(f.execute(base, new AbortController().signal), /lineage no longer matches/);
  assert.equal(f.provider.calls.length, 0);
  assert.equal(repository.runs.size, 0);
});

test("extracted stage rejects provider output outside deterministic bundle identity", async () => {
  const provider = new FakeProvider();
  provider.override = bundleFor(`gs://${outputBucket}/extractions/wrong.jsonl`);
  const f = fixture({ provider });
  await assert.rejects(f.execute(base, new AbortController().signal), /outside the deterministic candidate bundle identity/);
  assert.equal(f.bundleReader.calls.length, 0);
  assert.equal(f.repository.runs.size, 0);
});

test("candidate validation requires exact evidence, bounded confidence and provenance", async (t) => {
  const identity = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  const bundle = bundleFor(identity.objectUri);
  const baseCandidate = JSON.parse(candidateLine()) as Record<string, unknown>;
  for (const item of [
    { name: "missing evidence", patch: { sourceReferences: [] }, error: /requires exact source evidence/ },
    { name: "invalid confidence", patch: { confidence: { value: 1.2 } }, error: /between 0 and 1/ },
    { name: "missing provenance", patch: { provenance: null }, error: /requires provenance object/ },
  ]) {
    await t.test(item.name, () => {
      const record = { ...baseCandidate, ...item.patch };
      assert.throws(() => parseExtractionCandidateBundle({
        jsonl: JSON.stringify(record), extractionRunId: identity.extractionRunId, representation, bundle,
      }), item.error);
    });
  }
});

test("extraction provider configuration is optional and bounded", () => {
  assert.equal(configuredExtractionProviderConfig({ NODE_ENV: "test" }), undefined);
  assert.deepEqual(configuredExtractionProviderConfig({
    NODE_ENV: "test",
    CORVIS_EXTRACTION_ENDPOINT: "https://extraction.example/",
    CORVIS_OBJECT_STORE_BUCKET: outputBucket,
    CORVIS_EXTRACTION_TIMEOUT_MS: "999999",
  }), {
    endpoint: "https://extraction.example/",
    audience: "https://extraction.example/",
    outputBucket,
    timeoutMs: 25_000,
  });
  assert.throws(() => configuredExtractionProviderConfig({
    NODE_ENV: "test",
    CORVIS_EXTRACTION_ENDPOINT: "https://extraction.example",
  }), /CORVIS_OBJECT_STORE_BUCKET/);
});

test("HTTP extraction provider uses keyless identity and passes governed contract plus idempotency", async () => {
  const identity = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("http://metadata.google.internal/")) return new Response("oidc-token", { status: 200 });
    return new Response(JSON.stringify(bundleFor(identity.objectUri)), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = new HttpExtractionProvider({
    endpoint: "https://extraction.example",
    audience: "https://extraction.example",
    timeoutMs: 5_000,
  }, fakeFetch);
  const result = await provider.extract({
    tenantId,
    documentId,
    artifactVersionId,
    representationId,
    representationType: representation.representationType,
    representationObjectUri: representation.objectUri,
    representationStorageGeneration: representation.storageGeneration,
    representationContentSha256: representation.contentSha256,
    extractionRunId: identity.extractionRunId,
    outputObjectUri: identity.objectUri,
    idempotencyKey: base.idempotencyKey,
    signal: new AbortController().signal,
  });
  assert.equal(result.objectUri, identity.objectUri);
  assert.equal(calls.length, 2);
  const request = calls[1]!;
  assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer oidc-token");
  assert.equal(new Headers(request.init.headers).get("x-corvis-idempotency-key"), base.idempotencyKey);
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.skillId, "quarterly_fund_report_extraction");
  assert.equal(body.skillVersion, "1.6");
  assert.equal(body.schemaVersion, "1.2");
  assert.deepEqual(body.output, { objectUri: identity.objectUri, format: "jsonl" });
});

test("GCS candidate reader verifies immutable representation lineage and actual bundle bytes", async () => {
  const identity = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  const jsonl = `${candidateLine()}\n`;
  const contentHash = createHash("sha256").update(jsonl).digest("hex");
  const descriptor: ExtractionBundleDescriptor = {
    ...bundleFor(identity.objectUri),
    contentSha256: contentHash,
    sizeBytes: Buffer.byteLength(jsonl),
  };
  let calls = 0;
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    calls += 1;
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer local-token");
    if (calls === 1) {
      return new Response(JSON.stringify({
        generation: descriptor.storageGeneration,
        size: String(descriptor.sizeBytes),
        metadata: {
          "corvis-content-sha256": descriptor.contentSha256,
          "corvis-extraction-run-id": identity.extractionRunId,
          "corvis-representation-id": representationId,
          "corvis-representation-generation": representation.storageGeneration,
          "corvis-representation-sha256": representation.contentSha256,
          "corvis-skill-id": "quarterly_fund_report_extraction",
          "corvis-skill-version": "1.6",
          "corvis-schema-version": "1.2",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.match(String(input), /alt=media/);
    return new Response(jsonl, { status: 200, headers: { "content-length": String(descriptor.sizeBytes) } });
  };
  const reader = new GcpExtractionBundleReader(outputBucket, { fetchImpl: fakeFetch, accessToken: "local-token" });
  assert.equal(await reader.read({
    descriptor,
    extractionRunId: identity.extractionRunId,
    representationId,
    representationStorageGeneration: representation.storageGeneration,
    representationContentSha256: representation.contentSha256,
    signal: new AbortController().signal,
  }), jsonl);
  assert.equal(calls, 2);
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

test("Postgres extraction repository re-resolves representation by tenant, document and representation", async () => {
  const db = new FakePostgres();
  db.rows = [{
    representation_id: representationId,
    document_artifact_version_id: artifactVersionId,
    representation_type: representation.representationType,
    object_uri: representation.objectUri,
    storage_generation: representation.storageGeneration,
    content_sha256: representation.contentSha256,
    size_bytes: representation.sizeBytes,
    producer: representation.producer,
    producer_version: representation.producerVersion,
    method: representation.method,
    status: "ready",
  }];
  const repository = new PostgresExtractionCandidateRepository(db);
  const result = await repository.findRepresentation({ tenantId, documentId, representationId });
  assert.equal(result?.representationId, representationId);
  assert.deepEqual(db.calls[0]?.parameters, [tenantId, documentId, representationId]);
  assert.match(db.calls[0]?.sql ?? "", /tenant_id=\$1::uuid/);
  assert.match(db.calls[0]?.sql ?? "", /document_id=\$2::uuid/);
  assert.match(db.calls[0]?.sql ?? "", /representation_id=\$3::uuid/);
});

test("extraction candidate migration is forced-RLS, server-only and keeps candidates separate from canonical observations", async () => {
  const sql = (await readFile("db/postgres/migrations/024_extraction_candidates.sql", "utf8")).toLowerCase();
  for (const table of ["extraction_run", "extraction_candidate", "extraction_candidate_source_reference"]) {
    assert.match(sql, new RegExp(`create table if not exists corvis_source\\.${table}`));
    assert.match(sql, new RegExp(`alter table corvis_source\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`alter table corvis_source\\.${table} force row level security`));
    assert.equal(new RegExp(`create policy[^;]+${table}`).test(sql), false);
  }
  assert.match(sql, /review_status text not null default 'candidate'/);
  assert.match(sql, /candidate_set_sha256/);
  assert.match(sql, /foreign key \(tenant_id, representation_id\)/);
  assert.equal(/insert into corvis_facts\.observation/.test(sql), false);
});
