import test from "node:test";
import assert from "node:assert/strict";
import {
  computeWebhookRetryDelayMs,
  processQueuedExports,
  processWebhookDeliveries,
  sweepUnsubscribedWebhookFanoutEvents,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
  WEBHOOK_FANOUT_SWEEP_LIMIT,
  WEBHOOK_RETRY_BASE_DELAY_MS,
  WEBHOOK_RETRY_MAX_DELAY_MS,
  WEBHOOK_RETRY_JITTER_RATIO,
} from "./delivery.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { policyCheckedLookup, policyPinnedWebhookFetch } from "./webhook-endpoint-policy.ts";

type RecordedStatement = { sql: string; parameters: PostgresPrimitive[] };

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const EVENT = "00000000-0000-4000-8000-0000000000e1";
const WEBHOOK = "00000000-0000-4000-8000-0000000000c1";

/** Records every statement and answers the few shapes webhook/export delivery issues. */
class FakeDeliveryStore implements PostgresSqlApi {
  readonly statements: RecordedStatement[] = [];
  events: PostgresRow[] = [];
  reclaimedWebhookRows: PostgresRow[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.statements.push({ sql, parameters });
    if (sql.startsWith("update corvis_control.webhook_delivery") && sql.includes("lease expired")) return this.reclaimedWebhookRows;
    if (sql.includes("from corvis_control.outbox_event e")) return this.events;
    if (sql.startsWith("insert into corvis_control.webhook_delivery")) return [{ delivery_id: parameters[1] ?? null }];
    if (sql.startsWith("update corvis_control.webhook_delivery") && sql.includes("state='complete'")) return [{ completed_at: new Date().toISOString() }];
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.statements.push({ sql, parameters });
  }

  async health(): Promise<boolean> { return true; }

  sqlText(): string { return this.statements.map((statement) => statement.sql).join("\n;\n"); }
}

function pendingEvent(overrides: PostgresRow = {}): PostgresRow {
  return {
    tenant_id: TENANT, event_id: EVENT, event_type: "SnapshotPublicationChanged", aggregate_id: "snap-1",
    payload: { snapshotId: "snap-1" }, created_at: "2026-09-01T00:00:00.000Z",
    webhook_id: WEBHOOK, endpoint_url: "https://hooks.example.com/corvis", signing_secret: "s".repeat(64), prior_attempts: 0,
    ...overrides,
  };
}

const publicLookup = async () => [{ address: "93.184.216.34" }];

function recordingFetch(response: () => Response): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function failureUpdate(store: FakeDeliveryStore): RecordedStatement | undefined {
  return store.statements.find((statement) => statement.sql.startsWith("update corvis_control.webhook_delivery") && statement.sql.includes("set state=$1"));
}

test("webhook delivery never reads or writes the processing transport's outbox bookkeeping", async () => {
  const store = new FakeDeliveryStore();
  store.events = [pendingEvent()];
  const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 204 }));
  const result = await processWebhookDeliveries(10, () => 0.5, { store, fetchImpl, lookup: publicLookup });
  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.equal(calls.length, 1);

  const sql = store.sqlText();
  assert.doesNotMatch(sql, /published_at/, "webhook delivery must not use the transport's published_at");
  assert.doesNotMatch(sql, /attempt_count/, "webhook delivery must not bump the transport's attempt_count");
  const outboxWrites = store.statements.filter((statement) => /update corvis_control\.outbox_event/.test(statement.sql));
  assert.ok(outboxWrites.length > 0);
  for (const write of outboxWrites) {
    assert.doesNotMatch(write.sql, /last_error|next_attempt_at|transport_/, "webhook delivery must only write its own fan-out column on the outbox");
  }
  const select = store.statements.find((statement) => statement.sql.includes("from corvis_control.outbox_event e"))!.sql;
  assert.match(select, /e\.webhook_fanout_completed_at is null/);
  for (const transportType of ["DocumentRegistered", "ProcessingStageReady", "ProcessingStageRetryScheduled", "ProcessingJobRetryRequested"]) {
    assert.match(select, new RegExp(`not in \\([^)]*'${transportType}'`), `${transportType} must be excluded from webhook fan-out`);
  }
  assert.ok(store.statements.some((statement) => /set webhook_fanout_completed_at=now\(\)/.test(statement.sql)), "a completed fan-out is marked on its own column");
});

