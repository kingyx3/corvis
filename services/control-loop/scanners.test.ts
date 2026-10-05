import assert from "node:assert/strict";
import test from "node:test";
import { matchesPrefix, scanArchitectureDrift } from "./scanners/architecture-drift.ts";
import { scanDocumentationAuthority } from "./scanners/documentation-authority.ts";
import { dedupeFindings } from "./classifiers/fingerprint.ts";
import { scanInternalLinks } from "./scanners/internal-links.ts";
import { scanIssueHygiene, type IssueSnapshot } from "./scanners/issue-hygiene.ts";
import { isDocumentationPath, markdownLinks, proseLines, relativePathBetween, resolveRelative } from "./scanners/markdown.ts";
import { selectScanScope, type RepoSnapshot } from "./scanners/repo-snapshot.ts";
import { fingerprintFor } from "./classifiers/fingerprint.ts";
import { rule } from "./rules/catalog.ts";
import type { RepoFile } from "./scanners/repo-snapshot.ts";
import type { Watermark } from "./types.ts";

// ---- markdown ----

test("isDocumentationPath accepts docs/ markdown and top-level markdown, rejects nested non-docs markdown", () => {
  assert.equal(isDocumentationPath("docs/README.md"), true);
  assert.equal(isDocumentationPath("README.md"), true);
  assert.equal(isDocumentationPath("src/app/README.md"), false);
  assert.equal(isDocumentationPath("docs/README.ts"), false);
});

test("proseLines strips fenced code blocks but keeps their line numbers out of the result", () => {
  const lines = proseLines("a\n```\ncode\n```\nb");
  assert.deepEqual(lines.map((l) => l.text), ["a", "b"]);
  assert.deepEqual(lines.map((l) => l.number), [1, 5]);
});

test("markdownLinks finds inline and reference-style links but ignores inline code spans", () => {
  const links = markdownLinks("see [a](./a.md) and `[not a link](./x.md)` and\n[ref]: ./ref.md");
  assert.deepEqual(links.map((l) => l.target), ["./a.md", "./ref.md"]);
});

test("resolveRelative walks .. segments and returns null past the repository root", () => {
  assert.equal(resolveRelative("docs/sub/PAGE.md", "../OTHER.md"), "docs/OTHER.md");
  assert.equal(resolveRelative("docs/PAGE.md", "../../OTHER.md"), null);
});

test("relativePathBetween produces a path that resolveRelative resolves back to the target", () => {
  const from = "docs/sub/PAGE.md";
  const target = "docs/OTHER.md";
  const relative = relativePathBetween(from, target);
  assert.equal(resolveRelative(from, relative), target);
});

// ---- documentation-authority ----

function file(path: string, text: string): RepoFile { return { path, text }; }

test("business/control truth stated without a Confluence link is flagged", () => {
  const findings = scanDocumentationAuthority([file("docs/PLAN.md", "This page defines the pricing for enterprise customers.")]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.ruleId, "CL-DOC-001");
});

test("business/control truth with a Confluence link anywhere in the file is not flagged", () => {
  const findings = scanDocumentationAuthority([file("docs/PLAN.md", "See https://corvis.atlassian.net/wiki/spaces/X\n\nThis page defines the pricing for enterprise customers.")]);
  assert.equal(findings.length, 0);
});

test("deferring GitHub-owned technical detail to Confluence is flagged", () => {
  const findings = scanDocumentationAuthority([file("docs/PLAN.md", "The Terraform deployment pipeline is documented in Confluence.")]);
  assert.ok(findings.some((f) => f.ruleId === "CL-DOC-002"));
});

test("a line that asserts GitHub owns technical truth is not treated as deferral", () => {
  const findings = scanDocumentationAuthority([file("docs/PLAN.md", "GitHub owns technical truth: deployment pipeline, migrations and secrets.")]);
  assert.equal(findings.some((f) => f.ruleId === "CL-DOC-002"), false);
});

test("non-documentation files are never scanned for authority findings", () => {
  assert.deepEqual(scanDocumentationAuthority([file("src/platform/config.ts", "pricing pricing pricing")]), []);
});

