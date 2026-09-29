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

// Tablet/phone widths hide the sidebar section, so the rail/tab bar carries a Workspace button (#245).
test("the workspace switcher and tenant-admin link are reachable from the mobile navigation @matrix", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "admin"));
  await page.goto("/");
  const open = page.getByRole("button", { name: "Workspace and access" });
  await expect(open).toBeVisible();
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Workspace and access" });
  await expect(dialog.getByRole("combobox", { name: "Current workspace" })).toHaveValue("demo-workspace");
  await expect(dialog.getByRole("link", { name: /audit, bulk onboarding/i })).toHaveAttribute("href", "/access-self-service");
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test("the mobile Workspace button stays out of the desktop sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Current workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Workspace and access" })).toBeHidden();
});