test("a subscription only receives events raised after it was created, and fan-out completion agrees", async () => {
  const store = new FakeDeliveryStore();
  store.events = [pendingEvent()];
  const { fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
  await processWebhookDeliveries(10, () => 0.5, { store, fetchImpl, lookup: publicLookup });
  const select = store.statements.find((statement) => statement.sql.includes("from corvis_control.outbox_event e"))!.sql;
  assert.match(select, /join corvis_control\.webhook_subscription s[\s\S]*and s\.created_at<=e\.created_at[\s\S]*join corvis_control\.webhook_signing_key/,
    "a new subscription must not replay events that predate it");
  const completion = store.statements.find((statement) => /set webhook_fanout_completed_at=now\(\)/.test(statement.sql))!.sql;
  assert.match(completion, /s\.created_at<=e\.created_at/, "a subscription created after the event must not hold its fan-out open forever");
});

test("webhook POST refuses redirects and is bounded by a timeout", async () => {
  const store = new FakeDeliveryStore();
  store.events = [pendingEvent()];
  const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
  const result = await processWebhookDeliveries(10, () => 0.5, { store, fetchImpl, lookup: publicLookup });
  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.equal(calls[0]?.init.redirect, "manual");
  assert.ok(calls[0]?.init.signal instanceof AbortSignal, "every webhook POST carries an abort signal");
  assert.equal(WEBHOOK_DELIVERY_TIMEOUT_MS, 10_000);
  const failure = failureUpdate(store);
  assert.equal(failure?.parameters[0], "retryable");
  assert.match(String(failure?.parameters[2]), /redirect refused \(302\)/);
  assert.equal(store.statements.some((statement) => /webhook_fanout_completed_at=now/.test(statement.sql)), false, "a retryable failure leaves the fan-out pending");
});

test("a timed-out webhook POST is recorded as a retryable timeout", async () => {
  const store = new FakeDeliveryStore();
  store.events = [pendingEvent()];
  const fetchImpl = (async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }) as typeof fetch;
  await processWebhookDeliveries(10, () => 0.5, { store, fetchImpl, lookup: publicLookup });
  const failure = failureUpdate(store);
  assert.equal(failure?.parameters[0], "retryable");
  assert.equal(failure?.parameters[2], "Webhook endpoint timed out");
});

test("send-time policy refuses endpoints that are, or resolve to, internal addresses without calling fetch", async () => {
  for (const [endpointUrl, lookup] of [
    ["https://hooks.example.com/corvis", async () => [{ address: "93.184.216.34" }, { address: "10.0.0.7" }]],
    ["https://rebind.example.com/corvis", async () => [{ address: "169.254.169.254" }]],
    ["https://127.0.0.1/corvis", publicLookup],
    ["https://metadata.google.internal/computeMetadata/v1/", publicLookup],
  ] as const) {
    const store = new FakeDeliveryStore();
    store.events = [pendingEvent({ endpoint_url: endpointUrl })];
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 200 }));
    const result = await processWebhookDeliveries(10, () => 0.5, { store, fetchImpl, lookup });
    assert.deepEqual(result, { processed: 0, failed: 1 }, endpointUrl);
    assert.equal(calls.length, 0, `${endpointUrl} must never be fetched`);
    assert.match(String(failureUpdate(store)?.parameters[2]), /webhook endpoint refused/);
  }
});

test("the default webhook transport re-checks addresses at connect time, so a DNS rebind to an internal address is refused", async () => {
  const store = new FakeDeliveryStore();
  store.events = [pendingEvent({ endpoint_url: "https://rebind.example.com/corvis" })];
  const answers = [[{ address: "93.184.216.34" }], [{ address: "169.254.169.254" }]];
  const lookups: string[] = [];
  const rebindingLookup = async (hostname: string) => { lookups.push(hostname); return answers[Math.min(lookups.length - 1, 1)]!; };
  const result = await processWebhookDeliveries(10, () => 0.5, { store, lookup: rebindingLookup });
  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.equal(lookups.length, 2, "the connect-time lookup must go through the policy, not a second unchecked resolution");
  assert.match(String(failureUpdate(store)?.parameters[2]), /resolves_to_private_address/);
});

