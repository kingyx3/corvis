import { createHash } from "crypto";
import type { ProcessingStage } from "../../../shared/domain/enterprise.ts";
import { getServerConfig } from "../../../platform/config/config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import type { ProcessingStageDelivery } from "./orchestration-stage.ts";
import { safeErrorText } from "./processing-error-text.ts";
import { countMetric, logEvent } from "../../../platform/observability/telemetry.ts";

type TransportEvent = {
  tenantId: string;
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempt: number;
  leaseToken: string;
};

export type ProcessingTransportConfig = {
  projectId: string;
  region: string;
  topicName: string;
  queueName: string;
  workerUrl: string;
  workerAudience: string;
  workerServiceAccountEmail: string;
};

export interface ProcessingTransportAdapter {
  publish(delivery: ProcessingStageDelivery): Promise<void>;
  schedule(delivery: ProcessingStageDelivery, scheduleTime: string): Promise<void>;
}

export type TransportFailOutcome = { deadLettered: boolean };

type TransportRepository = {
  claim(limit: number): Promise<TransportEvent[]>;
  describe(event: TransportEvent): Promise<ProcessingStageDelivery>;
  complete(event: TransportEvent): Promise<void>;
  fail(event: TransportEvent, error: unknown): Promise<TransportFailOutcome | void>;
  /** Hands back a claimed-but-unattempted event so it neither waits out its lease nor burns a retry attempt. */
  release?(event: TransportEvent): Promise<void>;
};

/** Lease taken by `claim` (seconds). The batch must finish, including the last publish, inside it. */
export const TRANSPORT_LEASE_SECONDS = 60;
/** Terminal attempt count for `fail_processing_transport_event` (migration 021). */
export const TRANSPORT_MAX_ATTEMPTS = 8;

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value) as unknown; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { return {}; }
  }
  return {};
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key,entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function sha256(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
function text(row: PostgresRow, key: string): string { return row[key] == null ? "" : String(row[key]); }

export class PostgresProcessingTransportRepository implements TransportRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) { this.db = db; }

  async claim(limit = 50): Promise<TransportEvent[]> {
    const rows = await this.db.query("select * from corvis_control.claim_processing_transport_events($1,$2)", [limit,TRANSPORT_LEASE_SECONDS]);
    return rows.map((row) => ({
      tenantId: text(row,"tenant_id"), eventId: text(row,"event_id"), eventType: text(row,"event_type"),
      aggregateType: text(row,"aggregate_type"), aggregateId: text(row,"aggregate_id"), payload: object(row.payload),
      attempt: Number(row.attempt_count ?? 0), leaseToken: text(row,"lease_token"),
    }));
  }

  async describe(event: TransportEvent): Promise<ProcessingStageDelivery> {
    let jobId = typeof event.payload.jobId === "string" ? event.payload.jobId : "";
    let documentId = typeof event.payload.documentId === "string" ? event.payload.documentId : "";
    let stage = typeof event.payload.stage === "string" ? event.payload.stage : "";
    if (!jobId || !documentId || !stage) {
      const rows = jobId
        ? await this.db.query(`select job_id,document_id,stage from corvis_control.processing_job where tenant_id=$1 and job_id=$2 limit 1`, [event.tenantId,jobId])
        : await this.db.query(`select job_id,document_id,stage from corvis_control.processing_job where tenant_id=$1 and document_id=$2::uuid and stage='registered' order by created_at desc limit 1`, [event.tenantId,event.aggregateId]);
      const row = rows[0];
      if (!row) throw new Error("processing transport event cannot resolve its authoritative job");
      jobId = text(row,"job_id"); documentId = text(row,"document_id"); stage = text(row,"stage");
    }
    if (!["registered","represented","extracted","reviewed","canonicalized","reconciled","consolidated","published"].includes(stage)) {
      throw new Error("processing transport event carries an invalid stage");
    }
    return {
      tenantId: event.tenantId,
      consumerName: "processing-stage-worker",
      eventId: event.eventId,
      eventType: event.eventType,
      documentId,
      jobId,
      expectedStage: stage as ProcessingStage,
      payload: event.payload,
      payloadSha256: sha256(event.payload),
      maxAttempts: 5,
      leaseSeconds: 300,
    };
  }

  async complete(event: TransportEvent): Promise<void> {
    const rows = await this.db.query("select corvis_control.complete_processing_transport_event($1::uuid,$2::uuid,$3::uuid) as completed", [event.tenantId,event.eventId,event.leaseToken]);
    if (rows[0]?.completed !== true && rows[0]?.completed !== "true") throw new Error("processing transport lease was lost before completion");
  }

  async fail(event: TransportEvent, error: unknown): Promise<TransportFailOutcome> {
    // Persist a stable class plus a redacted, truncated message: provider error bodies can carry secrets.
    const rows = await this.db.query("select * from corvis_control.fail_processing_transport_event($1::uuid,$2::uuid,$3::uuid,$4,$5)", [event.tenantId,event.eventId,event.leaseToken,safeErrorText(error),TRANSPORT_MAX_ATTEMPTS]);
    const deadLettered = rows[0]?.dead_lettered;
    return { deadLettered: deadLettered === true || deadLettered === "true" };
  }

  async release(event: TransportEvent): Promise<void> {
    await this.db.query("select corvis_control.release_processing_transport_event($1::uuid,$2::uuid,$3::uuid) as released", [event.tenantId,event.eventId,event.leaseToken]);
  }
}

