import { fingerprintFor, parseFingerprint } from "../classifiers/fingerprint.ts";
import { rule } from "../rules/catalog.ts";
import type { Finding, RunMode } from "../types.ts";

export interface IssueSnapshotItem {
  number: number;
  state: "open" | "closed";
  title: string;
  fingerprint: string | null;
  labels: string[];
}

export interface IssueSnapshot {
  fetchedAt: string;
  issues: IssueSnapshotItem[];
}

export interface IssueHygieneResult {
  complete: boolean;
  reason: string | null;
  findings: Finding[];
  closureCandidates: number[];
  reopenCandidates: number[];
}

export const CONTROL_LOOP_LABEL = "control-loop";

function isControlLoopIssue(issue: IssueSnapshotItem): boolean {
  return issue.labels.includes(CONTROL_LOOP_LABEL);
}

export function scanIssueHygiene(input: { snapshot: IssueSnapshot | null; findings: Finding[]; mode: RunMode }): IssueHygieneResult {
  const { snapshot, findings, mode } = input;
  if (!snapshot) {
    return { complete: false, reason: "issue_snapshot_unavailable", findings: [], closureCandidates: [], reopenCandidates: [] };
  }
  const active = new Set(findings.map((finding) => finding.fingerprint));
  const produced: Finding[] = [];
  const closureCandidates: number[] = [];
  const reopenCandidates: number[] = [];
  const openByFingerprint = new Map<string, number[]>();
  const missing = rule("CL-ISSUE-001");
  const duplicate = rule("CL-ISSUE-002");
  const recurred = rule("CL-ISSUE-003");

  for (const issue of [...snapshot.issues].sort((left, right) => left.number - right.number)) {
    if (!isControlLoopIssue(issue)) continue;
    const parsed = issue.fingerprint ? parseFingerprint(issue.fingerprint) : null;
    if (!parsed) {
      if (issue.state === "open" && missing.modes.includes(mode)) {
        const subject = `issue-${issue.number}:missing-fingerprint`;
        produced.push({
          ruleId: missing.id,
          fingerprint: fingerprintFor(missing, subject),
          subject,
          severity: missing.severity,
          authority: missing.authority,
          remediation: missing.remediation,
          path: null,
          line: null,
          detail: `issue #${issue.number} carries no parseable control-loop fingerprint, so it cannot be deduplicated`,
          suggestion: null,
        });
      }
      continue;
    }
    const value = issue.fingerprint as string;
    if (issue.state === "open") {
      openByFingerprint.set(value, [...(openByFingerprint.get(value) ?? []), issue.number]);
      if (!active.has(value)) closureCandidates.push(issue.number);
      continue;
    }
    if (active.has(value)) {
      reopenCandidates.push(issue.number);
      const subject = `issue-${issue.number}:recurred`;
      produced.push({
        ruleId: recurred.id,
        fingerprint: fingerprintFor(recurred, subject),
        subject,
        severity: recurred.severity,
        authority: recurred.authority,
        remediation: recurred.remediation,
        path: null,
        line: null,
        detail: `closed issue #${issue.number} matches an active finding (${value}) and must reopen rather than duplicate`,
        suggestion: null,
      });
    }
  }

  for (const [value, numbers] of [...openByFingerprint.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
    if (numbers.length < 2) continue;
    const subject = `fingerprint:${value}:duplicated`;
    produced.push({
      ruleId: duplicate.id,
      fingerprint: fingerprintFor(duplicate, subject),
      subject,
      severity: duplicate.severity,
      authority: duplicate.authority,
      remediation: duplicate.remediation,
      path: null,
      line: null,
      detail: `issues ${numbers.map((number) => `#${number}`).join(", ")} share fingerprint ${value}`,
      suggestion: null,
    });
  }

  return { complete: true, reason: null, findings: produced, closureCandidates, reopenCandidates };
}
