import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { accessibilityBudget } from "./quality-budgets.ts";
import { openSurface, surfaces } from "./support/surfaces.ts";

type Violation = { id: string; impact?: string | null; help: string; nodes: Array<{ target: unknown[] }> };

async function blockingViolations(page: Page, include?: string): Promise<Violation[]> {
  const builder = new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]);
  const results = await (include ? builder.include(include) : builder).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

function describe(violations: Violation[]): string {
  return violations.map((violation) => `${violation.impact}/${violation.id}: ${violation.help} (${violation.nodes.length} node(s), first: ${JSON.stringify(violation.nodes[0]?.target)})`).join("\n");
}

for (const surface of surfaces) {
  test(`${surface.label} surface has no serious or critical accessibility violations @matrix`, async ({ page }) => {
    if (surface.role) await page.addInitScript((role) => window.sessionStorage.setItem("corvis:demo:role", role), surface.role);
    await page.goto("/");
    await openSurface(page, surface);
    await expect(page.getByRole("heading", { name: surface.heading }).first()).toBeVisible();
    const violations = await blockingViolations(page);
    expect(violations, describe(violations)).toEqual([]);
  });
}

test("admin console has no serious or critical accessibility violations @matrix", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: /admin console/i })).toBeVisible();
  const violations = await blockingViolations(page);
  expect(violations, describe(violations)).toEqual([]);
  const unnamed = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((element) => element.offsetParent !== null).filter((element) => {
    const explicit = element.getAttribute("aria-label") || element.getAttribute("title");
    const associated = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent : "";
    const wrapping = element.closest("label")?.textContent;
    return !(explicit || associated || wrapping || element.textContent || "").trim();
  }).map((element) => element.outerHTML.slice(0, 140)));
  expect(unnamed, unnamed.join("\n")).toEqual([]);
});

test("admin destructive confirmation shows the exact endpoint, focuses Cancel and is accessible", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: /admin console/i })).toBeVisible();
  const deletion = page.locator("section").filter({ has: page.getByRole("heading", { name: "Retention-aware deletion" }) });
  await deletion.getByRole("combobox", { name: /^action/i }).selectOption("execute");
  await deletion.getByRole("textbox", { name: /deletion request id/i }).fill("req-2026-0042");
  const trigger = deletion.getByRole("button", { name: /review change/i });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /confirm retention-aware deletion/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: /confirm destructive change/i })).toBeVisible();
  await expect(dialog.getByText("POST /api/v1/admin/deletion-requests/req-2026-0042/execute", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^cancel$/i })).toBeFocused();
  const violations = await blockingViolations(page, '[role="dialog"]');
  expect(violations, describe(violations)).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("upload dialog has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await page.getByRole("button", { name: /upload documents/i }).first().click();
  await expect(page.getByRole("dialog", { name: /upload documents/i })).toBeVisible();
  const violations = await blockingViolations(page, '[role="dialog"]');
  expect(violations, describe(violations)).toEqual([]);
});

test("workspace exposes the expected semantic landmarks and a single top-level heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await expect(page.getByRole("navigation", { name: /workspace sections/i })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("complementary", { name: /workspace navigation/i })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  const currentItems = page.locator('nav [aria-current="page"]');
  await expect(currentItems).toHaveCount(1);
  await expect(currentItems).toHaveText(/overview/i);
});

test("primary navigation is reachable and operable by keyboard alone", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  const navButtons = page.getByRole("navigation", { name: /workspace sections/i }).getByRole("button");
  await expect(navButtons).toHaveCount(6);
  await navButtons.first().focus();
  const labels: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    labels.push(((await page.evaluate(() => document.activeElement?.textContent ?? "")) || "").trim());
    if (index < 5) await page.keyboard.press("Tab");
  }
  expect(labels.map((item) => item.replace(/\d+$/, "").toLowerCase())).toEqual(["overview","portfolio analytics","documents","data review","data delivery","ask corvis"]);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /^ask corvis$/i })).toBeVisible();
  await expect(page.locator('nav [aria-current="page"]')).toHaveText(/ask corvis/i);
});

test("every focusable control in the workspace shell exposes an accessible name", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  const unnamed = await page.evaluate(() => {
    const selector = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((element) => element.offsetParent !== null).filter((element) => {
      const label = (element.getAttribute("aria-label") || element.textContent || element.getAttribute("title") || "").trim();
      return label.length === 0;
    }).map((element) => element.outerHTML.slice(0, 120));
  });
  expect(unnamed, unnamed.join("\n")).toEqual([]);
});

test("the upload dialog traps focus and restores it on close", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  const trigger = page.getByRole("button", { name: /upload documents/i }).first();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /upload documents/i });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(async () => { const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')); expect(inside).toBe(true); }).toPass();
  for (let index = 0; index < 8; index += 1) { await page.keyboard.press("Tab"); const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')); expect(inside, `focus escaped the modal after ${index + 1} Tab press(es)`).toBe(true); }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
