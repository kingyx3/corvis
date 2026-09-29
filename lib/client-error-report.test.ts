import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClientErrorEvent } from "./client-error-report.ts";

const now = new Date("2026-09-29T00:00:00.000Z");

test("free-text messages, stacks and PII never reach the event", () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'jane.doe@example.com') for Advent International");
  const event = buildClientErrorEvent("view-boundary", error, { view: "review", now });
  assert.deepEqual(event, { event: "corvis.client_error", source: "view-boundary", name: "TypeError", view: "review", occurredAt: now.toISOString() });
  assert.equal(JSON.stringify(event).includes("jane.doe"), false);
});

test("machine-code messages and digests are kept", () => {
  const error = Object.assign(new Error("research_timeout"), { digest: "abc123" });
  const event = buildClientErrorEvent("error-boundary", error, { now });
  assert.equal(event.code, "research_timeout");
  assert.equal(event.digest, "abc123");
});

test("non-Error throwables and unsafe error names are normalised", () => {
  assert.equal(buildClientErrorEvent("unhandled-rejection", "boom jane@example.com", { now }).name, "NonError");
  const odd = new Error("x");
  odd.name = "Failure for jane@example.com";
  assert.equal(buildClientErrorEvent("window-error", odd, { now }).name, "NonError");
});
