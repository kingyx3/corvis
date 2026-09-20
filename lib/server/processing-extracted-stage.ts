import { createHash } from "crypto";
import type { ProcessingStageHandler } from "./processing-stage-effects.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const EXTRACTION_CONTRACT_VERSION = "1";
const EXTRACTION_SCHEMA_VERSION = "1.2";
const EXTRACTION_SKILL_ID = "quarterly_fund_report_extraction";
const EXTRACTION_SKILL_VERSION = "1.6";
const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;
const METADATA_TIMEOUT_MS = 5_000;
const PROVIDER_RESPONSE_LIMIT_BYTES = 64 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/i;
const CANDIDATE_TYPES = new Set([
  "fund",
  "company",
  "holding",
  "instrument",
  "lifecycle_event",
  "metric_observation",
  "exception",
]);
const EXTRACTION_METHODS = new Set([
  "native_text",
  "table_parser",
  "ocr",
  "vision",
  "spreadsheet_parser",
]);

export type ExtractionRepresentationRecord = {
  representationId: string;
  artifactVersionId: string;
  representationType: string;
  objectUri: string;
  storageGeneration: string;
  contentSha256: string;
  sizeBytes: number;
  producer: string;
  producerVersion: string;
  method: string;
  status: string;
};

export type ExtractionBundleDescriptor = {
  objectUri: string;
  storageGeneration: string;
  contentSha256: string;
  sizeBytes: number;
  producer: string;
  producerVersion: string;
  modelProvider: string;
  modelName: string;
  modelVersion: string;
};

export type ExtractionSourceReference = {
  sourceReferenceId: string;
  referenceKey: string;
  pageNumber?: number;
  sheetName?: string;
  sectionTitle?: string;
  tableTitle?: string;
  rowLabel?: string;
  columnLabel?: string;
  cellOrRange?: string;
  footnoteMarker?: string;
  sourceText?: string;
  extractionMethod: string;
  boundingBox?: Record<string, unknown>;
};

export type ExtractionCandidate = {
  candidateId: string;
  candidateKey: string;
  candidateType: string;
  payload: Record<string, unknown>;
  confidence: Record<string, number>;
  provenance: Record<string, unknown>;
  exceptionCodes: string[];
  sourceReferences: ExtractionSourceReference[];
};

export interface ExtractionCandidateRepository {
  findRepresentation(input: {
    tenantId: string;
    documentId: string;
    representationId: string;
  }): Promise<ExtractionRepresentationRecord | undefined>;
  beginRun(input: {
    tenantId: string;
    documentId: string;
    artifactVersionId: string;
    representationId: string;
    extractionRunId: string;
    bundle: ExtractionBundleDescriptor;
  }): Promise<void>;
  saveCandidate(input: {
    tenantId: string;
    documentId: string;
    representationId: string;
    extractionRunId: string;
    candidate: ExtractionCandidate;
  }): Promise<void>;
  finalizeRun(input: {
    tenantId: string;
    extractionRunId: string;
    candidateCount: number;
    candidateSetSha256: string;
  }): Promise<void>;
}

export interface ExtractionProvider {
  extract(input: {
    tenantId: string;
    documentId: string;
    artifactVersionId: string;
    representationId: string;
    representationType: string;
    representationObjectUri: string;
    representationStorageGeneration: string;
    representationContentSha256: string;
    extractionRunId: string;
    outputObjectUri: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<ExtractionBundleDescriptor>;
}

export interface ExtractionBundleReader {
  read(input: {
    descriptor: ExtractionBundleDescriptor;
    extractionRunId: string;
    representationId: string;
    representationStorageGeneration: string;
    representationContentSha256: string;
    signal: AbortSignal;
  }): Promise<string>;
}

type ExtractionProviderConfig = {
  endpoint: string;
  audience: string;
  outputBucket: string;
  timeoutMs: number;
};

type PredecessorResult = {
  representationId: string;
  artifactVersionId: string;
  representationType: string;
  storageGeneration: string;
  contentSha256: string;
  sizeBytes: number;
  producer: string;
  producerVersion: string;
  method: string;
};

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`extracted stage requires ${field}`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`extracted stage requires valid ${field}`);
  return value.trim();
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`extracted stage requires valid ${field}`);
  return parsed;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`extracted stage requires valid ${field}`);
  return parsed;
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("extracted stage execution aborted");
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function predecessorResult(effect: ProcessingStageEffectInput): PredecessorResult {
  const predecessor = object(effect.payload.predecessorResult);
  if (!predecessor) throw new Error("extracted stage requires predecessorResult");
  const contentSha256 = requiredText(predecessor.contentSha256, "predecessorResult.contentSha256").toLowerCase();
  if (!SHA256.test(contentSha256)) throw new Error("extracted stage requires valid predecessorResult.contentSha256");
  return {
    representationId: requiredText(predecessor.representationId, "predecessorResult.representationId"),
    artifactVersionId: requiredText(predecessor.artifactVersionId, "predecessorResult.artifactVersionId"),
    representationType: requiredText(predecessor.representationType, "predecessorResult.representationType"),
    storageGeneration: requiredText(predecessor.storageGeneration, "predecessorResult.storageGeneration"),
    contentSha256,
    sizeBytes: requiredNonNegativeInteger(predecessor.sizeBytes, "predecessorResult.sizeBytes"),
    producer: requiredText(predecessor.producer, "predecessorResult.producer"),
    producerVersion: requiredText(predecessor.producerVersion, "predecessorResult.producerVersion"),
    method: requiredText(predecessor.method, "predecessorResult.method"),
  };
}

