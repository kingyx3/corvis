import { createHash } from "crypto";
import type { ProcessingStageHandler } from "./processing-stage-effects.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

const REPRESENTATION_TYPE = "document_interpretation_v1";
const REPRESENTATION_CONTRACT_VERSION = "1";
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;
const METADATA_TIMEOUT_MS = 5_000;
const SHA256 = /^[0-9a-f]{64}$/i;
const ALLOWED_METHODS = new Set(["native", "ocr", "vision", "hybrid"]);

export type RepresentedSourceRecord = {
  artifactVersionId: string;
  ingestionId: string;
  objectUri: string;
  storageGeneration: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  malwareScanStatus: string;
  quarantineStatus: string;
};

export type DocumentRepresentationRecord = {
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

export interface DocumentRepresentationRepository {
  findSource(input: {
    tenantId: string;
    documentId: string;
    artifactVersionId: string;
  }): Promise<RepresentedSourceRecord | undefined>;
  saveReady(input: {
    tenantId: string;
    documentId: string;
    representation: DocumentRepresentationRecord;
  }): Promise<DocumentRepresentationRecord>;
}

export type ProducedRepresentation = Omit<DocumentRepresentationRecord, "representationId" | "artifactVersionId" | "status">;

export interface DocumentRepresentationProducer {
  produce(input: {
    tenantId: string;
    documentId: string;
    artifactVersionId: string;
    sourceObjectUri: string;
    sourceStorageGeneration: string;
    sourceSha256: string;
    sourceMediaType: string;
    representationId: string;
    representationType: string;
    outputObjectUri: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<ProducedRepresentation>;
}

export interface RepresentationObjectVerifier {
  verify(input: {
    objectUri: string;
    storageGeneration: string;
    sizeBytes: number;
    contentSha256: string;
    representationId: string;
    representationType: string;
    artifactVersionId: string;
    sourceStorageGeneration: string;
    sourceSha256: string;
    signal: AbortSignal;
  }): Promise<void>;
}

type RepresentationProducerConfig = {
  endpoint: string;
  audience: string;
  outputBucket: string;
  timeoutMs: number;
};

type GoogleAccessTokenResponse = { access_token?: string; expires_in?: number };

type PredecessorResult = {
  artifactVersionId: string;
  ingestionId: string;
  storageGeneration: string;
  sha256: string;
  sizeBytes: number;
};

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`represented stage requires ${field}`);
  return value.trim();
}

function requiredNonNegativeNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`represented stage requires valid ${field}`);
  return parsed;
}

