import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { accessibilityBudget } from "./quality-budgets.ts";

// Email notification settings (#258): reachable from the sidebar, the command palette and the
// ?notifications=settings link every optional email carries; accessible in both themes; mandatory
// security notices cannot be switched off; and delivery status is stated honestly.

async function blockingViolations(page: Page, include: string) {
  const results = await new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]).include(include).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

async function openFromSidebar(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  const settingsButton = page.getByRole("button", { name: /^notification settings$/i }).filter({ visible: true });
  // At phone widths the sidebar footer is hidden; the same entry lives in the "Workspace and access" dialog.
  if (await settingsButton.count() === 0) await page.getByRole("button", { name: "Workspace and access" }).click();
  await settingsButton.first().click();
  const dialog = page.getByRole("dialog", { name: "Notification settings" });
  await expect(dialog.getByRole("list", { name: "Notification categories" })).toBeVisible();
  return dialog;
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`notification settings dialog passes axe in ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openFromSidebar(page);
    const violations = await blockingViolations(page, '[role="dialog"]');
    expect(violations.map((violation) => `${violation.impact}/${violation.id}: ${violation.help}`)).toEqual([]);
  });
}

test("security notices are always on, optional categories save, and delivery status is honest", async ({ page }) => {
  const dialog = await openFromSidebar(page);
  await expect(dialog.getByText("Email delivery isn’t switched on yet").or(dialog.getByText("Email delivery isn't switched on yet"))).toBeVisible();
  const roleChanged = dialog.getByRole("listitem").filter({ hasText: "Your access changed" });
  await expect(roleChanged.getByText("Always on")).toBeVisible();
  await expect(roleChanged.getByRole("checkbox")).toHaveCount(0);

  const exportReady = dialog.getByRole("listitem").filter({ hasText: "Export ready" });
  const checkbox = exportReady.getByRole("checkbox", { name: /email me about export ready/i });
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(exportReady.getByRole("combobox", { name: /when to email about export ready/i })).toBeDisabled();

  const saved = page.waitForRequest((request) => request.url().endsWith("/api/v1/notification-preferences") && request.method() === "PUT");
  await dialog.getByRole("button", { name: "Save settings" }).click();
  const body = (await saved).postDataJSON() as { categories: Array<{ id: string; enabled: boolean }> };
  expect(body.categories.find((category) => category.id === "export_ready")?.enabled).toBe(false);
  expect(body.categories.some((category) => category.id === "role_changed")).toBe(false);
  await expect(dialog).toBeHidden();
});

test("clicking the backdrop over an edited dialog keeps focus inside it so Escape only dismisses the prompt", async ({ page }) => {
  const dialog = await openFromSidebar(page);
  const exportReady = dialog.getByRole("listitem").filter({ hasText: "Export ready" });
  await exportReady.getByRole("checkbox", { name: /email me about export ready/i }).uncheck();
  // A click outside the dialog surface (top-left corner of the viewport is backdrop).
  await page.mouse.click(2, 2);
  const keepEditing = dialog.getByRole("button", { name: "Keep editing" });
  await expect(keepEditing).toBeVisible();
  await expect(keepEditing).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(keepEditing).toBeHidden();
  await expect(dialog).toBeVisible();
});

test("the settings link in emails opens the dialog and a failed save is reported", async ({ page }) => {
  await page.goto("/?notifications=settings");
  const dialog = page.getByRole("dialog", { name: "Notification settings" });
  await expect(dialog.getByRole("list", { name: "Notification categories" })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("notifications")).toBe(false);

  await page.route("**/api/v1/notification-preferences", (route) => route.request().method() === "PUT"
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporarily_unavailable" }) })
    : route.fallback());
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog).toBeVisible();
});

test("the command palette opens notification settings", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.getByRole("button", { name: /search workspace or run a command/i }).click();
  await page.getByRole("combobox", { name: /search workspace or run a command/i }).fill("notification");
  await page.getByRole("option", { name: /notification settings/i }).click();
  await expect(page.getByRole("dialog", { name: "Notification settings" })).toBeVisible();
});

test("Tab and Shift+Tab stay inside the dialog after dismissing the discard prompt @matrix", async ({ page }) => {
  const dialog = await openFromSidebar(page);
  await dialog.getByRole("checkbox", { name: /email me about export ready/i }).uncheck();
  await page.mouse.click(2, 2);
  await expect(dialog.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await dialog.focus();
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
});
