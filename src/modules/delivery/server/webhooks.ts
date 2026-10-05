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

/**
 * Signs one delivery attempt. `sentAt` defaults to the current time rather
 * than `envelope.createdAt`: `envelope.createdAt` is the business event's own
 * timestamp and stays fixed across every retry of that event, while a retry
 * can be sent minutes or hours later. Signing with the fixed event timestamp
 * would make `verifyWebhookSignature`'s tolerance window reject every retry
 * once enough time had passed, since the header timestamp would already be
 * stale the moment it was sent.
 */
export function webhookHeaders(secret: string, envelope: WebhookEnvelope, sentAt: string = new Date().toISOString()): Record<string,string> {
  const body = JSON.stringify(envelope);
  return {
    "content-type": "application/json",
    "x-corvis-webhook-id": envelope.id,
    "x-corvis-webhook-timestamp": sentAt,
    "x-corvis-webhook-signature": signWebhook(secret, sentAt, body),
  };
}
