import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import {
  configuredExtractionProviderConfig,
  createConfiguredExtractedStageHandler,
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
  type ExtractionSourceReference,
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
    timeoutMs: 480_000,
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

// ---------------------------------------------------------------------------
// Handler guards, abort propagation and predecessor validation
// ---------------------------------------------------------------------------

const runIdentity = extractionIdentity({ tenantId, documentId, representationId, outputBucket });

function parse(jsonl: string, bundle: ExtractionBundleDescriptor = bundleFor(runIdentity.objectUri)): ExtractionCandidate[] {
  return parseExtractionCandidateBundle({ jsonl, extractionRunId: runIdentity.extractionRunId, representation, bundle });
}

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(patch);
  try { return fn(); } finally { apply(saved); }
}

test("extracted stage rejects effects that belong to another stage", async () => {
  const f = fixture();
  await assert.rejects(
    f.execute({ ...base, stage: "represented" }, new AbortController().signal),
    { message: "extracted document handler cannot execute stage represented" },
  );
  assert.equal(f.repository.findCalls, 0);
});

test("extracted stage fails closed on missing, non-ready or non-GCS representations", async (t) => {
  const cases: Array<{ name: string; record: ExtractionRepresentationRecord | undefined; error: string }> = [
    { name: "representation not found", record: undefined, error: "extracted stage representation was not found" },
    { name: "representation not ready", record: { ...representation, status: "pending" }, error: "extracted stage representation lineage no longer matches the represented stage result" },
    { name: "representation size drifted", record: { ...representation, sizeBytes: representation.sizeBytes + 1 }, error: "extracted stage representation lineage no longer matches the represented stage result" },
    { name: "representation not in GCS", record: { ...representation, objectUri: "https://example.com/representation.json" }, error: "extracted stage representation is not authoritative GCS evidence" },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const repository = new FakeRepository();
      repository.representation = item.record;
      const f = fixture({ repository });
      await assert.rejects(f.execute(base, new AbortController().signal), { message: item.error });
      assert.equal(f.provider.calls.length, 0);
      assert.equal(f.repository.beginCalls, 0);
    });
  }
});

test("extracted stage rejects provider output written outside the deterministic bundle identity", async () => {
  const provider = new FakeProvider();
  provider.override = bundleFor(`gs://${outputBucket}/extractions/elsewhere.jsonl`);
  const f = fixture({ provider });
  await assert.rejects(
    f.execute(base, new AbortController().signal),
    { message: "extraction provider wrote outside the deterministic candidate bundle identity" },
  );
  assert.equal(f.bundleReader.calls.length, 0);
  assert.equal(f.repository.beginCalls, 0);
});

test("extracted stage validates the predecessor result before any lookup", async (t) => {
  const predecessor = base.payload.predecessorResult as Record<string, unknown>;
  const cases: Array<{ name: string; payload: Record<string, unknown>; error: string }> = [
    { name: "missing predecessorResult", payload: {}, error: "extracted stage requires predecessorResult" },
    { name: "array predecessorResult", payload: { predecessorResult: [] }, error: "extracted stage requires predecessorResult" },
    { name: "missing sha", payload: { predecessorResult: { ...predecessor, contentSha256: undefined } }, error: "extracted stage requires predecessorResult.contentSha256" },
    { name: "malformed sha", payload: { predecessorResult: { ...predecessor, contentSha256: "not-a-sha" } }, error: "extracted stage requires valid predecessorResult.contentSha256" },
    { name: "negative size", payload: { predecessorResult: { ...predecessor, sizeBytes: -1 } }, error: "extracted stage requires valid predecessorResult.sizeBytes" },
    { name: "fractional size", payload: { predecessorResult: { ...predecessor, sizeBytes: 1.5 } }, error: "extracted stage requires valid predecessorResult.sizeBytes" },
    ...["representationId", "artifactVersionId", "representationType", "storageGeneration", "producer", "producerVersion", "method"].map((field) => ({
      name: `blank ${field}`,
      payload: { predecessorResult: { ...predecessor, [field]: "  " } },
      error: `extracted stage requires predecessorResult.${field}`,
    })),
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const f = fixture();
      await assert.rejects(f.execute({ ...base, payload: item.payload }, new AbortController().signal), { message: item.error });
      assert.equal(f.repository.findCalls, 0);
    });
  }
});

test("extracted stage accepts an upper-case predecessor hash and normalises it", async () => {
  const predecessor = base.payload.predecessorResult as Record<string, unknown>;
  const f = fixture();
  const result = await f.execute(
    { ...base, payload: { predecessorResult: { ...predecessor, contentSha256: representationSha256.toUpperCase() } } },
    new AbortController().signal,
  );
  assert.equal((result as { candidateCount: number }).candidateCount, 1);
  assert.equal(f.provider.calls[0]?.representationContentSha256, representationSha256);
});

test("extracted stage honours router aborts before and between every external step", async (t) => {
  await t.test("already aborted with an Error reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("router aborted early"));
    const f = fixture();
    await assert.rejects(f.execute(base, controller.signal), { message: "router aborted early" });
    assert.equal(f.repository.findCalls, 0);
  });

  await t.test("already aborted with a non-Error reason", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const f = fixture();
    await assert.rejects(f.execute(base, controller.signal), { message: "extracted stage execution aborted" });
    assert.equal(f.repository.findCalls, 0);
  });

  await t.test("aborted while the representation is being resolved", async () => {
    const controller = new AbortController();
    const f = fixture();
    f.repository.findRepresentation = async () => {
      controller.abort(new Error("aborted after lookup"));
      return { ...representation };
    };
    await assert.rejects(f.execute(base, controller.signal), { message: "aborted after lookup" });
    assert.equal(f.provider.calls.length, 0);
  });

  await t.test("aborted while the provider is extracting", async () => {
    const controller = new AbortController();
    const f = fixture();
    f.provider.extract = async (input) => {
      f.provider.calls.push(input);
      controller.abort(new Error("aborted after provider"));
      return bundleFor(input.outputObjectUri);
    };
    await assert.rejects(f.execute(base, controller.signal), { message: "aborted after provider" });
    assert.equal(f.bundleReader.calls.length, 0);
  });

  await t.test("aborted while the bundle is being read", async () => {
    const controller = new AbortController();
    const f = fixture();
    f.bundleReader.read = async () => {
      controller.abort(new Error("aborted after read"));
      return candidateLine();
    };
    await assert.rejects(f.execute(base, controller.signal), { message: "aborted after read" });
    assert.equal(f.repository.beginCalls, 0);
  });

  await t.test("aborted before the first candidate is persisted", async () => {
    const controller = new AbortController();
    const f = fixture();
    f.repository.beginRun = async () => { controller.abort(new Error("aborted after begin")); };
    await assert.rejects(f.execute(base, controller.signal), { message: "aborted after begin" });
    assert.equal(f.repository.saveCalls, 0);
    assert.equal(f.repository.finalizeCalls, 0);
  });

  await t.test("aborted between candidates", async () => {
    const controller = new AbortController();
    const reader = new FakeBundleReader();
    reader.jsonl = `${candidateLine("a-candidate")}\n${candidateLine("b-candidate")}\n`;
    const f = fixture({ bundleReader: reader });
    f.repository.saveCandidate = async () => {
      f.repository.saveCalls += 1;
      controller.abort(new Error("aborted mid-persist"));
    };
    await assert.rejects(f.execute(base, controller.signal), { message: "aborted mid-persist" });
    assert.equal(f.repository.saveCalls, 1);
    assert.equal(f.repository.finalizeCalls, 0);
  });
});

test("extracted stage persists every candidate in key order and finalises with the set hash", async () => {
  const reader = new FakeBundleReader();
  reader.jsonl = `${candidateLine("z-candidate")}\n${candidateLine("a-candidate")}\n`;
  const f = fixture({ bundleReader: reader });
  const result = await f.execute(base, new AbortController().signal) as { candidateCount: number; candidateSetSha256: string };
  assert.equal(result.candidateCount, 2);
  assert.equal(f.repository.saveCalls, 2);
  assert.deepEqual([...f.repository.candidates.values()].map((candidate) => candidate.candidateKey), ["a-candidate", "z-candidate"]);
  assert.equal(result.candidateSetSha256, extractionCandidateSetSha256([...f.repository.candidates.values()]));
  assert.equal(f.bundleReader.calls[0]?.representationContentSha256, representationSha256);
  assert.equal(f.bundleReader.calls[0]?.representationStorageGeneration, representation.storageGeneration);
});

// ---------------------------------------------------------------------------
// Candidate bundle parsing
// ---------------------------------------------------------------------------

test("candidate bundle rejects an unsupported orchestration policy version", () => {
  const bundle = { ...bundleFor(runIdentity.objectUri), orchestrationPolicyVersion: "2" };
  assert.throws(() => parse(candidateLine(), bundle), { message: "extraction candidate bundle uses unsupported orchestration policy version" });
});

