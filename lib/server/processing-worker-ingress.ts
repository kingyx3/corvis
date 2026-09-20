import { createHash } from "crypto";
import type { ProcessingStage, RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { GoogleOidcVerifier, type GoogleServiceAccountIdentity } from "./gcp-oidc.ts";
import {
  PostgresProcessingStageRepository,
  type ProcessingStageDelivery,
} from "./orchestration-stage.ts";
import { PostgresProcessingStageEffectRepository } from "./orchestration-stage-effect.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";
import { createProductionProcessingStageEffectRouter } from "./processing-registered-stage.ts";
import {
  processingWorkerIdentityRepositories,
  resolveProcessingWorkerIdentity,
} from "./processing-worker-identity.ts";
import {
  runProcessingStageDelivery,
  type ProcessingStageEffectPort,
  type ProcessingStageWorkerResult,
} from "./processing-stage-worker.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;
const STAGES = new Set<ProcessingStage>(["registered","represented","extracted","reviewed","canonicalized","reconciled","consolidated","published"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export type ProcessingWorkerIngressConfig = {
  workerUrl: string;
  serviceAccountEmail: string;
};

type StageRepository = Pick<PostgresProcessingStageRepository, "claim" | "complete" | "fail">;
type EffectRepository = Pick<PostgresProcessingStageEffectRepository, "begin" | "complete">;

export type ProcessingWorkerIngressDependencies = {
  config: ProcessingWorkerIngressConfig;
  verifyGoogleIdentity(input: {
    authorization: string | null;
    audience: string;
    serviceAccountEmail: string;
  }): Promise<GoogleServiceAccountIdentity>;
  resolveIdentity(input: { tenantId: string; subject: string; documentId: string }): Promise<RequestIdentity | undefined>;
  stages: StageRepository;
  effects: EffectRepository;
  handler: ProcessingStageEffectPort;
};

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

export function processingPayloadSha256(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ProcessingWorkerRequestError("invalid_delivery", 400, `${field} is required`);
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) <= 0) throw new ProcessingWorkerRequestError("invalid_delivery", 400, `${field} must be a positive integer`);
  return Number(value);
}

function deliveryFrom(value: unknown): ProcessingStageDelivery {
  const body = object(value);
  if (!body) throw new ProcessingWorkerRequestError("invalid_delivery", 400, "delivery must be an object");
  const tenantId = requiredString(body.tenantId, "tenantId");
  const eventId = requiredString(body.eventId, "eventId");
  const documentId = requiredString(body.documentId, "documentId");
  if (!UUID.test(tenantId) || !UUID.test(eventId) || !UUID.test(documentId)) throw new ProcessingWorkerRequestError("invalid_delivery", 400, "delivery UUID is invalid");
  const consumerName = requiredString(body.consumerName, "consumerName");
  if (consumerName !== "processing-stage-worker") throw new ProcessingWorkerRequestError("invalid_delivery", 400, "unexpected processing consumer");
  const expectedStage = requiredString(body.expectedStage, "expectedStage") as ProcessingStage;
  if (!STAGES.has(expectedStage)) throw new ProcessingWorkerRequestError("invalid_delivery", 400, "processing stage is invalid");
  const payload = object(body.payload);
  if (!payload) throw new ProcessingWorkerRequestError("invalid_delivery", 400, "payload must be an object");
  const payloadSha256 = requiredString(body.payloadSha256, "payloadSha256");
  if (!SHA256.test(payloadSha256) || processingPayloadSha256(payload) !== payloadSha256.toLowerCase()) {
    throw new ProcessingWorkerRequestError("invalid_delivery", 400, "payloadSha256 does not match payload");
  }
  const leaseSeconds = positiveInteger(body.leaseSeconds, "leaseSeconds");
  if (leaseSeconds !== undefined && leaseSeconds > 3600) throw new ProcessingWorkerRequestError("invalid_delivery", 400, "leaseSeconds exceeds worker bound");
  const maxAttempts = positiveInteger(body.maxAttempts, "maxAttempts");
  if (maxAttempts !== undefined && maxAttempts > 20) throw new ProcessingWorkerRequestError("invalid_delivery", 400, "maxAttempts exceeds worker bound");
  return {
    tenantId,
    consumerName,
    eventId,
    eventType: requiredString(body.eventType, "eventType"),
    documentId,
    jobId: requiredString(body.jobId, "jobId"),
    expectedStage,
    payload,
    payloadSha256,
    maxAttempts,
    leaseSeconds,
  };
}

function pubsubDelivery(value: Record<string, unknown>): ProcessingStageDelivery | undefined {
  const message = object(value.message);
  if (!message) return undefined;
  const data = requiredString(message.data, "message.data");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as unknown;
  } catch {
    throw new ProcessingWorkerRequestError("invalid_delivery", 400, "Pub/Sub message data is invalid");
  }
  const delivery = deliveryFrom(decoded);
  const attributes = object(message.attributes);
  if (attributes?.tenantId !== undefined && attributes.tenantId !== delivery.tenantId) {
    throw new ProcessingWorkerRequestError("invalid_delivery", 400, "Pub/Sub tenant attribute mismatch");
  }
  if (attributes?.eventType !== undefined && attributes.eventType !== delivery.eventType) {
    throw new ProcessingWorkerRequestError("invalid_delivery", 400, "Pub/Sub event type attribute mismatch");
  }
  return delivery;
}

