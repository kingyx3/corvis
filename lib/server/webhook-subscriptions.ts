import { randomBytes, randomUUID } from "crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export class WebhookSubscriptionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "WebhookSubscriptionError";
    this.code = code;
  }
}

function controlDb(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }

function newSigningSecret(): string { return randomBytes(32).toString("hex"); }

function text(row: PostgresRow, key: string): string | undefined {
  const value = row[key];
  return value == null ? undefined : String(value);
}

/** Encodes a string array as a Postgres array-literal string, for binding through a scalar-only parameter API and casting with `::text[]`. */
function postgresTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`);
  return `{${escaped.join(",")}}`;
}

export type WebhookSubscriptionStatus = "active" | "paused" | "revoked";

export type WebhookSubscriptionRecord = {
  webhookId: string;
  endpointUrl: string;
  eventTypes: string[];
  status: WebhookSubscriptionStatus;
  createdAt: string;
  updatedAt: string;
};

export type WebhookSubscriptionCreated = WebhookSubscriptionRecord & {
  /** The signing secret. Returned exactly once at creation/rotation time; it is never re-readable afterward. */
  signingSecret: string;
  signingKeyId: string;
};

export type WebhookSigningKeyRotated = {
  webhookId: string;
  signingKeyId: string;
  signingSecret: string;
};

export type WebhookDeliveryDiagnostic = {
  deliveryId: string;
  eventId: string;
  attempt: number;
  state: "delivering" | "complete" | "retryable" | "failed";
  statusCode?: number;
  lastError?: string;
  createdAt: string;
  completedAt?: string;
};

function toSubscriptionRecord(row: PostgresRow): WebhookSubscriptionRecord {
  return {
    webhookId: String(row.webhook_id),
    endpointUrl: String(row.endpoint_url),
    eventTypes: Array.isArray(row.event_types) ? row.event_types.map(String) : [],
    status: (text(row, "status") ?? "active") as WebhookSubscriptionStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function validateEventTypes(eventTypes: unknown): string[] {
  if (!Array.isArray(eventTypes)) throw new WebhookSubscriptionError("event_types_required");
  const normalized = eventTypes.map((value) => String(value).trim()).filter((value) => value.length > 0);
  if (normalized.length === 0) throw new WebhookSubscriptionError("event_types_required");
  return [...new Set(normalized)];
}

function validateEndpointUrl(endpointUrl: unknown): string {
  if (typeof endpointUrl !== "string" || !endpointUrl.trim()) throw new WebhookSubscriptionError("endpoint_url_required");
  let parsed: URL;
  try { parsed = new URL(endpointUrl.trim()); } catch { throw new WebhookSubscriptionError("endpoint_url_invalid"); }
  if (parsed.protocol !== "https:") throw new WebhookSubscriptionError("endpoint_url_must_be_https");
  return parsed.toString();
}

/**
 * Creates a subscription and its first signing key in one atomic Postgres
 * call (`create_webhook_subscription`), so a subscription can never exist
 * with zero signing keys. The returned secret is the only time it is ever
 * readable; only metadata is returned by later reads.
 */
export async function createWebhookSubscription(
  identity: RequestIdentity,
  input: { endpointUrl: string; eventTypes: string[] },
  db: PostgresSqlApi = controlDb(),
): Promise<WebhookSubscriptionCreated> {
  const endpointUrl = validateEndpointUrl(input.endpointUrl);
  const eventTypes = validateEventTypes(input.eventTypes);
  const webhookId = randomUUID();
  const keyId = randomUUID();
  const secret = newSigningSecret();

  await db.query(`select corvis_control.create_webhook_subscription(
    $1::uuid,$2::uuid,$3,$4::text[],$5,$6::uuid,$7)`,
  [identity.tenantId, webhookId, endpointUrl, postgresTextArrayLiteral(eventTypes), identity.subject, keyId, secret]);

  const now = new Date().toISOString();
  return { webhookId, endpointUrl, eventTypes, status: "active", createdAt: now, updatedAt: now, signingSecret: secret, signingKeyId: keyId };
}

export async function listWebhookSubscriptions(
  identity: RequestIdentity,
  db: PostgresSqlApi = controlDb(),
): Promise<WebhookSubscriptionRecord[]> {
  const rows = await db.query(`select webhook_id, endpoint_url, event_types, status, created_at, updated_at
    from corvis_control.webhook_subscription
    where tenant_id=$1
    order by webhook_id`, [identity.tenantId]);
  return rows.map(toSubscriptionRecord);
}

async function transitionStatus(
  identity: RequestIdentity,
  webhookId: string,
  from: readonly WebhookSubscriptionStatus[],
  to: WebhookSubscriptionStatus,
  actorColumn: "paused_by" | "revoked_by" | null,
  db: PostgresSqlApi,
): Promise<WebhookSubscriptionRecord> {
  const actorAssignment = actorColumn ? `,${actorColumn}=$5,${actorColumn === "paused_by" ? "paused_at" : "revoked_at"}=now()` : "";
  const rows = await db.query(`update corvis_control.webhook_subscription
    set status=$3, updated_at=now()${actorAssignment}
    where tenant_id=$1 and webhook_id=$2::uuid and status = any($4::text[])
    returning webhook_id, endpoint_url, event_types, status, created_at, updated_at`,
  [identity.tenantId, webhookId, to, postgresTextArrayLiteral(from), ...(actorColumn ? [identity.subject] : [])]);
  const row = rows[0];
  if (!row) throw new WebhookSubscriptionError("webhook_subscription_transition_denied");
  return toSubscriptionRecord(row);
}

export async function pauseWebhookSubscription(identity: RequestIdentity, webhookId: string, db: PostgresSqlApi = controlDb()): Promise<WebhookSubscriptionRecord> {
  return transitionStatus(identity, webhookId, ["active"], "paused", "paused_by", db);
}

export async function resumeWebhookSubscription(identity: RequestIdentity, webhookId: string, db: PostgresSqlApi = controlDb()): Promise<WebhookSubscriptionRecord> {
  return transitionStatus(identity, webhookId, ["paused"], "active", null, db);
}

export async function revokeWebhookSubscription(identity: RequestIdentity, webhookId: string, db: PostgresSqlApi = controlDb()): Promise<WebhookSubscriptionRecord> {
  return transitionStatus(identity, webhookId, ["active", "paused"], "revoked", "revoked_by", db);
}

/**
 * Rotates the subscription's signing key: the current active key is marked
 * `retiring` (kept only as lifecycle/audit metadata — outbound delivery
 * always signs with the current active key) and a freshly generated key
 * becomes active, atomically, via `rotate_webhook_signing_key`.
 */
export async function rotateWebhookSigningKey(
  identity: RequestIdentity,
  webhookId: string,
  db: PostgresSqlApi = controlDb(),
): Promise<WebhookSigningKeyRotated> {
  const existing = await db.query(`select status from corvis_control.webhook_subscription
    where tenant_id=$1 and webhook_id=$2::uuid limit 1`, [identity.tenantId, webhookId]);
  const status = text(existing[0] ?? {}, "status");
  if (!status || status === "revoked") throw new WebhookSubscriptionError("webhook_subscription_not_found");

  const keyId = randomUUID();
  const secret = newSigningSecret();
  await db.query(`select corvis_control.rotate_webhook_signing_key($1::uuid,$2::uuid,$3::uuid,$4,$5)`,
    [identity.tenantId, webhookId, keyId, secret, identity.subject]);
  return { webhookId, signingKeyId: keyId, signingSecret: secret };
}

/** New endpoint with no unpaginated caller: the route always applies cursor pagination, up to this bound per underlying fetch. */
const DELIVERY_DIAGNOSTIC_FETCH_CAP = 2000;

export async function listWebhookDeliveries(
  identity: RequestIdentity,
  webhookId: string,
  db: PostgresSqlApi = controlDb(),
): Promise<WebhookDeliveryDiagnostic[]> {
  const rows = await db.query(`select delivery_id, event_id, attempt, state, status_code, last_error, created_at, completed_at
    from corvis_control.webhook_delivery
    where tenant_id=$1 and webhook_id=$2::uuid
    order by delivery_id
    limit $3`, [identity.tenantId, webhookId, DELIVERY_DIAGNOSTIC_FETCH_CAP]);
  return rows.map((row) => ({
    deliveryId: String(row.delivery_id),
    eventId: String(row.event_id),
    attempt: Number(row.attempt),
    state: String(row.state) as WebhookDeliveryDiagnostic["state"],
    statusCode: row.status_code == null ? undefined : Number(row.status_code),
    lastError: text(row, "last_error"),
    createdAt: String(row.created_at),
    completedAt: text(row, "completed_at"),
  }));
}

/** Marks past-due retiring keys revoked. Purely cleanup; delivery never signs with a non-active key regardless. */
export async function sweepExpiredWebhookSigningKeys(db: PostgresSqlApi = controlDb()): Promise<number> {
  const rows = await db.query(`update corvis_control.webhook_signing_key
    set status='revoked', revoked_at=now()
    where status='retiring' and retire_by is not null and retire_by <= now()
    returning key_id`);
  return rows.length;
}