function representationMatches(left: ExtractionRepresentationRecord, right: PredecessorResult): boolean {
  return left.representationId === right.representationId
    && left.artifactVersionId === right.artifactVersionId
    && left.representationType === right.representationType
    && left.storageGeneration === right.storageGeneration
    && left.contentSha256.toLowerCase() === right.contentSha256
    && left.sizeBytes === right.sizeBytes
    && left.producer === right.producer
    && left.producerVersion === right.producerVersion
    && left.method === right.method
    && left.status === "ready";
}

export function extractionIdentity(input: {
  tenantId: string;
  documentId: string;
  representationId: string;
  outputBucket: string;
}): { extractionRunId: string; objectUri: string } {
  const extractionRunId = deterministicUuid([
    "corvis-extraction-run",
    EXTRACTION_CONTRACT_VERSION,
    EXTRACTION_SCHEMA_VERSION,
    EXTRACTION_SKILL_ID,
    EXTRACTION_SKILL_VERSION,
    input.tenantId,
    input.documentId,
    input.representationId,
  ].join(":"));
  return {
    extractionRunId,
    objectUri: `gs://${input.outputBucket}/extractions/${input.tenantId}/${input.documentId}/${input.representationId}/${extractionRunId}.jsonl`,
  };
}

function parseJson(row: PostgresRow, key: string): unknown {
  const value = row[key];
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { return value; }
}