export function processingWorkerIngressConfig(env: NodeJS.ProcessEnv = process.env): ProcessingWorkerIngressConfig {
  const workerUrl = env.CORVIS_PROCESSING_WORKER_URL?.trim() ?? "";
  const serviceAccountEmail = env.CORVIS_PROCESSING_WORKER_SERVICE_ACCOUNT?.trim() ?? "";
  if (!workerUrl || !serviceAccountEmail) throw new Error("processing worker ingress is not configured");
  return { workerUrl, serviceAccountEmail };
}

export async function parseProcessingStageDelivery(request: Request): Promise<ProcessingStageDelivery> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) throw new ProcessingWorkerRequestError("delivery_too_large", 413, "processing delivery exceeds maximum size");
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { throw new ProcessingWorkerRequestError("invalid_delivery", 400, "processing delivery is not valid JSON"); }
  const wrapped = object(parsed);
  return wrapped ? pubsubDelivery(wrapped) ?? deliveryFrom(wrapped) : deliveryFrom(parsed);
}

export async function executeProcessingWorkerRequest(
  request: Request,
  dependencies: ProcessingWorkerIngressDependencies,
): Promise<ProcessingStageWorkerResult> {
  let googleIdentity: GoogleServiceAccountIdentity;
  try {
    googleIdentity = await dependencies.verifyGoogleIdentity({
      authorization: request.headers.get("authorization"),
      audience: dependencies.config.workerUrl,
      serviceAccountEmail: dependencies.config.serviceAccountEmail,
    });
  } catch {
    throw new ProcessingWorkerRequestError("worker_authentication_failed", 401, "approved GCP worker identity is required");
  }

  const delivery = await parseProcessingStageDelivery(request);
  const identity = await dependencies.resolveIdentity({
    tenantId: delivery.tenantId,
    subject: googleIdentity.subject,
    documentId: delivery.documentId,
  });
  if (!identity) throw new ProcessingWorkerRequestError("worker_authorization_failed", 403, "service identity is not authorized for this document");

  return runProcessingStageDelivery({
    identity,
    delivery,
    stages: dependencies.stages,
    effects: dependencies.effects,
    handler: dependencies.handler,
  });
}

let googleVerifier: GoogleOidcVerifier | undefined;

function productionVerifier(): GoogleOidcVerifier {
  if (!googleVerifier) googleVerifier = new GoogleOidcVerifier();
  return googleVerifier;
}

export function productionProcessingWorkerDependencies(db: PostgresSqlApi): ProcessingWorkerIngressDependencies {
  const config = processingWorkerIngressConfig();
  const verifier = productionVerifier();
  const identities = processingWorkerIdentityRepositories(db);
  return {
    config,
    verifyGoogleIdentity: (input) => verifier.verify(input),
    resolveIdentity: (input) => resolveProcessingWorkerIdentity({ ...input, ...identities }),
    stages: new PostgresProcessingStageRepository(db),
    effects: new PostgresProcessingStageEffectRepository(db),
    handler: createProductionProcessingStageEffectRouter(db),
  };
}

export async function executeConfiguredProcessingWorkerRequest(request: Request): Promise<ProcessingStageWorkerResult> {
  const db = postgres(getServerConfig().postgresDsn);
  return executeProcessingWorkerRequest(request, productionProcessingWorkerDependencies(db));
}

export class ProcessingWorkerRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ProcessingWorkerRequestError";
    this.code = code;
    this.status = status;
  }
}