test("candidate bundle rejects malformed lines with their line number and ignores blank lines", () => {
  assert.throws(() => parse(`${candidateLine("a")}\n{oops`), { message: "extraction candidate bundle line 2 is invalid JSON" });
  assert.throws(() => parse("[1,2]"), { message: "extraction candidate bundle line 1 is invalid JSON" });
  assert.throws(() => parse("null"), { message: "extraction candidate bundle line 1 is invalid JSON" });
  assert.throws(() => parse(""), { message: "extraction candidate bundle contains no candidates" });
  assert.throws(() => parse("\n  \r\n\t\n"), { message: "extraction candidate bundle contains no candidates" });
  const parsed = parse(`\r\n${candidateLine("b-candidate")}\r\n\r\n   \r\n${candidateLine("a-candidate")}\r\n`);
  assert.deepEqual(parsed.map((candidate) => candidate.candidateKey), ["a-candidate", "b-candidate"]);
});

test("candidate bundle rejects structurally invalid candidates", async (t) => {
  const key = "metric:revenue:ltm-jun-26";
  const cases: Array<{ name: string; jsonl: string; error: string }> = [
    { name: "blank candidateKey", jsonl: JSON.stringify(candidateRecord({ candidateKey: " " })), error: "extracted stage requires candidate line 1 candidateKey" },
    { name: "duplicate candidateKey", jsonl: `${candidateLine()}\n${candidateLine()}`, error: `extraction candidate bundle repeats candidateKey ${key}` },
    { name: "missing candidateType", jsonl: JSON.stringify(candidateRecord({ candidateType: undefined })), error: `extracted stage requires candidate ${key} candidateType` },
    { name: "unsupported candidateType", jsonl: JSON.stringify(candidateRecord({ candidateType: "gossip" })), error: `extraction candidate ${key} has unsupported candidateType` },
    { name: "array payload", jsonl: JSON.stringify(candidateRecord({ payload: [] })), error: `extraction candidate ${key} requires payload object` },
    { name: "missing payload", jsonl: JSON.stringify(candidateRecord({ payload: undefined })), error: `extraction candidate ${key} requires payload object` },
    { name: "string provenance", jsonl: JSON.stringify(candidateRecord({ provenance: "x" })), error: `extraction candidate ${key} requires provenance object` },
    { name: "empty sourceReferences", jsonl: JSON.stringify(candidateRecord({ sourceReferences: [] })), error: `extraction candidate ${key} requires exact source evidence` },
    { name: "non-array sourceReferences", jsonl: JSON.stringify(candidateRecord({ sourceReferences: "page 18" })), error: `extraction candidate ${key} requires exact source evidence` },
    { name: "non-array exceptionCodes", jsonl: JSON.stringify(candidateRecord({ exceptionCodes: "unmapped" })), error: "extraction candidate exceptionCodes must be non-empty strings" },
    { name: "non-string exception code", jsonl: JSON.stringify(candidateRecord({ exceptionCodes: [1] })), error: "extraction candidate exceptionCodes must be non-empty strings" },
    { name: "blank exception code", jsonl: JSON.stringify(candidateRecord({ exceptionCodes: ["  "] })), error: "extraction candidate exceptionCodes must be non-empty strings" },
    { name: "missing confidence", jsonl: JSON.stringify(candidateRecord({ confidence: undefined })), error: "extraction candidate requires dimension confidence" },
    { name: "empty confidence", jsonl: JSON.stringify(candidateRecord({ confidence: {} })), error: "extraction candidate requires dimension confidence" },
    { name: "confidence above 1", jsonl: JSON.stringify(candidateRecord({ confidence: { value: 1.5 } })), error: "extraction candidate confidence value must be between 0 and 1" },
    { name: "confidence below 0", jsonl: JSON.stringify(candidateRecord({ confidence: { value: -0.1 } })), error: "extraction candidate confidence value must be between 0 and 1" },
    { name: "non-numeric confidence", jsonl: JSON.stringify(candidateRecord({ confidence: { entity: "0.9" } })), error: "extraction candidate confidence entity must be between 0 and 1" },
  ];
  for (const item of cases) {
    await t.test(item.name, () => assert.throws(() => parse(item.jsonl), { message: item.error }));
  }
});

test("candidate bundle rejects invalid source references", async (t) => {
  const withReference = (overrides: Record<string, unknown>) => JSON.stringify(candidateRecord({ sourceReferences: [sourceReference(overrides)] }));
  const cases: Array<{ name: string; jsonl: string; error: string }> = [
    { name: "non-object reference", jsonl: JSON.stringify(candidateRecord({ sourceReferences: ["page 18"] })), error: "extraction candidate source reference must be an object" },
    { name: "blank referenceKey", jsonl: withReference({ referenceKey: "" }), error: "extracted stage requires source reference referenceKey" },
    { name: "zero pageNumber", jsonl: withReference({ pageNumber: 0 }), error: "extracted stage requires valid source reference pageNumber" },
    { name: "fractional pageNumber", jsonl: withReference({ pageNumber: 1.5 }), error: "extracted stage requires valid source reference pageNumber" },
    { name: "no page and no sheet", jsonl: withReference({ pageNumber: null }), error: "extraction candidate source reference requires pageNumber or sheetName" },
    { name: "non-string sheetName", jsonl: withReference({ sheetName: 5 }), error: "extracted stage requires valid source reference sheetName" },
    { name: "blank sectionTitle", jsonl: withReference({ sectionTitle: "   " }), error: "extracted stage requires valid source reference sectionTitle" },
    { name: "non-string sourceText", jsonl: withReference({ sourceText: 125.4 }), error: "extracted stage requires valid source reference sourceText" },
    { name: "missing extractionMethod", jsonl: withReference({ extractionMethod: undefined }), error: "extracted stage requires source reference extractionMethod" },
    { name: "unsupported extractionMethod", jsonl: withReference({ extractionMethod: "telepathy" }), error: "extraction candidate source reference uses unsupported extractionMethod" },
    { name: "missing pageCoverageState", jsonl: withReference({ pageCoverageState: undefined }), error: "extracted stage requires source reference pageCoverageState" },
    { name: "string boundingBox", jsonl: withReference({ boundingBox: "top-left" }), error: "extraction candidate source reference boundingBox must be an object" },
    { name: "array boundingBox", jsonl: withReference({ boundingBox: [1, 2, 3, 4] }), error: "extraction candidate source reference boundingBox must be an object" },
    { name: "non-array fundContextIds", jsonl: withReference({ fundContextIds: "fund-a" }), error: "extracted stage requires source reference fundContextIds array" },
    { name: "blank fund context id", jsonl: withReference({ fundContextIds: ["fund-a", ""] }), error: "extracted stage requires source reference fundContextIds" },
    { name: "missing documentSegmentId", jsonl: withReference({ documentSegmentId: undefined }), error: "extracted stage requires source reference documentSegmentId" },
  ];
  for (const item of cases) {
    await t.test(item.name, () => assert.throws(() => parse(item.jsonl), { message: item.error }));
  }
});

