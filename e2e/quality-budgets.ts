// Version-controlled quality budgets. Every number here is asserted by e2e/performance.spec.ts
// and documented in docs/QUALITY_BUDGETS.md. Budgets are deliberately generous ceilings that catch
// order-of-magnitude regressions without depending on runner speed.

export type BudgetTarget = "development" | "production";

export type PerformanceBudget = {
  // Wall-clock ceilings. Generous by design: they exist to catch a hang or an order-of-magnitude
  // regression, not to police runner jitter.
  navigationMs: number;
  surfaceSwitchMs: number;
  workspaceApiMs: number;
  // Deterministic ceilings. These do not depend on machine speed at all.
  documentDomNodes: number;
  scriptRequestCount: number;
  scriptTransferBytes: number;
  maxHorizontalOverflowPx: number;
};

export const performanceBudgets: Record<BudgetTarget, PerformanceBudget> = {
  development: {
    navigationMs: 30_000,
    surfaceSwitchMs: 6_000,
    workspaceApiMs: 6_000,
    documentDomNodes: 2_500,
    scriptRequestCount: 120,
    scriptTransferBytes: 48 * 1024 * 1024,
    maxHorizontalOverflowPx: 1,
  },
  production: {
    navigationMs: 10_000,
    surfaceSwitchMs: 3_000,
    workspaceApiMs: 3_000,
    documentDomNodes: 2_500,
    scriptRequestCount: 40,
    scriptTransferBytes: 3 * 1024 * 1024,
    maxHorizontalOverflowPx: 1,
  },
};

export const accessibilityBudget = {
  // WCAG 2.1 AA is the contractual bar for the customer workspace.
  tags: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
  // Nothing at or above "serious" is allowed on a critical customer surface.
  blockedImpacts: ["serious", "critical"] as const,
};

export function budgetTarget(): BudgetTarget {
  return process.env.CORVIS_E2E_TARGET === "production" ? "production" : "development";
}

export function activeBudget(): PerformanceBudget {
  return performanceBudgets[budgetTarget()];
}