export class PostgresExtractionCandidateRepository implements ExtractionCandidateRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async findRepresentation(input: {
    tenantId: string;
    documentId: string;
    representationId: string;
  }): Promise<ExtractionRepresentationRecord | undefined> {
    const rows = await this.db.query(`select
        representation_id,document_artifact_version_id,representation_type,object_uri,
        storage_generation,content_sha256,size_bytes,producer,producer_version,method,status
      from corvis_source.document_representation
      where tenant_id=$1::uuid and document_id=$2::uuid and representation_id=$3::uuid
      limit 1`, [input.tenantId, input.documentId, input.representationId]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      representationId: text(row, "representation_id"),
      artifactVersionId: text(row, "document_artifact_version_id"),
      representationType: text(row, "representation_type"),
      objectUri: text(row, "object_uri"),
      storageGeneration: text(row, "storage_generation"),
      contentSha256: text(row, "content_sha256").toLowerCase(),
      sizeBytes: Number(row.size_bytes ?? -1),
      producer: text(row, "producer"),
      producerVersion: text(row, "producer_version"),
      method: text(row, "method"),
      status: text(row, "status"),
    };
  }

  async beginRun(input: {
    tenantId: string;
    documentId: string;
    artifactVersionId: string;
    representationId: string;
    extractionRunId: string;
    bundle: ExtractionBundleDescriptor;
  }): Promise<void> {
    const parameters: PostgresPrimitive[] = [
      input.tenantId, input.extractionRunId, input.documentId, input.artifactVersionId,
      input.representationId, EXTRACTION_CONTRACT_VERSION, EXTRACTION_SCHEMA_VERSION,
      EXTRACTION_SKILL_ID, EXTRACTION_SKILL_VERSION, input.bundle.objectUri,
      input.bundle.storageGeneration, input.bundle.contentSha256.toLowerCase(), input.bundle.sizeBytes,
      input.bundle.producer, input.bundle.producerVersion, input.bundle.modelProvider,
      input.bundle.modelName, input.bundle.modelVersion,
    ];
    await this.db.query(`insert into corvis_source.extraction_run (
        tenant_id,extraction_run_id,document_id,document_artifact_version_id,representation_id,
        extraction_contract_version,schema_version,skill_id,skill_version,bundle_object_uri,
        bundle_storage_generation,bundle_content_sha256,bundle_size_bytes,producer,producer_version,
        model_provider,model_name,model_version,status
      ) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'writing')
      on conflict (tenant_id,extraction_run_id) do nothing`, parameters);
    const rows = await this.db.query(`select * from corvis_source.extraction_run
      where tenant_id=$1::uuid and extraction_run_id=$2::uuid limit 1`, [input.tenantId, input.extractionRunId]);
    const row = rows[0];
    if (!row) throw new Error("extracted stage could not persist extraction run");
    const actual = [
      text(row, "document_id"), text(row, "document_artifact_version_id"), text(row, "representation_id"),
      text(row, "extraction_contract_version"), text(row, "schema_version"), text(row, "skill_id"),
      text(row, "skill_version"), text(row, "bundle_object_uri"), text(row, "bundle_storage_generation"),
      text(row, "bundle_content_sha256").toLowerCase(), Number(row.bundle_size_bytes ?? -1),
      text(row, "producer"), text(row, "producer_version"), text(row, "model_provider"),
      text(row, "model_name"), text(row, "model_version"),
    ];
    const expected = [
      input.documentId, input.artifactVersionId, input.representationId,
      EXTRACTION_CONTRACT_VERSION, EXTRACTION_SCHEMA_VERSION, EXTRACTION_SKILL_ID,
      EXTRACTION_SKILL_VERSION, input.bundle.objectUri, input.bundle.storageGeneration,
      input.bundle.contentSha256.toLowerCase(), input.bundle.sizeBytes,
      input.bundle.producer, input.bundle.producerVersion, input.bundle.modelProvider,
      input.bundle.modelName, input.bundle.modelVersion,
    ];
    if (stable(actual) !== stable(expected)) throw new Error("existing extraction run conflicts with immutable extraction lineage");
  }

  async saveCandidate(input: {
    tenantId: string;
    documentId: string;
    representationId: string;
    extractionRunId: string;
    candidate: ExtractionCandidate;
  }): Promise<void> {
    const candidate = input.candidate;
    await this.db.query(`insert into corvis_source.extraction_candidate (
        tenant_id,extraction_run_id,candidate_id,candidate_key,document_id,representation_id,
        candidate_type,payload,confidence,provenance,exception_codes,review_status,source_reference_count
      ) values ($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,'candidate',$12)
      on conflict (tenant_id,extraction_run_id,candidate_id) do nothing`, [
      input.tenantId, input.extractionRunId, candidate.candidateId, candidate.candidateKey,
      input.documentId, input.representationId, candidate.candidateType,
      JSON.stringify(candidate.payload), JSON.stringify(candidate.confidence), JSON.stringify(candidate.provenance),
      JSON.stringify(candidate.exceptionCodes), candidate.sourceReferences.length,
    ]);
    const rows = await this.db.query(`select candidate_key,candidate_type,payload,confidence,provenance,
        exception_codes,review_status,source_reference_count
      from corvis_source.extraction_candidate
      where tenant_id=$1::uuid and extraction_run_id=$2::uuid and candidate_id=$3::uuid
      limit 1`, [input.tenantId, input.extractionRunId, candidate.candidateId]);
    const row = rows[0];
    if (!row) throw new Error("extracted stage could not persist extraction candidate");
    const persisted = {
      candidateKey: text(row, "candidate_key"),
      candidateType: text(row, "candidate_type"),
      payload: parseJson(row, "payload"),
      confidence: parseJson(row, "confidence"),
      provenance: parseJson(row, "provenance"),
      exceptionCodes: parseJson(row, "exception_codes"),
      reviewStatus: text(row, "review_status"),
      sourceReferenceCount: Number(row.source_reference_count ?? -1),
    };
    const expected = {
      candidateKey: candidate.candidateKey,
      candidateType: candidate.candidateType,
      payload: candidate.payload,
      confidence: candidate.confidence,
      provenance: candidate.provenance,
      exceptionCodes: candidate.exceptionCodes,
      reviewStatus: "candidate",
      sourceReferenceCount: candidate.sourceReferences.length,
    };
    if (stable(persisted) !== stable(expected)) throw new Error("existing extraction candidate conflicts with deterministic candidate state");

    for (const reference of candidate.sourceReferences) {
      await this.saveSourceReference({ ...input, candidate, reference });
    }
  }

  private async saveSourceReference(input: {
    tenantId: string;
    documentId: string;
    representationId: string;
    extractionRunId: string;
    candidate: ExtractionCandidate;
    reference: ExtractionSourceReference;
  }): Promise<void> {
    const reference = input.reference;
    await this.db.query(`insert into corvis_source.extraction_candidate_source_reference (
        tenant_id,extraction_run_id,candidate_id,source_reference_id,reference_key,document_id,representation_id,
        page_number,sheet_name,section_title,table_title,row_label,column_label,cell_or_range,footnote_marker,
        source_text,extraction_method,bounding_box
      ) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7::uuid,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
      on conflict (tenant_id,extraction_run_id,source_reference_id) do nothing`, [
      input.tenantId, input.extractionRunId, input.candidate.candidateId, reference.sourceReferenceId,
      reference.referenceKey, input.documentId, input.representationId, reference.pageNumber ?? null,
      reference.sheetName ?? null, reference.sectionTitle ?? null, reference.tableTitle ?? null,
      reference.rowLabel ?? null, reference.columnLabel ?? null, reference.cellOrRange ?? null,
      reference.footnoteMarker ?? null, reference.sourceText ?? null, reference.extractionMethod,
      reference.boundingBox ? JSON.stringify(reference.boundingBox) : null,
    ]);
    const rows = await this.db.query(`select reference_key,page_number,sheet_name,section_title,table_title,
        row_label,column_label,cell_or_range,footnote_marker,source_text,extraction_method,bounding_box
      from corvis_source.extraction_candidate_source_reference
      where tenant_id=$1::uuid and extraction_run_id=$2::uuid and source_reference_id=$3::uuid limit 1`, [
      input.tenantId, input.extractionRunId, reference.sourceReferenceId,
    ]);
    const row = rows[0];
    if (!row) throw new Error("extracted stage could not persist candidate source evidence");
    const persisted = {
      referenceKey: text(row, "reference_key"),
      pageNumber: row.page_number == null ? undefined : Number(row.page_number),
      sheetName: optionalText(row.sheet_name, "persisted sheet name"),
      sectionTitle: optionalText(row.section_title, "persisted section title"),
      tableTitle: optionalText(row.table_title, "persisted table title"),
      rowLabel: optionalText(row.row_label, "persisted row label"),
      columnLabel: optionalText(row.column_label, "persisted column label"),
      cellOrRange: optionalText(row.cell_or_range, "persisted cell range"),
      footnoteMarker: optionalText(row.footnote_marker, "persisted footnote marker"),
      sourceText: optionalText(row.source_text, "persisted source text"),
      extractionMethod: text(row, "extraction_method"),
      boundingBox: parseJson(row, "bounding_box") ?? undefined,
    };
    const expected = {
      referenceKey: reference.referenceKey,
      pageNumber: reference.pageNumber,
      sheetName: reference.sheetName,
      sectionTitle: reference.sectionTitle,
      tableTitle: reference.tableTitle,
      rowLabel: reference.rowLabel,
      columnLabel: reference.columnLabel,
      cellOrRange: reference.cellOrRange,
      footnoteMarker: reference.footnoteMarker,
      sourceText: reference.sourceText,
      extractionMethod: reference.extractionMethod,
      boundingBox: reference.boundingBox,
    };
    if (stable(persisted) !== stable(expected)) throw new Error("existing candidate source evidence conflicts with deterministic evidence state");
  }

  async finalizeRun(input: {
    tenantId: string;
    extractionRunId: string;
    candidateCount: number;
    candidateSetSha256: string;
  }): Promise<void> {
    const counts = await this.db.query(`select count(*)::integer as candidate_count
      from corvis_source.extraction_candidate where tenant_id=$1::uuid and extraction_run_id=$2::uuid`, [
      input.tenantId, input.extractionRunId,
    ]);
    if (Number(counts[0]?.candidate_count ?? -1) !== input.candidateCount) {
      throw new Error("extracted stage candidate persistence is incomplete");
    }
    const rows = await this.db.query(`update corvis_source.extraction_run
      set status='ready',candidate_count=$3,candidate_set_sha256=$4,completed_at=coalesce(completed_at,now())
      where tenant_id=$1::uuid and extraction_run_id=$2::uuid
        and (status='writing' or (status='ready' and candidate_count=$3 and candidate_set_sha256=$4))
      returning status,candidate_count,candidate_set_sha256`, [
      input.tenantId, input.extractionRunId, input.candidateCount, input.candidateSetSha256,
    ]);
    const row = rows[0];
    if (!row || text(row, "status") !== "ready"
      || Number(row.candidate_count ?? -1) !== input.candidateCount
      || text(row, "candidate_set_sha256") !== input.candidateSetSha256) {
      throw new Error("existing extraction run conflicts with finalized candidate set");
    }
  }
}