test("candidate bundle normalises optional evidence fields and merges provenance deterministically", () => {
  const record = candidateRecord({
    provenance: { profileVersion: "gp-template-v3", skillId: "forged-skill", extractionPass: "reduced" },
    exceptionCodes: ["  unmapped_metric  "],
    sourceReferences: [
      sourceReference({
        referenceKey: "  sheet:summary:b4  ",
        pageNumber: null,
        sheetName: "  Summary  ",
        cellOrRange: " B4:C9 ",
        footnoteMarker: " (1) ",
        sectionTitle: undefined,
        tableTitle: undefined,
        rowLabel: undefined,
        columnLabel: undefined,
        sourceText: undefined,
        workUnitId: undefined,
        documentSegmentId: "segment-b",
        fundContextIds: ["fund-b", "fund-a", "fund-a"],
        extractionMethod: "spreadsheet_parser",
        pageCoverageState: "overlap_shared",
        boundingBox: { x: 1, y: 2, width: 3, height: 4 },
      }),
      sourceReference({ referenceKey: "page-2", pageNumber: 2, documentSegmentId: "segment-a", workUnitId: "work-2", fundContextIds: ["fund-c"] }),
      sourceReference({ referenceKey: "page-3", pageNumber: 3, documentSegmentId: "segment-a", workUnitId: "work-1", fundContextIds: [] }),
    ],
  });
  const [candidate] = parse(JSON.stringify(record));
  assert.ok(candidate);
  const [sheet, second] = candidate.sourceReferences;
  assert.equal(sheet?.referenceKey, "sheet:summary:b4");
  assert.equal(sheet?.pageNumber, undefined);
  assert.equal(sheet?.sheetName, "Summary");
  assert.equal(sheet?.cellOrRange, "B4:C9");
  assert.equal(sheet?.footnoteMarker, "(1)");
  assert.equal(sheet?.workUnitId, undefined);
  assert.deepEqual(sheet?.fundContextIds, ["fund-a", "fund-b"]);
  assert.deepEqual(sheet?.boundingBox, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(second?.boundingBox, undefined);
  assert.notEqual(sheet?.sourceReferenceId, second?.sourceReferenceId);
  assert.deepEqual(candidate.exceptionCodes, ["unmapped_metric"]);
  assert.deepEqual(candidate.provenance.documentSegmentIds, ["segment-a", "segment-b"]);
  assert.deepEqual(candidate.provenance.workUnitIds, ["work-1", "work-2"]);
  assert.deepEqual(candidate.provenance.fundContextIds, ["fund-a", "fund-b", "fund-c"]);
  assert.equal(candidate.provenance.profileVersion, "gp-template-v3");
  assert.equal(candidate.provenance.skillId, "quarterly_fund_report_extraction", "provider provenance cannot override governed lineage");
  assert.equal(candidate.provenance.representationGeneration, representation.storageGeneration);
  assert.equal(candidate.provenance.representationContentSha256, representationSha256);
  assert.equal(candidate.provenance.orchestrationManifestObjectUri, bundleFor(runIdentity.objectUri).orchestrationManifest.objectUri);
});

test("candidates that are not fund scoped need no fund attribution and default to no exception codes", () => {
  const [candidate] = parse(JSON.stringify(candidateRecord({
    candidateKey: "exception:unreadable-page",
    candidateType: "exception",
    exceptionCodes: undefined,
    sourceReferences: [sourceReference({ fundContextIds: [], workUnitId: undefined })],
  })));
  assert.equal(candidate?.candidateType, "exception");
  assert.deepEqual(candidate?.exceptionCodes, []);
  assert.deepEqual(candidate?.provenance.fundContextIds, []);
  assert.deepEqual(candidate?.provenance.workUnitIds, []);
});

test("candidate set hash is order-independent for object keys but sensitive to content", () => {
  const [candidate] = parse(candidateLine());
  assert.ok(candidate);
  const reordered: ExtractionCandidate = {
    sourceReferences: candidate.sourceReferences,
    exceptionCodes: candidate.exceptionCodes,
    provenance: candidate.provenance,
    confidence: candidate.confidence,
    payload: candidate.payload,
    candidateType: candidate.candidateType,
    candidateKey: candidate.candidateKey,
    candidateId: candidate.candidateId,
  };
  assert.equal(extractionCandidateSetSha256([reordered]), extractionCandidateSetSha256([candidate]));
  assert.notEqual(
    extractionCandidateSetSha256([{ ...candidate, payload: { ...candidate.payload, value_raw: "$1.0m" } }]),
    extractionCandidateSetSha256([candidate]),
  );
});

// ---------------------------------------------------------------------------
// HTTP extraction provider
// ---------------------------------------------------------------------------

type ProviderBody = Record<string, unknown> & { orchestrationManifest: Record<string, unknown> };

function providerBody(mutate: (body: ProviderBody) => void = () => undefined): string {
  const body = structuredClone(bundleFor(runIdentity.objectUri)) as unknown as ProviderBody;
  mutate(body);
  return JSON.stringify(body);
}

function providerInput(): Parameters<ExtractionProvider["extract"]>[0] {
  return {
    tenantId, documentId, artifactVersionId, representationId,
    representationType: representation.representationType,
    representationObjectUri: representation.objectUri,
    representationStorageGeneration: representation.storageGeneration,
    representationContentSha256: representation.contentSha256,
    extractionRunId: runIdentity.extractionRunId,
    outputObjectUri: runIdentity.objectUri,
    idempotencyKey: base.idempotencyKey,
    signal: new AbortController().signal,
  };
}

function httpProvider(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  options: { endpoint?: string; token?: () => Response } = {},
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("http://metadata.google.internal/")) return options.token ? options.token() : new Response("oidc-token", { status: 200 });
    return respond(url, init);
  };
  const provider = new HttpExtractionProvider({
    endpoint: options.endpoint ?? "https://extraction.example",
    audience: "https://extraction.example",
    timeoutMs: 5_000,
  }, fakeFetch);
  return { provider, calls };
}

test("provider requests a full identity token for its audience and posts to the normalised endpoint", async () => {
  const { provider, calls } = httpProvider(() => new Response(providerBody(), { status: 200 }), { endpoint: "https://extraction.example/" });
  const descriptor = await provider.extract(providerInput());
  assert.deepEqual(descriptor, bundleFor(runIdentity.objectUri));
  assert.equal(calls.length, 2);
  const identityUrl = new URL(calls[0]!.url);
  assert.equal(identityUrl.searchParams.get("audience"), "https://extraction.example");
  assert.equal(identityUrl.searchParams.get("format"), "full");
  assert.equal(new Headers(calls[0]!.init.headers).get("Metadata-Flavor"), "Google");
  assert.equal(calls[1]!.url, "https://extraction.example/v1/extractions");
  assert.equal(calls[1]!.init.method, "POST");
  const headers = new Headers(calls[1]!.init.headers);
  assert.equal(headers.get("x-corvis-idempotency-key"), base.idempotencyKey);
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
  assert.equal(body.extractionRunId, runIdentity.extractionRunId);
  assert.deepEqual(body.output, { objectUri: runIdentity.objectUri, format: "jsonl" });
});

test("provider upper-case hashes are normalised to lower case", async () => {
  const { provider } = httpProvider(() => new Response(providerBody((body) => {
    body.contentSha256 = bundleSha256.toUpperCase();
    body.orchestrationManifest.contentSha256 = manifestSha256.toUpperCase();
  }), { status: 200 }));
  const descriptor = await provider.extract(providerInput());
  assert.equal(descriptor.contentSha256, bundleSha256);
  assert.equal(descriptor.orchestrationManifest.contentSha256, manifestSha256);
});

test("provider fails when the identity token cannot be obtained", async () => {
  const unauthorised = httpProvider(() => new Response("{}"), { token: () => new Response("denied", { status: 403 }) });
  await assert.rejects(unauthorised.provider.extract(providerInput()), { message: "GCP extraction identity token request failed (403)" });
  assert.equal(unauthorised.calls.length, 1);

  const blank = httpProvider(() => new Response("{}"), { token: () => new Response("  \n", { status: 200 }) });
  await assert.rejects(blank.provider.extract(providerInput()), { message: "GCP extraction identity token response was empty" });
  assert.equal(blank.calls.length, 1);
});

test("provider fails on non-2xx responses and oversized or malformed bodies", async (t) => {
  const oversized = "x".repeat(64 * 1024 + 1);
  const cases: Array<{ name: string; response: () => Response; error: string }> = [
    { name: "service unavailable", response: () => new Response("busy", { status: 503 }), error: "extraction provider failed (503)" },
    { name: "declared content-length too large", response: () => new Response("{}", { status: 200, headers: { "content-length": String(64 * 1024 + 1) } }), error: "extraction provider response exceeds metadata limit" },
    { name: "unparseable content-length with oversized body", response: () => new Response(oversized, { status: 200, headers: { "content-length": "unknown" } }), error: "extraction provider response exceeds metadata limit" },
    { name: "not JSON", response: () => new Response("<html>", { status: 200 }), error: "extraction provider returned invalid JSON" },
    { name: "JSON array", response: () => new Response("[]", { status: 200 }), error: "extraction provider returned invalid JSON" },
    { name: "JSON null", response: () => new Response("null", { status: 200 }), error: "extraction provider returned invalid JSON" },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const { provider } = httpProvider(item.response);
      await assert.rejects(provider.extract(providerInput()), { message: item.error });
    });
  }
});

