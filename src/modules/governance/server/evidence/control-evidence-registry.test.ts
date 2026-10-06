import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_DEFINITIONS,
  EVIDENCE_SOURCES,
  controlDefinition,
  evidenceSource,
  evidenceSourcesForControl,
  isCollectable,
} from "./control-evidence-registry.ts";

test("every evidence source references a control that exists in the register", () => {
  for (const source of EVIDENCE_SOURCES) {
    assert.ok(controlDefinition(source.controlCode), `${source.sourceKey} references unknown control ${source.controlCode}`);
  }
});

test("every control has at least one evidence source", () => {
  for (const control of CONTROL_DEFINITIONS) {
    assert.ok(evidenceSourcesForControl(control.controlCode).length > 0, `${control.controlCode} has no evidence source`);
  }
});

test("source keys and control codes are unique", () => {
  assert.equal(new Set(EVIDENCE_SOURCES.map((s) => s.sourceKey)).size, EVIDENCE_SOURCES.length);
  assert.equal(new Set(CONTROL_DEFINITIONS.map((c) => c.controlCode)).size, CONTROL_DEFINITIONS.length);
});

test("collection method and collectability agree, matching the migration's check constraint", () => {
  for (const source of EVIDENCE_SOURCES) {
    assert.equal(isCollectable(source), source.collection === "automated", source.sourceKey);
  }
});

test("a provider-gated source always states why it cannot be collected in-repository", () => {
  for (const source of EVIDENCE_SOURCES.filter((s) => s.collection === "provider_gated")) {
    assert.ok(source.gatedOn && source.gatedOn.length > 0, `${source.sourceKey} is provider_gated without an explanation`);
  }
});

test("an automated source names an in-repository producer and carries no gating reason", () => {
  for (const source of EVIDENCE_SOURCES.filter((s) => s.collection === "automated")) {
    assert.ok(source.producer.length > 0, source.sourceKey);
    assert.equal(source.gatedOn, undefined, `${source.sourceKey} is automated but still carries a gating reason`);
  }
});

test("cadence and grace windows are sane and bounded", () => {
  for (const source of EVIDENCE_SOURCES) {
    assert.ok(source.cadenceDays >= 1 && source.cadenceDays <= 365 * 3, source.sourceKey);
    assert.ok(source.graceDays >= 0 && source.graceDays <= source.cadenceDays, `${source.sourceKey} grace window exceeds its own cadence`);
  }
});

test("evidenceSource returns undefined for an unknown key instead of throwing", () => {
  assert.equal(evidenceSource("does-not-exist"), undefined);
});