// Every outbound call is bounded well inside the 60s transport lease, so a hung
// GCP endpoint fails the event for bounded retry instead of stalling the batch
// past its lease (which would let another dispatcher re-claim and double-send).
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

async function metadataToken(fetchImpl: typeof fetch, timeoutMs: number): Promise<{ value: string; expiresAt: number }> {
  const response = await fetchImpl("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GCP metadata token request failed with status ${response.status}`);
  const payload = await response.json() as { access_token?: string; expires_in?: number };
  if (!payload.access_token) throw new Error("GCP metadata token response did not include access_token");
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 300;
  return { value: payload.access_token, expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 };
}

export class GcpProcessingTransportAdapter implements ProcessingTransportAdapter {
  private readonly config: ProcessingTransportConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cachedToken?: { value: string; expiresAt: number };

  constructor(config: ProcessingTransportConfig, fetchImpl: typeof fetch = fetch, options: { timeoutMs?: number } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }
  private async token(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt - Date.now() > 60_000) return this.cachedToken.value;
    this.cachedToken = await metadataToken(this.fetchImpl, this.timeoutMs);
    return this.cachedToken.value;
  }

  async publish(delivery: ProcessingStageDelivery): Promise<void> {
    const token = await this.token();
    const url = `https://pubsub.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/topics/${encodeURIComponent(this.config.topicName)}:publish`;
    const response = await this.fetchImpl(url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ messages: [{ data: Buffer.from(JSON.stringify(delivery)).toString("base64"), attributes: { eventType: delivery.eventType, tenantId: delivery.tenantId } }] }),
    });
    if (!response.ok) throw new Error(`Pub/Sub processing publish failed with status ${response.status}`);
  }

  async schedule(delivery: ProcessingStageDelivery, scheduleTime: string): Promise<void> {
    const token = await this.token();
    const url = `https://cloudtasks.googleapis.com/v2/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(this.config.region)}/queues/${encodeURIComponent(this.config.queueName)}/tasks`;
    const response = await this.fetchImpl(url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ task: {
        scheduleTime,
        httpRequest: {
          httpMethod: "POST", url: this.config.workerUrl, headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify(delivery)).toString("base64"),
          oidcToken: { serviceAccountEmail: this.config.workerServiceAccountEmail, audience: this.config.workerAudience },
        },
      } }),
    });
    if (!response.ok) throw new Error(`Cloud Tasks processing schedule failed with status ${response.status}`);
  }
}

export function processingTransportConfig(env: NodeJS.ProcessEnv = process.env, workerUrlOverride?: string): ProcessingTransportConfig | undefined {
  const values = {
    projectId: env.CORVIS_GCP_PROJECT_ID?.trim() ?? "",
    region: env.CORVIS_GCP_REGION?.trim() || "asia-southeast1",
    topicName: env.CORVIS_PROCESSING_TOPIC_NAME?.trim() ?? "",
    queueName: env.CORVIS_PROCESSING_QUEUE_NAME?.trim() ?? "",
    workerUrl: workerUrlOverride?.trim() || env.CORVIS_PROCESSING_WORKER_URL?.trim() || "",
    workerAudience: env.CORVIS_PROCESSING_WORKER_AUDIENCE?.trim() ?? "",
    workerServiceAccountEmail: env.CORVIS_PROCESSING_WORKER_SERVICE_ACCOUNT?.trim() ?? "",
  };
  return Object.values(values).every(Boolean) ? values : undefined;
}

