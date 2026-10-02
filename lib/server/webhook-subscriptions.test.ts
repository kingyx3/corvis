import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { encodeCursor, InvalidCursorError } from "./pagination.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import {
  createWebhookSubscription, listWebhookDeliveries, listWebhookSubscriptions, pauseWebhookSubscription,
  resumeWebhookSubscription, revokeWebhookSubscription, rotateWebhookSigningKey, sweepExpiredWebhookSigningKeys,
  webhookSubscriptionTransition,
  WebhookSubscriptionError,
  MAX_WEBHOOK_ENDPOINT_URL_LENGTH, MAX_WEBHOOK_SUBSCRIPTIONS_PER_TENANT,
  type WebhookDeliveryPage,
} from "./webhook-subscriptions.ts";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";

function identity(tenantId: string): RequestIdentity {
  return { tenantId, workspaceId: "ws-1", subject: "user-1", sessionId: "session-1", roles: ["admin"] } as RequestIdentity;
}

type SubscriptionRow = { tenant_id: string; webhook_id: string; endpoint_url: string; event_types: string[]; status: string; created_at: string; updated_at: string };
type SigningKeyRow = { tenant_id: string; webhook_id: string; key_id: string; secret: string; status: string; retire_by: string | null };
type DeliveryRow = { tenant_id: string; webhook_id: string; delivery_id: string; event_id: string; attempt: number; state: string; status_code: number | null; last_error: string | null; created_at: string; completed_at: string | null };

