import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Not tagged @matrix: .sidebar-section (and this switcher) is display:none at or below
// 960px width, so this UI doesn't exist on the mobile-chromium project's viewport.
test("workspace switching resets data, permissions and search state and survives reload", async ({ page }) => {
  await page.goto("/");
  const selector = page.getByRole("combobox", { name: "Current workspace" });
  await expect(selector).toHaveValue("demo-workspace");
  await page.getByRole("button", { name: "Data review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Data review", exact: true })).toBeVisible();
  await selector.selectOption("demo-secondary");
  await expect(page.getByRole("combobox", { name: "Current workspace" })).toHaveValue("demo-secondary");
  await expect(page.getByRole("button", { name: "Data review", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Data delivery", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(page.locator(".document-name")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Current workspace" })).toHaveValue("demo-secondary");
  await page.getByRole("combobox", { name: "Current workspace" }).selectOption("demo-workspace");
  await expect(page.getByRole("button", { name: "Data review", exact: true })).toBeVisible();
});

test("workspace selector and access management dialog pass accessibility checks", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "admin"));
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Current workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Access administration", exact: true }).click();
  await page.getByRole("button", { name: "Change Primary Workspace role for jordan.lee@example.test", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Manage workspace role" });
  await dialog.getByLabel("New workspace role").selectOption("");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Change Primary Workspace role for jordan.lee@example.test", exact: true })).toBeFocused();
});
