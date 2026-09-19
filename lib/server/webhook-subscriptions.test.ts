import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import {
  createWebhookSubscription, listWebhookDeliveries, listWebhookSubscriptions, pauseWebhookSubscription,
  resumeWebhookSubscription, revokeWebhookSubscription, rotateWebhookSigningKey, sweepExpiredWebhookSigningKeys,
  WebhookSubscriptionError,
} from "./webhook-subscriptions.ts";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";

function identity(tenantId: string): RequestIdentity {
  return { tenantId, workspaceId: "ws-1", subject: "user-1", sessionId: "session-1", roles: ["admin"] } as RequestIdentity;
}

type SubscriptionRow = { tenant_id: string; webhook_id: string; endpoint_url: string; event_types: string[]; status: string; created_at: string; updated_at: string };
type SigningKeyRow = { tenant_id: string; webhook_id: string; key_id: string; secret: string; status: string; retire_by: string | null };
type DeliveryRow = { tenant_id: string; webhook_id: string; delivery_id: string; event_id: string; attempt: number; state: string; status_code: number | null; last_error: string | null; created_at: string; completed_at: string | null };

function parsePgTextArray(literal: string): string[] {
  const inner = literal.slice(1, -1);
  if (!inner) return [];
  return inner.split(",").map((value) => value.replace(/^"|"$/g, "").replaceAll("\\\"", "\"").replaceAll("\\\\", "\\"));
}

class FakeWebhookDb implements PostgresSqlApi {
  subscriptions: SubscriptionRow[] = [];
  signingKeys: SigningKeyRow[] = [];
  deliveries: DeliveryRow[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    if (sql.includes("select corvis_control.create_webhook_subscription(")) {
      const [tenantId, webhookId, endpointUrl, eventTypesLiteral, createdBy, keyId, secret] = parameters as string[];
      if (this.subscriptions.some((row) => row.webhook_id === webhookId)) throw new Error("duplicate webhook_id");
      this.subscriptions.push({ tenant_id: tenantId, webhook_id: webhookId, endpoint_url: endpointUrl, event_types: parsePgTextArray(eventTypesLiteral), status: "active", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      this.signingKeys.push({ tenant_id: tenantId, webhook_id: webhookId, key_id: keyId, secret, status: "active", retire_by: null });
      void createdBy;
      return [];
    }
    if (sql.includes("select corvis_control.rotate_webhook_signing_key(")) {
      const [tenantId, webhookId, newKeyId, newSecret] = parameters as string[];
      for (const key of this.signingKeys) {
        if (key.tenant_id === tenantId && key.webhook_id === webhookId && key.status === "active") key.status = "retiring";
      }
      this.signingKeys.push({ tenant_id: tenantId, webhook_id: webhookId, key_id: newKeyId, secret: newSecret, status: "active", retire_by: null });
      return [];
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
    if (sql.includes("from corvis_control.webhook_delivery") && sql.includes("order by delivery_id")) {
      const [tenantId, webhookId] = parameters as string[];
      return this.deliveries
        .filter((row) => row.tenant_id === tenantId && row.webhook_id === webhookId)
        .sort((a, b) => (a.delivery_id < b.delivery_id ? -1 : 1))
        .map((row) => ({ ...row }));
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
    () => createWebhookSubscription(identity(TENANT_A), { endpointUrl: "http://example.com/hook", eventTypes: ["DocumentRegistered"] }, db),
    WebhookSubscriptionError,
  );
  await assert.rejects(
    () => createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: [] }, db),
    WebhookSubscriptionError,
  );
});

test("createWebhookSubscription returns the signing secret exactly once; later reads never include it", async () => {
  const db = new FakeWebhookDb();
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: ["DocumentRegistered", "DocumentRegistered"] }, db);
  assert.equal(created.eventTypes.length, 1, "duplicate event types are deduplicated");
  assert.equal(created.signingSecret.length >= 32, true);

  const listed = await listWebhookSubscriptions(identity(TENANT_A), db);
  assert.equal(listed.length, 1);
  assert.equal((listed[0] as unknown as { signingSecret?: string }).signingSecret, undefined, "list must never re-expose the signing secret");
});

test("a tenant cannot see or mutate another tenant's subscription", async () => {
  const db = new FakeWebhookDb();
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: ["DocumentRegistered"] }, db);

  assert.deepEqual(await listWebhookSubscriptions(identity(TENANT_B), db), []);
  await assert.rejects(() => pauseWebhookSubscription(identity(TENANT_B), created.webhookId, db), WebhookSubscriptionError);
  await assert.rejects(() => rotateWebhookSigningKey(identity(TENANT_B), created.webhookId, db), WebhookSubscriptionError);
});

test("pause/resume/revoke enforce valid transitions and revoke is terminal", async () => {
  const db = new FakeWebhookDb();
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: ["DocumentRegistered"] }, db);

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

test("rotateWebhookSigningKey retires the old key and activates exactly one new key; revoked subscriptions cannot rotate", async () => {
  const db = new FakeWebhookDb();
  const created = await createWebhookSubscription(identity(TENANT_A), { endpointUrl: "https://example.com/hook", eventTypes: ["DocumentRegistered"] }, db);
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

test("listWebhookDeliveries returns diagnostics scoped to the tenant and subscription", async () => {
  const db = new FakeWebhookDb();
  db.deliveries.push(
    { tenant_id: TENANT_A, webhook_id: "w1", delivery_id: "d1", event_id: "e1", attempt: 1, state: "failed", status_code: 500, last_error: "boom", created_at: "2026-01-01T00:00:00Z", completed_at: null },
    { tenant_id: TENANT_B, webhook_id: "w1", delivery_id: "d2", event_id: "e2", attempt: 1, state: "complete", status_code: 200, last_error: null, created_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:00:01Z" },
  );
  const diagnostics = await listWebhookDeliveries(identity(TENANT_A), "w1", db);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.deliveryId, "d1");
  assert.equal(diagnostics[0]?.lastError, "boom");
});