function predecessorResult(input: ProcessingStageEffectInput): PredecessorResult {
  const predecessor = object(input.payload.predecessorResult);
  if (!predecessor) throw new Error("represented stage requires predecessorResult");
  const sha256 = requiredText(predecessor.sha256, "predecessorResult.sha256").toLowerCase();
  if (!SHA256.test(sha256)) throw new Error("represented stage requires valid predecessorResult.sha256");
  return {
    artifactVersionId: requiredText(predecessor.artifactVersionId, "predecessorResult.artifactVersionId"),
    ingestionId: requiredText(predecessor.ingestionId, "predecessorResult.ingestionId"),
    storageGeneration: requiredText(predecessor.storageGeneration, "predecessorResult.storageGeneration"),
    sha256,
    sizeBytes: requiredNonNegativeNumber(predecessor.sizeBytes, "predecessorResult.sizeBytes"),
  };
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("represented stage execution aborted");
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function representationIdentity(input: {
  tenantId: string;
  documentId: string;
  artifactVersionId: string;
  outputBucket: string;
}): { representationId: string; objectUri: string } {
  const representationId = deterministicUuid([
    "corvis-representation",
    REPRESENTATION_CONTRACT_VERSION,
    input.tenantId,
    input.documentId,
    input.artifactVersionId,
    REPRESENTATION_TYPE,
  ].join(":"));
  const objectKey = [
    "representations",
    input.tenantId,
    input.documentId,
    input.artifactVersionId,
    `${representationId}.json`,
  ].join("/");
  return { representationId, objectUri: `gs://${input.outputBucket}/${objectKey}` };
}

function recordsMatch(left: DocumentRepresentationRecord, right: DocumentRepresentationRecord): boolean {
  return left.representationId === right.representationId
    && left.artifactVersionId === right.artifactVersionId
    && left.representationType === right.representationType
    && left.objectUri === right.objectUri
    && left.storageGeneration === right.storageGeneration
    && left.contentSha256.toLowerCase() === right.contentSha256.toLowerCase()
    && left.sizeBytes === right.sizeBytes
    && left.producer === right.producer
    && left.producerVersion === right.producerVersion
    && left.method === right.method
    && left.status === right.status;
}

export class PostgresDocumentRepresentationRepository implements DocumentRepresentationRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async findSource(input: {
    tenantId: string;
    documentId: string;
    artifactVersionId: string;
  }): Promise<RepresentedSourceRecord | undefined> {
    const rows = await this.db.query(`select
        a.document_artifact_version_id,a.ingestion_id,a.object_uri,a.storage_generation,
        a.sha256,a.size_bytes,a.malware_scan_status,a.quarantine_status,d.media_type
      from corvis_source.document_artifact_version a
      join corvis_source.document d
        on d.tenant_id=a.tenant_id and d.document_id=a.document_id
      where a.tenant_id=$1::uuid
        and a.document_id=$2::uuid
        and a.document_artifact_version_id=$3::uuid
      limit 1`, [input.tenantId, input.documentId, input.artifactVersionId]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      artifactVersionId: text(row, "document_artifact_version_id"),
      ingestionId: text(row, "ingestion_id"),
      objectUri: text(row, "object_uri"),
      storageGeneration: text(row, "storage_generation"),
      sha256: text(row, "sha256").toLowerCase(),
      sizeBytes: Number(row.size_bytes ?? -1),
      mediaType: text(row, "media_type"),
      malwareScanStatus: text(row, "malware_scan_status"),
      quarantineStatus: text(row, "quarantine_status"),
    };
  }

  async saveReady(input: {
    tenantId: string;
    documentId: string;
    representation: DocumentRepresentationRecord;
  }): Promise<DocumentRepresentationRecord> {
    const representation = input.representation;
    await this.db.query(`insert into corvis_source.document_representation (
        tenant_id,representation_id,document_id,document_artifact_version_id,
        representation_type,object_uri,storage_generation,content_sha256,size_bytes,
        producer,producer_version,method,status
      ) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,'ready')
      on conflict (tenant_id,representation_id) do nothing`, [
      input.tenantId,
      representation.representationId,
      input.documentId,
      representation.artifactVersionId,
      representation.representationType,
      representation.objectUri,
      representation.storageGeneration,
      representation.contentSha256.toLowerCase(),
      representation.sizeBytes,
      representation.producer,
      representation.producerVersion,
      representation.method,
    ]);
    const rows = await this.db.query(`select
        representation_id,document_artifact_version_id,representation_type,object_uri,
        storage_generation,content_sha256,size_bytes,producer,producer_version,method,status
      from corvis_source.document_representation
      where tenant_id=$1::uuid and document_id=$2::uuid and representation_id=$3::uuid
      limit 1`, [input.tenantId, input.documentId, representation.representationId]);
    const row = rows[0];
    if (!row) throw new Error("represented stage could not persist representation metadata");
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
}

function boundedSignal(parent: AbortSignal, timeoutMs: number, label: string): {
  signal: AbortSignal;
  dispose(): void;
} {
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
  try {
    return await fetchImpl(url, { ...init, signal: execution.signal, cache: "no-store" });
  } finally {
    execution.dispose();
  }
}

async function googleIdentityToken(
  fetchImpl: typeof fetch,
  audience: string,
  parent: AbortSignal,
): Promise<string> {
  const url = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
  url.searchParams.set("audience", audience);
  url.searchParams.set("format", "full");
  const response = await boundedFetch(fetchImpl, url.toString(), {
    headers: { "Metadata-Flavor": "Google" },
  }, parent, METADATA_TIMEOUT_MS, "GCP identity token request");
  if (!response.ok) throw new Error(`GCP representation identity token request failed (${response.status})`);
  const token = (await response.text()).trim();
  if (!token) throw new Error("GCP representation identity token response was empty");
  return token;
}

export class HttpDocumentRepresentationProducer implements DocumentRepresentationProducer {
  private readonly config: Pick<RepresentationProducerConfig, "endpoint" | "audience" | "timeoutMs">;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: Pick<RepresentationProducerConfig, "endpoint" | "audience" | "timeoutMs">,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async produce(input: Parameters<DocumentRepresentationProducer["produce"]>[0]): Promise<ProducedRepresentation> {
    const token = await googleIdentityToken(this.fetchImpl, this.config.audience, input.signal);
    const response = await boundedFetch(this.fetchImpl, `${this.config.endpoint.replace(/\/$/, "")}/v1/representations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-corvis-idempotency-key": input.idempotencyKey,
      },
      body: JSON.stringify({
        contractVersion: REPRESENTATION_CONTRACT_VERSION,
        representationId: input.representationId,
        representationType: input.representationType,
        tenantId: input.tenantId,
        documentId: input.documentId,
        artifactVersionId: input.artifactVersionId,
        source: {
          objectUri: input.sourceObjectUri,
          storageGeneration: input.sourceStorageGeneration,
          sha256: input.sourceSha256,
          mediaType: input.sourceMediaType,
        },
        output: { objectUri: input.outputObjectUri, contentType: "application/json" },
      }),
    }, input.signal, this.config.timeoutMs, "document representation provider");
    if (!response.ok) throw new Error(`document representation provider failed (${response.status})`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_LIMIT_BYTES) {
      throw new Error("document representation provider response exceeds metadata limit");
    }
    const responseText = await response.text();
    if (Buffer.byteLength(responseText, "utf8") > RESPONSE_LIMIT_BYTES) {
      throw new Error("document representation provider response exceeds metadata limit");
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(responseText) as unknown;
      const record = object(parsed);
      if (!record) throw new Error("not object");
      body = record;
    } catch {
      throw new Error("document representation provider returned invalid JSON");
    }
    const contentSha256 = requiredText(body.contentSha256, "provider contentSha256").toLowerCase();
    if (!SHA256.test(contentSha256)) throw new Error("document representation provider returned invalid content SHA-256");
    const method = requiredText(body.method, "provider method");
    if (!ALLOWED_METHODS.has(method)) throw new Error("document representation provider returned unsupported method");
    return {
      representationType: requiredText(body.representationType, "provider representationType"),
      objectUri: requiredText(body.objectUri, "provider objectUri"),
      storageGeneration: requiredText(body.storageGeneration, "provider storageGeneration"),
      contentSha256,
      sizeBytes: requiredNonNegativeNumber(body.sizeBytes, "provider sizeBytes"),
      producer: requiredText(body.producer, "provider producer"),
      producerVersion: requiredText(body.producerVersion, "provider producerVersion"),
      method,
    };
  }
}

function parseGcsUri(uri: string): { bucket: string; key: string } {
  if (!uri.startsWith("gs://")) throw new Error("representation object is not authoritative GCS evidence");
  const rest = uri.slice(5);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) throw new Error("representation object URI is invalid");
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

export class GcpRepresentationObjectVerifier implements RepresentationObjectVerifier {
  private readonly outputBucket: string;
  private readonly fetchImpl: typeof fetch;
  private readonly staticAccessToken?: string;
  private cachedToken?: { value: string; expiresAt: number };

  constructor(outputBucket: string, options: { fetchImpl?: typeof fetch; accessToken?: string } = {}) {
    this.outputBucket = outputBucket;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.staticAccessToken = options.accessToken;
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    if (this.staticAccessToken) return this.staticAccessToken;
    if (this.cachedToken && this.cachedToken.expiresAt - Date.now() > 60_000) return this.cachedToken.value;
    const response = await boundedFetch(this.fetchImpl,
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } }, signal, METADATA_TIMEOUT_MS, "GCP access token request");
    if (!response.ok) throw new Error(`GCP representation access token request failed (${response.status})`);
    const body = await response.json() as GoogleAccessTokenResponse;
    if (!body.access_token) throw new Error("GCP representation access token response was empty");
    this.cachedToken = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(60, body.expires_in ?? 300) * 1000,
    };
    return body.access_token;
  }

  async verify(input: Parameters<RepresentationObjectVerifier["verify"]>[0]): Promise<void> {
    const parsed = parseGcsUri(input.objectUri);
    if (parsed.bucket !== this.outputBucket) throw new Error("representation object is outside the configured GCS evidence bucket");
    const token = await this.accessToken(input.signal);
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(parsed.bucket)}/o/${encodeURIComponent(parsed.key)}`);
    url.searchParams.set("fields", "generation,size,metadata");
    const response = await boundedFetch(this.fetchImpl, url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    }, input.signal, METADATA_TIMEOUT_MS, "GCS representation metadata read");
    if (response.status === 404) throw new Error("representation object is missing from GCS");
    if (!response.ok) throw new Error(`GCS representation metadata read failed (${response.status})`);
    const metadata = await response.json() as {
      generation?: string;
      size?: string;
      metadata?: Record<string, string>;
    };
    const custom = metadata.metadata ?? {};
    if (metadata.generation !== input.storageGeneration) throw new Error("representation GCS generation mismatch");
    if (Number(metadata.size) !== input.sizeBytes) throw new Error("representation GCS size mismatch");
    if (custom["corvis-content-sha256"]?.toLowerCase() !== input.contentSha256.toLowerCase()) {
      throw new Error("representation GCS content hash mismatch");
    }
    if (custom["corvis-representation-id"] !== input.representationId) throw new Error("representation GCS identity mismatch");
    if (custom["corvis-representation-type"] !== input.representationType) throw new Error("representation GCS type mismatch");
    if (custom["corvis-source-artifact-version-id"] !== input.artifactVersionId) throw new Error("representation GCS source artifact mismatch");
    if (custom["corvis-source-generation"] !== input.sourceStorageGeneration) throw new Error("representation GCS source generation mismatch");
    if (custom["corvis-source-sha256"]?.toLowerCase() !== input.sourceSha256.toLowerCase()) {
      throw new Error("representation GCS source hash mismatch");
    }
  }
}

