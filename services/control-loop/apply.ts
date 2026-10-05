import { classifyFailure } from "./failure.ts";
import type { AppliedAction, ApplyResult, PlannedAction, TextEdit } from "./types.ts";

export interface EditApplier {
  apply(edit: TextEdit): Promise<void>;
}

export type ApplyMode = "dry-run" | "execute";

export type ApplyOptions = {
  mode: ApplyMode;
  budget: number;
  applier?: EditApplier;
};

/**
 * Phase two of the mandated two-phase execution: apply only the automatic,
 * allowlisted actions phase one already persisted, bounded by an edit
 * budget. `mode: "dry-run"` (the CLI default) never calls the applier at
 * all, so it is always safe to run. Exceeding the budget stops applying
 * further actions rather than silently continuing past the configured
 * limit; the caller is expected to surface `budgetExceeded` as a health
 * finding instead of treating a truncated run as complete. An applier error
 * becomes a `failed` outcome rather than a rejection; auth/rate-limit errors
 * (401/403/429) additionally stop the remaining actions (recorded as skipped).
 */
export async function applyActions(plan: readonly PlannedAction[], options: ApplyOptions): Promise<ApplyResult> {
  const automatic = plan.filter((action) => action.approval === "automatic" && action.disposition === "planned" && action.edit);
  const dryRun = options.mode === "dry-run";
  const actions: AppliedAction[] = [];
  let budgetExceeded = false;
  let haltedReason: string | null = null;

  for (const action of automatic) {
    if (haltedReason) {
      actions.push({ fingerprint: action.fingerprint, outcome: "skipped", reason: `halted_after:${haltedReason}` });
      continue;
    }
    if (actions.filter((entry) => entry.outcome === "applied").length >= options.budget) {
      budgetExceeded = true;
      actions.push({ fingerprint: action.fingerprint, outcome: "skipped", reason: "mutation_budget_exceeded" });
      continue;
    }
    if (dryRun) {
      actions.push({ fingerprint: action.fingerprint, outcome: "dry-run", reason: null });
      continue;
    }
    if (!options.applier) {
      actions.push({ fingerprint: action.fingerprint, outcome: "skipped", reason: "no_applier_configured" });
      continue;
    }
    // A failing edit is recorded, not thrown: earlier outcomes must survive
    // into the report and watermark instead of vanishing with the rejection.
    try {
      await options.applier.apply(action.edit as TextEdit);
    } catch (error) {
      const failure = classifyFailure(error);
      actions.push({ fingerprint: action.fingerprint, outcome: "failed", reason: failure.reason });
      if (failure.halt) haltedReason = failure.reason;
      continue;
    }
    actions.push({ fingerprint: action.fingerprint, outcome: "applied", reason: null });
  }

  return {
    executed: !dryRun,
    dryRun,
    budget: options.budget,
    budgetExceeded,
    blockedReason: budgetExceeded ? "mutation_budget_exceeded" : null,
    haltedReason,
    actions,
  };
}