/** The canonical microsecond UTC form the SQL `to_char(...)` produces for a created_at (input may already carry 6 fractional digits). */
function micros(timestamp: string): string {
  const fractional = /\.(\d{6})Z$/.exec(timestamp);
  return fractional ? timestamp : new Date(timestamp).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

function parsePgTextArray(literal: string): string[] {
  const inner = literal.slice(1, -1);
  if (!inner) return [];
  return inner.split(",").map((value) => value.replace(/^"|"$/g, "").replaceAll("\\\"", "\"").replaceAll("\\\\", "\\"));
}

class FakeWebhookDb implements PostgresSqlApi {
  subscriptions: SubscriptionRow[] = [];
  signingKeys: SigningKeyRow[] = [];
  deliveries: DeliveryRow[] = [];
  deliveryQueries = 0;
  lastDeliveryQuery: { sql: string; parameters: PostgresPrimitive[] } | undefined;
  locks = 0;

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    if (sql.includes("select corvis_control.create_webhook_subscription(")) {
      const [tenantId, webhookId, endpointUrl, eventTypesLiteral, createdBy, keyId, secret] = parameters as string[];
      if (this.subscriptions.some((row) => row.webhook_id === webhookId)) throw new Error("duplicate webhook_id");
      this.subscriptions.push({ tenant_id: tenantId, webhook_id: webhookId, endpoint_url: endpointUrl, event_types: parsePgTextArray(eventTypesLiteral), status: "active", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      this.signingKeys.push({ tenant_id: tenantId, webhook_id: webhookId, key_id: keyId, secret, status: "active", retire_by: null });
      void createdBy;
      return [];
    }
    if (sql.includes("pg_advisory_xact_lock")) { this.locks += 1; return []; }
    if (sql.includes("select count(*)::int as count from corvis_control.webhook_subscription")) {
      const [tenantId] = parameters as string[];
      return [{ count: this.subscriptions.filter((s) => s.tenant_id === tenantId && s.status !== "revoked").length }];
    }
    if (sql.includes("select corvis_control.rotate_webhook_signing_key(")) {
      const [tenantId, webhookId, newKeyId, newSecret] = parameters as string[];
      for (const key of this.signingKeys) {
        if (key.tenant_id === tenantId && key.webhook_id === webhookId && key.status === "active") key.status = "retiring";
      }
      this.signingKeys.push({ tenant_id: tenantId, webhook_id: webhookId, key_id: newKeyId, secret: newSecret, status: "active", retire_by: null });
      return [];
    }
    if (sql.includes("select event_types from corvis_control.webhook_subscription")) {
      const [tenantId, webhookId] = parameters as string[];
      const row = this.subscriptions.find((s) => s.tenant_id === tenantId && s.webhook_id === webhookId && s.status === "paused");
      return row ? [{ event_types: [...row.event_types] }] : [];
    }
    if (sql.includes("select status from corvis_control.webhook_subscription")) {
      const [tenantId, webhookId] = parameters as string[];
      const row = this.subscriptions.find((s) => s.tenant_id === tenantId && s.webhook_id === webhookId);
      return row ? [{ status: row.status }] : [];
    }
    if (sql.includes("from corvis_control.webhook_subscription") && sql.includes("order by webhook_id")) {
      const [tenantId] = parameters as string[];
      return this.subscriptions.filter((row) => row.tenant_id === tenantId).map((row) => ({ ...row }));
    }
    if (sql.startsWith("update corvis_control.webhook_subscription")) {
      const [tenantId, webhookId, toStatus, fromLiteral] = parameters as string[];
      const allowedFrom = parsePgTextArray(fromLiteral);
      const row = this.subscriptions.find((s) => s.tenant_id === tenantId && s.webhook_id === webhookId);
      if (!row || !allowedFrom.includes(row.status)) return [];
      row.status = toStatus;
      row.updated_at = new Date().toISOString();
      return [{ ...row }];
    }
    if (sql.includes("from corvis_control.webhook_delivery") && sql.includes("order by created_at desc, delivery_id desc")) {
      const [tenantId, webhookId, limit, afterCreatedAt, afterDeliveryId] = parameters as [string, string, number, string | null, string | null];
      this.deliveryQueries += 1;
      this.lastDeliveryQuery = { sql, parameters };
      // Mirrors `(created_at, delivery_id) < ($4, $5)` ordered by created_at desc, delivery_id desc at microsecond precision.
      const ordering = (a: DeliveryRow, b: DeliveryRow): number =>
        micros(b.created_at).localeCompare(micros(a.created_at)) || b.delivery_id.localeCompare(a.delivery_id);
      return this.deliveries
        .filter((row) => row.tenant_id === tenantId && row.webhook_id === webhookId)
        .filter((row) => afterCreatedAt == null || afterDeliveryId == null
          || micros(row.created_at) < afterCreatedAt
          || (micros(row.created_at) === afterCreatedAt && row.delivery_id < afterDeliveryId))
        .sort(ordering)
        .slice(0, limit)
        .map((row) => ({ ...row, cursor_created_at: micros(row.created_at) }));
    }
    if (sql.includes("update corvis_control.webhook_signing_key") && sql.includes("status='revoked'")) {
      const now = Date.now();
      const revoked: PostgresRow[] = [];
      for (const key of this.signingKeys) {
        if (key.status === "retiring" && key.retire_by && Date.parse(key.retire_by) <= now) {
          key.status = "revoked";
          revoked.push({ key_id: key.key_id });
        }
      }
      return revoked;
    }
    return [];
  }

  async execute(): Promise<void> {}

  async health(): Promise<boolean> { return true; }
}

test("createWebhookSubscription rejects a non-https endpoint and empty event types", async () => {
  const db = new FakeWebhookDb();
  await assert.rejects(
    () => createWebhookSubscription(identity(TENANT_A), { endpointUrl: "http://example.com/hook", eventTypes: ["SnapshotPublicationChanged"] }, db),
    WebhookSubscriptionError,
  );
  await assert.rejects(
    () => createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: [] }, db),
    WebhookSubscriptionError,
  );
});

test("createWebhookSubscription returns the signing secret exactly once; later reads never include it", async () => {
  const db = new FakeWebhookDb();
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: ["SnapshotPublicationChanged", "SnapshotPublicationChanged"] }, db);
  assert.equal(created.eventTypes.length, 1, "duplicate event types are deduplicated");
  assert.equal(created.signingSecret.length >= 32, true);

  const listed = await listWebhookSubscriptions(identity(TENANT_A), db);
  assert.equal(listed.length, 1);
  assert.equal((listed[0] as unknown as { signingSecret?: string }).signingSecret, undefined, "list must never re-expose the signing secret");
});

test("a tenant cannot see or mutate another tenant's subscription", async () => {
  const db = new FakeWebhookDb();
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: ["SnapshotPublicationChanged"] }, db);

  assert.deepEqual(await listWebhookSubscriptions(identity(TENANT_B), db), []);
  await assert.rejects(() => pauseWebhookSubscription(identity(TENANT_B), created.webhookId, db), WebhookSubscriptionError);
  await assert.rejects(() => rotateWebhookSigningKey(identity(TENANT_B), created.webhookId, db), WebhookSubscriptionError);
});

