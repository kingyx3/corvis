import assert from "node:assert/strict";
import test from "node:test";
import { statusPillTone, statusSlug } from "./status-pill-logic.ts";

test("statusPillTone maps known statuses to their documented tone", () => {
  assert.equal(statusPillTone("Published"), "success");
  assert.equal(statusPillTone("Needs review"), "warning");
  assert.equal(statusPillTone("Draft"), "neutral");
  assert.equal(statusPillTone("Processing"), "info");
  assert.equal(statusPillTone("Failed"), "danger");
});

test("statusPillTone falls back to neutral for an unknown status", () => {
  assert.equal(statusPillTone("Something made up"), "neutral");
  assert.equal(statusPillTone(""), "neutral");
});

test("statusSlug slugifies mixed-case and punctuated statuses", () => {
  assert.equal(statusSlug("Needs review"), "needs-review");
  assert.equal(statusSlug("Published"), "published");
  assert.equal(statusSlug("  No change!  "), "no-change");
});

test("statusSlug falls back to unknown when nothing alphanumeric remains", () => {
  assert.equal(statusSlug(""), "unknown");
  assert.equal(statusSlug("   "), "unknown");
  assert.equal(statusSlug("---"), "unknown");
});
