import assert from "node:assert/strict";
import test from "node:test";
import { blocksControlPromotion, canPromoteControl, evaluateSourceLifecycle } from "./control-evidence-lifecycle.ts";
import type { EvidenceSourceDefinition } from "./control-evidence-registry.ts";

function source(overrides: Partial<EvidenceSourceDefinition> = {}): EvidenceSourceDefinition {
  return {
    sourceKey: "test.source",
    controlCode: "TEST-CONTROL",
    title: "Test source",
    producer: "test",
    owner: "platform-engineering",
    cadenceDays: 7,
    graceDays: 3,
    collection: "automated",
    mandatory: true,
    confidentiality: "internal",
    ...overrides,
  };
}

const NOW = new Date("2026-09-19T00:00:00.000Z");
function daysAgo(days: number): Date { return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000); }
function daysFromNow(days: number): Date { return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000); }

test("a provider-gated source is never missing or expired, only an open not-collectable gap", () => {
  const gated = source({ collection: "provider_gated", mandatory: true });
  const evaluation = evaluateSourceLifecycle(gated, undefined, NOW);
  assert.equal(evaluation.state, "not_collectable");
  assert.equal(evaluation.escalation, "notice");

  const optionalGated = source({ collection: "provider_gated", mandatory: false });
  assert.equal(evaluateSourceLifecycle(optionalGated, undefined, NOW).escalation, "none");
});

test("a mandatory automated source with no record ever is missing and breaches", () => {
  const evaluation = evaluateSourceLifecycle(source({ mandatory: true }), undefined, NOW);
  assert.equal(evaluation.state, "missing");
  assert.equal(evaluation.escalation, "breach");
});

test("an optional automated source with no record ever is missing but only warns", () => {
  const evaluation = evaluateSourceLifecycle(source({ mandatory: false }), undefined, NOW);
  assert.equal(evaluation.state, "missing");
  assert.equal(evaluation.escalation, "warning");
});

test("a failing record is always failing regardless of how current it is", () => {
  const evaluation = evaluateSourceLifecycle(
    source(),
    { result: "fail", collectedAt: daysAgo(0), validThrough: daysFromNow(7) },
    NOW,
  );
  assert.equal(evaluation.state, "failing");
  assert.equal(evaluation.escalation, "breach");
});

test("a passing record well inside its validity window is current", () => {
  const evaluation = evaluateSourceLifecycle(
    source({ graceDays: 3 }),
    { result: "pass", collectedAt: daysAgo(1), validThrough: daysFromNow(6) },
    NOW,
  );
  assert.equal(evaluation.state, "current");
  assert.equal(evaluation.escalation, "none");
});

test("a passing record approaching expiry inside the grace window is due_soon", () => {
  const evaluation = evaluateSourceLifecycle(
    source({ graceDays: 3 }),
    { result: "pass", collectedAt: daysAgo(6), validThrough: daysFromNow(1) },
    NOW,
  );
  assert.equal(evaluation.state, "due_soon");
  assert.equal(evaluation.escalation, "notice");
});

test("a record just past its validity window but inside grace is stale, not expired", () => {
  const evaluation = evaluateSourceLifecycle(
    source({ graceDays: 3 }),
    { result: "pass", collectedAt: daysAgo(8), validThrough: daysAgo(1) },
    NOW,
  );
  assert.equal(evaluation.state, "stale");
  assert.equal(evaluation.escalation, "warning");
});

test("a record past its validity window and past grace is expired and breaches", () => {
  const evaluation = evaluateSourceLifecycle(
    source({ graceDays: 3 }),
    { result: "pass", collectedAt: daysAgo(20), validThrough: daysAgo(10) },
    NOW,
  );
  assert.equal(evaluation.state, "expired");
  assert.equal(evaluation.escalation, "breach");
});

test("an optional source never blocks control promotion regardless of state", () => {
  const evaluation = evaluateSourceLifecycle(source({ mandatory: false }), undefined, NOW);
  assert.equal(blocksControlPromotion(evaluation, false), false);
});

test("a mandatory source blocks promotion unless it is exactly current", () => {
  const expired = evaluateSourceLifecycle(
    source({ graceDays: 3 }),
    { result: "pass", collectedAt: daysAgo(20), validThrough: daysAgo(10) },
    NOW,
  );
  assert.equal(blocksControlPromotion(expired, true), true);

  const current = evaluateSourceLifecycle(
    source(),
    { result: "pass", collectedAt: daysAgo(1), validThrough: daysFromNow(6) },
    NOW,
  );
  assert.equal(blocksControlPromotion(current, true), false);
});

test("a control cannot be promoted with zero mandatory sources or any blocked mandatory source", () => {
  const current = evaluateSourceLifecycle(
    source(),
    { result: "pass", collectedAt: daysAgo(1), validThrough: daysFromNow(6) },
    NOW,
  );
  const expired = evaluateSourceLifecycle(
    source({ sourceKey: "other" }),
    { result: "pass", collectedAt: daysAgo(20), validThrough: daysAgo(10) },
    NOW,
  );

  assert.equal(canPromoteControl([]), false, "a control with no mandatory sources can never be promoted from objective evidence");
  assert.equal(canPromoteControl([{ evaluation: current, mandatory: true }]), true);
  assert.equal(
    canPromoteControl([
      { evaluation: current, mandatory: true },
      { evaluation: expired, mandatory: true },
    ]),
    false,
  );
  assert.equal(
    canPromoteControl([
      { evaluation: current, mandatory: true },
      { evaluation: expired, mandatory: false },
    ]),
    true,
    "a blocked optional source must not veto promotion",
  );
});
