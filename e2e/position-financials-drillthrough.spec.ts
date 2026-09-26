import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { accessibilityBudget } from "./quality-budgets.ts";

test("drill-through from Data review to Position Financials pre-scopes the position, and Review's filters/sort/search survive the round trip", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^data review$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();

  // Set filter/sort/search state that should survive navigating away and back.
  await page.getByLabel("Review sort").selectOption("company");
  await page.getByLabel("Search review observations").fill("ABC");

  const link = page.getByRole("button", { name: /view position financials/i }).first();
  await expect(link).toBeVisible();
  await link.click();

  await expect(page.getByRole("heading", { name: /^position financials$/i })).toBeVisible();
  const positionSelect = page.locator("label", { hasText: "Position" }).getByRole("combobox");
  await expect(positionSelect).toHaveValue(/company-abc-corp/);
  await expect(page.getByRole("heading", { name: /revenue across periods/i })).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]).analyze();
  const blocking = results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);

  // Exercise the chart's tabular fallback. Scoped to the revenue figure by
  // heading: the position financials page also renders a workspace exposure
  // composition chart earlier in the DOM, so ".first()" is not reliable here.
  const details = page.locator("figure.chart-figure", { has: page.getByRole("heading", { name: /revenue across periods/i }) }).locator(".chart-data-toggle");
  await details.locator("summary").click();
  await expect(details.locator("table")).toContainText("Q1 2026");

  await page.getByRole("button", { name: /^data review$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
  await expect(page.getByLabel("Review sort")).toHaveValue("company");
  await expect(page.getByLabel("Search review observations")).toHaveValue("ABC");
});
