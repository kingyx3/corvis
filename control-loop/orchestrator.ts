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
} from "./issue-reconciliation.ts";
import type { StateStore } from "./state.ts";
import type { Finding, RunMode, RunReport, RunStatus, ScannerStatus, Watermark } from "./types.ts";
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
}): Watermark {
  const { previous, mode, now, runId, status, scanComplete } = input;
  const succeeded = status === "complete";
  const isWeekly = mode === "weekly" || mode === "monthly";
  return {
    schemaVersion: 1,
    lastSuccessfulDailyRunAt: succeeded ? now.toISOString() : previous.lastSuccessfulDailyRunAt,
    lastSuccessfulWeeklyRunAt: succeeded && isWeekly ? now.toISOString() : previous.lastSuccessfulWeeklyRunAt,
    lastWeeklyScanComplete: isWeekly ? succeeded && scanComplete : previous.lastWeeklyScanComplete,
    consecutiveFailures: succeeded ? 0 : previous.consecutiveFailures + 1,
    lastRunId: runId,
  };
}

/**
 * Runs one control-loop cycle end to end: acquire the single-writer lock,
 * scan under the mode's scope rules, classify and (dry-run by default) apply
 * findings, evaluate health, decide whether automatic issue closure is
 * allowed, and persist the watermark — all inside one report so a caller
 * never has to reassemble run state from side effects.
 *
 * Never throws: an unexpected scanner failure is caught and reported as a
 * `failed` run so a crash cannot corrupt the watermark or silently vanish.
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
      notes.push(`scan_failed:${error instanceof Error ? error.message : String(error)}`);
    }

    // Coverage for health/watermark purposes ignores explicitly skipped
    // (unconfigured) scanners; closure additionally needs every scanner,
    // since closing issues without an issue snapshot is meaningless.
    const scanComplete = status !== "failed" && scanners.every((scanner) => scanner.complete || scanner.skipped === true);
    const allScannersComplete = status !== "failed" && scanners.every((scanner) => scanner.complete);
    const nextWatermarkValue = nextWatermark({ previous: previousWatermark, mode: deps.mode, now: deps.now, runId, status, scanComplete });
    const health = evaluateHealth({ now: deps.now, watermark: nextWatermarkValue, weeklyScanComplete: nextWatermarkValue.lastWeeklyScanComplete });
    const degraded = healthFinding(health);
    const allFindings = degraded ? dedupeFindings(sortFindings([...findings, degraded])) : findings;

    const plan = planActions(allFindings);
    const applyResult = status === "failed"
      ? undefined
      : await applyActions(plan, { mode: deps.applyMode ?? "dry-run", budget: deps.mutationBudget ?? DEFAULT_MUTATION_BUDGET, applier: deps.applier });
    if (applyResult?.budgetExceeded) notes.push("mutation_budget_exceeded");

    const closure = closureDecision({ status, health, scanComplete: allScannersComplete, fullScan: scanFull });

    // Reconciliation needs a real issue snapshot to compare against; without
    // one (no GitHub token configured) there is nothing safe to reconcile.
    const issueReconciliation = deps.issueSnapshot
      ? await applyIssueReconciliation(
        planIssueReconciliation({ findings: activeFindings, snapshot: deps.issueSnapshot, status, closureAllowed: closure.allowed }),
        {
          mode: deps.issueApplyMode ?? "dry-run",
          budget: deps.issueMutationBudget ?? DEFAULT_MUTATION_BUDGET,
          writer: deps.issueWriter,
        },
      )
      : null;

    // Conditional stores only persist if no other run wrote the watermark since
    // this run read it (e.g. after this run's lease went stale), instead of
    // last-writer-wins.
    if (!(await writeWatermarkIfUnchanged(deps.stateStore, nextWatermarkValue, previousRead))) {
      notes.push("watermark_write_conflict");
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
