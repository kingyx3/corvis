import { randomUUID } from "node:crypto";
import { applyActions, type ApplyMode, type EditApplier } from "./apply.ts";
import { dedupeFindings, sortFindings } from "./classifiers/fingerprint.ts";
import { planActions } from "./plan.ts";
import { closureDecision, evaluateHealth, healthFinding } from "./reports/health.ts";
import { scanArchitectureDrift } from "./scanners/architecture-drift.ts";
import { scanDocumentationAuthority } from "./scanners/documentation-authority.ts";
import { scanInternalLinks } from "./scanners/internal-links.ts";
import { scanIssueHygiene, type IssueSnapshot } from "./scanners/issue-hygiene.ts";
import { loadRepoSnapshot, selectScanScope } from "./scanners/repo-snapshot.ts";
import {
  applyIssueReconciliation,
  planIssueReconciliation,
  type IssueWriter,
  type ReconciliationApplyMode,
  type ReconciliationResult,
} from "./issue-reconciliation.ts";
import type { StateStore } from "./state.ts";
import type { ApplyResult, Finding, RunMode, RunReport, RunStatus, ScannerStatus, Watermark } from "./types.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { readWatermark, readWatermarkVersioned, writeWatermarkIfUnchanged } from "./watermark.ts";

const LOCK_OWNER_PREFIX = "control-loop";
const DEFAULT_LOCK_STALE_AFTER_MS = 60 * 60 * 1000;
const DEFAULT_MUTATION_BUDGET = 20;