test("pause/resume/revoke enforce valid transitions and revoke is terminal", async () => {
  const db = new FakeWebhookDb();
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: ["SnapshotPublicationChanged"] }, db);

  await assert.rejects(() => resumeWebhookSubscription(identity(TENANT_A), created.webhookId, db), WebhookSubscriptionError, "cannot resume an already-active subscription");

  const paused = await pauseWebhookSubscription(identity(TENANT_A), created.webhookId, db);
  assert.equal(paused.status, "paused");

  const resumed = await resumeWebhookSubscription(identity(TENANT_A), created.webhookId, db);
  assert.equal(resumed.status, "active");

  const revoked = await revokeWebhookSubscription(identity(TENANT_A), created.webhookId, db);
  assert.equal(revoked.status, "revoked");

  await assert.rejects(() => resumeWebhookSubscription(identity(TENANT_A), created.webhookId, db), WebhookSubscriptionError, "revoked is terminal");
  await assert.rejects(() => pauseWebhookSubscription(identity(TENANT_A), created.webhookId, db), WebhookSubscriptionError);
});

test("a paused subscription with no event types cannot be resumed and reports a client error", async () => {
  const db = new FakeWebhookDb();
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: ["SnapshotPublicationChanged"] }, db);
  await pauseWebhookSubscription(identity(TENANT_A), created.webhookId, db);
  db.subscriptions[0]!.event_types = [];
  await assert.rejects(
    () => resumeWebhookSubscription(identity(TENANT_A), created.webhookId, db),
    (error: unknown) => error instanceof WebhookSubscriptionError && error.code === "event_types_required",
  );
  assert.equal(db.subscriptions[0]!.status, "paused");
});

test("rotateWebhookSigningKey retires the old key and activates exactly one new key; revoked subscriptions cannot rotate", async () => {
  const db = new FakeWebhookDb();
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: ["SnapshotPublicationChanged"] }, db);
  const rotated = await rotateWebhookSigningKey(identity(TENANT_A), created.webhookId, db);
  assert.notEqual(rotated.signingKeyId, created.signingKeyId);
  assert.notEqual(rotated.signingSecret, created.signingSecret);

  const activeKeys = db.signingKeys.filter((key) => key.webhook_id === created.webhookId && key.status === "active");
  assert.equal(activeKeys.length, 1, "exactly one active key must remain after rotation");
  const retiringKeys = db.signingKeys.filter((key) => key.webhook_id === created.webhookId && key.status === "retiring");
  assert.equal(retiringKeys.length, 1);

  await revokeWebhookSubscription(identity(TENANT_A), created.webhookId, db);
  await assert.rejects(() => rotateWebhookSigningKey(identity(TENANT_A), created.webhookId, db), WebhookSubscriptionError);
});

test("rotating a nonexistent subscription fails closed instead of creating an orphan key", async () => {
  const db = new FakeWebhookDb();
  await assert.rejects(() => rotateWebhookSigningKey(identity(TENANT_A), "not-a-real-webhook-id", db), WebhookSubscriptionError);
});

test("sweepExpiredWebhookSigningKeys revokes only past-due retiring keys", async () => {
  const db = new FakeWebhookDb();
  db.signingKeys.push(
    { tenant_id: TENANT_A, webhook_id: "w1", key_id: "k1", secret: "s".repeat(32), status: "retiring", retire_by: new Date(Date.now() - 1000).toISOString() },
    { tenant_id: TENANT_A, webhook_id: "w1", key_id: "k2", secret: "s".repeat(32), status: "retiring", retire_by: new Date(Date.now() + 60_000).toISOString() },
  );
  await sweepExpiredWebhookSigningKeys(db);
  assert.equal(db.signingKeys.find((key) => key.key_id === "k1")?.status, "revoked");
  assert.equal(db.signingKeys.find((key) => key.key_id === "k2")?.status, "retiring", "a key not yet past its grace deadline must remain untouched");
});

const HOOK_ID = "00000000-0000-4000-8000-0000000000c1";

function delivery(tenantId: string, deliveryId: string, createdAt: string, overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return { tenant_id: tenantId, webhook_id: HOOK_ID, delivery_id: deliveryId, event_id: "e1", attempt: 1, state: "complete", status_code: 200, last_error: null, created_at: createdAt, completed_at: null, ...overrides };
}

