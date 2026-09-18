import test from "node:test";
import assert from "node:assert/strict";
import { signWebhook, verifyWebhookSignature } from "./webhooks.ts";

test("valid webhook signatures verify", () => {
  const ts = "2026-09-18T03:00:00.000Z";
  const body = JSON.stringify({ id: "evt-1" });
  const sig = signWebhook("secret", ts, body);
  assert.equal(verifyWebhookSignature("secret", ts, body, sig, Date.parse(ts) + 1000), true);
});

test("tampering and stale delivery are rejected", () => {
  const ts = "2026-09-18T03:00:00.000Z";
  const body = "{}";
  const sig = signWebhook("secret", ts, body);
  assert.equal(verifyWebhookSignature("secret", ts, "{\"x\":1}", sig, Date.parse(ts) + 1000), false);
  assert.equal(verifyWebhookSignature("secret", ts, body, sig, Date.parse(ts) + 10 * 60_000), false);
});
