import { FINGERPRINT_LINE, legacyFingerprintOf } from "./classifiers/fingerprint.ts";
import { classifyFailure } from "./failure.ts";
import type { Finding, RunStatus } from "./types.ts";
import { CONTROL_LOOP_LABEL, type IssueSnapshot, type IssueSnapshotItem } from "./scanners/issue-hygiene.ts";

export type ReconciliationActionType = "create" | "reopen" | "close" | "rekey";

export interface ReconciliationAction {
  type: ReconciliationActionType;
  fingerprint: string;
  /** The tracked issue, or null for `create` (the number does not exist yet). */
  issueNumber: number | null;
  /** Set for `create` only. */
  title: string | null;
  /** Set for `create` (issue body), `rekey` (the rewritten issue body) and `reopen`/`close` (explanatory comment). */
  body: string | null;
}

export interface ReconciliationInput {
  /**
   * The same non-hygiene findings (documentation-authority, internal-links,
   * architecture-drift) that `scanIssueHygiene` treats as "active" — never
   * the CL-ISSUE-* / CL-HEALTH-* findings hygiene itself produces, or a
   * reconciliation run would try to open issues about its own bookkeeping.
   */
  findings: readonly Finding[];
  snapshot: IssueSnapshot;
  status: RunStatus;
  /** Mirrors the orchestrator's own closure gate: never close on an incomplete/partial/unhealthy run. */
  closureAllowed: boolean;
}

function isTracked(issue: IssueSnapshotItem): issue is IssueSnapshotItem & { fingerprint: string } {
  return issue.labels.includes(CONTROL_LOOP_LABEL) && issue.fingerprint !== null;
}

function issueTitle(finding: Finding): string {
  const subject = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ""}` : finding.subject;
  return `[control-loop] ${finding.ruleId}: ${subject}`.slice(0, 250);
}

function issueBody(finding: Finding): string {
  return [
    finding.detail,
    "",
    `- Rule: \`${finding.ruleId}\` (${finding.severity})`,
    finding.path ? `- Location: \`${finding.path}${finding.line ? `:${finding.line}` : ""}\`` : null,
    "",
    `Finding fingerprint: \`${finding.fingerprint}\``,
    "",
    "_Opened automatically by corvis-control-loop. This issue is reconciled by fingerprint — do not edit the fingerprint line, and let the loop close or reopen it._",
  ].filter((line) => line !== null).join("\n");
}

function reopenComment(finding: Finding): string {
  return `Reopened automatically: this finding (\`${finding.fingerprint}\`) recurred in a later scan.\n\n${finding.detail}`;
}

function closeComment(fingerprint: string): string {
  return `Closed automatically: finding \`${fingerprint}\` is no longer present after a complete, healthy scan.`;
}

function rekeyedBody(issue: IssueSnapshotItem, fingerprint: string): string | null {
  if (typeof issue.body !== "string" || !FINGERPRINT_LINE.test(issue.body)) return null;
  return issue.body.replace(FINGERPRINT_LINE, () => `Finding fingerprint: \`${fingerprint}\``);
}

/**
 * Pure, deterministic reconciliation: given the currently active findings and
 * the last-known issue snapshot, decides which control-loop-labeled GitHub
 * issues to create, reopen or close by stable fingerprint. Never runs off a
 * failed run (its findings are not trustworthy), and only ever proposes a
 * `close` when the caller's own closure gate allows it — the same gate the
 * orchestrator already uses to decide automatic closure is safe.
 *
 * Issues opened before fingerprints carried a subject hash are keyed by the
 * legacy form (the current fingerprint without `#hash`). Rather than closing
 * them and opening duplicates, each is adopted by the first active finding (in
 * fingerprint order) that maps to it and re-keyed: a `rekey` action rewrites the
 * fingerprint line of its body, after which it reconciles like any other issue.
 * When several findings share one legacy fingerprint (the collision that the
 * hash exists to prevent) only one adopts the issue and the others get their
 * own. An issue whose body cannot be re-keyed is not adopted.
 */