test("policyCheckedLookup answers net's single and all-address forms and refuses private answers", async () => {
  const lookup = policyCheckedLookup(async () => [{ address: "93.184.216.34" }, { address: "2606:4700:4700::1111" }]);
  const single = await new Promise<unknown[]>((resolve) => lookup("hooks.example.com", {}, (...args) => resolve(args)));
  assert.deepEqual(single, [null, "93.184.216.34", 4]);
  const all = await new Promise<unknown[]>((resolve) => lookup("hooks.example.com", { all: true }, (...args) => resolve(args)));
  assert.deepEqual(all, [null, [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]]);
  const refused = policyCheckedLookup(async () => [{ address: "10.0.0.7" }]);
  const [error] = await new Promise<unknown[]>((resolve) => refused("hooks.example.com", {}, (...args) => resolve(args)));
  assert.match(String(error), /resolves_to_private_address/);
});

test("the default webhook transport surfaces a timeout as TimeoutError", async () => {
  const fetchImpl = policyPinnedWebhookFetch(publicLookup);
  const signal = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
  await assert.rejects(() => fetchImpl("https://hooks.example.com/corvis", { method: "POST", body: "{}", signal }), (error: unknown) => {
    assert.equal((error as Error).name, "TimeoutError");
    return true;
  });
});

test("the final failed webhook attempt is terminal and closes the fan-out", async () => {
  const store = new FakeDeliveryStore();
  store.events = [pendingEvent({ prior_attempts: 4 })];
  const { fetchImpl } = recordingFetch(() => new Response(null, { status: 500 }));
  await processWebhookDeliveries(10, () => 0.5, { store, fetchImpl, lookup: publicLookup });
  const failure = failureUpdate(store);
  assert.equal(failure?.parameters[0], "failed");
  assert.equal(failure?.parameters[1], null);
  assert.ok(store.statements.some((statement) => /webhook_fanout_completed_at=now/.test(statement.sql)));
});

test("webhook and export deliveries stuck in 'delivering' after a crash are reclaimed before claiming", async () => {
  const store = new FakeDeliveryStore();
  store.reclaimedWebhookRows = [{ tenant_id: TENANT, event_id: EVENT, state: "failed" }];
  const { fetchImpl } = recordingFetch(() => new Response(null, { status: 200 }));
  await processWebhookDeliveries(10, () => 0.5, { store, fetchImpl, lookup: publicLookup });
  const webhookReclaim = store.statements[0]!;
  assert.match(webhookReclaim.sql, /update corvis_control\.webhook_delivery[\s\S]*where state='delivering' and created_at < now\(\)-make_interval\(mins => \$2\)/);
  assert.deepEqual(webhookReclaim.parameters, [5, 10]);
  assert.ok(store.statements.some((statement) => /webhook_fanout_completed_at=now/.test(statement.sql)), "a reclaimed-to-failed delivery re-evaluates fan-out completion");

  const exportStore = new FakeDeliveryStore();
  await processQueuedExports(5, exportStore);
  const exportReclaim = exportStore.statements[0]!;
  assert.match(exportReclaim.sql, /update corvis_serving\.export_job[\s\S]*where state='delivering'[\s\S]*delivery_started_at/);
  assert.deepEqual(exportReclaim.parameters, [5, 10]);
});

