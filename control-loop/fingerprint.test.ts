import assert from "node:assert/strict";
import test from "node:test";
import { dedupeFindings, fingerprintFor, formatFingerprint, parseFingerprint, sortFindings } from "./classifiers/fingerprint.ts";
import { rule } from "./rules/catalog.ts";
import type { Finding } from "./types.ts";

test("formatFingerprint requires a non-empty domain, owners and subject", () => {
  assert.throws(() => formatFingerprint({ domain: "", owners: ["a"], subject: "b" }));
  assert.throws(() => formatFingerprint({ domain: "a", owners: [], subject: "b" }));
  assert.throws(() => formatFingerprint({ domain: "a", owners: ["b"], subject: "" }));
});

test("formatFingerprint slugifies each part deterministically", () => {
  assert.equal(formatFingerprint({ domain: "Business Control Loop", owners: ["Strategy", "Engineering"], subject: "docs/README.md:broken-link" }),
    "business-control-loop:strategy-engineering:docs-readme-md-broken-link");
});

test("parseFingerprint round-trips a value produced by formatFingerprint", () => {
  const value = fingerprintFor(rule("CL-DOC-003"), "docs/README.md:broken-link:foo");
  const parsed = parseFingerprint(value);
  assert.ok(parsed);
  assert.equal(formatFingerprint(parsed!), value);
});

test("parseFingerprint rejects a malformed value instead of throwing", () => {
  assert.equal(parseFingerprint("not-a-fingerprint"), null);
  assert.equal(parseFingerprint("a:b:c:d"), null);
  assert.equal(parseFingerprint("Upper:case:value"), null, "a value that does not round-trip through the slug is not a valid fingerprint");
});

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "CL-DOC-003", fingerprint: "f1", subject: "s", severity: "medium",
    authority: "github", remediation: "auto-fix", path: null, line: null, detail: "d", suggestion: null,
    ...overrides,
  };
}

test("dedupeFindings keeps the first occurrence of each fingerprint and drops the rest", () => {
  const findings = [finding({ fingerprint: "a", detail: "first" }), finding({ fingerprint: "a", detail: "second" }), finding({ fingerprint: "b" })];
  const deduped = dedupeFindings(findings);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]?.detail, "first");
});

test("sortFindings orders by severity, then rule id, then fingerprint, deterministically", () => {
  const low = finding({ fingerprint: "z", severity: "low", ruleId: "CL-DOC-003" });
  const critical = finding({ fingerprint: "a", severity: "critical", ruleId: "CL-ARCH-001" });
  const highB = finding({ fingerprint: "b", severity: "high", ruleId: "CL-DOC-001" });
  const highA = finding({ fingerprint: "a", severity: "high", ruleId: "CL-DOC-001" });
  const sorted = sortFindings([low, highB, critical, highA]);
  assert.deepEqual(sorted.map((f) => f.fingerprint), ["a", "a", "b", "z"]);
  assert.equal(sorted[0]?.severity, "critical");
});