function boundedSignal(parent: AbortSignal, timeoutMs: number, label: string): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out`)), timeoutMs);
  if (parent.aborted) onAbort();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

async function boundedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  parent: AbortSignal,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const execution = boundedSignal(parent, timeoutMs, label);
  try { return await fetchImpl(url, { ...init, signal: execution.signal, cache: "no-store" }); }
  finally { execution.dispose(); }
}

async function googleIdentityToken(fetchImpl: typeof fetch, audience: string, signal: AbortSignal): Promise<string> {
  const url = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
  url.searchParams.set("audience", audience);
  url.searchParams.set("format", "full");
  const response = await boundedFetch(fetchImpl, url.toString(), { headers: { "Metadata-Flavor": "Google" } }, signal, METADATA_TIMEOUT_MS, "GCP extraction identity token request");
  if (!response.ok) throw new Error(`GCP extraction identity token request failed (${response.status})`);
  const token = (await response.text()).trim();
  if (!token) throw new Error("GCP extraction identity token response was empty");
  return token;
}

export class HttpExtractionProvider implements ExtractionProvider {
  private readonly config: Pick<ExtractionProviderConfig, "endpoint" | "audience" | "timeoutMs">;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Pick<ExtractionProviderConfig, "endpoint" | "audience" | "timeoutMs">, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async extract(input: Parameters<ExtractionProvider["extract"]>[0]): Promise<ExtractionBundleDescriptor> {
    const token = await googleIdentityToken(this.fetchImpl, this.config.audience, input.signal);
    const response = await boundedFetch(this.fetchImpl, `${this.config.endpoint.replace(/\/$/, "")}/v1/extractions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-corvis-idempotency-key": input.idempotencyKey,
      },
      body: JSON.stringify({
        extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
        skillId: EXTRACTION_SKILL_ID,
        skillVersion: EXTRACTION_SKILL_VERSION,
        extractionRunId: input.extractionRunId,
        tenantId: input.tenantId,
        documentId: input.documentId,
        artifactVersionId: input.artifactVersionId,
        representation: {
          representationId: input.representationId,
          representationType: input.representationType,
          objectUri: input.representationObjectUri,
          storageGeneration: input.representationStorageGeneration,
          contentSha256: input.representationContentSha256,
        },
        output: { objectUri: input.outputObjectUri, format: "jsonl" },
      }),
    }, input.signal, this.config.timeoutMs, "extraction provider");
    if (!response.ok) throw new Error(`extraction provider failed (${response.status})`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > PROVIDER_RESPONSE_LIMIT_BYTES) throw new Error("extraction provider response exceeds metadata limit");
    const responseText = await response.text();
    if (Buffer.byteLength(responseText, "utf8") > PROVIDER_RESPONSE_LIMIT_BYTES) throw new Error("extraction provider response exceeds metadata limit");
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(responseText) as unknown;
      const record = object(parsed);
      if (!record) throw new Error("not object");
      body = record;
    } catch {
      throw new Error("extraction provider returned invalid JSON");
    }
    const contentSha256 = requiredText(body.contentSha256, "provider contentSha256").toLowerCase();
    if (!SHA256.test(contentSha256)) throw new Error("extraction provider returned invalid content SHA-256");
    return {
      objectUri: requiredText(body.objectUri, "provider objectUri"),
      storageGeneration: requiredText(body.storageGeneration, "provider storageGeneration"),
      contentSha256,
      sizeBytes: requiredNonNegativeInteger(body.sizeBytes, "provider sizeBytes"),
      producer: requiredText(body.producer, "provider producer"),
      producerVersion: requiredText(body.producerVersion, "provider producerVersion"),
      modelProvider: requiredText(body.modelProvider, "provider modelProvider"),
      modelName: requiredText(body.modelName, "provider modelName"),
      modelVersion: requiredText(body.modelVersion, "provider modelVersion"),
    };
  }
}