test("provider validates every descriptor field", async (t) => {
  const cases: Array<{ name: string; mutate: (body: ProviderBody) => void; error: string }> = [
    { name: "missing contentSha256", mutate: (body) => { delete body.contentSha256; }, error: "extracted stage requires provider contentSha256" },
    { name: "malformed contentSha256", mutate: (body) => { body.contentSha256 = "abc"; }, error: "extraction provider returned invalid content SHA-256" },
    { name: "missing orchestrationPolicyVersion", mutate: (body) => { delete body.orchestrationPolicyVersion; }, error: "extracted stage requires provider orchestrationPolicyVersion" },
    { name: "unsupported orchestrationPolicyVersion", mutate: (body) => { body.orchestrationPolicyVersion = "2"; }, error: "extraction provider returned unsupported orchestration policy version" },
    { name: "blank objectUri", mutate: (body) => { body.objectUri = " "; }, error: "extracted stage requires provider objectUri" },
    { name: "missing storageGeneration", mutate: (body) => { delete body.storageGeneration; }, error: "extracted stage requires provider storageGeneration" },
    { name: "negative sizeBytes", mutate: (body) => { body.sizeBytes = -1; }, error: "extracted stage requires valid provider sizeBytes" },
    { name: "missing producer", mutate: (body) => { delete body.producer; }, error: "extracted stage requires provider producer" },
    { name: "missing producerVersion", mutate: (body) => { delete body.producerVersion; }, error: "extracted stage requires provider producerVersion" },
    { name: "missing modelProvider", mutate: (body) => { delete body.modelProvider; }, error: "extracted stage requires provider modelProvider" },
    { name: "missing modelName", mutate: (body) => { delete body.modelName; }, error: "extracted stage requires provider modelName" },
    { name: "missing modelVersion", mutate: (body) => { delete body.modelVersion; }, error: "extracted stage requires provider modelVersion" },
    { name: "missing manifest", mutate: (body) => { delete (body as Record<string, unknown>).orchestrationManifest; }, error: "extraction provider requires orchestrationManifest object" },
    { name: "array manifest", mutate: (body) => { (body as Record<string, unknown>).orchestrationManifest = []; }, error: "extraction provider requires orchestrationManifest object" },
    { name: "manifest missing sha", mutate: (body) => { delete body.orchestrationManifest.contentSha256; }, error: "extracted stage requires orchestrationManifest.contentSha256" },
    { name: "manifest malformed sha", mutate: (body) => { body.orchestrationManifest.contentSha256 = "zz"; }, error: "extraction provider returned invalid orchestration manifest SHA-256" },
    { name: "manifest missing objectUri", mutate: (body) => { delete body.orchestrationManifest.objectUri; }, error: "extracted stage requires orchestrationManifest.objectUri" },
    { name: "manifest missing storageGeneration", mutate: (body) => { delete body.orchestrationManifest.storageGeneration; }, error: "extracted stage requires orchestrationManifest.storageGeneration" },
    { name: "manifest invalid sizeBytes", mutate: (body) => { body.orchestrationManifest.sizeBytes = "big"; }, error: "extracted stage requires valid orchestrationManifest.sizeBytes" },
    { name: "manifest invalid pageCount", mutate: (body) => { body.orchestrationManifest.pageCount = -2; }, error: "extracted stage requires valid orchestrationManifest.pageCount" },
    { name: "manifest invalid coveredPageCount", mutate: (body) => { body.orchestrationManifest.coveredPageCount = "x"; }, error: "extracted stage requires valid orchestrationManifest.coveredPageCount" },
    { name: "manifest zero documentSegmentCount", mutate: (body) => { body.orchestrationManifest.documentSegmentCount = 0; }, error: "extracted stage requires valid orchestrationManifest.documentSegmentCount" },
    { name: "manifest invalid workUnitCount", mutate: (body) => { body.orchestrationManifest.workUnitCount = -1; }, error: "extracted stage requires valid orchestrationManifest.workUnitCount" },
    { name: "manifest invalid unexplainedPageGapCount", mutate: (body) => { body.orchestrationManifest.unexplainedPageGapCount = -1; }, error: "extracted stage requires valid orchestrationManifest.unexplainedPageGapCount" },
    { name: "manifest invalid unresolvedMaterialAttributionCount", mutate: (body) => { body.orchestrationManifest.unresolvedMaterialAttributionCount = "n/a"; }, error: "extracted stage requires valid orchestrationManifest.unresolvedMaterialAttributionCount" },
    { name: "manifest not GCS", mutate: (body) => { body.orchestrationManifest.objectUri = "https://example.com/manifest.json"; }, error: "orchestration manifest is not authoritative GCS evidence" },
    { name: "manifest page gap with full coverage", mutate: (body) => { body.orchestrationManifest.unexplainedPageGapCount = 2; }, error: "extraction provider returned unexplained page gaps" },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const { provider } = httpProvider(() => new Response(providerBody(item.mutate), { status: 200 }));
      await assert.rejects(provider.extract(providerInput()), { message: item.error });
    });
  }
});

test("provider and reader default to the global fetch", async (t) => {
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity")) return new Response("global-oidc");
    if (url.startsWith("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token")) {
      return new Response(JSON.stringify({ access_token: "global-access", expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith("https://extraction.example/")) return new Response(providerBody(), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch);

  const provider = new HttpExtractionProvider({ endpoint: "https://extraction.example", audience: "https://extraction.example", timeoutMs: 5_000 });
  assert.equal((await provider.extract(providerInput())).objectUri, runIdentity.objectUri);

  const fixtureData = gcsFixture();
  const withStatic = new GcpExtractionBundleReader(outputBucket, { accessToken: "static" });
  await assert.rejects(withStatic.read(fixtureData.readInput), { message: "extraction candidate bundle is missing from GCS" });
  const withMetadataToken = new GcpExtractionBundleReader(outputBucket);
  await assert.rejects(withMetadataToken.read(fixtureData.readInput), { message: "extraction candidate bundle is missing from GCS" });
  assert.ok(seen.some((url) => url.endsWith("/service-accounts/default/token")));
  assert.equal(seen.filter((url) => url.startsWith("https://storage.googleapis.com/")).length, 2);
});

// ---------------------------------------------------------------------------
// GCS bundle reader
// ---------------------------------------------------------------------------

function gcsFixture() {
  const jsonl = `${candidateLine()}\n`;
  const descriptor = bundleFor(runIdentity.objectUri);
  descriptor.contentSha256 = createHash("sha256").update(jsonl).digest("hex");
  descriptor.sizeBytes = Buffer.byteLength(jsonl);
  const metadataBody = {
    generation: descriptor.storageGeneration,
    size: String(descriptor.sizeBytes),
    metadata: {
      "corvis-content-sha256": descriptor.contentSha256,
      "corvis-extraction-run-id": runIdentity.extractionRunId,
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
    } as Record<string, string>,
  };
  return {
    jsonl,
    descriptor,
    metadataBody,
    readInput: {
      descriptor,
      extractionRunId: runIdentity.extractionRunId,
      representationId,
      representationStorageGeneration: representation.storageGeneration,
      representationContentSha256: representation.contentSha256,
      signal: new AbortController().signal,
    },
  };
}

type GcsMetadataBody = ReturnType<typeof gcsFixture>["metadataBody"];

function gcsReader(
  data: ReturnType<typeof gcsFixture>,
  options: {
    mutateMetadata?: (body: GcsMetadataBody) => void;
    metadataStatus?: number;
    metadataBody?: unknown;
    mediaStatus?: number;
    mediaBody?: string;
    mediaHeaders?: Record<string, string>;
    accessToken?: string;
  } = {},
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("alt=media")) {
      return new Response(options.mediaBody ?? data.jsonl, { status: options.mediaStatus ?? 200, headers: options.mediaHeaders });
    }
    const body = structuredClone(data.metadataBody);
    options.mutateMetadata?.(body);
    return new Response(JSON.stringify(options.metadataBody ?? body), { status: options.metadataStatus ?? 200 });
  };
  return { reader: new GcpExtractionBundleReader(outputBucket, { fetchImpl: fakeFetch, accessToken: options.accessToken ?? "local-token" }), calls };
}

test("GCS reader pins reads to the immutable generation and accepts upper-case metadata hashes", async () => {
  const data = gcsFixture();
  const { reader, calls } = gcsReader(data, {
    mutateMetadata: (body) => {
      for (const key of ["corvis-content-sha256", "corvis-representation-sha256", "corvis-orchestration-manifest-sha256"]) {
        body.metadata[key] = body.metadata[key]!.toUpperCase();
      }
    },
  });
  assert.equal(await reader.read(data.readInput), data.jsonl);
  assert.equal(calls.length, 2);
  const metadataUrl = new URL(calls[0]!.url);
  assert.equal(metadataUrl.pathname, `/storage/v1/b/${outputBucket}/o/${encodeURIComponent(runIdentity.objectUri.slice(`gs://${outputBucket}/`.length))}`);
  assert.equal(metadataUrl.searchParams.get("fields"), "generation,size,metadata");
  assert.equal(metadataUrl.searchParams.get("generation"), data.descriptor.storageGeneration);
  const mediaUrl = new URL(calls[1]!.url);
  assert.equal(mediaUrl.searchParams.get("alt"), "media");
  assert.equal(mediaUrl.searchParams.get("generation"), data.descriptor.storageGeneration);
  assert.equal(new Headers(calls[1]!.init.headers).get("authorization"), "Bearer local-token");
});

test("GCS reader rejects descriptors that are not authoritative evidence in the configured bucket", async (t) => {
  const cases: Array<{ name: string; uri: string; error: string }> = [
    { name: "not a gs URI", uri: "https://storage.googleapis.com/b/o", error: "extraction bundle is not authoritative GCS evidence" },
    { name: "no object key separator", uri: "gs://bucket", error: "extraction bundle GCS URI is invalid" },
    { name: "empty bucket", uri: "gs:///key.jsonl", error: "extraction bundle GCS URI is invalid" },
    { name: "empty object key", uri: `gs://${outputBucket}/`, error: "extraction bundle GCS URI is invalid" },
    { name: "foreign bucket", uri: "gs://other-bucket/key.jsonl", error: "extraction bundle is outside the configured GCS evidence bucket" },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const data = gcsFixture();
      data.descriptor.objectUri = item.uri;
      const { reader, calls } = gcsReader(data);
      await assert.rejects(reader.read(data.readInput), { message: item.error });
      assert.equal(calls.length, 0);
    });
  }

  await t.test("descriptor larger than the maximum bundle size", async () => {
    const data = gcsFixture();
    data.descriptor.sizeBytes = 32 * 1024 * 1024 + 1;
    const { reader, calls } = gcsReader(data);
    await assert.rejects(reader.read(data.readInput), { message: "extraction candidate bundle exceeds maximum size" });
    assert.equal(calls.length, 0);
  });
});

