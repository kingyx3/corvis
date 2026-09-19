import test from "node:test";
import assert from "node:assert/strict";
import { signWebhook, verifyWebhookSignature, webhookHeaders } from "./webhooks.ts";

const ts = "2026-09-18T03:00:00.000Z";
const body = JSON.stringify({ id: "evt-1", tenantId: "tenant-a" });

test("valid webhook signatures verify", () => {
  const sig = signWebhook("secret", ts, body);
  assert.equal(verifyWebhookSignature("secret", ts, body, sig, Date.parse(ts) + 1000), true);
});

test("tampering and stale delivery are rejected", () => {
  const sig = signWebhook("secret", ts, body);
  assert.equal(verifyWebhookSignature("secret", ts, "{\"x\":1}", sig, Date.parse(ts) + 1000), false);
  assert.equal(verifyWebhookSignature("secret", ts, body, sig, Date.parse(ts) + 10 * 60_000), false);
});

test("future-dated replay attempts outside tolerance are rejected", () => {
  const sig = signWebhook("secret", ts, body);
  assert.equal(verifyWebhookSignature("secret", ts, body, sig, Date.parse(ts) - 10 * 60_000), false);
});

test("wrong secret, truncated signature and empty signature are rejected", () => {
  const sig = signWebhook("secret", ts, body);
  assert.equal(verifyWebhookSignature("wrong-secret", ts, body, sig, Date.parse(ts)), false);
  assert.equal(verifyWebhookSignature("secret", ts, body, sig.slice(0, -2), Date.parse(ts)), false);
  assert.equal(verifyWebhookSignature("secret", ts, body, "", Date.parse(ts)), false);
});

test("malformed timestamps fail closed", () => {
  const malformed = "not-a-timestamp";
  const sig = signWebhook("secret", malformed, body);
  assert.equal(verifyWebhookSignature("secret", malformed, body, sig, Date.parse(ts)), false);
});

test("signature is bound to the exact timestamp", () => {
  const sig = signWebhook("secret", ts, body);
  const shifted = "2026-09-18T03:00:01.000Z";
  assert.equal(verifyWebhookSignature("secret", shifted, body, sig, Date.parse(shifted)), false);
});

test("webhookHeaders signs with the current send time, not the envelope's own (possibly old) createdAt, so a late retry still verifies", () => {
  const envelope = { id: "evt-1", type: "DocumentRegistered", createdAt: "2020-01-01T00:00:00.000Z", tenantId: "tenant-a", data: {} };
  const sentAt = "2026-09-18T03:00:00.000Z";
  const headers = webhookHeaders("secret", envelope, sentAt);
  assert.equal(headers["x-corvis-webhook-timestamp"], sentAt);
  assert.equal(
    verifyWebhookSignature("secret", headers["x-corvis-webhook-timestamp"]!, JSON.stringify(envelope), headers["x-corvis-webhook-signature"]!, Date.parse(sentAt) + 1000),
    true,
    "a retry sent long after the original business event must still verify against the actual send time",
  );
});

test("webhookHeaders defaults sentAt to now when not supplied", () => {
  const envelope = { id: "evt-2", type: "DocumentRegistered", createdAt: "2020-01-01T00:00:00.000Z", tenantId: "tenant-a", data: {} };
  const before = Date.now();
  const headers = webhookHeaders("secret", envelope);
  const timestampMs = Date.parse(headers["x-corvis-webhook-timestamp"]!);
  assert.ok(timestampMs >= before && timestampMs <= Date.now());
});
