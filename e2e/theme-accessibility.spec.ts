import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { accessibilityBudget } from "./quality-budgets.ts";
import { openSurface, surfaces } from "./support/surfaces.ts";

type Violation = { id: string; impact?: string | null; help: string; nodes: Array<{ target: unknown[] }> };

// `reducedMotion: "reduce"` (playwright.config.ts) is meant to collapse every CSS transition to ~0 via the
// `prefers-reduced-motion` media query (src/app/globals.css), but WebKit's emulation of that media feature is
// unreliable, so a scan run immediately after a state change (e.g. the Reauthorize button swapping between
// primary/secondary as connection health updates) can sample a color mid-transition and report a transient,
// never-actually-rendered contrast violation. Waiting for in-flight animations/transitions to settle first
// removes that race without weakening the scan itself.
async function waitForTransitions(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
}

async function blockingViolations(page: Page): Promise<Violation[]> {
  await waitForTransitions(page);
  const results = await new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

function describe(violations: Violation[]): string {
  return violations.map((violation) => `${violation.impact}/${violation.id}: ${violation.help} (${violation.nodes.length} node(s), first: ${JSON.stringify(violation.nodes[0]?.target)})`).join("\n");
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const surface of surfaces) {
    test(`${surface.label} passes the accessibility matrix in ${colorScheme} theme @matrix`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      if (surface.role) await page.addInitScript((role) => window.sessionStorage.setItem("corvis:demo:role", role), surface.role);
      await page.goto("/");
      await openSurface(page, surface);
      await expect(page.getByRole("heading", { name: surface.heading }).first()).toBeVisible();
      await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme === "dark" ? /dark/ : /light/);
      const violations = await blockingViolations(page);
      expect(violations, describe(violations)).toEqual([]);
    });
  }

  test(`admin console passes the accessibility matrix in ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: /admin console/i })).toBeVisible();
    const violations = await blockingViolations(page);
    expect(violations, describe(violations)).toEqual([]);
  });
}
