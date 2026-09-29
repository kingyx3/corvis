import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ProcessingStageDelivery } from "./orchestration-stage.ts";
import {
  dispatchProcessingTransportBatch,
  GcpProcessingTransportAdapter,
  PostgresProcessingTransportRepository,
  TRANSPORT_BATCH_BUDGET_MS,
  TRANSPORT_LEASE_SECONDS,
  processingTransportConfig,
  type ProcessingTransportAdapter,
  type ProcessingTransportConfig,
} from "./processing-transport.ts";

const delivery: ProcessingStageDelivery = {
  tenantId: "00000000-0000-4000-8000-000000000001", consumerName: "processing-stage-worker",
  eventId: "00000000-0000-4000-8000-000000000002", eventType: "ProcessingStageRetryScheduled",
  documentId: "00000000-0000-4000-8000-000000000003", jobId: "represented:doc", expectedStage: "represented",
  payload: { nextAttemptAt: "2026-09-20T02:00:00.000Z" }, payloadSha256: "a".repeat(64), maxAttempts: 5, leaseSeconds: 300,
};

test("transport configuration is fail-closed until every real GCP binding is present", () => {
  assert.equal(processingTransportConfig({} as NodeJS.ProcessEnv), undefined);
  const config = processingTransportConfig({
    NODE_ENV: "test",
    CORVIS_GCP_PROJECT_ID: "project", CORVIS_PROCESSING_TOPIC_NAME: "topic", CORVIS_PROCESSING_QUEUE_NAME: "queue",
    CORVIS_PROCESSING_WORKER_URL: "https://worker.example/run",
    CORVIS_PROCESSING_WORKER_AUDIENCE: "https://corvis-worker-test.internal",
    CORVIS_PROCESSING_WORKER_SERVICE_ACCOUNT: "worker@example.iam.gserviceaccount.com",
  } as NodeJS.ProcessEnv);
  assert.equal(config?.region, "asia-southeast1");
  assert.equal(config?.workerAudience, "https://corvis-worker-test.internal");
});

test("authoritative retry timestamps go through Cloud Tasks while immediate work goes through Pub/Sub", async () => {
  const calls: string[] = [];
  const repository = {
    async claim() { return [
      { tenantId: delivery.tenantId,eventId: delivery.eventId,eventType: delivery.eventType,aggregateType:"processing_job",aggregateId:delivery.jobId,payload:delivery.payload,attempt:1,leaseToken:"lease-1" },
      { tenantId: delivery.tenantId,eventId:"00000000-0000-4000-8000-000000000004",eventType:"ProcessingStageReady",aggregateType:"processing_job",aggregateId:delivery.jobId,payload:{},attempt:1,leaseToken:"lease-2" },
    ]; },
    async describe(event: { eventId: string }) { return { ...delivery, eventId: event.eventId, payload: event.eventId === delivery.eventId ? delivery.payload : {} }; },
    async complete(event: { eventId: string }) { calls.push(`complete:${event.eventId}`); },
    async fail() { calls.push("fail"); },
  };
  const adapter: ProcessingTransportAdapter = {
    async publish(value) { calls.push(`publish:${value.eventId}`); },
    async schedule(value, at) { calls.push(`schedule:${value.eventId}:${at}`); },
  };
  const result = await dispatchProcessingTransportBatch({ repository, adapter, now: new Date("2026-09-20T01:00:00.000Z") });
  assert.deepEqual(result, { claimed: 2, dispatched: 2, failed: 0, deferred: 0, deadLettered: 0 });
  assert.equal(calls[0], `schedule:${delivery.eventId}:2026-09-20T02:00:00.000Z`);
  assert.match(calls[2] ?? "", /^publish:/);
});

test("transport dispatch failures retain the event for bounded database retry", async () => {
  let failed = 0;
  const repository = {
    async claim() { return [{ tenantId:delivery.tenantId,eventId:delivery.eventId,eventType:"ProcessingStageReady",aggregateType:"processing_job",aggregateId:delivery.jobId,payload:{},attempt:1,leaseToken:"lease" }]; },
    async describe() { return { ...delivery, payload: {} }; },
    async complete() { throw new Error("unexpected"); },
    async fail() { failed += 1; },
  };
  const adapter: ProcessingTransportAdapter = { async publish() { throw new Error("pubsub unavailable"); }, async schedule() {} };
  assert.deepEqual(await dispatchProcessingTransportBatch({ repository, adapter }), { claimed: 1, dispatched: 0, failed: 1, deferred: 0, deadLettered: 0 });
  assert.equal(failed, 1);
});

test("transport migration uses leases, SKIP LOCKED, bounded backoff and terminal dead-letter state", async () => {
  const sql = (await readFile("db/postgres/migrations/021_processing_transport_runtime.sql", "utf8")).toLowerCase();
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /transport_lease_token/);
  assert.match(sql, /attempt_count=o\.attempt_count\+1/);
  assert.match(sql, /transport_dead_lettered_at=now\(\)/);
  assert.match(sql, /least\(300,5 \* power/);
});

const gcpConfig: ProcessingTransportConfig = {
  projectId: "project", region: "asia-southeast1", topicName: "topic", queueName: "queue",
  workerUrl: "https://worker.example/run", workerAudience: "https://worker.example",
  workerServiceAccountEmail: "worker@example.iam.gserviceaccount.com",
};

const isMetadataServer = (url: string) => new URL(url).hostname === "metadata.google.internal";