test("GCS reader fails closed on metadata that does not match the immutable lineage", async (t) => {
  const meta = (key: string, value: string | undefined) => (body: GcsMetadataBody) => {
    if (value === undefined) delete body.metadata[key];
    else body.metadata[key] = value;
  };
  const cases: Array<{ name: string; mutate: (body: GcsMetadataBody) => void; error: string }> = [
    { name: "generation", mutate: (body) => { body.generation = "1"; }, error: "extraction bundle GCS generation mismatch" },
    { name: "size", mutate: (body) => { body.size = "1"; }, error: "extraction bundle GCS size mismatch" },
    { name: "content hash", mutate: meta("corvis-content-sha256", "e".repeat(64)), error: "extraction bundle GCS content hash mismatch" },
    { name: "missing content hash", mutate: meta("corvis-content-sha256", undefined), error: "extraction bundle GCS content hash mismatch" },
    { name: "run identity", mutate: meta("corvis-extraction-run-id", "other-run"), error: "extraction bundle GCS run identity mismatch" },
    { name: "representation id", mutate: meta("corvis-representation-id", "other-representation"), error: "extraction bundle GCS representation mismatch" },
    { name: "representation generation", mutate: meta("corvis-representation-generation", "1"), error: "extraction bundle GCS representation generation mismatch" },
    { name: "representation hash", mutate: meta("corvis-representation-sha256", "e".repeat(64)), error: "extraction bundle GCS representation hash mismatch" },
    { name: "missing representation hash", mutate: meta("corvis-representation-sha256", undefined), error: "extraction bundle GCS representation hash mismatch" },
    { name: "skill id", mutate: meta("corvis-skill-id", "other_skill"), error: "extraction bundle GCS skill contract mismatch" },
    { name: "skill version", mutate: meta("corvis-skill-version", "2.0"), error: "extraction bundle GCS skill contract mismatch" },
    { name: "schema version", mutate: meta("corvis-schema-version", "1.5"), error: "extraction bundle GCS schema contract mismatch" },
    { name: "orchestration policy", mutate: meta("corvis-orchestration-policy-version", "2"), error: "extraction bundle GCS orchestration policy mismatch" },
    { name: "manifest uri", mutate: meta("corvis-orchestration-manifest-uri", `gs://${outputBucket}/other.json`), error: "extraction bundle GCS orchestration manifest URI mismatch" },
    { name: "manifest generation", mutate: meta("corvis-orchestration-manifest-generation", "1"), error: "extraction bundle GCS orchestration manifest generation mismatch" },
    { name: "manifest hash", mutate: meta("corvis-orchestration-manifest-sha256", "e".repeat(64)), error: "extraction bundle GCS orchestration manifest hash mismatch" },
    { name: "missing manifest hash", mutate: meta("corvis-orchestration-manifest-sha256", undefined), error: "extraction bundle GCS orchestration manifest hash mismatch" },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const data = gcsFixture();
      const { reader, calls } = gcsReader(data, { mutateMetadata: item.mutate });
      await assert.rejects(reader.read(data.readInput), { message: item.error });
      assert.equal(calls.length, 1, "the media body is never fetched when metadata is wrong");
    });
  }

  await t.test("object without custom metadata", async () => {
    const data = gcsFixture();
    const { reader } = gcsReader(data, { metadataBody: { generation: data.descriptor.storageGeneration, size: String(data.descriptor.sizeBytes) } });
    await assert.rejects(reader.read(data.readInput), { message: "extraction bundle GCS content hash mismatch" });
  });

  await t.test("object missing from GCS", async () => {
    const data = gcsFixture();
    const { reader } = gcsReader(data, { metadataStatus: 404 });
    await assert.rejects(reader.read(data.readInput), { message: "extraction candidate bundle is missing from GCS" });
  });

  await t.test("metadata read failure", async () => {
    const data = gcsFixture();
    const { reader } = gcsReader(data, { metadataStatus: 500 });
    await assert.rejects(reader.read(data.readInput), { message: "GCS extraction metadata read failed (500)" });
  });
});

test("GCS reader fails closed on bundle bodies that do not match immutable metadata", async (t) => {
  await t.test("media read failure", async () => {
    const data = gcsFixture();
    const { reader } = gcsReader(data, { mediaStatus: 502 });
    await assert.rejects(reader.read(data.readInput), { message: "GCS extraction bundle read failed (502)" });
  });

  await t.test("declared content-length above the maximum", async () => {
    const data = gcsFixture();
    const { reader } = gcsReader(data, { mediaHeaders: { "content-length": String(32 * 1024 * 1024 + 1) } });
    await assert.rejects(reader.read(data.readInput), { message: "extraction candidate bundle exceeds maximum size" });
  });

  await t.test("unparseable content-length falls back to the exact size check", async () => {
    const data = gcsFixture();
    const { reader } = gcsReader(data, { mediaHeaders: { "content-length": "unknown" } });
    assert.equal(await reader.read(data.readInput), data.jsonl);
  });

  await t.test("body shorter than the recorded size", async () => {
    const data = gcsFixture();
    const { reader } = gcsReader(data, { mediaBody: data.jsonl.slice(0, -2) });
    await assert.rejects(reader.read(data.readInput), { message: "extraction bundle body size does not match immutable metadata" });
  });

  await t.test("same-size body with a different hash", async () => {
    const data = gcsFixture();
    const tampered = `${"x".repeat(data.descriptor.sizeBytes - 1)}\n`;
    assert.equal(Buffer.byteLength(tampered), data.descriptor.sizeBytes);
    const { reader } = gcsReader(data, { mediaBody: tampered });
    await assert.rejects(reader.read(data.readInput), { message: "extraction bundle body hash does not match immutable metadata" });
  });
});