/**
 * One publish can take a metadata-token call plus the publish itself, each up to
 * DEFAULT_FETCH_TIMEOUT_MS. No new event is started once the remaining lease
 * could not cover that worst case, so a slow batch never outlives its lease
 * (which would let another dispatcher re-claim and double-publish, and make
 * `complete` fail with "lease lost").
 */
const WORST_CASE_EVENT_MS = 2 * DEFAULT_FETCH_TIMEOUT_MS;
const LEASE_SAFETY_MARGIN_MS = 5_000;
export const TRANSPORT_BATCH_BUDGET_MS = TRANSPORT_LEASE_SECONDS * 1000 - WORST_CASE_EVENT_MS - LEASE_SAFETY_MARGIN_MS;

export type TransportBatchResult = { claimed: number; dispatched: number; failed: number; deferred: number; deadLettered: number };

export async function dispatchProcessingTransportBatch(input: {
  repository: TransportRepository;
  adapter: ProcessingTransportAdapter;
  limit?: number;
  now?: Date;
  /** Wall-clock source for the lease budget; injectable for tests. */
  clock?: () => number;
  budgetMs?: number;
}): Promise<TransportBatchResult> {
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = input.budgetMs ?? TRANSPORT_BATCH_BUDGET_MS;
  const events = await input.repository.claim(input.limit ?? 50);
  let dispatched = 0; let failed = 0; let deferred = 0; let deadLettered = 0;
  const now = input.now ?? new Date();
  for (const event of events) {
    const context = { correlationId: event.eventId, tenantId: event.tenantId };
    if (clock() - startedAt >= budgetMs) {
      // Out of lease budget: give the event back untouched instead of publishing on a lease about to expire.
      deferred += 1;
      try { await input.repository.release?.(event); }
      catch (releaseError) { logEvent("warn", "processing.transport.release_failed", context, { error: safeErrorText(releaseError) }); }
      continue;
    }
    try {
      const delivery = await input.repository.describe(event);
      const retryAt = typeof event.payload.nextAttemptAt === "string" ? event.payload.nextAttemptAt : undefined;
      if (retryAt && Number.isFinite(Date.parse(retryAt)) && Date.parse(retryAt) > now.getTime()) await input.adapter.schedule(delivery, new Date(retryAt).toISOString());
      else await input.adapter.publish(delivery);
      await input.repository.complete(event);
      dispatched += 1;
    } catch (error) {
      failed += 1;
      // A bookkeeping failure here (database blip) must not abort the remaining events: the
      // lease simply expires and this event is retried by a later tick.
      try {
        const outcome = await input.repository.fail(event, error);
        if (outcome && outcome.deadLettered) {
          deadLettered += 1;
          // Dead-lettered transport events leave the document `registered` forever; make that visible.
          countMetric("processing.transport.dead_letter", 1, context, { eventType: event.eventType, attempts: event.attempt });
          logEvent("error", "processing.transport.dead_lettered", context, { eventType: event.eventType, aggregateId: event.aggregateId, attempts: event.attempt, error: safeErrorText(error) });
        }
      } catch (failError) {
        countMetric("processing.transport.fail_bookkeeping_error", 1, context, { eventType: event.eventType });
        logEvent("error", "processing.transport.fail_bookkeeping_error", context, { error: safeErrorText(failError) });
      }
    }
  }
  return { claimed: events.length, dispatched, failed, deferred, deadLettered };
}

export async function dispatchConfiguredProcessingTransport(workerUrlOverride?: string): Promise<{ configured: boolean } & TransportBatchResult> {
  const config = processingTransportConfig(process.env, workerUrlOverride);
  if (!config) return { configured: false, claimed: 0, dispatched: 0, failed: 0, deferred: 0, deadLettered: 0 };
  const repository = new PostgresProcessingTransportRepository(postgres(getServerConfig().postgresDsn));
  const result = await dispatchProcessingTransportBatch({ repository, adapter: new GcpProcessingTransportAdapter(config) });
  return { configured: true, ...result };
}