export function createRepresentedDocumentStageHandler(input: {
  repository: DocumentRepresentationRepository;
  producer: DocumentRepresentationProducer;
  verifier: RepresentationObjectVerifier;
  outputBucket: string;
}): ProcessingStageHandler {
  return async (effect, signal) => {
    if (effect.stage !== "represented") throw new Error(`represented document handler cannot execute stage ${effect.stage}`);
    assertNotAborted(signal);
    const predecessor = predecessorResult(effect);
    const source = await input.repository.findSource({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      artifactVersionId: predecessor.artifactVersionId,
    });
    assertNotAborted(signal);
    if (!source) throw new Error("represented source artifact was not found");
    if (source.malwareScanStatus !== "clean" || source.quarantineStatus !== "released") {
      throw new Error("represented source artifact is not clean and released");
    }
    if (!source.objectUri.startsWith("gs://")) throw new Error("represented source artifact is not authoritative GCS evidence");
    if (!source.mediaType) throw new Error("represented source artifact is missing media type");
    if (source.ingestionId !== predecessor.ingestionId
      || source.storageGeneration !== predecessor.storageGeneration
      || source.sha256.toLowerCase() !== predecessor.sha256
      || source.sizeBytes !== predecessor.sizeBytes) {
      throw new Error("represented source lineage no longer matches the registered stage result");
    }

    const identity = representationIdentity({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      artifactVersionId: source.artifactVersionId,
      outputBucket: input.outputBucket,
    });
    const produced = await input.producer.produce({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      artifactVersionId: source.artifactVersionId,
      sourceObjectUri: source.objectUri,
      sourceStorageGeneration: source.storageGeneration,
      sourceSha256: source.sha256,
      sourceMediaType: source.mediaType,
      representationId: identity.representationId,
      representationType: REPRESENTATION_TYPE,
      outputObjectUri: identity.objectUri,
      idempotencyKey: effect.idempotencyKey,
      signal,
    });
    assertNotAborted(signal);
    if (produced.representationType !== REPRESENTATION_TYPE) throw new Error("representation provider returned an incompatible representation type");
    if (produced.objectUri !== identity.objectUri) throw new Error("representation provider wrote outside the deterministic object identity");

    const expected: DocumentRepresentationRecord = {
      representationId: identity.representationId,
      artifactVersionId: source.artifactVersionId,
      representationType: produced.representationType,
      objectUri: produced.objectUri,
      storageGeneration: produced.storageGeneration,
      contentSha256: produced.contentSha256.toLowerCase(),
      sizeBytes: produced.sizeBytes,
      producer: produced.producer,
      producerVersion: produced.producerVersion,
      method: produced.method,
      status: "ready",
    };
    await input.verifier.verify({
      objectUri: expected.objectUri,
      storageGeneration: expected.storageGeneration,
      sizeBytes: expected.sizeBytes,
      contentSha256: expected.contentSha256,
      representationId: expected.representationId,
      representationType: expected.representationType,
      artifactVersionId: source.artifactVersionId,
      sourceStorageGeneration: source.storageGeneration,
      sourceSha256: source.sha256,
      signal,
    });
    assertNotAborted(signal);
    const persisted = await input.repository.saveReady({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      representation: expected,
    });
    if (!recordsMatch(persisted, expected)) throw new Error("persisted representation metadata conflicts with the deterministic representation");

    return {
      representationId: expected.representationId,
      artifactVersionId: expected.artifactVersionId,
      representationType: expected.representationType,
      storageGeneration: expected.storageGeneration,
      contentSha256: expected.contentSha256,
      sizeBytes: expected.sizeBytes,
      producer: expected.producer,
      producerVersion: expected.producerVersion,
      method: expected.method,
    };
  };
}