test("GCS reader obtains, caches and refreshes metadata-server access tokens", async (t) => {
  const tokenCalls = { count: 0 };
  function tokenReader(tokenBody: () => Response, data = gcsFixture()) {
    const fakeFetch: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith("http://metadata.google.internal/")) {
        tokenCalls.count += 1;
        assert.equal(new Headers(init.headers).get("Metadata-Flavor"), "Google");
        return tokenBody();
      }
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${tokenCalls.count === 1 ? "first-token" : `token-${tokenCalls.count}`}`);
      return new Response("{}", { status: 404 });
    };
    return { reader: new GcpExtractionBundleReader(outputBucket, { fetchImpl: fakeFetch }), data };
  }
  const missing = { message: "extraction candidate bundle is missing from GCS" };

  await t.test("a long-lived token is fetched once and reused", async () => {
    tokenCalls.count = 0;
    const { reader, data } = tokenReader(() => new Response(JSON.stringify({ access_token: "first-token", expires_in: 3600 })));
    await assert.rejects(reader.read(data.readInput), missing);
    await assert.rejects(reader.read(data.readInput), missing);
    assert.equal(tokenCalls.count, 1);
  });

  await t.test("a token without expires_in defaults to five minutes and is reused", async () => {
    tokenCalls.count = 0;
    const { reader, data } = tokenReader(() => new Response(JSON.stringify({ access_token: "first-token" })));
    await assert.rejects(reader.read(data.readInput), missing);
    await assert.rejects(reader.read(data.readInput), missing);
    assert.equal(tokenCalls.count, 1);
  });

  await t.test("a token about to expire is refreshed on the next read", async () => {
    tokenCalls.count = 0;
    const { reader, data } = tokenReader(() => new Response(JSON.stringify({ access_token: tokenCalls.count === 1 ? "first-token" : `token-${tokenCalls.count}`, expires_in: 1 })));
    await assert.rejects(reader.read(data.readInput), missing);
    await assert.rejects(reader.read(data.readInput), missing);
    assert.equal(tokenCalls.count, 2);
  });

  await t.test("token endpoint failure", async () => {
    const { reader, data } = tokenReader(() => new Response("nope", { status: 500 }));
    await assert.rejects(reader.read(data.readInput), { message: "GCP extraction GCS token response failed (500)" });
  });

  await t.test("token response without access_token", async () => {
    const { reader, data } = tokenReader(() => new Response(JSON.stringify({ expires_in: 3600 })));
    await assert.rejects(reader.read(data.readInput), { message: "GCP extraction GCS token response was empty" });
  });
});

// ---------------------------------------------------------------------------
// Configuration and wiring
// ---------------------------------------------------------------------------

test("extraction provider configuration validates its environment and clamps timeouts", () => {
  const env = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv => ({
    NODE_ENV: "test",
    CORVIS_EXTRACTION_ENDPOINT: "https://extraction.example",
    CORVIS_OBJECT_STORE_BUCKET: outputBucket,
    ...extra,
  });
  assert.equal(configuredExtractionProviderConfig(env({ CORVIS_EXTRACTION_ENDPOINT: "   " })), undefined);
  assert.throws(
    () => configuredExtractionProviderConfig(env({ CORVIS_OBJECT_STORE_BUCKET: "  " })),
    { message: "CORVIS_OBJECT_STORE_BUCKET is required when extraction processing is enabled" },
  );
  assert.throws(
    () => configuredExtractionProviderConfig(env({ CORVIS_OBJECT_STORE_BUCKET: undefined })),
    { message: "CORVIS_OBJECT_STORE_BUCKET is required when extraction processing is enabled" },
  );
  assert.deepEqual(configuredExtractionProviderConfig(env({
    CORVIS_EXTRACTION_ENDPOINT: "  https://extraction.example  ",
    CORVIS_EXTRACTION_AUDIENCE: " https://audience.example ",
    CORVIS_OBJECT_STORE_BUCKET: ` ${outputBucket} `,
    CORVIS_EXTRACTION_TIMEOUT_MS: "30000",
  })), {
    endpoint: "https://extraction.example",
    audience: "https://audience.example",
    outputBucket,
    timeoutMs: 30_000,
  });
  for (const timeout of [undefined, "", "abc", "0", "-5", "1.5"]) {
    assert.equal(
      configuredExtractionProviderConfig(env({ CORVIS_EXTRACTION_TIMEOUT_MS: timeout }))?.timeoutMs,
      15_000,
      `timeout ${String(timeout)} falls back to the default`,
    );
  }
  assert.equal(configuredExtractionProviderConfig(env({ CORVIS_EXTRACTION_TIMEOUT_MS: "480000" }))?.timeoutMs, 480_000);
  assert.equal(configuredExtractionProviderConfig(env({ CORVIS_EXTRACTION_TIMEOUT_MS: "480001" }))?.timeoutMs, 480_000);
});

test("extraction provider configuration reads process.env by default", () => {
  withEnv({ CORVIS_EXTRACTION_ENDPOINT: undefined }, () => {
    assert.equal(configuredExtractionProviderConfig(), undefined);
  });
  withEnv({
    CORVIS_EXTRACTION_ENDPOINT: "https://process-env.example",
    CORVIS_OBJECT_STORE_BUCKET: outputBucket,
    CORVIS_EXTRACTION_AUDIENCE: undefined,
    CORVIS_EXTRACTION_TIMEOUT_MS: undefined,
  }, () => {
    assert.deepEqual(configuredExtractionProviderConfig(), {
      endpoint: "https://process-env.example",
      audience: "https://process-env.example",
      outputBucket,
      timeoutMs: 15_000,
    });
  });
});

test("configured extracted stage handler is only created when extraction is enabled", async () => {
  const db = new FakePostgres();
  assert.equal(createConfiguredExtractedStageHandler(db, { NODE_ENV: "test" }), undefined);

  const handler = createConfiguredExtractedStageHandler(db, {
    NODE_ENV: "test",
    CORVIS_EXTRACTION_ENDPOINT: "https://extraction.example",
    CORVIS_OBJECT_STORE_BUCKET: outputBucket,
    CORVIS_GCP_ACCESS_TOKEN: "static-token",
  });
  assert.equal(typeof handler, "function");
  await assert.rejects(
    handler!({ ...base, stage: "registered" }, new AbortController().signal),
    { message: "extracted document handler cannot execute stage registered" },
  );
  assert.equal(db.calls.length, 0);

  await withEnv({
    CORVIS_EXTRACTION_ENDPOINT: "https://extraction.example",
    CORVIS_OBJECT_STORE_BUCKET: outputBucket,
    CORVIS_GCP_ACCESS_TOKEN: undefined,
  }, async () => {
    const fromProcessEnv = createConfiguredExtractedStageHandler(db);
    assert.equal(typeof fromProcessEnv, "function");
    // Wired to the Postgres repository: a missing representation is looked up by tenant/document/representation.
    await assert.rejects(
      fromProcessEnv!(base, new AbortController().signal),
      { message: "extracted stage representation was not found" },
    );
  });
  assert.deepEqual(db.calls[0]?.parameters, [tenantId, documentId, representationId]);
});

// ---------------------------------------------------------------------------
// Postgres repository
// ---------------------------------------------------------------------------

type Route = { match: RegExp; rows: PostgresRow[] | ((parameters: PostgresPrimitive[]) => PostgresRow[]) };

class RoutedPostgres implements PostgresSqlApi {
  readonly calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  private readonly routes: Route[];
  constructor(routes: Route[] = []) { this.routes = routes; }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    const route = this.routes.find((candidate) => candidate.match.test(sql));
    if (!route) return [];
    return typeof route.rows === "function" ? route.rows(parameters) : route.rows;
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

function runRow(bundle: ExtractionBundleDescriptor, overrides: PostgresRow = {}): PostgresRow {
  const manifest = bundle.orchestrationManifest;
  return {
    document_id: documentId,
    document_artifact_version_id: artifactVersionId,
    representation_id: representationId,
    extraction_contract_version: "1",
    schema_version: "1.6",
    skill_id: "quarterly_fund_report_extraction",
    skill_version: "2.1",
    bundle_object_uri: bundle.objectUri,
    bundle_storage_generation: bundle.storageGeneration,
    bundle_content_sha256: bundle.contentSha256.toUpperCase(),
    bundle_size_bytes: String(bundle.sizeBytes),
    producer: bundle.producer,
    producer_version: bundle.producerVersion,
    model_provider: bundle.modelProvider,
    model_name: bundle.modelName,
    model_version: bundle.modelVersion,
    orchestration_policy_version: bundle.orchestrationPolicyVersion,
    orchestration_manifest_object_uri: manifest.objectUri,
    orchestration_manifest_storage_generation: manifest.storageGeneration,
    orchestration_manifest_content_sha256: manifest.contentSha256.toUpperCase(),
    orchestration_manifest_size_bytes: String(manifest.sizeBytes),
    page_count: String(manifest.pageCount),
    covered_page_count: String(manifest.coveredPageCount),
    document_segment_count: String(manifest.documentSegmentCount),
    work_unit_count: String(manifest.workUnitCount),
    unexplained_page_gap_count: String(manifest.unexplainedPageGapCount),
    unresolved_material_attribution_count: String(manifest.unresolvedMaterialAttributionCount),
    ...overrides,
  };
}

test("Postgres repository reports a missing representation and defaults absent columns", async () => {
  const empty = new PostgresExtractionCandidateRepository(new FakePostgres());
  assert.equal(await empty.findRepresentation({ tenantId, documentId, representationId }), undefined);

  const db = new FakePostgres();
  db.rows = [{ representation_id: representationId, content_sha256: "ABCDEF".padEnd(64, "0"), size_bytes: "8192" }];
  const sparse = await new PostgresExtractionCandidateRepository(db).findRepresentation({ tenantId, documentId, representationId });
  assert.deepEqual(sparse, {
    representationId,
    artifactVersionId: "",
    representationType: "",
    objectUri: "",
    storageGeneration: "",
    contentSha256: "abcdef".padEnd(64, "0"),
    sizeBytes: 8192,
    producer: "",
    producerVersion: "",
    method: "",
    status: "",
  });

  db.rows = [{ representation_id: representationId, size_bytes: null }];
  const unsized = await new PostgresExtractionCandidateRepository(db).findRepresentation({ tenantId, documentId, representationId });
  assert.equal(unsized?.sizeBytes, -1);
  assert.equal(unsized?.contentSha256, "");
});

test("Postgres repository begins a run idempotently and verifies the stored lineage", async () => {
  const bundle = bundleFor(runIdentity.objectUri);
  bundle.contentSha256 = bundleSha256.toUpperCase();
  bundle.orchestrationManifest.contentSha256 = manifestSha256.toUpperCase();
  const db = new RoutedPostgres([{ match: /select \* from corvis_source\.extraction_run/, rows: [runRow(bundle)] }]);
  const repository = new PostgresExtractionCandidateRepository(db);
  await repository.beginRun({
    tenantId, documentId, artifactVersionId, representationId, extractionRunId: runIdentity.extractionRunId, bundle,
  });
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[0]!.sql, /^insert into corvis_source\.extraction_run/);
  assert.match(db.calls[0]!.sql, /on conflict \(tenant_id,extraction_run_id\) do nothing/);
  assert.deepEqual(db.calls[0]!.parameters, [
    tenantId, runIdentity.extractionRunId, documentId, artifactVersionId, representationId,
    "1", "1.6", "quarterly_fund_report_extraction", "2.1", bundle.objectUri,
    bundle.storageGeneration, bundleSha256, bundle.sizeBytes,
    bundle.producer, bundle.producerVersion, bundle.modelProvider,
    bundle.modelName, bundle.modelVersion, "1",
    bundle.orchestrationManifest.objectUri, bundle.orchestrationManifest.storageGeneration, manifestSha256, bundle.orchestrationManifest.sizeBytes,
    320, 320, 6, 9, 0, 0,
  ]);
  assert.match(db.calls[1]!.sql, /select \* from corvis_source\.extraction_run/);
  assert.deepEqual(db.calls[1]!.parameters, [tenantId, runIdentity.extractionRunId]);
});

test("Postgres repository refuses runs that vanished or conflict with immutable lineage", async (t) => {
  const bundle = bundleFor(runIdentity.objectUri);
  const input = { tenantId, documentId, artifactVersionId, representationId, extractionRunId: runIdentity.extractionRunId, bundle };
  const conflict = "existing extraction run conflicts with immutable extraction lineage";

  await t.test("run row missing after insert", async () => {
    const repository = new PostgresExtractionCandidateRepository(new RoutedPostgres());
    await assert.rejects(repository.beginRun(input), { message: "extracted stage could not persist extraction run" });
  });

  await t.test("row with every lineage column absent", async () => {
    const repository = new PostgresExtractionCandidateRepository(new RoutedPostgres([{ match: /select \*/, rows: [{ unrelated: "value" }] }]));
    await assert.rejects(repository.beginRun(input), { message: conflict });
  });

  const drifts: Array<[string, PostgresRow]> = [
    ["document", { document_id: "99999999-9999-4999-8999-999999999999" }],
    ["bundle uri", { bundle_object_uri: `gs://${outputBucket}/other.jsonl` }],
    ["bundle hash", { bundle_content_sha256: "e".repeat(64) }],
    ["bundle size", { bundle_size_bytes: "1" }],
    ["model version", { model_version: "2020-01-01" }],
    ["manifest hash", { orchestration_manifest_content_sha256: "e".repeat(64) }],
    ["page count", { page_count: "321" }],
    ["unexplained gaps", { unexplained_page_gap_count: "1" }],
  ];
  for (const [name, override] of drifts) {
    await t.test(`${name} drift`, async () => {
      const repository = new PostgresExtractionCandidateRepository(new RoutedPostgres([{ match: /select \*/, rows: [runRow(bundle, override)] }]));
      await assert.rejects(repository.beginRun(input), { message: conflict });
    });
  }
});