function parseGcsUri(uri: string): { bucket: string; key: string } {
  if (!uri.startsWith("gs://")) throw new Error("extraction bundle is not authoritative GCS evidence");
  const remainder = uri.slice(5);
  const slash = remainder.indexOf("/");
  if (slash <= 0 || slash === remainder.length - 1) throw new Error("extraction bundle GCS URI is invalid");
  return { bucket: remainder.slice(0, slash), key: remainder.slice(slash + 1) };
}

export class GcpExtractionBundleReader implements ExtractionBundleReader {
  private readonly outputBucket: string;
  private readonly fetchImpl: typeof fetch;
  private readonly staticToken?: string;
  private cachedToken?: { value: string; expiresAt: number };

  constructor(outputBucket: string, options: { fetchImpl?: typeof fetch; accessToken?: string } = {}) {
    this.outputBucket = outputBucket;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.staticToken = options.accessToken;
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    if (this.staticToken) return this.staticToken;
    if (this.cachedToken && this.cachedToken.expiresAt - Date.now() > 60_000) return this.cachedToken.value;
    const response = await boundedFetch(this.fetchImpl,
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } }, signal, METADATA_TIMEOUT_MS, "GCP extraction GCS token request");
    if (!response.ok) throw new Error(`GCP extraction GCS token request failed (${response.status})`);
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("GCP extraction GCS token response was empty");
    this.cachedToken = { value: body.access_token, expiresAt: Date.now() + Math.max(60, body.expires_in ?? 300) * 1000 };
    return body.access_token;
  }

  async read(input: Parameters<ExtractionBundleReader["read"]>[0]): Promise<string> {
    const parsed = parseGcsUri(input.descriptor.objectUri);
    if (parsed.bucket !== this.outputBucket) throw new Error("extraction bundle is outside the configured GCS evidence bucket");
    if (input.descriptor.sizeBytes > MAX_BUNDLE_BYTES) throw new Error("extraction candidate bundle exceeds maximum size");
    const token = await this.accessToken(input.signal);
    const metadataUrl = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(parsed.bucket)}/o/${encodeURIComponent(parsed.key)}`);
    metadataUrl.searchParams.set("fields", "generation,size,metadata");
    metadataUrl.searchParams.set("generation", input.descriptor.storageGeneration);
    const metadataResponse = await boundedFetch(this.fetchImpl, metadataUrl.toString(), {
      headers: { authorization: `Bearer ${token}` },
    }, input.signal, METADATA_TIMEOUT_MS, "GCS extraction metadata read");
    if (metadataResponse.status === 404) throw new Error("extraction candidate bundle is missing from GCS");
    if (!metadataResponse.ok) throw new Error(`GCS extraction metadata read failed (${metadataResponse.status})`);
    const metadata = await metadataResponse.json() as { generation?: string; size?: string; metadata?: Record<string, string> };
    const custom = metadata.metadata ?? {};
    if (metadata.generation !== input.descriptor.storageGeneration) throw new Error("extraction bundle GCS generation mismatch");
    if (Number(metadata.size) !== input.descriptor.sizeBytes) throw new Error("extraction bundle GCS size mismatch");
    if (custom["corvis-content-sha256"]?.toLowerCase() !== input.descriptor.contentSha256.toLowerCase()) throw new Error("extraction bundle GCS content hash mismatch");
    if (custom["corvis-extraction-run-id"] !== input.extractionRunId) throw new Error("extraction bundle GCS run identity mismatch");
    if (custom["corvis-representation-id"] !== input.representationId) throw new Error("extraction bundle GCS representation mismatch");
    if (custom["corvis-representation-generation"] !== input.representationStorageGeneration) throw new Error("extraction bundle GCS representation generation mismatch");
    if (custom["corvis-representation-sha256"]?.toLowerCase() !== input.representationContentSha256.toLowerCase()) throw new Error("extraction bundle GCS representation hash mismatch");
    if (custom["corvis-skill-id"] !== EXTRACTION_SKILL_ID || custom["corvis-skill-version"] !== EXTRACTION_SKILL_VERSION) throw new Error("extraction bundle GCS skill contract mismatch");
    if (custom["corvis-schema-version"] !== EXTRACTION_SCHEMA_VERSION) throw new Error("extraction bundle GCS schema contract mismatch");

    const mediaUrl = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(parsed.bucket)}/o/${encodeURIComponent(parsed.key)}`);
    mediaUrl.searchParams.set("alt", "media");
    mediaUrl.searchParams.set("generation", input.descriptor.storageGeneration);
    const mediaResponse = await boundedFetch(this.fetchImpl, mediaUrl.toString(), {
      headers: { authorization: `Bearer ${token}` },
    }, input.signal, METADATA_TIMEOUT_MS, "GCS extraction bundle read");
    if (!mediaResponse.ok) throw new Error(`GCS extraction bundle read failed (${mediaResponse.status})`);
    const declaredLength = Number(mediaResponse.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BUNDLE_BYTES) throw new Error("extraction candidate bundle exceeds maximum size");
    const bytes = Buffer.from(await mediaResponse.arrayBuffer());
    if (bytes.length !== input.descriptor.sizeBytes) throw new Error("extraction bundle body size does not match immutable metadata");
    if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("extraction candidate bundle exceeds maximum size");
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== input.descriptor.contentSha256.toLowerCase()) throw new Error("extraction bundle body hash does not match immutable metadata");
    return bytes.toString("utf8");
  }
}

