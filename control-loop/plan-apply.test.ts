import assert from "node:assert/strict";
import test from "node:test";
import { applyActions, type EditApplier } from "./apply.ts";
import { planActions } from "./plan.ts";
import type { Finding, PlannedAction, TextEdit } from "./types.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "CL-DOC-003", fingerprint: "f1", subject: "s", severity: "medium",
    authority: "github", remediation: "auto-fix", path: "docs/A.md", line: 1, detail: "d", suggestion: null,
    ...overrides,
  };
}

// ---- planActions ----

test("a human-approval rule always blocks, even with a concrete edit available", () => {
  const [plan] = planActions([finding({ ruleId: "CL-DOC-001", remediation: "human-approval" as never, suggestion: { path: "docs/A.md", before: "x", after: "y" } })]);
  assert.equal(plan?.approval, "human");
  assert.equal(plan?.disposition, "blocked");
  assert.equal(plan?.blockedReason, "rule_requires_human_approval");
});

test("an auto-fix rule with no suggested edit blocks rather than guessing", () => {
  const [plan] = planActions([finding({ suggestion: null })]);
  assert.equal(plan?.disposition, "blocked");
  assert.equal(plan?.blockedReason, "no_deterministic_edit_available");
});

test("an auto-fix rule whose edit path falls outside the rule's allowlist blocks", () => {
  const [plan] = planActions([finding({ path: "app/README.md", suggestion: { path: "app/README.md", before: "x", after: "y" } })]);
  assert.equal(plan?.disposition, "blocked");
  assert.equal(plan?.blockedReason, "edit_path_not_allowlisted");
});

test("an auto-fix rule with an allowlisted edit path is planned for automatic application", () => {
  const [plan] = planActions([finding({ suggestion: { path: "docs/A.md", before: "x", after: "y" } })]);
  assert.equal(plan?.approval, "automatic");
  assert.equal(plan?.disposition, "planned");
  assert.deepEqual(plan?.edit, { path: "docs/A.md", before: "x", after: "y" });
});

// ---- applyActions ----

function plannedAutomatic(fingerprint: string, edit: TextEdit): PlannedAction {
  return { ruleId: "CL-DOC-003", fingerprint, approval: "automatic", disposition: "planned", blockedReason: null, edit };
}

function plannedBlocked(fingerprint: string): PlannedAction {
  return { ruleId: "CL-DOC-001", fingerprint, approval: "human", disposition: "blocked", blockedReason: "rule_requires_human_approval", edit: null };
}

class RecordingApplier implements EditApplier {
  readonly applied: TextEdit[] = [];
  async apply(edit: TextEdit): Promise<void> { this.applied.push(edit); }
}

test("dry-run mode never calls the applier, even for automatic actions", async () => {
  const applier = new RecordingApplier();
  const result = await applyActions([plannedAutomatic("a", { path: "docs/A.md", before: "x", after: "y" })], { mode: "dry-run", budget: 10, applier });
  assert.equal(result.dryRun, true);
  assert.equal(result.executed, false);
  assert.equal(applier.applied.length, 0);
  assert.deepEqual(result.actions, [{ fingerprint: "a", outcome: "dry-run", reason: null }]);
});

test("a blocked/human action is never passed to the applier in either mode", async () => {
  const applier = new RecordingApplier();
  await applyActions([plannedBlocked("a")], { mode: "execute", budget: 10, applier });
  assert.equal(applier.applied.length, 0);
});

test("execute mode with no applier configured reports the action as skipped rather than silently succeeding", async () => {
  const result = await applyActions([plannedAutomatic("a", { path: "docs/A.md", before: "x", after: "y" })], { mode: "execute", budget: 10 });
  assert.deepEqual(result.actions, [{ fingerprint: "a", outcome: "skipped", reason: "no_applier_configured" }]);
});

test("execute mode with an applier calls it exactly once per automatic action", async () => {
  const applier = new RecordingApplier();
  const plan = [plannedAutomatic("a", { path: "docs/A.md", before: "x", after: "y" }), plannedAutomatic("b", { path: "docs/B.md", before: "x", after: "y" })];
  const result = await applyActions(plan, { mode: "execute", budget: 10, applier });
  assert.equal(applier.applied.length, 2);
  assert.deepEqual(result.actions.map((a) => a.outcome), ["applied", "applied"]);
});

test("the mutation budget stops further automatic actions and is reported as exceeded", async () => {
  const applier = new RecordingApplier();
  const plan = [
    plannedAutomatic("a", { path: "docs/A.md", before: "x", after: "y" }),
    plannedAutomatic("b", { path: "docs/B.md", before: "x", after: "y" }),
    plannedAutomatic("c", { path: "docs/C.md", before: "x", after: "y" }),
  ];
  const result = await applyActions(plan, { mode: "execute", budget: 2, applier });
  assert.equal(applier.applied.length, 2);
  assert.equal(result.budgetExceeded, true);
  assert.equal(result.blockedReason, "mutation_budget_exceeded");
  assert.deepEqual(result.actions.map((a) => a.outcome), ["applied", "applied", "skipped"]);
});