function evidenceCandidate(): ExtractionCandidate {
  const [candidate] = parse(JSON.stringify(candidateRecord({
    exceptionCodes: ["unmapped_metric"],
    sourceReferences: [
      sourceReference({
        referenceKey: "page-18:revenue",
        pageNumber: 18,
        sheetName: "Summary",
        cellOrRange: "B4:C9",
        footnoteMarker: "(1)",
        boundingBox: { x: 1, y: 2, width: 3, height: 4 },
      }),
      sourceReference({
        referenceKey: "sheet:minimal",
        pageNumber: null,
        sheetName: "Minimal",
        sectionTitle: undefined,
        tableTitle: undefined,
        rowLabel: undefined,
        columnLabel: undefined,
        sourceText: undefined,
        workUnitId: undefined,
        extractionMethod: "spreadsheet_parser",
        pageCoverageState: "excluded",
        fundContextIds: ["fund-a", "fund-b"],
      }),
      sourceReference({ referenceKey: "page-20:plain", pageNumber: 20 }),
    ],
  })));
  return candidate!;
}

function candidateRow(candidate: ExtractionCandidate, asJson: boolean, overrides: PostgresRow = {}): PostgresRow {
  const wrap = (value: unknown) => asJson ? JSON.stringify(value) : value;
  return {
    candidate_key: candidate.candidateKey,
    candidate_type: candidate.candidateType,
    payload: wrap(candidate.payload),
    confidence: wrap(candidate.confidence),
    provenance: wrap(candidate.provenance),
    exception_codes: wrap(candidate.exceptionCodes),
    review_status: "candidate",
    source_reference_count: String(candidate.sourceReferences.length),
    ...overrides,
  };
}

function referenceRow(reference: ExtractionSourceReference, asJson: boolean, overrides: PostgresRow = {}): PostgresRow {
  const wrap = (value: unknown) => asJson ? JSON.stringify(value) : value;
  return {
    reference_key: reference.referenceKey,
    page_number: reference.pageNumber === undefined ? null : String(reference.pageNumber),
    sheet_name: reference.sheetName ?? null,
    section_title: reference.sectionTitle ?? null,
    table_title: reference.tableTitle ?? null,
    row_label: reference.rowLabel ?? null,
    column_label: reference.columnLabel ?? null,
    cell_or_range: reference.cellOrRange ?? null,
    footnote_marker: reference.footnoteMarker ?? null,
    source_text: reference.sourceText ?? null,
    document_segment_id: reference.documentSegmentId,
    work_unit_id: reference.workUnitId ?? null,
    fund_context_ids: wrap(reference.fundContextIds),
    page_coverage_state: reference.pageCoverageState,
    extraction_method: reference.extractionMethod,
    bounding_box: reference.boundingBox ? wrap(reference.boundingBox) : null,
    ...overrides,
  };
}

function candidateDb(candidate: ExtractionCandidate, asJson: boolean, options: {
  candidateRows?: PostgresRow[];
  referenceRows?: (reference: ExtractionSourceReference) => PostgresRow[];
} = {}): RoutedPostgres {
  return new RoutedPostgres([
    { match: /^select candidate_key/, rows: options.candidateRows ?? [candidateRow(candidate, asJson)] },
    {
      match: /^select reference_key/,
      rows: (parameters) => {
        const reference = candidate.sourceReferences.find((entry) => entry.sourceReferenceId === parameters[2])!;
        return options.referenceRows ? options.referenceRows(reference) : [referenceRow(reference, asJson)];
      },
    },
  ]);
}

function saveInput(candidate: ExtractionCandidate) {
  return { tenantId, documentId, representationId, extractionRunId: runIdentity.extractionRunId, candidate };
}