function confidence(value: unknown): Record<string, number> {
  const record = object(value);
  if (!record || Object.keys(record).length === 0) throw new Error("extraction candidate requires dimension confidence");
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1) {
      throw new Error(`extraction candidate confidence ${key} must be between 0 and 1`);
    }
    result[key] = entry;
  }
  return result;
}

function exceptionCodes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error("extraction candidate exceptionCodes must be non-empty strings");
  }
  return value.map((entry) => String(entry).trim());
}

function sourceReference(value: unknown, candidateId: string): ExtractionSourceReference {
  const record = object(value);
  if (!record) throw new Error("extraction candidate source reference must be an object");
  const referenceKey = requiredText(record.referenceKey, "source reference referenceKey");
  const pageNumber = record.pageNumber == null ? undefined : requiredPositiveInteger(record.pageNumber, "source reference pageNumber");
  const sheetName = optionalText(record.sheetName, "source reference sheetName");
  if (pageNumber === undefined && !sheetName) throw new Error("extraction candidate source reference requires pageNumber or sheetName");
  const extractionMethod = requiredText(record.extractionMethod, "source reference extractionMethod");
  if (!EXTRACTION_METHODS.has(extractionMethod)) throw new Error("extraction candidate source reference uses unsupported extractionMethod");
  const boundingBox = record.boundingBox == null ? undefined : object(record.boundingBox);
  if (record.boundingBox != null && !boundingBox) throw new Error("extraction candidate source reference boundingBox must be an object");
  return {
    sourceReferenceId: deterministicUuid(`corvis-extraction-source-reference:${candidateId}:${referenceKey}`),
    referenceKey,
    pageNumber,
    sheetName,
    sectionTitle: optionalText(record.sectionTitle, "source reference sectionTitle"),
    tableTitle: optionalText(record.tableTitle, "source reference tableTitle"),
    rowLabel: optionalText(record.rowLabel, "source reference rowLabel"),
    columnLabel: optionalText(record.columnLabel, "source reference columnLabel"),
    cellOrRange: optionalText(record.cellOrRange, "source reference cellOrRange"),
    footnoteMarker: optionalText(record.footnoteMarker, "source reference footnoteMarker"),
    sourceText: optionalText(record.sourceText, "source reference sourceText"),
    extractionMethod,
    boundingBox,
  };
}

