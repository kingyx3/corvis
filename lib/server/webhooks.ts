import { createHmac, timingSafeEqual } from "crypto";

export type WebhookEnvelope<T = unknown> = {
  id: string;
  type: string;
  createdAt: string;
  tenantId: string;
  data: T;
};

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string, nowMs = Date.now(), toleranceMs = 5 * 60_000): boolean {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > toleranceMs) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function webhookHeaders(secret: string, envelope: WebhookEnvelope): Record<string,string> {
  const body = JSON.stringify(envelope);
  return {
    "content-type": "application/json",
    "x-corvis-webhook-id": envelope.id,
    "x-corvis-webhook-timestamp": envelope.createdAt,
    "x-corvis-webhook-signature": signWebhook(secret, envelope.createdAt, body),
  };
}
