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
const manifestSha256 = "d".repeat(64);
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

function sourceReference(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    referenceKey: "page-18:revenue:ltm-jun-26",
    pageNumber: 18,
    sectionTitle: "Fund A — Portfolio Company Summary",
    tableTitle: "Operating Performance",
    rowLabel: "Revenue",
    columnLabel: "LTM Jun-26",
    sourceText: "$125.4m",
    documentSegmentId: "segment-fund-a",
    workUnitId: "work-fund-a-portfolio",
    fundContextIds: ["fund-a"],
    pageCoverageState: "primary",
    extractionMethod: "table_parser",
    ...overrides,
  };
}

function candidateRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidateKey: "metric:revenue:ltm-jun-26",
    candidateType: "metric_observation",
    payload: {
      fund_id: "fund-a",
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
      extractionPass: "reduced",
    },
    exceptionCodes: [],
    sourceReferences: [sourceReference()],
    ...overrides,
  };
}

function candidateLine(candidateKey = "metric:revenue:ltm-jun-26"): string {
  return JSON.stringify(candidateRecord({ candidateKey }));
}

function statementLine(): string {
  return JSON.stringify({
    candidateKey: "statement:income:custom-operating-item",
    candidateType: "financial_statement_line",
    payload: {
      statement_type: "income_statement",
      statement_key: "company-a-income-statement",
      statement_line_key: "custom-operating-item",
      semantic_line_key: "custom_operating_item",
      statement_line_label: "Custom operating item",
      statement_line_role: "line_item",
      display_order: 14,
      depth: 0,
      fund_id: "fund-a",
      holding_id: "55555555-5555-4555-8555-555555555555",
      company_id: "company-a",
      report_period: "2026Q2",
      value_raw: "$12.0m",
      value_numeric: "12000000",
      currency: "USD",
      unit: "currency",
      reported_multiplier: "1",
      value_nature: "flow",
      period_type: "quarter",
      period_start: "2026-04-01",
      period_end: "2026-06-30",
      fiscal_year: 2026,
      fiscal_quarter: 2,
      source_document_period_end: "2026-06-30",
      actuality: "actual",
    },
    confidence: { value: 0.99, period: 0.99, entity: 0.99 },
    provenance: { extractionPass: "reduced" },
    exceptionCodes: ["unmapped_metric"],
    sourceReferences: [sourceReference({
      referenceKey: "page-19:custom-operating-item:q2-26",
      pageNumber: 19,
      tableTitle: "Income Statement",
      rowLabel: "Custom operating item",
      columnLabel: "Q2 2026",
      sourceText: "$12.0m",
      workUnitId: "work-fund-a-statements",
    })],
  });
}

