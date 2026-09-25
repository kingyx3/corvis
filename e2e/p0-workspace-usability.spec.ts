import { expect, test } from "@playwright/test";

test("overview makes attention state immediately visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview · (all caught up|\d+ reporting periods? needs? attention)/i })).toBeVisible();
  await expect(page.getByRole("region", { name: /workspace metrics ordered for/i })).toBeVisible();

  const reviewNow = page.getByRole("button", { name: /review now/i });
  if (await reviewNow.count()) {
    await reviewNow.click();
    await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
  }
});

test("position financials exposes period change controls and trust guidance", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /portfolio analytics/i }).first().click();
  await expect(page.getByRole("heading", { name: /position financials/i })).toBeVisible();
  const deltaGroup = page.getByRole("group", { name: /period-over-period change display/i });
  await expect(deltaGroup.getByRole("button", { name: "Δ value" })).toBeVisible();
  await expect(deltaGroup.getByRole("button", { name: "Δ %" })).toBeVisible();
  await expect(deltaGroup.getByRole("button", { name: "Δ both" })).toHaveAttribute("aria-pressed", "true");
  await deltaGroup.getByRole("button", { name: "Δ %" }).click();
  await expect(deltaGroup.getByRole("button", { name: "Δ %" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/each reported value shows its governed as-of\/trust state/i)).toBeVisible();
});