export type RunDependencies = {
  root: string;
  mode: RunMode;
  now: Date;
  stateStore: StateStore;
  runId?: string;
  /** Paths changed since the watermark, for a daily incremental scan. `null`/omitted means unavailable, which forces a full scan. */
  changedPaths?: string[] | null;
  /** Commit the scanned checkout is at; recorded in the watermark when the run succeeds so the next daily scan can diff from it. */
  headCommit?: string | null;
  /** Open/closed control-loop-labeled issues. `null`/omitted means unavailable. */
  issueSnapshot?: IssueSnapshot | null;
  /**
   * Whether a missing issue snapshot is a run failure. Defaults to true. The CLI
   * sets it only when a GitHub credential is configured: without one, issue
   * hygiene is an unconfigured optional scanner (anonymous API access is
   * best-effort and rate-limited), so its absence is reported as skipped
   * rather than driving the failure streak and health degradation forever.
   */
  issueSnapshotRequired?: boolean;
  /** Lease owner. Defaults to a per-run unique id so concurrent runs exclude each other. */
  lockOwner?: string;
  lockStaleAfterMs?: number;
  applyMode?: ApplyMode;
  mutationBudget?: number;
  applier?: EditApplier;
  /**
   * Issue reconciliation (create/reopen/close control-loop issues by
   * fingerprint) defaults to dry-run and no writer, same as file-edit apply —
   * safe to leave unset. Deliberately a separate mode/budget from
   * `applyMode`/`mutationBudget`: mutating GitHub issues and mutating repo
   * files are independent blast radii with independent rollout timing.
   */
  issueApplyMode?: ReconciliationApplyMode;
  issueMutationBudget?: number;
  issueWriter?: IssueWriter;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scannerStatuses(issueHygiene: ScannerStatus): ScannerStatus[] {
  return [
    { name: "documentation-authority", complete: true, reason: null },
    { name: "internal-links", complete: true, reason: null },
    { name: "architecture-drift", complete: true, reason: null },
    issueHygiene,
  ];
}

function nextWatermark(input: {
  previous: Watermark;
  mode: RunMode;
  now: Date;
  runId: string;
  status: RunStatus;
  scanComplete: boolean;
  headCommit: string | null;
}): Watermark {
  const { previous, mode, now, runId, status, scanComplete, headCommit } = input;
  const succeeded = status === "complete";
  const isWeekly = mode === "weekly" || mode === "monthly";
  return {
    schemaVersion: 1,
    lastSuccessfulDailyRunAt: succeeded ? now.toISOString() : previous.lastSuccessfulDailyRunAt,
    lastSuccessfulWeeklyRunAt: succeeded && isWeekly ? now.toISOString() : previous.lastSuccessfulWeeklyRunAt,
    lastWeeklyScanComplete: isWeekly ? succeeded && scanComplete : previous.lastWeeklyScanComplete,
    consecutiveFailures: succeeded ? 0 : previous.consecutiveFailures + 1,
    lastRunId: runId,
    // Only a successful run proves everything up to headCommit was scanned; an
    // unknown head (no git) keeps the older commit, which only widens the next diff.
    lastScannedCommit: succeeded && headCommit ? headCommit : previous.lastScannedCommit ?? null,
  };
}

/**
 * Runs one control-loop cycle end to end: acquire the single-writer lock,
 * scan under the mode's scope rules, classify and (dry-run by default) apply
 * findings, evaluate health, decide whether automatic issue closure is
 * allowed, and persist the watermark — all inside one report so a caller
 * never has to reassemble run state from side effects.
 *
 * Never throws once the lock is acquired: an unexpected scanner failure is
 * caught and reported as a `failed` run, and a writer/applier failure (e.g. a
 * GitHub 403 or rate limit) is recorded as a `failed` outcome that downgrades
 * the run to `incomplete`, so a crash cannot corrupt the watermark or silently
 * vanish.
 */
export async function runControlLoop(deps: RunDependencies): Promise<RunReport> {
  const runId = deps.runId ?? randomUUID();
  const startedAt = deps.now.toISOString();
  // A constant owner would make every run treat a live lease as its own, so
  // there would be no mutual exclusion and the first finisher would release
  // the other run's lease. The run id is random per invocation.
  const lockOwner = deps.lockOwner ?? `${LOCK_OWNER_PREFIX}:${runId}`;
  const lockStaleAfterMs = deps.lockStaleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;

  const lock = await acquireLock(deps.stateStore, lockOwner, deps.now, lockStaleAfterMs);
  if (!lock.acquired) {
    const watermark = await readWatermark(deps.stateStore);
    const health = evaluateHealth({ now: deps.now, watermark, weeklyScanComplete: watermark.lastWeeklyScanComplete });
    return {
      schemaVersion: 1,
      runId,
      mode: deps.mode,
      startedAt,
      finishedAt: deps.now.toISOString(),
      status: "incomplete",
      skipped: true,
      notes: [`lock held by ${lock.heldBy.owner} since ${lock.heldBy.acquiredAt}`],
      scan: { full: false, reason: "lock_not_acquired", filesScanned: 0, scanners: [] },
      findings: [],
      plan: [],
      applied: null,
      health,
      closure: { allowed: false, reason: "run_skipped_lock_contention" },
      watermark,
      issueReconciliation: null,
    };
  }

  try {
    const previousRead = await readWatermarkVersioned(deps.stateStore);
    const previousWatermark = previousRead.watermark;
    let status: RunStatus = "complete";
    const notes: string[] = [];
    let findings: Finding[] = [];
    let scanners: ScannerStatus[] = [];
    let filesScanned = 0;
    let scanFull = true;
    let scanReason = "full_scan";
    // The non-hygiene findings (documentation-authority, internal-links,
    // architecture-drift), which is exactly the "active" set issue
    // reconciliation compares against tracked issues. Never includes the
    // CL-ISSUE-*/CL-HEALTH-* findings hygiene/health produce, or
    // reconciliation would try to open issues about its own bookkeeping.
    let activeFindings: Finding[] = [];

    try {
      const snapshot = await loadRepoSnapshot(deps.root);
      const scope = selectScanScope({
        mode: deps.mode,
        watermark: previousWatermark,
        snapshot,
        changedPaths: deps.changedPaths ?? null,
      });
      scanFull = scope.full;
      scanReason = scope.reason;
      filesScanned = scope.files.length;

      const docAuthority = scanDocumentationAuthority(scope.files);
      const internalLinks = scanInternalLinks(scope.files, snapshot);
      const architectureDrift = scanArchitectureDrift(scope.files);
      const preHygiene = dedupeFindings(sortFindings([...docAuthority, ...internalLinks, ...architectureDrift]));
      activeFindings = preHygiene;

      const hygiene = scanIssueHygiene({ snapshot: deps.issueSnapshot ?? null, findings: preHygiene, mode: deps.mode });
      findings = dedupeFindings(sortFindings([...preHygiene, ...hygiene.findings]));
      const hygieneSkipped = !hygiene.complete && !deps.issueSnapshot && deps.issueSnapshotRequired === false;
      scanners = scannerStatuses(hygieneSkipped
        ? { name: "issue-hygiene", complete: false, skipped: true, reason: "issue_snapshot_unavailable_no_github_token" }
        : { name: "issue-hygiene", complete: hygiene.complete, reason: hygiene.reason });
      if (hygieneSkipped) notes.push("issue_hygiene_skipped:no_github_token");
      else if (!hygiene.complete) status = "incomplete";
    } catch (error) {
      status = "failed";
      notes.push(`scan_failed:${errorMessage(error)}`);
    }

    // Coverage for health/watermark purposes ignores explicitly skipped
    // (unconfigured) scanners; closure additionally needs every scanner,
    // since closing issues without an issue snapshot is meaningless.
    const scanComplete = status !== "failed" && scanners.every((scanner) => scanner.complete || scanner.skipped === true);
    const allScannersComplete = status !== "failed" && scanners.every((scanner) => scanner.complete);
    const computeWatermark = () => nextWatermark({ previous: previousWatermark, mode: deps.mode, now: deps.now, runId, status, scanComplete, headCommit: deps.headCommit ?? null });
    const computeHealth = (watermark: Watermark) => evaluateHealth({ now: deps.now, watermark, weeklyScanComplete: watermark.lastWeeklyScanComplete });
    // Plan from the pre-apply health; the watermark and reported health are
    // recomputed below if a writer failure downgrades the run's status.
    const degraded = healthFinding(computeHealth(computeWatermark()));
    const allFindings = degraded ? dedupeFindings(sortFindings([...findings, degraded])) : findings;

    const plan = planActions(allFindings);
    // Writer/applier failures must never reject the run: that would lose the
    // watermark (failure streak, freshness), the report, and the outcomes of
    // earlier successful applies. They downgrade the run to "incomplete".
    let applyResult: ApplyResult | undefined;
    if (status !== "failed") {
      try {
        applyResult = await applyActions(plan, { mode: deps.applyMode ?? "dry-run", budget: deps.mutationBudget ?? DEFAULT_MUTATION_BUDGET, applier: deps.applier });
      } catch (error) {
        status = "incomplete";
        notes.push(`apply_failed:${errorMessage(error)}`);
      }
    }
    if (applyResult?.budgetExceeded) notes.push("mutation_budget_exceeded");
    if (applyResult?.actions.some((action) => action.outcome === "failed")) {
      status = "incomplete";
      notes.push("apply_action_failed");
    }
    if (applyResult?.haltedReason) notes.push(`apply_halted:${applyResult.haltedReason}`);

    const closure = closureDecision({ status, health: computeHealth(computeWatermark()), scanComplete: allScannersComplete, fullScan: scanFull });

    // Reconciliation needs a real issue snapshot to compare against; without
    // one (no GitHub token configured) there is nothing safe to reconcile.
    let issueReconciliation: ReconciliationResult | null = null;
    if (deps.issueSnapshot) {
      try {
        issueReconciliation = await applyIssueReconciliation(
          planIssueReconciliation({ findings: activeFindings, snapshot: deps.issueSnapshot, status, closureAllowed: closure.allowed }),
          {
            mode: deps.issueApplyMode ?? "dry-run",
            budget: deps.issueMutationBudget ?? DEFAULT_MUTATION_BUDGET,
            writer: deps.issueWriter,
          },
        );
      } catch (error) {
        status = "incomplete";
        notes.push(`issue_reconciliation_failed:${errorMessage(error)}`);
      }
    }
    if (issueReconciliation?.budgetExceeded) notes.push("issue_mutation_budget_exceeded");
    if (issueReconciliation?.outcomes.some((outcome) => outcome.outcome === "failed")) {
      status = "incomplete";
      notes.push("issue_reconciliation_action_failed");
    }
    if (issueReconciliation?.haltedReason) notes.push(`issue_reconciliation_halted:${issueReconciliation.haltedReason}`);

    // The watermark and reported health reflect the final status, so a run
    // downgraded by a writer failure counts toward the failure streak instead
    // of recording a success.
    const nextWatermarkValue = computeWatermark();
    const health = computeHealth(nextWatermarkValue);

    // Conditional stores only persist if no other run wrote the watermark since
    // this run read it (e.g. after this run's lease went stale), instead of
    // last-writer-wins. A store error is reported rather than thrown so the
    // report (and its evidence) still reaches the caller.
    try {
      if (!(await writeWatermarkIfUnchanged(deps.stateStore, nextWatermarkValue, previousRead))) {
        notes.push("watermark_write_conflict");
      }
    } catch (error) {
      notes.push(`watermark_write_failed:${errorMessage(error)}`);
    }

    return {
      schemaVersion: 1,
      runId,
      mode: deps.mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      skipped: false,
      notes,
      scan: { full: scanFull, reason: scanReason, filesScanned, scanners },
      findings: allFindings,
      plan,
      applied: applyResult ?? null,
      health,
      closure,
      watermark: nextWatermarkValue,
      issueReconciliation,
    };
  } finally {
    await releaseLock(deps.stateStore, lockOwner);
  }
}
