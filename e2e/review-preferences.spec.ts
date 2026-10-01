import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
async function review(page: import("@playwright/test").Page) { await page.goto("/"); await page.getByRole("button", { name: /^data review$/i }).first().click(); }
test("exception explanation opens an editable, subject-scoped draft without sending it @matrix", async ({ page }) => {
  await review(page); await page.getByRole("button", { name: "Explain with Ask Corvis" }).click();
  const input = page.getByRole("textbox", { name: "Ask Corvis a question" }); await expect(input).toHaveValue(/company-northstar-health.*fund-nordic-v.*Q2 2026/);
  await expect(page.getByText(/Demo response for:/)).toHaveCount(0); await input.fill("Explain fair value for Northstar Health in Q2 2026");
  await page.getByRole("button", { name: "Send question" }).click(); await expect(page.getByText(/Demo response for: Explain fair value/)).toBeVisible();
});
test("resolution shows historical table and competing values without changing the resolution action @matrix", async ({ page }) => {
  await review(page); await page.getByLabel(/Authoritative source for/).selectOption({ index: 1 }); await page.getByRole("button", { name: "Select authoritative source", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resolve reconciliation exception" }); await expect(dialog.getByText(/Competing value 1/)).toBeVisible();
  await dialog.getByText(/View as table/).click(); await expect(dialog.getByRole("table")).toContainText("Q4 2025"); await expect(dialog.getByRole("table")).toContainText("Restated");
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze(); expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
  await dialog.getByRole("button", { name: "Resolve exception", exact: true }).click(); await expect(page.getByText(/Reconciliation exception resolved/i)).toBeVisible();
});
test("Review and Research open the exact original through the shared document path @matrix", async ({ page }) => {
  await page.route("**/api/v1/source-references/*/document", (route) => route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\nOriginal fixture" }));
  await review(page); await page.getByRole("region", { name: "Reconciliation exceptions table" }).getByRole("button", { name: "Page 52" }).first().click();
  await page.getByRole("button", { name: "Open full document" }).click(); const drawer = page.getByRole("dialog", { name: /Document details/ });
  await expect(drawer.getByRole("link", { name: "Open original PDF" })).toHaveAttribute("href", /#page=52$/); await drawer.getByRole("button", { name: "Close document details" }).click();
  await page.getByRole("button", { name: /^ask corvis$/i }).first().click(); await page.getByRole("textbox", { name: "Ask Corvis a question" }).fill("Revenue?"); await page.getByRole("button", { name: "Send question" }).click();
  await page.getByRole("button", { name: "Open entitled source" }).click(); await page.getByRole("button", { name: "Open full document" }).click(); await expect(page.getByRole("dialog", { name: /Document details/ }).getByRole("link", { name: "Open original PDF" })).toHaveAttribute("href", /#page=18$/);
});
for (const screen of ["Documents", "Data review", "Portfolio analytics"]) {
  test(`${screen} saves a named shared layout and restores its default after reload @matrix`, async ({ page }) => {
    await page.goto("/"); await page.getByRole("button", { name: screen, exact: true }).first().click();
    if (screen === "Documents") await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("Advent");
    if (screen === "Data review") await page.getByLabel("Review sort", { exact: true }).selectOption("confidence");
    if (screen === "Portfolio analytics") await page.getByRole("button", { name: "Δ %", exact: true }).click();
    await page.getByRole("button", { name: "Save view", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Save view", exact: true });
    await dialog.getByLabel("View name").fill("Quarter close"); await dialog.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByLabel("Saved view", { exact: true }).selectOption({ label: "Quarter close · shared" }); await page.getByRole("button", { name: "Make default" }).click(); await expect(page.getByRole("button", { name: "Clear default" })).toBeVisible();
    await page.reload(); await expect(page.getByLabel("Saved view", { exact: true })).toHaveValue(/.+/);
    if (screen === "Documents") await expect(page.getByRole("textbox", { name: "Search documents", exact: true })).toHaveValue("Advent");
    if (screen === "Data review") await expect(page.getByLabel("Review sort", { exact: true })).toHaveValue("confidence");
    if (screen === "Portfolio analytics") await expect(page.getByRole("button", { name: "Δ %", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Rename view" }).click(); await page.getByRole("dialog").getByLabel("View name").fill("Renamed view"); await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Delete view", exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: "Delete view", exact: true }).click(); await expect(page.getByRole("option", { name: /Renamed view/ })).toHaveCount(0);
  });
}
for (const colorScheme of ["light", "dark"] as const) test(`display preferences preserve calendar dates and pass accessibility in ${colorScheme} theme @matrix`, async ({ page }) => {
  await page.emulateMedia({ colorScheme }); await page.goto("/"); await page.getByRole("button", { name: "Search workspace or run a command" }).click(); await page.getByRole("combobox", { name: "Search workspace or run a command" }).fill("display preferences"); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Display preferences" }); await dialog.getByLabel("Time zone", { exact: true }).selectOption("America/Los_Angeles"); await dialog.getByLabel("Date format", { exact: true }).selectOption("iso"); await dialog.getByLabel("Number format", { exact: true }).selectOption("de-DE"); await expect(dialog.getByRole("status")).toContainText("2026-09-30 · 1.234,5");
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze(); expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
  await dialog.getByRole("button", { name: "Save preferences" }).click(); await page.getByRole("button", { name: "Portfolio analytics", exact: true }).first().click(); await expect(page.getByText(/As of 2026-09-30/).first()).toBeVisible(); await page.reload(); await page.getByRole("button", { name: "Display preferences", exact: true }).first().click(); await expect(page.getByRole("dialog").getByLabel("Number format", { exact: true })).toHaveValue("de-DE");
});