for (const asJson of [false, true]) {
  test(`Postgres repository persists a candidate and its evidence and verifies the stored rows (${asJson ? "json text" : "decoded jsonb"})`, async () => {
    const candidate = evidenceCandidate();
    const db = candidateDb(candidate, asJson);
    await new PostgresExtractionCandidateRepository(db).saveCandidate(saveInput(candidate));

    assert.equal(db.calls.length, 8);
    assert.match(db.calls[0]!.sql, /^insert into corvis_source\.extraction_candidate \(/);
    assert.match(db.calls[0]!.sql, /on conflict \(tenant_id,extraction_run_id,candidate_id\) do nothing/);
    assert.deepEqual(db.calls[0]!.parameters, [
      tenantId, runIdentity.extractionRunId, candidate.candidateId, candidate.candidateKey,
      documentId, representationId, "metric_observation",
      JSON.stringify(candidate.payload), JSON.stringify(candidate.confidence), JSON.stringify(candidate.provenance),
      JSON.stringify(["unmapped_metric"]), 3,
    ]);
    assert.match(db.calls[1]!.sql, /^select candidate_key/);
    assert.deepEqual(db.calls[1]!.parameters, [tenantId, runIdentity.extractionRunId, candidate.candidateId]);

    const [full, minimal, plain] = candidate.sourceReferences;
    assert.match(db.calls[2]!.sql, /^insert into corvis_source\.extraction_candidate_source_reference/);
    assert.match(db.calls[2]!.sql, /on conflict \(tenant_id,extraction_run_id,source_reference_id\) do nothing/);
    assert.deepEqual(db.calls[2]!.parameters, [
      tenantId, runIdentity.extractionRunId, candidate.candidateId, full!.sourceReferenceId,
      "page-18:revenue", documentId, representationId, 18,
      "Summary", "Fund A — Portfolio Company Summary", "Operating Performance",
      "Revenue", "LTM Jun-26", "B4:C9", "(1)",
      "$125.4m", "segment-fund-a",
      "work-fund-a-portfolio", JSON.stringify(["fund-a"]), "primary", "table_parser", JSON.stringify({ x: 1, y: 2, width: 3, height: 4 }),
    ]);
    assert.deepEqual(db.calls[3]!.parameters, [tenantId, runIdentity.extractionRunId, full!.sourceReferenceId]);
    assert.deepEqual(db.calls[4]!.parameters, [
      tenantId, runIdentity.extractionRunId, candidate.candidateId, minimal!.sourceReferenceId,
      "sheet:minimal", documentId, representationId, null,
      "Minimal", null, null,
      null, null, null, null,
      null, "segment-fund-a",
      null, JSON.stringify(["fund-a", "fund-b"]), "excluded", "spreadsheet_parser", null,
    ]);
    assert.deepEqual(db.calls[5]!.parameters, [tenantId, runIdentity.extractionRunId, minimal!.sourceReferenceId]);
    assert.deepEqual(db.calls[6]!.parameters, [
      tenantId, runIdentity.extractionRunId, candidate.candidateId, plain!.sourceReferenceId,
      "page-20:plain", documentId, representationId, 20,
      null, "Fund A — Portfolio Company Summary", "Operating Performance",
      "Revenue", "LTM Jun-26", null, null,
      "$125.4m", "segment-fund-a",
      "work-fund-a-portfolio", JSON.stringify(["fund-a"]), "primary", "table_parser", null,
    ]);
    assert.deepEqual(db.calls[7]!.parameters, [tenantId, runIdentity.extractionRunId, plain!.sourceReferenceId]);
  });
}

test("Postgres repository saves a candidate without evidence rows when none are attached", async () => {
  const candidate = { ...evidenceCandidate(), sourceReferences: [] };
  const db = candidateDb(candidate, false);
  await new PostgresExtractionCandidateRepository(db).saveCandidate(saveInput(candidate));
  assert.equal(db.calls.length, 2);
  assert.equal(db.calls[0]!.parameters[11], 0);
});

test("Postgres repository refuses candidates that vanished or conflict with deterministic state", async (t) => {
  const candidate = evidenceCandidate();
  const conflict = "existing extraction candidate conflicts with deterministic candidate state";
  const save = (db: RoutedPostgres) => new PostgresExtractionCandidateRepository(db).saveCandidate(saveInput(candidate));

  await t.test("candidate row missing after insert", async () => {
    await assert.rejects(save(candidateDb(candidate, false, { candidateRows: [] })), { message: "extracted stage could not persist extraction candidate" });
  });

  await t.test("persisted jsonb that is not valid JSON text is compared verbatim and rejected", async () => {
    await assert.rejects(save(candidateDb(candidate, true, { candidateRows: [candidateRow(candidate, true, { payload: "{broken" })] })), { message: conflict });
  });

  await t.test("row with every column absent", async () => {
    await assert.rejects(save(candidateDb(candidate, false, { candidateRows: [{ unrelated: true }] })), { message: conflict });
  });

  const drifts: Array<[string, PostgresRow]> = [
    ["candidate key", { candidate_key: "metric:other" }],
    ["candidate type", { candidate_type: "fund" }],
    ["payload", { payload: { value_raw: "$1.0m" } }],
    ["confidence", { confidence: { value: 0.1 } }],
    ["provenance", { provenance: { extractionPass: "other" } }],
    ["exception codes", { exception_codes: [] }],
    ["review status", { review_status: "approved" }],
    ["source reference count", { source_reference_count: "1" }],
    ["missing source reference count", { source_reference_count: null }],
  ];
  for (const [name, override] of drifts) {
    await t.test(`${name} drift`, async () => {
      await assert.rejects(save(candidateDb(candidate, false, { candidateRows: [candidateRow(candidate, false, override)] })), { message: conflict });
    });
  }
});

test("Postgres repository refuses source evidence that vanished or conflicts with deterministic state", async (t) => {
  const candidate = evidenceCandidate();
  const conflict = "existing candidate source evidence conflicts with deterministic evidence state";
  const saveWith = (referenceRows: (reference: ExtractionSourceReference) => PostgresRow[]) =>
    new PostgresExtractionCandidateRepository(candidateDb(candidate, false, { referenceRows })).saveCandidate(saveInput(candidate));

  await t.test("evidence row missing after insert", async () => {
    await assert.rejects(saveWith(() => []), { message: "extracted stage could not persist candidate source evidence" });
  });

  await t.test("persisted jsonb that is not valid JSON text is compared verbatim and rejected", async () => {
    await assert.rejects(saveWith((reference) => [referenceRow(reference, true, { fund_context_ids: "[not json" })]), { message: conflict });
  });

  await t.test("row with every column absent", async () => {
    await assert.rejects(saveWith(() => [{ unrelated: true }]), { message: conflict });
  });

  const drifts: Array<[string, PostgresRow]> = [
    ["reference key", { reference_key: "page-99:other" }],
    ["page number", { page_number: "19" }],
    ["sheet name", { sheet_name: "Other" }],
    ["section title", { section_title: "Other" }],
    ["table title", { table_title: "Other" }],
    ["row label", { row_label: "Other" }],
    ["column label", { column_label: "Other" }],
    ["cell range", { cell_or_range: "Z1" }],
    ["footnote marker", { footnote_marker: "(2)" }],
    ["source text", { source_text: "$1.0m" }],
    ["document segment", { document_segment_id: "segment-other" }],
    ["work unit", { work_unit_id: "work-other" }],
    ["fund contexts", { fund_context_ids: ["fund-z"] }],
    ["page coverage", { page_coverage_state: "excluded" }],
    ["extraction method", { extraction_method: "ocr" }],
    ["bounding box", { bounding_box: { x: 9 } }],
  ];
  for (const [name, override] of drifts) {
    await t.test(`${name} drift`, async () => {
      await assert.rejects(
        saveWith((reference) => reference.referenceKey === "page-18:revenue" ? [referenceRow(reference, false, override)] : [referenceRow(reference, false)]),
        { message: conflict },
      );
    });
  }

  for (const [column, label] of [
    ["sheet_name", "persisted sheet name"],
    ["section_title", "persisted section title"],
    ["table_title", "persisted table title"],
    ["row_label", "persisted row label"],
    ["column_label", "persisted column label"],
    ["cell_or_range", "persisted cell range"],
    ["footnote_marker", "persisted footnote marker"],
    ["source_text", "persisted source text"],
    ["work_unit_id", "persisted work unit id"],
  ] as const) {
    await t.test(`corrupt ${label}`, async () => {
      await assert.rejects(
        saveWith((reference) => [referenceRow(reference, false, { [column]: "   " })]),
        { message: `extracted stage requires valid ${label}` },
      );
    });
  }
});

test("Postgres repository finalises a run only when the persisted candidate set is complete", async (t) => {
  const finalize = { tenantId, extractionRunId: runIdentity.extractionRunId, candidateCount: 3, candidateSetSha256: "f".repeat(64) };
  const ready = { status: "ready", candidate_count: "3", candidate_set_sha256: "f".repeat(64) };
  const dbWith = (counts: PostgresRow[], updated: PostgresRow[]) => new RoutedPostgres([
    { match: /count\(\*\)::integer/, rows: counts },
    { match: /^update corvis_source\.extraction_run/, rows: updated },
  ]);
  const run = (db: RoutedPostgres) => new PostgresExtractionCandidateRepository(db).finalizeRun(finalize);
  const incomplete = { message: "extracted stage candidate persistence is incomplete" };
  const conflict = { message: "existing extraction run conflicts with finalized candidate set or incomplete orchestration coverage" };

  await t.test("complete set is marked ready", async () => {
    const db = dbWith([{ candidate_count: 3 }], [ready]);
    await run(db);
    assert.equal(db.calls.length, 2);
    assert.match(db.calls[0]!.sql, /from corvis_source\.extraction_candidate where tenant_id=\$1::uuid and extraction_run_id=\$2::uuid/);
    assert.deepEqual(db.calls[0]!.parameters, [tenantId, runIdentity.extractionRunId]);
    assert.match(db.calls[1]!.sql, /unexplained_page_gap_count=0 and unresolved_material_attribution_count=0/);
    assert.match(db.calls[1]!.sql, /page_count=covered_page_count/);
    assert.deepEqual(db.calls[1]!.parameters, [tenantId, runIdentity.extractionRunId, 3, "f".repeat(64)]);
  });

  await t.test("too few persisted candidates", async () => {
    const db = dbWith([{ candidate_count: 2 }], [ready]);
    await assert.rejects(run(db), incomplete);
    assert.equal(db.calls.length, 1, "the run is never marked ready");
  });

  await t.test("count query returning nothing", async () => {
    await assert.rejects(run(dbWith([], [ready])), incomplete);
  });

  await t.test("count query returning a null count", async () => {
    await assert.rejects(run(dbWith([{ candidate_count: null }], [ready])), incomplete);
  });

  await t.test("run not updatable (coverage gaps or lineage conflict)", async () => {
    await assert.rejects(run(dbWith([{ candidate_count: 3 }], [])), conflict);
  });

  await t.test("run not reported ready", async () => {
    await assert.rejects(run(dbWith([{ candidate_count: 3 }], [{ ...ready, status: "writing" }])), conflict);
  });

  await t.test("run reports a different candidate count", async () => {
    await assert.rejects(run(dbWith([{ candidate_count: 3 }], [{ ...ready, candidate_count: "4" }])), conflict);
  });

  await t.test("run reports a null candidate count", async () => {
    await assert.rejects(run(dbWith([{ candidate_count: 3 }], [{ ...ready, candidate_count: null }])), conflict);
  });

  await t.test("run reports a different candidate set hash", async () => {
    await assert.rejects(run(dbWith([{ candidate_count: 3 }], [{ ...ready, candidate_set_sha256: "a".repeat(64) }])), conflict);
  });
});
