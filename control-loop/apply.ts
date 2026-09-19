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
 * finding instead of treating a truncated run as complete.
 */
export async function applyActions(plan: readonly PlannedAction[], options: ApplyOptions): Promise<ApplyResult> {
  const automatic = plan.filter((action) => action.approval === "automatic" && action.disposition === "planned" && action.edit);
  const dryRun = options.mode === "dry-run";
  const actions: AppliedAction[] = [];
  let budgetExceeded = false;

  for (const action of automatic) {
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
    await options.applier.apply(action.edit as TextEdit);
    actions.push({ fingerprint: action.fingerprint, outcome: "applied", reason: null });
  }

  return {
    executed: !dryRun,
    dryRun,
    budget: options.budget,
    budgetExceeded,
    blockedReason: budgetExceeded ? "mutation_budget_exceeded" : null,
    actions,
  };
}
