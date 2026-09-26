import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { accessibilityBudget } from "./quality-budgets.ts";
import { openSurface, surfaces } from "./support/surfaces.ts";

type Violation = { id: string; impact?: string | null; help: string; nodes: Array<{ target: unknown[] }> };

async function blockingViolations(page: Page): Promise<Violation[]> {
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