/** The route's behavior: walk every page via nextCursor. */
async function walkDeliveries(db: FakeWebhookDb, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: WebhookDeliveryPage = await listWebhookDeliveries(identity(TENANT_A), HOOK_ID, db, { cursor, limit });
    assert.ok(page.items.length <= limit, "a page never exceeds its size");
    seen.push(...page.items.map((item) => item.deliveryId));
    cursor = page.nextCursor;
  } while (cursor);
  return seen;
}

function deliveryUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

test("listWebhookDeliveries returns diagnostics scoped to the tenant and subscription", async () => {
  const db = new FakeWebhookDb();
  db.deliveries.push(
    delivery(TENANT_A, deliveryUuid(1), "2026-01-01T00:00:00Z", { state: "failed", status_code: 500, last_error: "boom" }),
    delivery(TENANT_B, deliveryUuid(2), "2026-01-01T00:00:00Z", { completed_at: "2026-01-01T00:00:01Z" }),
    { ...delivery(TENANT_A, deliveryUuid(3), "2026-01-01T00:00:00Z"), webhook_id: "00000000-0000-4000-8000-0000000000c2" },
  );
  const { items, nextCursor } = await listWebhookDeliveries(identity(TENANT_A), HOOK_ID, db);
  assert.equal(nextCursor, null);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.deliveryId, deliveryUuid(1));
  assert.equal(items[0]?.lastError, "boom");
  assert.equal(items[0]?.statusCode, 500);
  assert.equal(items[0]?.state, "failed");
  assert.equal(items[0]?.completedAt, undefined);
});

test("listWebhookDeliveries maps a retryable delivery with an absent status code", async () => {
  const db = new FakeWebhookDb();
  db.deliveries.push(delivery(TENANT_A, deliveryUuid(1), "2026-01-01T00:00:00Z", { status_code: null, completed_at: "2026-01-01T00:00:01Z", state: "retryable", attempt: 3 }));
  const { items } = await listWebhookDeliveries(identity(TENANT_A), HOOK_ID, db);
  assert.equal(items[0]?.statusCode, undefined);
  assert.equal(items[0]?.completedAt, "2026-01-01T00:00:01Z");
  assert.equal(items[0]?.attempt, 3);
});

test("listWebhookDeliveries lists the latest deliveries first, regardless of their random delivery ids", async () => {
  const db = new FakeWebhookDb();
  // Ids deliberately anti-correlated with time: a delivery_id ordering would put the oldest row first.
  db.deliveries.push(
    delivery(TENANT_A, deliveryUuid(1), "2026-03-01T00:00:03Z", { state: "failed" }),
    delivery(TENANT_A, deliveryUuid(2), "2026-03-01T00:00:02Z"),
    delivery(TENANT_A, deliveryUuid(3), "2026-03-01T00:00:01Z"),
    delivery(TENANT_A, deliveryUuid(4), "2026-03-01T00:00:03Z", { state: "retryable" }),
  );
  const first = await listWebhookDeliveries(identity(TENANT_A), HOOK_ID, db, { limit: 2 });
  // Equal created_at ties break by delivery_id descending; the newest instant leads.
  assert.deepEqual(first.items.map((item) => item.deliveryId), [deliveryUuid(4), deliveryUuid(1)]);
  assert.ok(first.nextCursor);
  const second = await listWebhookDeliveries(identity(TENANT_A), HOOK_ID, db, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.deliveryId), [deliveryUuid(2), deliveryUuid(3)]);
  assert.equal(second.nextCursor, null);
});

test("listWebhookDeliveries pages by a composite cursor so rows sharing a timestamp are neither skipped nor repeated", async () => {
  const db = new FakeWebhookDb();
  const total = 2105;
  for (let index = 0; index < total; index++) {
    // Many rows share each instant (7 per second), and sub-millisecond digits differ between some of them.
    const second = String(Math.floor(index / 7) % 60).padStart(2, "0");
    const minute = String(Math.floor(index / 420)).padStart(2, "0");
    const fraction = index % 2 === 0 ? ".000000" : ".000500";
    db.deliveries.push(delivery(TENANT_A, deliveryUuid((index * 7919) % 100_003), `2026-01-01T00:${minute}:${second}${fraction}Z`));
  }
  const seen = await walkDeliveries(db, 200);
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total, "no delivery is repeated across pages");
  const expected = [...db.deliveries]
    .sort((a, b) => micros(b.created_at).localeCompare(micros(a.created_at)) || b.delivery_id.localeCompare(a.delivery_id))
    .map((row) => row.delivery_id);
  assert.deepEqual(seen, expected, "the walk is chronological, newest first");
  // Page fetches stay bounded at page + 1 rows.
  assert.equal(db.lastDeliveryQuery?.parameters[2], 201);
});

