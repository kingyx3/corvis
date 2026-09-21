import { createHash } from "crypto";
import type { ProcessingStage } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";
import type { ProcessingStageDelivery } from "./orchestration-stage.ts";

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

type TransportRepository = {
  claim(limit: number): Promise<TransportEvent[]>;
  describe(event: TransportEvent): Promise<ProcessingStageDelivery>;
  complete(event: TransportEvent): Promise<void>;
  fail(event: TransportEvent, error: unknown): Promise<void>;
};

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
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function text(row: PostgresRow, key: string): string { return row[key] == null ? "" : String(row[key]); }

export class PostgresProcessingTransportRepository implements TransportRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) { this.db = db; }

  async claim(limit = 50): Promise<TransportEvent[]> {
    const rows = await this.db.query("select * from corvis_control.claim_processing_transport_events($1,$2)", [limit,60]);
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

  async fail(event: TransportEvent, error: unknown): Promise<void> {
    await this.db.query("select * from corvis_control.fail_processing_transport_event($1::uuid,$2::uuid,$3::uuid,$4,$5)", [event.tenantId,event.eventId,event.leaseToken,errorText(error),8]);
  }
}

async function metadataToken(fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error(`GCP metadata token request failed with status ${response.status}`);
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error("GCP metadata token response did not include access_token");
  return payload.access_token;
}

export class GcpProcessingTransportAdapter implements ProcessingTransportAdapter {
  private readonly config: ProcessingTransportConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ProcessingTransportConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }
  private async token(): Promise<string> { return metadataToken(this.fetchImpl); }

  async publish(delivery: ProcessingStageDelivery): Promise<void> {
    const token = await this.token();
    const url = `https://pubsub.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/topics/${encodeURIComponent(this.config.topicName)}:publish`;
    const response = await this.fetchImpl(url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ data: Buffer.from(JSON.stringify(delivery)).toString("base64"), attributes: { eventType: delivery.eventType, tenantId: delivery.tenantId } }] }),
    });
    if (!response.ok) throw new Error(`Pub/Sub processing publish failed with status ${response.status}`);
  }

  async schedule(delivery: ProcessingStageDelivery, scheduleTime: string): Promise<void> {
    const token = await this.token();
    const url = `https://cloudtasks.googleapis.com/v2/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(this.config.region)}/queues/${encodeURIComponent(this.config.queueName)}/tasks`;
    const response = await this.fetchImpl(url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
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

export async function dispatchProcessingTransportBatch(input: {
  repository: TransportRepository;
  adapter: ProcessingTransportAdapter;
  limit?: number;
  now?: Date;
}): Promise<{ claimed: number; dispatched: number; failed: number }> {
  const events = await input.repository.claim(input.limit ?? 50);
  let dispatched = 0; let failed = 0;
  const now = input.now ?? new Date();
  for (const event of events) {
    try {
      const delivery = await input.repository.describe(event);
      const retryAt = typeof event.payload.nextAttemptAt === "string" ? event.payload.nextAttemptAt : undefined;
      if (retryAt && Number.isFinite(Date.parse(retryAt)) && Date.parse(retryAt) > now.getTime()) await input.adapter.schedule(delivery, new Date(retryAt).toISOString());
      else await input.adapter.publish(delivery);
      await input.repository.complete(event);
      dispatched += 1;
    } catch (error) {
      await input.repository.fail(event, error);
      failed += 1;
    }
  }
  return { claimed: events.length, dispatched, failed };
}

export async function dispatchConfiguredProcessingTransport(workerUrlOverride?: string): Promise<{ configured: boolean; claimed: number; dispatched: number; failed: number }> {
  const config = processingTransportConfig(process.env, workerUrlOverride);
  if (!config) return { configured: false, claimed: 0, dispatched: 0, failed: 0 };
  const repository = new PostgresProcessingTransportRepository(postgres(getServerConfig().postgresDsn));
  const result = await dispatchProcessingTransportBatch({ repository, adapter: new GcpProcessingTransportAdapter(config) });
  return { configured: true, ...result };
}
