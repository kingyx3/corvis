import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { accessibilityBudget } from "./quality-budgets.ts";

// Issue #175 A3/A4/A5/A6/A7/A9: the Overview leads with one unified, ranked
// attention count, charts published value and exposure, flags freshness, and
// drills every item through to its evidence screen in one click.

test("the needs-attention headline, card and ranked list agree and each item deep-links", async ({ page }) => {
  await page.goto("/");
  const heading = page.getByRole("heading", { level: 1, name: /reporting overview · (\d+) items? needs? attention/i });
  await expect(heading).toBeVisible();
  const headline = Number(/· (\d+)/.exec((await heading.textContent()) ?? "")?.[1]);

  const attention = page.getByRole("region", { name: /most urgent first/i });
  await expect(attention).toBeVisible();
  const rows = attention.getByRole("listitem");
  expect(await rows.count()).toBeGreaterThanOrEqual(3);

  const metrics = page.getByRole("region", { name: /workspace metrics ordered for/i });
  await expect(metrics.getByRole("button", { name: /needs attention/i })).toContainText(String(headline));

  // A blocking or high-severity review item opens Data review.
  await attention.getByRole("button", { name: /observations? needs? review/i }).first().click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();

  // The stuck document opens its document drawer.
  await page.getByRole("button", { name: /^overview$/i }).first().click();
  await page.getByRole("region", { name: /most urgent first/i }).getByRole("button", { name: /document/i }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("value trend and exposure are charted from published periods and drill through to evidence", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /published portfolio value/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /exposure by fund/i })).toBeVisible();
  await expect(page.getByText(/as of .* · published \(final\) data only/i)).toBeVisible();

  const exposure = page.getByRole("list", { name: /exposure by fund, drill through to evidence/i });
  const funds = exposure.getByRole("button");
  await expect(funds).toHaveCount(3);
  // Nordic Capital Fund V is still in review, so it has no published exposure.
  await expect(exposure).not.toContainText("Nordic Capital Fund V");
  await funds.first().click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();

  const results = await new AxeBuilder({ page: await page.goto("/").then(() => page) }).withTags([...accessibilityBudget.tags]).analyze();
  const blocking = results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});

test("administrators additionally see unhealthy sources on the attention surface", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "admin"));
  await page.goto("/");
  await expect(page.getByRole("region", { name: /most urgent first/i }).getByText(/source connection/i)).toBeVisible();
});

test("exposure breaks down by governed asset type and GP-reported sector, reconciling to the total", async ({ page }) => {
  await page.goto("/");
  const breakdowns = page.getByRole("region", { name: /exposure breakdowns/i });
  await expect(breakdowns.getByRole("heading", { name: /exposure by asset type/i })).toBeVisible();
  await expect(breakdowns.getByRole("heading", { name: /exposure by sector/i })).toBeVisible();
  await expect(breakdowns.getByText(/common equity/i).first()).toBeVisible();
  await expect(breakdowns.getByText(/healthcare/i).first()).toBeVisible();
  await expect(breakdowns.getByText(/rows sum exactly to the .* exposure total/i).first()).toBeVisible();
});

test("a reviewer classifies an unclassified company and the sector breakdown picks it up", async ({ page }) => {
  await page.goto("/");
  const breakdowns = page.getByRole("region", { name: /exposure breakdowns/i });
  await expect(breakdowns.getByRole("heading", { name: /exposure by sector/i })).toBeVisible();
  await expect(breakdowns.getByText(/in companies not yet classified/i)).toBeVisible();

  await breakdowns.getByRole("button", { name: /classify companies/i }).click();
  const dialog = page.getByRole("dialog", { name: /classify portfolio companies by sector/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: /sector for project sparrow/i }).selectOption("consumer_staples");
  await dialog.getByRole("button", { name: /save sector for project sparrow/i }).click();
  await expect(dialog.getByRole("status")).toContainText(/project sparrow classified as consumer staples/i);

  const results = await new AxeBuilder({ page }).include('[role="dialog"]').withTags([...accessibilityBudget.tags]).analyze();
  const blocking = results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);

  await dialog.getByRole("button", { name: /^done$/i }).click();
  await expect(breakdowns.getByText(/consumer staples/i).first()).toBeVisible();
});

test("viewers see the sector breakdown but cannot classify companies", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "read_only"));
  await page.goto("/");
  const breakdowns = page.getByRole("region", { name: /exposure breakdowns/i });
  await expect(breakdowns.getByRole("heading", { name: /exposure by sector/i })).toBeVisible();
  await expect(breakdowns.getByRole("button", { name: /classify companies/i })).toHaveCount(0);
});