test("listWebhookDeliveries clamps the page size to 1..200, defaulting to 50", async () => {
  const db = new FakeWebhookDb();
  for (let index = 0; index < 260; index++) db.deliveries.push(delivery(TENANT_A, deliveryUuid(index), "2026-01-01T00:00:00Z"));
  assert.equal((await listWebhookDeliveries(identity(TENANT_A), HOOK_ID, db)).items.length, 50);
  assert.equal((await listWebhookDeliveries(identity(TENANT_A), HOOK_ID, db, { limit: 0 })).items.length, 1);
  assert.equal((await listWebhookDeliveries(identity(TENANT_A), HOOK_ID, db, { limit: 10_000 })).items.length, 200);
  assert.equal((await listWebhookDeliveries(identity(TENANT_A), HOOK_ID, db, { limit: 2.9 })).items.length, 2);
});

test("listWebhookDeliveries rejects pre-existing, tampered or impossible cursors as invalid_cursor before any query", async () => {
  const db = new FakeWebhookDb();
  const goodStamp = "2026-01-01T00:00:00.000000Z";
  const goodId = deliveryUuid(1);
  const rejected = [
    encodeCursor(goodId), // a cursor issued before the ordering change: bare delivery id
    encodeCursor(`${goodStamp}|not-a-uuid'); drop table x;--`),
    encodeCursor(`2026-01-01T00:00:00Z|${goodId}`), // missing microsecond digits
    encodeCursor(`0000-01-01T00:00:00.000000Z|${goodId}`), // no year zero in Postgres
    encodeCursor(`2026-02-30T00:00:00.000000Z|${goodId}`), // impossible date Date.parse would roll over
    encodeCursor(`2026-01-01T24:00:00.000000Z|${goodId}`),
    encodeCursor(`${goodStamp}|`),
    encodeCursor(`|${goodId}`),
    encodeCursor(`${goodStamp}${goodId}`), // no separator
    "not-base64-json",
  ];
  for (const cursor of rejected) {
    await assert.rejects(() => listWebhookDeliveries(identity(TENANT_A), HOOK_ID, db, { cursor }), InvalidCursorError, cursor);
  }
  assert.equal(db.deliveryQueries, 0, "a bad cursor never reaches the ::timestamptz / ::uuid casts");

  // A well-formed composite cursor (upper-case id included) is accepted and normalized.
  const hexId = deliveryUuid(0xab);
  const accepted = await listWebhookDeliveries(identity(TENANT_A), HOOK_ID, db, { cursor: encodeCursor(`${goodStamp}|${hexId.toUpperCase()}`) });
  assert.deepEqual(accepted.items, []);
  assert.equal(db.lastDeliveryQuery?.parameters[3], goodStamp);
  assert.equal(db.lastDeliveryQuery?.parameters[4], hexId);
});

async function rejectsWithCode(promise: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WebhookSubscriptionError);
    assert.equal(error.code, code);
    return true;
  });
}

test("createWebhookSubscription rejects internal processing-transport and unknown event types", async () => {
  const db = new FakeWebhookDb();
  for (const eventType of ["DocumentRegistered", "ProcessingStageReady", "ProcessingStageRetryScheduled", "ProcessingJobRetryRequested", "NotARealEvent"]) {
    await rejectsWithCode(
      () => createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: ["SnapshotPublicationChanged", eventType] }, db),
      "event_type_not_supported",
    );
  }
  assert.equal(db.subscriptions.length, 0, "a rejected subscription must never reach the database");
});

