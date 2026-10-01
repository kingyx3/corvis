import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  dedupeFindings,
  fingerprintFor,
  formatFingerprint,
  formatLegacyFingerprint,
  legacyFingerprintOf,
  parseFingerprint,
  sortFindings,
} from "./classifiers/fingerprint.ts";
import { rule } from "./rules/catalog.ts";
import type { Finding } from "./types.ts";

test("formatFingerprint requires a non-empty domain, owners and subject", () => {
  assert.throws(() => formatFingerprint({ domain: "", owners: ["a"], subject: "b" }));
  assert.throws(() => formatFingerprint({ domain: "a", owners: [], subject: "b" }));
  assert.throws(() => formatFingerprint({ domain: "a", owners: ["b"], subject: "" }));
});

test("formatFingerprint slugifies each part deterministically", () => {
  const subject = "docs/README.md:broken-link";
  const hash = createHash("sha256").update(subject).digest("hex").slice(0, 10);
  assert.equal(formatFingerprint({ domain: "Business Control Loop", owners: ["Strategy", "Engineering"], subject }),
    `business-control-loop:strategy-engineering:docs-readme-md-broken-link#${hash}`);
});

test("subjects that slug to the same text keep distinct fingerprints", () => {
  const owners = ["Engineering"];
  const subjects = ["docs/a-b.md:missing.md", "docs/a_b.md:missing.md", "docs/A-B.md:missing.md", "docs/a-b.md:missing-md"];
  const fingerprints = subjects.map((subject) => formatFingerprint({ domain: "docs", owners, subject }));
  assert.equal(new Set(fingerprints).size, subjects.length);
  assert.equal(new Set(fingerprints.map(legacyFingerprintOf)).size, 1, "they did collide in the legacy format");
  // The collision is no longer silently deduplicated away.
  const findings = fingerprints.map((fingerprint, index) => ({
    ruleId: "CL-DOC-003", fingerprint, subject: subjects[index]!, severity: "medium" as const,
    authority: "github" as const, remediation: "auto-fix" as const, path: null, line: null, detail: "d", suggestion: null,
  }));
  assert.equal(dedupeFindings(findings).length, subjects.length);
});

test("a subject with no ASCII letters is fingerprinted by its hash instead of throwing", () => {
  const value = formatFingerprint({ domain: "docs", owners: ["eng"], subject: "文档说明" });
  assert.match(value, /^docs:eng:#[0-9a-f]{10}$/);
  assert.ok(parseFingerprint(value));
});

test("legacyFingerprintOf strips only the subject hash and leaves legacy values alone", () => {
  const current = formatFingerprint({ domain: "docs", owners: ["eng"], subject: "docs/a.md:x" });
  assert.equal(legacyFingerprintOf(current), "docs:eng:docs-a-md-x");
  assert.equal(legacyFingerprintOf("docs:eng:docs-a-md-x"), "docs:eng:docs-a-md-x");
  assert.equal(legacyFingerprintOf("not-a-fingerprint"), "not-a-fingerprint");
  assert.equal(legacyFingerprintOf(current), formatLegacyFingerprint({ domain: "docs", owners: ["eng"], subject: "docs/a.md:x" }));
});

test("parseFingerprint still accepts a legacy (hash-less) fingerprint and rejects a malformed hash", () => {
  const legacy = "business-control-loop:strategy-engineering:docs-a-md";
  assert.deepEqual(parseFingerprint(legacy), { domain: "business-control-loop", owners: ["strategy", "engineering"], subject: "docs-a-md" });
  assert.equal(parseFingerprint(`${legacy}#xyz`), null);
  assert.equal(parseFingerprint(`${legacy}#ABCDEF0123`), null, "the hash is lowercase hex");
  assert.equal(parseFingerprint(`${legacy}#abcdef01234`), null, "the hash has a fixed length");
});

test("parseFingerprint round-trips a value produced by formatFingerprint", () => {
  const value = fingerprintFor(rule("CL-DOC-003"), "docs/README.md:broken-link:foo");
  const parsed = parseFingerprint(value);
  assert.ok(parsed);
  assert.equal(formatFingerprint(parsed!), value);
  assert.match(value, /#[0-9a-f]{10}$/);
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
