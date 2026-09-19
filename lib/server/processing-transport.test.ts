import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ProcessingStageDelivery } from "./orchestration-stage.ts";
import { dispatchProcessingTransportBatch, processingTransportConfig, type ProcessingTransportAdapter } from "./processing-transport.ts";

const delivery: ProcessingStageDelivery = {
  tenantId: "00000000-0000-4000-8000-000000000001", consumerName: "processing-stage-worker",
  eventId: "00000000-0000-4000-8000-000000000002", eventType: "ProcessingStageRetryScheduled",
  documentId: "00000000-0000-4000-8000-000000000003", jobId: "represented:doc", expectedStage: "represented",
  payload: { nextAttemptAt: "2026-09-20T02:00:00.000Z" }, payloadSha256: "a".repeat(64), maxAttempts: 5, leaseSeconds: 300,
};

test("transport configuration is fail-closed until every real GCP binding is present", () => {
  assert.equal(processingTransportConfig({} as NodeJS.ProcessEnv), undefined);
  assert.equal(processingTransportConfig({
    CORVIS_GCP_PROJECT_ID: "project", CORVIS_PROCESSING_TOPIC_NAME: "topic", CORVIS_PROCESSING_QUEUE_NAME: "queue",
    CORVIS_PROCESSING_WORKER_URL: "https://worker.example/run", CORVIS_PROCESSING_WORKER_SERVICE_ACCOUNT: "worker@example.iam.gserviceaccount.com",
  } as NodeJS.ProcessEnv)?.region, "asia-southeast1");
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
  assert.deepEqual(result, { claimed: 2, dispatched: 2, failed: 0 });
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
  assert.deepEqual(await dispatchProcessingTransportBatch({ repository, adapter }), { claimed: 1, dispatched: 0, failed: 1 });
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