// ---- internal-links ----

function snapshot(paths: string[]): RepoSnapshot { return { root: ".", files: [], paths: new Set(paths) }; }

test("a link that resolves to a tracked path is not flagged", () => {
  const files = [file("docs/README.md", "[index](./OTHER.md)")];
  assert.deepEqual(scanInternalLinks(files, snapshot(["docs/README.md", "docs/OTHER.md"])), []);
});

test("a broken relative link is flagged with a suggestion when exactly one file shares its basename", () => {
  const files = [file("docs/README.md", "[index](./MOVED.md)")];
  const findings = scanInternalLinks(files, snapshot(["docs/README.md", "docs/renamed/MOVED.md"]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.remediation, "auto-fix");
  assert.equal(findings[0]?.suggestion?.after, "./renamed/MOVED.md");
});

test("a broken link with an ambiguous or absent replacement target requires human approval", () => {
  const files = [file("docs/README.md", "[index](./GONE.md)")];
  const findings = scanInternalLinks(files, snapshot(["docs/README.md"]));
  assert.equal(findings[0]?.remediation, "human-approval");
  assert.equal(findings[0]?.suggestion, null);
});

test("broken links in files whose paths differ only by punctuation or case are all reported, not deduplicated away", () => {
  const files = [
    file("docs/a-b.md", "[x](./missing.md)"),
    file("docs/a_b.md", "[x](./missing.md)"),
    file("docs/A-B.md", "[x](./missing.md)"),
  ];
  const findings = dedupeFindings(scanInternalLinks(files, snapshot(["docs/a-b.md", "docs/a_b.md", "docs/A-B.md"])));
  assert.equal(findings.length, 3);
  assert.equal(new Set(findings.map((f) => f.fingerprint)).size, 3);
});

test("external links, anchors and mailto targets are never flagged", () => {
  const files = [file("docs/README.md", "[a](https://example.com) [b](#section) [c](mailto:x@example.com)")];
  assert.deepEqual(scanInternalLinks(files, snapshot(["docs/README.md"])), []);
});

test("a link with a malformed percent escape does not throw; it resolves against the raw path", () => {
  const files = [file("docs/README.md", "[Growth](growth-100%.md) and [Other](./growth-100%.md)")];
  assert.doesNotThrow(() => scanInternalLinks(files, snapshot(["docs/README.md"])));
  const flagged = scanInternalLinks(files, snapshot(["docs/README.md"]));
  assert.equal(flagged.length, 2, "a missing target is still reported as a broken link");
  assert.deepEqual(scanInternalLinks(files, snapshot(["docs/README.md", "docs/growth-100%.md"])), [], "an existing file with a literal % resolves");
});

test("percent-encoded link targets are still decoded before resolving", () => {
  const files = [file("docs/README.md", "[x](./my%20doc.md)")];
  assert.deepEqual(scanInternalLinks(files, snapshot(["docs/README.md", "docs/my doc.md"])), []);
});

// ---- architecture-drift ----

test("a module's domain layer importing its server layer is a critical finding", () => {
  const findings = scanArchitectureDrift([file("src/modules/review/domain/decision.ts", `import { x } from "@/modules/review/server/service";`)]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.ruleId, "CL-ARCH-001");
  assert.equal(findings[0]?.severity, "critical");
});

test("the shared domain kernel importing platform infrastructure is flagged, importing another domain module is not", () => {
  const findings = scanArchitectureDrift([file("src/shared/domain/workspace.ts", `import { x } from "@/platform/config";\nimport { y } from "@/modules/review/domain/decision";`)]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.ruleId, "CL-ARCH-001");
});

test("a module's ui layer importing server or adapter code is flagged, importing domain or composition code is not", () => {
  const mixed = scanArchitectureDrift([file("src/modules/review/ui/view.ts", `import { a } from "@/shared/domain/enterprise";\nimport { c } from "@/composition/services";\nimport { b } from "@/modules/delivery/server/delivery";\nimport { d } from "../adapters/demo-store";`)]);
  assert.deepEqual(mixed.map((finding) => finding.ruleId), ["CL-ARCH-002", "CL-ARCH-002"]);
});

test("package and node: imports are not resolved against the repository layout", () => {
  assert.deepEqual(scanArchitectureDrift([file("src/modules/review/domain/decision.ts", `import { createHash } from "node:crypto";\nimport React from "react";`)]), []);
});

test("boundary prefixes treat * as exactly one path segment", () => {
  assert.equal(matchesPrefix("src/modules/review/domain/decision.ts", "src/modules/*/domain/"), true);
  assert.equal(matchesPrefix("src/modules/review/nested/domain/decision.ts", "src/modules/*/domain/"), false);
  assert.equal(matchesPrefix("src/platform/http/http.ts", "src/platform/"), true);
  assert.equal(matchesPrefix("srcXplatform/http.ts", "src.platform/"), false);
});

test("a .test.ts file is never scanned for architecture drift", () => {
  assert.deepEqual(scanArchitectureDrift([file("src/modules/review/domain/decision.test.ts", `import { x } from "@/platform/config";`)]), []);
});

test("a boundary violation is reported once per forbidden prefix even with multiple offending imports", () => {
  const findings = scanArchitectureDrift([file("src/shared/domain/workspace.ts", `import { a } from "@/platform/config";\nimport { b } from "@/platform/platform";`)]);
  assert.equal(findings.length, 1);
});

// ---- issue-hygiene ----

function issueSnapshot(issues: IssueSnapshot["issues"]): IssueSnapshot { return { fetchedAt: new Date().toISOString(), issues }; }

test("issue hygiene is incomplete when no snapshot is available, and produces no findings", () => {
  const result = scanIssueHygiene({ snapshot: null, findings: [], mode: "daily" });
  assert.equal(result.complete, false);
  assert.deepEqual(result.findings, []);
});

test("an open control-loop issue with no active matching finding is a closure candidate", () => {
  const fp = fingerprintFor(rule("CL-DOC-003"), "docs/README.md:broken-link:x");
  const result = scanIssueHygiene({
    snapshot: issueSnapshot([{ number: 1, state: "open", title: "t", fingerprint: fp, labels: ["control-loop"] }]),
    findings: [],
    mode: "daily",
  });
  assert.deepEqual(result.closureCandidates, [1]);
});

test("a closed issue whose fingerprint matches an active finding must reopen", () => {
  const fp = fingerprintFor(rule("CL-DOC-003"), "docs/README.md:broken-link:x");
  const result = scanIssueHygiene({
    snapshot: issueSnapshot([{ number: 2, state: "closed", title: "t", fingerprint: fp, labels: ["control-loop"] }]),
    findings: [{ ruleId: "CL-DOC-003", fingerprint: fp, subject: "s", severity: "medium", authority: "github", remediation: "auto-fix", path: null, line: null, detail: "d", suggestion: null }],
    mode: "daily",
  });
  assert.deepEqual(result.reopenCandidates, [2]);
  assert.ok(result.findings.some((f) => f.ruleId === "CL-ISSUE-003"));
});

test("two open issues sharing one fingerprint are flagged as duplicates", () => {
  const fp = fingerprintFor(rule("CL-DOC-003"), "docs/README.md:broken-link:x");
  const result = scanIssueHygiene({
    snapshot: issueSnapshot([
      { number: 1, state: "open", title: "t", fingerprint: fp, labels: ["control-loop"] },
      { number: 2, state: "open", title: "t", fingerprint: fp, labels: ["control-loop"] },
    ]),
    findings: [{ ruleId: "CL-DOC-003", fingerprint: fp, subject: "s", severity: "medium", authority: "github", remediation: "auto-fix", path: null, line: null, detail: "d", suggestion: null }],
    mode: "daily",
  });
  assert.ok(result.findings.some((f) => f.ruleId === "CL-ISSUE-002"));
  assert.deepEqual(result.closureCandidates, [], "an active duplicate pair must not also be proposed for closure");
});

test("an open issue with an unparseable fingerprint is flagged in a deep-scan mode rather than silently ignored", () => {
  const result = scanIssueHygiene({
    snapshot: issueSnapshot([{ number: 3, state: "open", title: "t", fingerprint: null, labels: ["control-loop"] }]),
    findings: [],
    mode: "weekly",
  });
  assert.ok(result.findings.some((f) => f.ruleId === "CL-ISSUE-001"));
});

test("an open issue with an unparseable fingerprint is not flagged during the fast daily loop", () => {
  const result = scanIssueHygiene({
    snapshot: issueSnapshot([{ number: 3, state: "open", title: "t", fingerprint: null, labels: ["control-loop"] }]),
    findings: [],
    mode: "daily",
  });
  assert.equal(result.findings.some((f) => f.ruleId === "CL-ISSUE-001"), false);
});

test("an issue without the control-loop label is never touched", () => {
  const result = scanIssueHygiene({
    snapshot: issueSnapshot([{ number: 4, state: "open", title: "t", fingerprint: null, labels: [] }]),
    findings: [],
    mode: "daily",
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.closureCandidates, []);
});

// ---- repo-snapshot: scan scope selection ----

function baseWatermark(overrides: Partial<Watermark> = {}): Watermark {
  return { schemaVersion: 1, lastSuccessfulDailyRunAt: null, lastSuccessfulWeeklyRunAt: null, lastWeeklyScanComplete: false, consecutiveFailures: 0, lastRunId: null, ...overrides };
}

test("weekly and monthly modes always scan fully and ignore the watermark", () => {
  const repo: RepoSnapshot = { root: ".", files: [file("a.md", "")], paths: new Set(["a.md"]) };
  const scope = selectScanScope({ mode: "weekly", watermark: baseWatermark({ lastSuccessfulDailyRunAt: new Date().toISOString() }), snapshot: repo, changedPaths: [] });
  assert.equal(scope.full, true);
  assert.equal(scope.files.length, 1);
});

test("a daily run with no prior watermark scans fully", () => {
  const repo: RepoSnapshot = { root: ".", files: [file("a.md", "")], paths: new Set(["a.md"]) };
  const scope = selectScanScope({ mode: "daily", watermark: baseWatermark(), snapshot: repo, changedPaths: [] });
  assert.equal(scope.full, true);
  assert.equal(scope.reason, "no_daily_watermark_full_scan");
});

test("a daily run with a watermark but unavailable changed-path information scans fully", () => {
  const repo: RepoSnapshot = { root: ".", files: [file("a.md", "")], paths: new Set(["a.md"]) };
  const scope = selectScanScope({ mode: "daily", watermark: baseWatermark({ lastSuccessfulDailyRunAt: new Date().toISOString(), lastScannedCommit: "a".repeat(40) }), snapshot: repo, changedPaths: null });
  assert.equal(scope.full, true);
  assert.equal(scope.reason, "changed_paths_unavailable_full_scan");
});

test("a daily run whose watermark has no last scanned commit scans fully even when changed paths are supplied", () => {
  const repo: RepoSnapshot = { root: ".", files: [file("a.md", ""), file("b.md", "")], paths: new Set(["a.md", "b.md"]) };
  const scope = selectScanScope({ mode: "daily", watermark: baseWatermark({ lastSuccessfulDailyRunAt: new Date().toISOString() }), snapshot: repo, changedPaths: ["b.md"] });
  assert.equal(scope.full, true);
  assert.equal(scope.reason, "no_last_scanned_commit_full_scan");
  assert.equal(scope.files.length, 2);
});

test("a daily run with a watermark and known changed paths scans only those files", () => {
  const repo: RepoSnapshot = { root: ".", files: [file("a.md", ""), file("b.md", "")], paths: new Set(["a.md", "b.md"]) };
  const scope = selectScanScope({ mode: "daily", watermark: baseWatermark({ lastSuccessfulDailyRunAt: new Date().toISOString(), lastScannedCommit: "a".repeat(40) }), snapshot: repo, changedPaths: ["b.md"] });
  assert.equal(scope.full, false);
  assert.deepEqual(scope.files.map((f) => f.path), ["b.md"]);
});
