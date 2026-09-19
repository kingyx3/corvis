import test from "node:test";
import assert from "node:assert/strict";
import { signWebhook, verifyWebhookSignature } from "./webhooks.ts";

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