function hangingUntilAborted(urls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (isMetadataServer(url)) {
      return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    }
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (!signal) return; // an unbounded call hangs forever and the test times out
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
}

test("GCP transport bounds every outbound call so a hung endpoint cannot outlive the dispatch lease", { timeout: 5_000 }, async () => {
  const urls: string[] = [];
  const adapter = new GcpProcessingTransportAdapter(gcpConfig, hangingUntilAborted(urls), { timeoutMs: 20 });
  // AbortSignal.timeout timers are unref'd; keep the loop alive the way a server would.
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await assert.rejects(adapter.publish(delivery));
    await assert.rejects(adapter.schedule(delivery, "2026-09-20T02:00:00.000Z"));
  } finally {
    clearInterval(keepAlive);
  }
  // The metadata access token is reused across events instead of refetched per call.
  assert.equal(urls.filter(isMetadataServer).length, 1);
  assert.equal(urls.length, 3);
});

function eventOf(n: number, attempt = 1) {
  return { tenantId: delivery.tenantId, eventId: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`, eventType: "ProcessingStageReady", aggregateType: "processing_job", aggregateId: delivery.jobId, payload: {}, attempt, leaseToken: `lease-${n}` };
}

test("a dead-lettered transport event emits a metric and error log instead of vanishing silently", async () => {
  const lines: string[] = [];
  const originalInfo = console.info; const originalError = console.error;
  console.info = (line: string) => { lines.push(String(line)); };
  console.error = (line: string) => { lines.push(String(line)); };
  try {
    const repository = {
      async claim() { return [eventOf(1, 8)]; },
      async describe() { return { ...delivery, payload: {} }; },
      async complete() { throw new Error("unexpected"); },
      async fail() { return { deadLettered: true }; },
    };
    const adapter: ProcessingTransportAdapter = { async publish() { throw new Error("Bearer ya29.secretsecretsecret rejected"); }, async schedule() {} };
    const result = await dispatchProcessingTransportBatch({ repository, adapter });
    assert.equal(result.deadLettered, 1);
  } finally { console.info = originalInfo; console.error = originalError; }
  const metric = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((record) => record.metric === "processing.transport.dead_letter");
  assert.ok(metric, "dead-letter metric must be emitted");
  assert.equal(metric.value, 1);
  assert.equal(lines.join("\n").includes("ya29"), false, "secrets must not reach logs");
});

test("a database error while recording a failure does not abort the remaining events", async () => {
  const completed: string[] = [];
  const repository = {
    async claim() { return [eventOf(1), eventOf(2), eventOf(3)]; },
    async describe() { return { ...delivery, payload: {} }; },
    async complete(event: { eventId: string }) { completed.push(event.eventId); },
    async fail() { throw new Error("connection terminated"); },
  };
  let calls = 0;
  const adapter: ProcessingTransportAdapter = { async publish() { calls += 1; if (calls === 1) throw new Error("pubsub down"); }, async schedule() {} };
  const silence = console.error; console.error = () => undefined; const silenceInfo = console.info; console.info = () => undefined;
  try {
    const result = await dispatchProcessingTransportBatch({ repository, adapter });
    assert.deepEqual(result, { claimed: 3, dispatched: 2, failed: 1, deferred: 0, deadLettered: 0 });
  } finally { console.error = silence; console.info = silenceInfo; }
  assert.equal(completed.length, 2);
});

test("a batch that outruns its lease budget releases the untouched events instead of publishing on an expiring lease", async () => {
  let now = 0;
  const released: string[] = []; const published: string[] = [];
  const repository = {
    async claim() { return [eventOf(1), eventOf(2), eventOf(3)]; },
    async describe(event: { eventId: string }) { return { ...delivery, eventId: event.eventId, payload: {} }; },
    async complete() {},
    async fail() { return { deadLettered: false }; },
    async release(event: { eventId: string }) { released.push(event.eventId); },
  };
  const adapter: ProcessingTransportAdapter = { async publish(value) { published.push(value.eventId); now += 20_000; }, async schedule() {} };
  const result = await dispatchProcessingTransportBatch({ repository, adapter, clock: () => now, budgetMs: 25_000 });
  assert.deepEqual(result, { claimed: 3, dispatched: 2, failed: 0, deferred: 1, deadLettered: 0 });
  assert.equal(published.length, 2);
  assert.deepEqual(released, [eventOf(3).eventId]);
});

test("the default batch budget leaves room for the worst-case publish inside the lease", () => {
  assert.ok(TRANSPORT_BATCH_BUDGET_MS + 2 * 10_000 < TRANSPORT_LEASE_SECONDS * 1000);
});

test("repository.fail reports dead-lettering from the database function and stores redacted error text", async () => {
  const calls: Array<{ sql: string; parameters: unknown[] }> = [];
  const db = { async query(sql: string, parameters: unknown[] = []) { calls.push({ sql, parameters }); return [{ next_attempt_at: null, dead_lettered: true }]; }, async execute() {}, async health() { return true; } };
  const repository = new PostgresProcessingTransportRepository(db as never);
  const outcome = await repository.fail(eventOf(1, 8), new Error("publish failed token=abc123 https://x.example/p?sig=zzz"));
  assert.deepEqual(outcome, { deadLettered: true });
  const stored = String(calls[0]!.parameters[3]);
  assert.match(stored, /^Error: publish failed/);
  assert.equal(/abc123|zzz/.test(stored), false);
  await repository.release(eventOf(1));
  assert.match(calls[1]!.sql, /release_processing_transport_event/);
});