function positiveTimeout(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PROVIDER_TIMEOUT_MS;
  return Math.min(parsed, 25_000);
}

export function configuredRepresentationProducerConfig(env: NodeJS.ProcessEnv = process.env): RepresentationProducerConfig | undefined {
  const endpoint = env.CORVIS_REPRESENTATION_ENDPOINT?.trim();
  if (!endpoint) return undefined;
  const outputBucket = env.CORVIS_OBJECT_STORE_BUCKET?.trim();
  if (!outputBucket) throw new Error("CORVIS_OBJECT_STORE_BUCKET is required when representation processing is enabled");
  return {
    endpoint,
    audience: env.CORVIS_REPRESENTATION_AUDIENCE?.trim() || endpoint,
    outputBucket,
    timeoutMs: positiveTimeout(env.CORVIS_REPRESENTATION_TIMEOUT_MS),
  };
}

export function createConfiguredRepresentedStageHandler(
  db: PostgresSqlApi,
  env: NodeJS.ProcessEnv = process.env,
): ProcessingStageHandler | undefined {
  const config = configuredRepresentationProducerConfig(env);
  if (!config) return undefined;
  return createRepresentedDocumentStageHandler({
    repository: new PostgresDocumentRepresentationRepository(db),
    producer: new HttpDocumentRepresentationProducer(config),
    verifier: new GcpRepresentationObjectVerifier(config.outputBucket, { accessToken: env.CORVIS_GCP_ACCESS_TOKEN }),
    outputBucket: config.outputBucket,
  });
}