test("createWebhookSubscription rejects loopback, private, link-local and metadata endpoints", async () => {
  const db = new FakeWebhookDb();
  for (const endpointUrl of [
    "https://localhost/hook",
    "https://api.localhost/hook",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://127.0.0.1/hook",
    "https://2130706433/hook",
    "https://10.1.2.3/hook",
    "https://172.16.0.1/hook",
    "https://192.168.1.10/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/hook",
    "https://0.0.0.0/hook",
    "https://[::1]/hook",
    "https://[fd00:ec2::254]/hook",
    "https://[fe80::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
  ]) {
    await rejectsWithCode(
      () => createWebhookSubscription(identity(TENANT_A), { endpointUrl, eventTypes: ["SnapshotPublicationChanged"] }, db),
      "endpoint_url_host_not_allowed",
    );
  }
  assert.equal(db.subscriptions.length, 0);
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://hooks.example.com/corvis", eventTypes: ["SnapshotPublicationChanged"] }, db);
  assert.equal(created.endpointUrl, "https://hooks.example.com/corvis");
});

test("a non-UUID webhook id is rejected as not-found before any database access", async () => {
  const db = new FakeWebhookDb();
  let queried = false;
  const original = db.query.bind(db);
  db.query = async (sql, parameters) => { queried = true; return original(sql, parameters); };
  await rejectsWithCode(() => pauseWebhookSubscription(identity(TENANT_A), "not-a-uuid", db), "webhook_subscription_not_found");
  await rejectsWithCode(() => rotateWebhookSigningKey(identity(TENANT_A), "1; drop table x", db), "webhook_subscription_not_found");
  await rejectsWithCode(() => listWebhookDeliveries(identity(TENANT_A), "w1", db), "webhook_subscription_not_found");
  assert.equal(queried, false);
});

test("webhookSubscriptionTransition resolves only own actions, never prototype members", () => {
  assert.equal(webhookSubscriptionTransition("pause"), pauseWebhookSubscription);
  assert.equal(webhookSubscriptionTransition("resume"), resumeWebhookSubscription);
  assert.equal(webhookSubscriptionTransition("revoke"), revokeWebhookSubscription);
  for (const action of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "", undefined, null, 1, {}]) {
    assert.equal(webhookSubscriptionTransition(action), undefined, `action ${String(action)} must not resolve`);
  }
});

const HOOK_EVENTS = ["SnapshotPublicationChanged"];

test("createWebhookSubscription rejects an over-long endpoint URL as submitted or once normalized, and accepts the limit", async () => {
  const db = new FakeWebhookDb();
  const prefix = "https://example.com/";
  const atLimit = prefix + "a".repeat(MAX_WEBHOOK_ENDPOINT_URL_LENGTH - prefix.length);
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: atLimit, eventTypes: HOOK_EVENTS }, db);
  assert.equal(created.endpointUrl.length, MAX_WEBHOOK_ENDPOINT_URL_LENGTH);

  await assert.rejects(
    () => createWebhookSubscription(identity(TENANT_A), { endpointUrl: atLimit + "a", eventTypes: HOOK_EVENTS }, db),
    (error: unknown) => error instanceof WebhookSubscriptionError && error.code === "endpoint_url_too_long",
  );
  // Short as submitted, longer once each non-ASCII character is percent-encoded (6 chars) by URL normalization.
  const expanding = prefix + "é".repeat(Math.ceil((MAX_WEBHOOK_ENDPOINT_URL_LENGTH - prefix.length) / 6) + 1);
  assert.ok(expanding.length <= MAX_WEBHOOK_ENDPOINT_URL_LENGTH);
  await assert.rejects(
    () => createWebhookSubscription(identity(TENANT_A), { endpointUrl: expanding, eventTypes: HOOK_EVENTS }, db),
    (error: unknown) => error instanceof WebhookSubscriptionError && error.code === "endpoint_url_too_long",
  );
  assert.equal(db.subscriptions.length, 1);
});

