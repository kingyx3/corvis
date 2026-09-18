import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

function navButton(page, name) {
  return page.locator("nav").getByRole("button", { name: new RegExp(`^${name}` , "i") });
}

test("critical customer workflow is navigable in demo mode", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /^Good /i })).toBeVisible();

  await navButton(page, "Documents").click();
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await page.getByRole("button", { name: /upload documents/i }).first().click();
  await expect(page.getByRole("heading", { name: "Upload documents" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: "quarterly-report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\n% Corvis E2E") });
  await expect(page.getByText("Uploaded")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /view documents/i }).click();

  await navButton(page, "Data review").click();
  await expect(page.getByRole("heading", { name: "Data review" })).toBeVisible();
  await expect(page.getByText(/every value is traceable/i)).toBeVisible();

  await navButton(page, "Ask Corvis").click();
  await expect(page.getByRole("heading", { name: "Ask Corvis" })).toBeVisible();
  await page.getByPlaceholder(/ask about a fund/i).fill("What changed in my portfolio this quarter?");
  await page.getByRole("button", { name: "Ask Corvis" }).click();
  await expect(page.getByText(/Demo mode:/)).toBeVisible();
  await expect(page.getByText(/permission checked before retrieval/i)).toBeVisible();

  await navButton(page, "Administration").click();
  await expect(page.getByRole("heading", { name: "Workspace controls" })).toBeVisible();
});

test("main product views have no serious or critical automated accessibility violations", async ({ page }) => {
  await page.goto("/");
  const views = ["Overview", "Documents", "Data review", "Ask Corvis", "Administration"];
  for (const view of views) {
    if (view !== "Overview") await navButton(page, view).click();
    await page.waitForTimeout(100);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
    expect(blocking, `${view} accessibility violations: ${blocking.map((item) => `${item.id}: ${item.help}`).join("; ")}`).toEqual([]);
  }
});

test("workspace remains usable at tablet and mobile widths", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1100 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /^Good /i })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: /^Good /i })).toBeVisible();
});
