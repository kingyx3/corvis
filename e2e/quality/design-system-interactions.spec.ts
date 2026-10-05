import { expect, test } from "@playwright/test";

test("command palette combines keyboard navigation commands with entitled actions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: /workspace command palette/i });
  await expect(palette).toBeVisible();
  const input = palette.getByRole("combobox", { name: /search workspace or run a command/i });
  await input.fill("Portfolio analytics");
  await expect(palette.getByRole("option", { name: /portfolio analytics/i })).toBeVisible();
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: /^position financials$/i })).toBeVisible();

  await page.keyboard.press("Control+K");
  await expect(palette).toBeVisible();
  await input.fill("Upload documents");
  await expect(palette.getByRole("option", { name: /upload documents/i })).toBeVisible();
  await input.press("Enter");
  await expect(page.getByRole("dialog", { name: /upload documents/i })).toBeVisible();
});

test("position financials uses the shared keyboard-sortable table and density control", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^portfolio analytics$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^position financials$/i })).toBeVisible();

  const table = page.getByRole("table", { name: /position financials for/i });
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute("data-density", "compact");

  const sortButton = table.getByRole("button", { name: /sort by income statement/i });
  await sortButton.focus();
  await page.keyboard.press("Enter");
  await expect(sortButton.locator("xpath=ancestor::th")).toHaveAttribute("aria-sort", "ascending");
  await page.keyboard.press("Enter");
  await expect(sortButton.locator("xpath=ancestor::th")).toHaveAttribute("aria-sort", "descending");

  await page.getByRole("button", { name: "Comfortable" }).click();
  await expect(table).toHaveAttribute("data-density", "comfortable");
  await page.getByRole("button", { name: "Compact" }).click();
  await expect(table).toHaveAttribute("data-density", "compact");
});

test("portfolio analytics allocation chart exposes a table view", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^portfolio analytics$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^position financials$/i })).toBeVisible();

  const allocation = page.locator(".position-financials-chart-panel").filter({ has: page.getByRole("heading", { name: /workspace exposure by fund/i }) });
  await expect(allocation).toBeVisible();
  const details = allocation.locator(".chart-data-toggle");
  await details.locator("summary").click();
  await expect(details.getByRole("table")).toBeVisible();
  await expect(details.getByRole("table")).toContainText(/share/i);
});