function bundleFor(objectUri: string): ExtractionBundleDescriptor {
  return {
    objectUri,
    storageGeneration: "1740000000001999",
    contentSha256: bundleSha256,
    sizeBytes: 2048,
    producer: "corvis-extraction-worker",
    producerVersion: "2026-09-25.1",
    modelProvider: "replaceable-model-provider",
    modelName: "private-markets-extractor",
    modelVersion: "2026-09-25",
    orchestrationPolicyVersion: "1",
    orchestrationManifest: {
      objectUri: `gs://${outputBucket}/orchestration/manifest.json`,
      storageGeneration: "1740000000001888",
      contentSha256: manifestSha256,
      sizeBytes: 4096,
      pageCount: 320,
      coveredPageCount: 320,
      documentSegmentCount: 6,
      workUnitCount: 9,
      unexplainedPageGapCount: 0,
      unresolvedMaterialAttributionCount: 0,
    },
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
    this.runs.set(input.extractionRunId, { bundle: structuredClone(input.bundle) });
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

function fixture(overrides: { repository?: FakeRepository; provider?: FakeProvider; bundleReader?: FakeBundleReader } = {}) {
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

test("extraction identity is deterministic for the governed 2.1 orchestration contract", () => {
  const first = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  const second = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  assert.deepEqual(first, second);
  assert.match(first.extractionRunId, /^[0-9a-f-]{36}$/);
  assert.equal(first.objectUri, `gs://${outputBucket}/extractions/${tenantId}/${documentId}/${representationId}/${first.extractionRunId}.jsonl`);
});

test("candidate bundle preserves segment, work-unit and fund attribution provenance", () => {
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
  const candidate = candidates[0]!;
  assert.equal(candidate.provenance.skillVersion, "2.1");
  assert.equal(candidate.provenance.schemaVersion, "1.6");
  assert.equal(candidate.provenance.orchestrationPolicyVersion, "1");
  assert.deepEqual(candidate.provenance.documentSegmentIds, ["segment-fund-a"]);
  assert.deepEqual(candidate.provenance.workUnitIds, ["work-fund-a-portfolio"]);
  assert.deepEqual(candidate.provenance.fundContextIds, ["fund-a"]);
  assert.equal(candidate.sourceReferences[0]?.pageCoverageState, "primary");
  assert.equal(candidate.sourceReferences[0]?.documentSegmentId, "segment-fund-a");
  assert.deepEqual(candidate.sourceReferences[0]?.fundContextIds, ["fund-a"]);
  assert.match(extractionCandidateSetSha256(candidates), /^[0-9a-f]{64}$/);
});

test("financial statement line candidates keep exact row evidence and fund scope", () => {
  const identity = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  const [candidate] = parseExtractionCandidateBundle({
    jsonl: `${statementLine()}\n`, extractionRunId: identity.extractionRunId, representation, bundle: bundleFor(identity.objectUri),
  });
  assert.equal(candidate?.candidateType, "financial_statement_line");
  assert.equal(candidate?.payload.statement_line_label, "Custom operating item");
  assert.equal(candidate?.payload.metric_code, undefined);
  assert.deepEqual(candidate?.provenance.fundContextIds, ["fund-a"]);
  assert.equal(candidate?.sourceReferences[0]?.workUnitId, "work-fund-a-statements");
});

test("material candidates fail closed without segment, fund attribution or valid page coverage", async (t) => {
  const identity = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  const bundle = bundleFor(identity.objectUri);
  const cases = [
    {
      name: "missing segment",
      record: candidateRecord({ sourceReferences: [sourceReference({ documentSegmentId: "" })] }),
      error: /documentSegmentId/,
    },
    {
      name: "missing fund attribution",
      record: candidateRecord({ sourceReferences: [sourceReference({ fundContextIds: [] })] }),
      error: /requires fund attribution/,
    },
    {
      name: "invalid page coverage state",
      record: candidateRecord({ sourceReferences: [sourceReference({ pageCoverageState: "mystery" })] }),
      error: /unsupported pageCoverageState/,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => assert.throws(() => parseExtractionCandidateBundle({
      jsonl: JSON.stringify(item.record), extractionRunId: identity.extractionRunId, representation, bundle,
    }), item.error));
  }
});

test("explicit unresolved-attribution exception keeps ambiguous evidence reviewable", () => {
  const identity = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  const record = candidateRecord({
    exceptionCodes: ["FUND_ATTRIBUTION_UNRESOLVED"],
    sourceReferences: [sourceReference({ fundContextIds: [] })],
  });
  const [candidate] = parseExtractionCandidateBundle({
    jsonl: JSON.stringify(record), extractionRunId: identity.extractionRunId, representation, bundle: bundleFor(identity.objectUri),
  });
  assert.deepEqual(candidate?.provenance.fundContextIds, []);
  assert.deepEqual(candidate?.exceptionCodes, ["FUND_ATTRIBUTION_UNRESOLVED"]);
});

test("extracted stage is idempotent and reports skill 2.1 / schema 1.6", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const first = await f.execute(base, signal);
  const second = await f.execute({ ...base, attempt: 2 }, signal);
  assert.deepEqual(first, second);
  assert.equal(f.repository.runs.size, 1);
  assert.equal(f.repository.candidates.size, 1);
  assert.equal(f.provider.calls.length, 2);
  assert.equal(f.bundleReader.calls.length, 2);
  assert.deepEqual(first, {
    extractionRunId: f.provider.calls[0]?.extractionRunId,
    representationId,
    artifactVersionId,
    candidateCount: 1,
    candidateSetSha256: f.repository.runs.values().next().value?.candidateSetSha256,
    schemaVersion: "1.6",
    skillId: "quarterly_fund_report_extraction",
    skillVersion: "2.1",
    orchestrationPolicyVersion: "1",
  });
});

test("extracted stage fails before provider work when representation lineage changed", async () => {
  const repository = new FakeRepository();
  repository.representation = { ...representation, contentSha256: "e".repeat(64) };
  const f = fixture({ repository });
  await assert.rejects(f.execute(base, new AbortController().signal), /lineage no longer matches/);
  assert.equal(f.provider.calls.length, 0);
});

test("provider request makes map-first large-document orchestration machine-readable", async () => {
  const identity = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("http://metadata.google.internal/")) return new Response("oidc-token", { status: 200 });
    return new Response(JSON.stringify(bundleFor(identity.objectUri)), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = new HttpExtractionProvider({ endpoint: "https://extraction.example", audience: "https://extraction.example", timeoutMs: 5_000 }, fakeFetch);
  await provider.extract({
    tenantId, documentId, artifactVersionId, representationId,
    representationType: representation.representationType,
    representationObjectUri: representation.objectUri,
    representationStorageGeneration: representation.storageGeneration,
    representationContentSha256: representation.contentSha256,
    extractionRunId: identity.extractionRunId,
    outputObjectUri: identity.objectUri,
    idempotencyKey: base.idempotencyKey,
    signal: new AbortController().signal,
  });
  const request = calls[1]!;
  assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer oidc-token");
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.skillVersion, "2.1");
  assert.equal(body.schemaVersion, "1.6");
  const policy = body.orchestrationPolicy as Record<string, unknown>;
  assert.equal(policy.mapBeforeFanOut, true);
  assert.equal(policy.partitionStrategy, "semantic_boundaries");
  assert.equal(policy.contextCapsulesRequired, true);
  assert.equal(policy.globalReducerRequired, true);
  assert.equal(policy.pageCoverageLedgerRequired, true);
  assert.equal(policy.workersMayPublishCanonicalFacts, false);
  assert.equal(policy.preserveDistinctFundHoldingPaths, true);
  assert.equal(policy.companyOperatingValues, "full_source_reported_no_ownership_proration");
});

test("provider rejects incomplete coverage and unresolved material attribution", async (t) => {
  const identity = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  for (const item of [
    { name: "page gap", manifest: { coveredPageCount: 319, unexplainedPageGapCount: 1 }, error: /incomplete page coverage/ },
    { name: "unresolved fund", manifest: { unresolvedMaterialAttributionCount: 1 }, error: /unresolved material fund attribution/ },
  ]) {
    await t.test(item.name, async () => {
      const fakeFetch: typeof fetch = async (input) => {
        if (String(input).startsWith("http://metadata.google.internal/")) return new Response("oidc-token", { status: 200 });
        const descriptor = bundleFor(identity.objectUri);
        return new Response(JSON.stringify({
          ...descriptor,
          orchestrationManifest: { ...descriptor.orchestrationManifest, ...item.manifest },
        }), { status: 200, headers: { "content-type": "application/json" } });
      };
      const provider = new HttpExtractionProvider({ endpoint: "https://extraction.example", audience: "https://extraction.example", timeoutMs: 5_000 }, fakeFetch);
      await assert.rejects(provider.extract({
        tenantId, documentId, artifactVersionId, representationId,
        representationType: representation.representationType,
        representationObjectUri: representation.objectUri,
        representationStorageGeneration: representation.storageGeneration,
        representationContentSha256: representation.contentSha256,
        extractionRunId: identity.extractionRunId,
        outputObjectUri: identity.objectUri,
        idempotencyKey: base.idempotencyKey,
        signal: new AbortController().signal,
      }), item.error);
    });
  }
});

test("GCS candidate reader verifies skill, schema, policy and manifest lineage", async () => {
  const identity = extractionIdentity({ tenantId, documentId, representationId, outputBucket });
  const jsonl = `${candidateLine()}\n`;
  const descriptor = bundleFor(identity.objectUri);
  descriptor.contentSha256 = createHash("sha256").update(jsonl).digest("hex");
  descriptor.sizeBytes = Buffer.byteLength(jsonl);
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
          "corvis-skill-version": "2.1",
          "corvis-schema-version": "1.6",
          "corvis-orchestration-policy-version": "1",
          "corvis-orchestration-manifest-uri": descriptor.orchestrationManifest.objectUri,
          "corvis-orchestration-manifest-generation": descriptor.orchestrationManifest.storageGeneration,
          "corvis-orchestration-manifest-sha256": descriptor.orchestrationManifest.contentSha256,
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

test("orchestration persistence remains source-layer only and gates 2.1 completeness", async () => {
  const sql = (await readFile("db/postgres/migrations/054_extraction_orchestration_provenance.sql", "utf8")).toLowerCase();
  assert.match(sql, /alter table corvis_source\.extraction_run/);
  assert.match(sql, /orchestration_policy_version/);
  assert.match(sql, /orchestration_manifest_content_sha256/);
  assert.match(sql, /covered_page_count=page_count/);
  assert.match(sql, /unexplained_page_gap_count=0/);
  assert.match(sql, /unresolved_material_attribution_count=0/);
  assert.match(sql, /alter table corvis_source\.extraction_candidate_source_reference/);
  assert.match(sql, /document_segment_id/);
  assert.match(sql, /work_unit_id/);
  assert.match(sql, /fund_context_ids jsonb/);
  assert.match(sql, /page_coverage_state/);
  assert.equal(/alter table corvis_facts\./.test(sql), false);
  assert.equal(/alter table corvis_identity\./.test(sql), false);
});