test("sweepUnsubscribedWebhookFanoutEvents marks fan-out complete only when no active-or-paused subscription can ever match, bounded by limit", async () => {
  const store = new FakeDeliveryStore();
  const swept = [{ event_id: "e1" }, { event_id: "e2" }];
  store.query = (async (sql: string, parameters: PostgresPrimitive[] = []) => {
    store.statements.push({ sql, parameters });
    if (sql.startsWith("update corvis_control.outbox_event e")) return swept;
    return [];
  }) as typeof store.query;

  const count = await sweepUnsubscribedWebhookFanoutEvents(store, 250);
  assert.equal(count, 2);

  const [statement] = store.statements;
  assert.ok(statement);
  assert.match(statement.sql, /update corvis_control\.outbox_event e\s+set webhook_fanout_completed_at=now\(\)/);
  assert.match(statement.sql, /e\.event_id in \(/);
  assert.match(statement.sql, /e2\.webhook_fanout_completed_at is null/);
  assert.match(statement.sql, /not exists \(\s*select 1 from corvis_control\.webhook_subscription s/);
  assert.match(statement.sql, /s\.status in \('active','paused'\)/, "a currently-paused subscription can still be resumed, so it still counts as a possible future subscriber");
  assert.match(statement.sql, /e2\.event_type=any\(s\.event_types\)/);
  assert.match(statement.sql, /s\.created_at<=e2\.created_at/, "must mirror the live fan-out query's created_at<=event.created_at semantics");
  for (const transportType of ["DocumentRegistered", "ProcessingStageReady", "ProcessingStageRetryScheduled", "ProcessingJobRetryRequested"]) {
    assert.match(statement.sql, new RegExp(`not in \\([^)]*'${transportType}'`), `${transportType} must be excluded from the sweep`);
  }
  assert.match(statement.sql, /limit \$1/);
  assert.deepEqual(statement.parameters, [250]);
});

test("sweepUnsubscribedWebhookFanoutEvents defaults to a bounded limit", async () => {
  const store = new FakeDeliveryStore();
  await sweepUnsubscribedWebhookFanoutEvents(store);
  assert.deepEqual(store.statements[0]?.parameters, [WEBHOOK_FANOUT_SWEEP_LIMIT]);
});

function jitterBounds(base: number) {
  const range = base * WEBHOOK_RETRY_JITTER_RATIO;
  return { min: base - range, max: base + range };
}

test("attempt 1 backs off around the original 5-minute base with no jitter when random is centered", () => {
  const delay = computeWebhookRetryDelayMs(1, () => 0.5);
  assert.equal(delay, WEBHOOK_RETRY_BASE_DELAY_MS);
});

test("delay grows monotonically with attempt number before hitting the cap", () => {
  const noJitter = () => 0.5;
  const attempt1 = computeWebhookRetryDelayMs(1, noJitter);
  const attempt2 = computeWebhookRetryDelayMs(2, noJitter);
  const attempt3 = computeWebhookRetryDelayMs(3, noJitter);
  const attempt4 = computeWebhookRetryDelayMs(4, noJitter);
  assert.ok(attempt2 > attempt1, "attempt 2 should back off longer than attempt 1");
  assert.ok(attempt3 > attempt2, "attempt 3 should back off longer than attempt 2");
  assert.ok(attempt4 > attempt3, "attempt 4 should back off longer than attempt 3");
  assert.equal(attempt2, WEBHOOK_RETRY_BASE_DELAY_MS * 2);
  assert.equal(attempt3, WEBHOOK_RETRY_BASE_DELAY_MS * 4);
  assert.equal(attempt4, WEBHOOK_RETRY_BASE_DELAY_MS * 8);
});

test("delay is capped at the maximum delay for large attempt numbers", () => {
  const noJitter = () => 0.5;
  const farFuture = computeWebhookRetryDelayMs(20, noJitter);
  assert.equal(farFuture, WEBHOOK_RETRY_MAX_DELAY_MS);
  // Confirm the exponential value would have exceeded the cap without it.
  const uncappedWouldBe = WEBHOOK_RETRY_BASE_DELAY_MS * 2 ** 19;
  assert.ok(uncappedWouldBe > WEBHOOK_RETRY_MAX_DELAY_MS);
});

test("jitter stays within +/-20% of the (possibly capped) delay across the random range", () => {
  for (const attempt of [1, 2, 3, 4, 10, 25]) {
    const base = Math.min(WEBHOOK_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), WEBHOOK_RETRY_MAX_DELAY_MS);
    const { min, max } = jitterBounds(base);
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = computeWebhookRetryDelayMs(attempt, () => r);
      assert.ok(delay >= min - 1 && delay <= max + 1, `attempt ${attempt} r=${r} delay ${delay} out of [${min},${max}]`);
    }
  }
});

test("jitter can push the delay both above and below the unjittered value", () => {
  const base = computeWebhookRetryDelayMs(2, () => 0.5);
  const low = computeWebhookRetryDelayMs(2, () => 0);
  const high = computeWebhookRetryDelayMs(2, () => 1);
  assert.ok(low < base, "random()=0 should jitter below the base delay");
  assert.ok(high > base, "random()=1 should jitter above the base delay");
});

test("delay never goes negative even with an out-of-range random source", () => {
  const delay = computeWebhookRetryDelayMs(1, () => -5);
  assert.ok(delay >= 0);
});

test("default random source (Math.random) stays within jittered bounds", () => {
  const base = WEBHOOK_RETRY_BASE_DELAY_MS * 4; // attempt 3
  const { min, max } = jitterBounds(base);
  for (let i = 0; i < 25; i++) {
    const delay = computeWebhookRetryDelayMs(3);
    assert.ok(delay >= min - 1 && delay <= max + 1);
  }
});