export function parseExtractionCandidateBundle(input: {
  jsonl: string;
  extractionRunId: string;
  representation: ExtractionRepresentationRecord;
  bundle: ExtractionBundleDescriptor;
}): ExtractionCandidate[] {
  const candidates: ExtractionCandidate[] = [];
  const keys = new Set<string>();
  for (const [index, rawLine] of input.jsonl.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      const value = object(parsed);
      if (!value) throw new Error("not object");
      record = value;
    } catch {
      throw new Error(`extraction candidate bundle line ${index + 1} is invalid JSON`);
    }
    const candidateKey = requiredText(record.candidateKey, `candidate line ${index + 1} candidateKey`);
    if (keys.has(candidateKey)) throw new Error(`extraction candidate bundle repeats candidateKey ${candidateKey}`);
    keys.add(candidateKey);
    const candidateType = requiredText(record.candidateType, `candidate ${candidateKey} candidateType`);
    if (!CANDIDATE_TYPES.has(candidateType)) throw new Error(`extraction candidate ${candidateKey} has unsupported candidateType`);
    const payload = object(record.payload);
    if (!payload) throw new Error(`extraction candidate ${candidateKey} requires payload object`);
    const providerProvenance = object(record.provenance);
    if (!providerProvenance) throw new Error(`extraction candidate ${candidateKey} requires provenance object`);
    if (!Array.isArray(record.sourceReferences) || record.sourceReferences.length === 0) {
      throw new Error(`extraction candidate ${candidateKey} requires exact source evidence`);
    }
    const candidateId = deterministicUuid(`corvis-extraction-candidate:${input.extractionRunId}:${candidateKey}`);
    const sourceReferences = record.sourceReferences.map((entry) => sourceReference(entry, candidateId));
    candidates.push({
      candidateId,
      candidateKey,
      candidateType,
      payload,
      confidence: confidence(record.confidence),
      provenance: {
        ...providerProvenance,
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
        skillId: EXTRACTION_SKILL_ID,
        skillVersion: EXTRACTION_SKILL_VERSION,
        extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
        extractionRunId: input.extractionRunId,
        representationId: input.representation.representationId,
        representationGeneration: input.representation.storageGeneration,
        representationContentSha256: input.representation.contentSha256,
        producer: input.bundle.producer,
        producerVersion: input.bundle.producerVersion,
        modelProvider: input.bundle.modelProvider,
        modelName: input.bundle.modelName,
        modelVersion: input.bundle.modelVersion,
      },
      exceptionCodes: exceptionCodes(record.exceptionCodes),
      sourceReferences,
    });
  }
  if (candidates.length === 0) throw new Error("extraction candidate bundle contains no candidates");
  return candidates;
}

export function extractionCandidateSetSha256(candidates: ExtractionCandidate[]): string {
  return createHash("sha256").update(stable(candidates)).digest("hex");
}