test("createWebhookSubscription caps non-revoked subscriptions per tenant, locks, and frees capacity on revoke", async () => {
  const db = new FakeWebhookDb();
  const created: string[] = [];
  for (let i = 0; i < MAX_WEBHOOK_SUBSCRIPTIONS_PER_TENANT; i += 1) {
    created.push((await createWebhookSubscription(identity(TENANT_A), { endpointUrl: `https://example.com/hook/${i}`, eventTypes: HOOK_EVENTS }, db)).webhookId);
  }
  assert.equal(db.locks, MAX_WEBHOOK_SUBSCRIPTIONS_PER_TENANT);
  await assert.rejects(
    () => createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/over", eventTypes: HOOK_EVENTS }, db),
    (error: unknown) => error instanceof WebhookSubscriptionError && error.code === "webhook_subscription_limit_reached",
  );
  assert.equal(db.subscriptions.length, MAX_WEBHOOK_SUBSCRIPTIONS_PER_TENANT);
  assert.equal(db.signingKeys.length, MAX_WEBHOOK_SUBSCRIPTIONS_PER_TENANT);

  // The cap is per tenant.
  await createWebhookSubscription(identity(TENANT_B), { endpointUrl: "https://example.com/b", eventTypes: HOOK_EVENTS }, db);

  // Pausing keeps a subscription counted; revoking (terminal) frees its slot.
  await pauseWebhookSubscription(identity(TENANT_A), created[0]!, db);
  await assert.rejects(
    () => createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/over", eventTypes: HOOK_EVENTS }, db),
    WebhookSubscriptionError,
  );
  await revokeWebhookSubscription(identity(TENANT_A), created[0]!, db);
  await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/again", eventTypes: HOOK_EVENTS }, db);
});

test("createWebhookSubscription rejects non-array event types and missing, non-string or unparseable endpoint URLs", async () => {
  const db = new FakeWebhookDb();
  const create = (input: unknown) => createWebhookSubscription(identity(TENANT_A), input as { endpointUrl: string; eventTypes: string[] }, db);
  await rejectsWithCode(() => create({ endpointUrl: "https://example.com/hook", eventTypes: "SnapshotPublicationChanged" }), "event_types_required");
  await rejectsWithCode(() => create({ endpointUrl: 42, eventTypes: HOOK_EVENTS }), "endpoint_url_required");
  await rejectsWithCode(() => create({ endpointUrl: "   ", eventTypes: HOOK_EVENTS }), "endpoint_url_required");
  await rejectsWithCode(() => create({ endpointUrl: "not a url", eventTypes: HOOK_EVENTS }), "endpoint_url_invalid");
  await rejectsWithCode(() => create({ endpointUrl: "http://example.com/hook", eventTypes: HOOK_EVENTS }), "endpoint_url_must_be_https");
  assert.equal(db.subscriptions.length, 0);
});

test("createWebhookSubscription treats an empty count result as zero existing subscriptions", async () => {
  const db = new FakeWebhookDb();
  const original = db.query.bind(db);
  db.query = async (sql, parameters) => sql.includes("select count(*)::int") ? [] : original(sql, parameters);
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: HOOK_EVENTS }, db);
  assert.equal(created.status, "active");
  assert.equal(db.subscriptions.length, 1);
});

test("listWebhookSubscriptions defaults a row without status to active and without event types to none", async () => {
  const db = new FakeWebhookDb();
  const sparse = { tenant_id: TENANT_A, webhook_id: "w-sparse", endpoint_url: "https://example.com/s", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
  db.subscriptions.push(sparse as unknown as SubscriptionRow);
  const [record] = await listWebhookSubscriptions(identity(TENANT_A), db);
  assert.equal(record?.status, "active");
  assert.deepEqual(record?.eventTypes, []);
});

test("webhook functions default to the configured control-plane database", async () => {
  const previousDsn = process.env.CORVIS_POSTGRES_DSN;
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; sql: string; parameters: unknown[] }> = [];
  process.env.CORVIS_POSTGRES_DSN = "https://control-plane.example.test/sql";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { sql: string; parameters: unknown[] };
    requests.push({ url: String(url), sql: body.sql, parameters: body.parameters });
    return Response.json({ rows: [{ delivery_id: deliveryUuid(7), event_id: "e1", attempt: 2, state: "failed", status_code: 502, last_error: "bad gateway", created_at: "2026-01-02T03:04:05.123456Z", completed_at: null, cursor_created_at: "2026-01-02T03:04:05.123456Z" }] });
  }) as typeof fetch;
  try {
    const page = await listWebhookDeliveries(identity(TENANT_A), HOOK_ID);
    assert.equal(page.items[0]?.lastError, "bad gateway");
    assert.equal(page.nextCursor, null);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://control-plane.example.test/sql");
    assert.match(requests[0]!.sql, /order by created_at desc, delivery_id desc/);
    assert.deepEqual(requests[0]!.parameters.slice(0, 3), [TENANT_A, HOOK_ID, 51]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDsn === undefined) delete process.env.CORVIS_POSTGRES_DSN;
    else process.env.CORVIS_POSTGRES_DSN = previousDsn;
  }
});