export function planIssueReconciliation(input: ReconciliationInput): ReconciliationAction[] {
  const { findings, snapshot, status, closureAllowed } = input;
  if (status === "failed") return [];

  const active = new Map(findings.map((finding) => [finding.fingerprint, finding]));
  const openByFingerprint = new Map<string, IssueSnapshotItem>();
  const closedByFingerprint = new Map<string, IssueSnapshotItem>();
  for (const issue of [...snapshot.issues].filter(isTracked).sort((left, right) => left.number - right.number)) {
    const fingerprint = issue.fingerprint as string;
    if (issue.state === "open") {
      if (!openByFingerprint.has(fingerprint)) openByFingerprint.set(fingerprint, issue);
    } else {
      // Last (highest-numbered) closed issue for a fingerprint is the one to reopen.
      closedByFingerprint.set(fingerprint, issue);
    }
  }

  const rekeys: ReconciliationAction[] = [];
  const actions: ReconciliationAction[] = [];
  /** Issue numbers adopted from a legacy fingerprint: they are tracked, so never closed as "gone". */
  const adopted = new Set<number>();

  for (const [fingerprint, finding] of [...active.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
    if (openByFingerprint.has(fingerprint)) continue;
    let closed = closedByFingerprint.get(fingerprint);
    if (!closed) {
      const legacy = legacyFingerprintOf(fingerprint);
      if (legacy !== fingerprint) {
        const candidate = [openByFingerprint.get(legacy), closedByFingerprint.get(legacy)]
          .find((issue) => issue !== undefined && !adopted.has(issue.number) && rekeyedBody(issue, fingerprint) !== null);
        if (candidate) {
          adopted.add(candidate.number);
          rekeys.push({ type: "rekey", fingerprint, issueNumber: candidate.number, title: null, body: rekeyedBody(candidate, fingerprint) });
          if (candidate.state === "open") continue;
          closed = candidate;
        }
      }
    }
    if (closed) {
      actions.push({ type: "reopen", fingerprint, issueNumber: closed.number, title: null, body: reopenComment(finding) });
      continue;
    }
    actions.push({ type: "create", fingerprint, issueNumber: null, title: issueTitle(finding), body: issueBody(finding) });
  }

  if (closureAllowed) {
    for (const [fingerprint, issue] of [...openByFingerprint.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
      if (!active.has(fingerprint) && !adopted.has(issue.number)) {
        actions.push({ type: "close", fingerprint, issueNumber: issue.number, title: null, body: closeComment(fingerprint) });
      }
    }
  }

  return [...rekeys, ...actions];
}

export interface IssueWriter {
  create(input: { title: string; body: string; labels: string[] }): Promise<{ number: number }>;
  setState(issueNumber: number, state: "open" | "closed"): Promise<void>;
  /** Replaces the issue body (used to re-key a legacy-fingerprint issue). */
  updateBody(issueNumber: number, body: string): Promise<void>;
  comment(issueNumber: number, body: string): Promise<void>;
}

export type ReconciliationApplyMode = "dry-run" | "execute";

export interface ReconciliationApplyOptions {
  mode: ReconciliationApplyMode;
  budget: number;
  writer?: IssueWriter;
}

export interface ReconciliationOutcome {
  type: ReconciliationActionType;
  fingerprint: string;
  issueNumber: number | null;
  outcome: "dry-run" | "applied" | "skipped" | "failed";
  reason: string | null;
}

export interface ReconciliationResult {
  executed: boolean;
  dryRun: boolean;
  budget: number;
  budgetExceeded: boolean;
  /** Set when an auth/rate-limit style failure stopped further writes; remaining actions are recorded as skipped. */
  haltedReason: string | null;
  outcomes: ReconciliationOutcome[];
}

/**
 * Phase two for issue reconciliation, mirroring `applyActions`: `dry-run`
 * (the default everywhere this is wired in today) never touches the writer,
 * and a bounded mutation budget stops further writes rather than continuing
 * past the configured limit. A writer error becomes a `failed` outcome rather
 * than a rejection; auth/rate-limit errors (401/403/429) additionally stop the
 * remaining writes (recorded as skipped). If `setState` succeeds and the
 * follow-up `comment` fails, the action is reported failed; the next run
 * re-plans from a fresh snapshot, so the state change is not repeated.
 */
export async function applyIssueReconciliation(
  actions: readonly ReconciliationAction[],
  options: ReconciliationApplyOptions,
): Promise<ReconciliationResult> {
  const dryRun = options.mode === "dry-run";
  const outcomes: ReconciliationOutcome[] = [];
  let applied = 0;
  let budgetExceeded = false;
  let haltedReason: string | null = null;

  for (const action of actions) {
    if (haltedReason) {
      outcomes.push({ type: action.type, fingerprint: action.fingerprint, issueNumber: action.issueNumber, outcome: "skipped", reason: `halted_after:${haltedReason}` });
      continue;
    }
    if (applied >= options.budget) {
      budgetExceeded = true;
      outcomes.push({ type: action.type, fingerprint: action.fingerprint, issueNumber: action.issueNumber, outcome: "skipped", reason: "mutation_budget_exceeded" });
      continue;
    }
    if (dryRun) {
      outcomes.push({ type: action.type, fingerprint: action.fingerprint, issueNumber: action.issueNumber, outcome: "dry-run", reason: null });
      continue;
    }
    if (!options.writer) {
      outcomes.push({ type: action.type, fingerprint: action.fingerprint, issueNumber: action.issueNumber, outcome: "skipped", reason: "no_writer_configured" });
      continue;
    }

    let issueNumber = action.issueNumber;
    try {
      if (action.type === "create") {
        const created = await options.writer.create({ title: action.title as string, body: action.body as string, labels: [CONTROL_LOOP_LABEL] });
        issueNumber = created.number;
      } else if (action.type === "rekey") {
        await options.writer.updateBody(action.issueNumber as number, action.body as string);
      } else {
        await options.writer.setState(action.issueNumber as number, action.type === "reopen" ? "open" : "closed");
        if (action.body) await options.writer.comment(action.issueNumber as number, action.body);
      }
    } catch (error) {
      // Recorded, not thrown: outcomes already applied this run must survive
      // into the report and watermark.
      const failure = classifyFailure(error);
      outcomes.push({ type: action.type, fingerprint: action.fingerprint, issueNumber, outcome: "failed", reason: failure.reason });
      if (failure.halt) haltedReason = failure.reason;
      continue;
    }
    outcomes.push({ type: action.type, fingerprint: action.fingerprint, issueNumber, outcome: "applied", reason: null });
    applied += 1;
  }

  return { executed: !dryRun, dryRun, budget: options.budget, budgetExceeded, haltedReason, outcomes };
}