export function createExtractedDocumentStageHandler(input: {
  repository: ExtractionCandidateRepository;
  provider: ExtractionProvider;
  bundleReader: ExtractionBundleReader;
  outputBucket: string;
}): ProcessingStageHandler {
  return async (effect, signal) => {
    if (effect.stage !== "extracted") throw new Error(`extracted document handler cannot execute stage ${effect.stage}`);
    assertNotAborted(signal);
    const predecessor = predecessorResult(effect);
    const representation = await input.repository.findRepresentation({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      representationId: predecessor.representationId,
    });
    assertNotAborted(signal);
    if (!representation) throw new Error("extracted stage representation was not found");
    if (!representationMatches(representation, predecessor)) throw new Error("extracted stage representation lineage no longer matches the represented stage result");
    if (!representation.objectUri.startsWith("gs://")) throw new Error("extracted stage representation is not authoritative GCS evidence");

    const identity = extractionIdentity({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      representationId: representation.representationId,
      outputBucket: input.outputBucket,
    });
    const bundle = await input.provider.extract({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      artifactVersionId: representation.artifactVersionId,
      representationId: representation.representationId,
      representationType: representation.representationType,
      representationObjectUri: representation.objectUri,
      representationStorageGeneration: representation.storageGeneration,
      representationContentSha256: representation.contentSha256,
      extractionRunId: identity.extractionRunId,
      outputObjectUri: identity.objectUri,
      idempotencyKey: effect.idempotencyKey,
      signal,
    });
    assertNotAborted(signal);
    if (bundle.objectUri !== identity.objectUri) throw new Error("extraction provider wrote outside the deterministic candidate bundle identity");
    const jsonl = await input.bundleReader.read({
      descriptor: bundle,
      extractionRunId: identity.extractionRunId,
      representationId: representation.representationId,
      representationStorageGeneration: representation.storageGeneration,
      representationContentSha256: representation.contentSha256,
      signal,
    });
    assertNotAborted(signal);
    const candidates = parseExtractionCandidateBundle({ jsonl, extractionRunId: identity.extractionRunId, representation, bundle });
    const candidateSetSha256 = extractionCandidateSetSha256(candidates);

    await input.repository.beginRun({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      artifactVersionId: representation.artifactVersionId,
      representationId: representation.representationId,
      extractionRunId: identity.extractionRunId,
      bundle,
    });
    for (const candidate of candidates) {
      assertNotAborted(signal);
      await input.repository.saveCandidate({
        tenantId: effect.tenantId,
        documentId: effect.documentId,
        representationId: representation.representationId,
        extractionRunId: identity.extractionRunId,
        candidate,
      });
    }
    await input.repository.finalizeRun({
      tenantId: effect.tenantId,
      extractionRunId: identity.extractionRunId,
      candidateCount: candidates.length,
      candidateSetSha256,
    });

    return {
      extractionRunId: identity.extractionRunId,
      representationId: representation.representationId,
      artifactVersionId: representation.artifactVersionId,
      candidateCount: candidates.length,
      candidateSetSha256,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      skillId: EXTRACTION_SKILL_ID,
      skillVersion: EXTRACTION_SKILL_VERSION,
    };
  };
}

function positiveTimeout(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PROVIDER_TIMEOUT_MS;
  return Math.min(parsed, 25_000);
}

export function configuredExtractionProviderConfig(env: NodeJS.ProcessEnv = process.env): ExtractionProviderConfig | undefined {
  const endpoint = env.CORVIS_EXTRACTION_ENDPOINT?.trim();
  if (!endpoint) return undefined;
  const outputBucket = env.CORVIS_OBJECT_STORE_BUCKET?.trim();
  if (!outputBucket) throw new Error("CORVIS_OBJECT_STORE_BUCKET is required when extraction processing is enabled");
  return {
    endpoint,
    audience: env.CORVIS_EXTRACTION_AUDIENCE?.trim() || endpoint,
    outputBucket,
    timeoutMs: positiveTimeout(env.CORVIS_EXTRACTION_TIMEOUT_MS),
  };
}

export function createConfiguredExtractedStageHandler(
  db: PostgresSqlApi,
  env: NodeJS.ProcessEnv = process.env,
): ProcessingStageHandler | undefined {
  const config = configuredExtractionProviderConfig(env);
  if (!config) return undefined;
  return createExtractedDocumentStageHandler({
    repository: new PostgresExtractionCandidateRepository(db),
    provider: new HttpExtractionProvider(config),
    bundleReader: new GcpExtractionBundleReader(config.outputBucket, { accessToken: env.CORVIS_GCP_ACCESS_TOKEN }),
    outputBucket: config.outputBucket,
  });
}
