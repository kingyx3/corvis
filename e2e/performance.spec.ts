import { expect, test } from "@playwright/test";
import { activeBudget } from "./quality-budgets.ts";
import { openSurface, surfaces } from "./support/surfaces.ts";

// Deliberately generous, version-controlled ceilings (see docs/QUALITY_BUDGETS.md). These exist to
// catch a hang or an order-of-magnitude regression, not to police day-to-day runner jitter.
const budget = activeBudget();

test("initial navigation to the workspace completes within budget", async ({ page }) => {
  const start = Date.now();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  expect(Date.now() - start).toBeLessThan(budget.navigationMs);
});

for (const surface of surfaces.filter((entry) => entry.nav)) {
  test(`switching to the ${surface.label} surface completes within budget`, async ({ page }) => {
    if (surface.role) await page.addInitScript((role) => window.sessionStorage.setItem("corvis:demo:role", role), surface.role);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();

    const start = Date.now();
    await openSurface(page, surface);
    await expect(page.getByRole("heading", { name: surface.heading }).first()).toBeVisible();
    expect(Date.now() - start).toBeLessThan(budget.surfaceSwitchMs);
  });
}

test("any workspace read API call on initial load responds within budget", async ({ page }) => {
  // The default CI/local target runs the demo composition (CORVIS_DEMO_MODE=true), whose
  // workspace port is served entirely client-side with no /api/v1/* network traffic. This
  // assertion is only exercised against real API calls, which CORVIS_E2E_TARGET=production makes.
  const timings: number[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/v1/")) return;
    const timing = response.request().timing();
    if (timing.responseEnd >= 0) timings.push(timing.responseEnd);
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();

  for (const elapsed of timings) expect(elapsed).toBeLessThan(budget.workspaceApiMs);
});

test("the workspace shell stays within its DOM-size and network-transfer budget", async ({ page }) => {
  let scriptRequestCount = 0;
  let scriptTransferBytes = 0;
  page.on("response", async (response) => {
    const headers = response.headers();
    if (!(headers["content-type"] ?? "").includes("javascript")) return;
    scriptRequestCount += 1;
    scriptTransferBytes += Number(headers["content-length"] ?? 0);
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();

  const domNodeCount = await page.evaluate(() => document.querySelectorAll("*").length);
  expect(domNodeCount).toBeLessThan(budget.documentDomNodes);
  expect(scriptRequestCount).toBeLessThan(budget.scriptRequestCount);
  // Some dev-mode script responses omit content-length; treat that as "unknown" rather than zero
  // by only asserting the budget when at least one script actually reported a size.
  if (scriptTransferBytes > 0) expect(scriptTransferBytes).toBeLessThan(budget.scriptTransferBytes);
});

test("the workspace shell never introduces horizontal page scroll at desktop width", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(budget.maxHorizontalOverflowPx);
});
