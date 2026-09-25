import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { accessibilityBudget } from "./quality-budgets.ts";

// Per the UX architecture, Overview must render fundamentally different
// priority content per role, not the same dashboard reordered: allocators
// see exposure first, Review Analysts see the review queue first, and
// administrators see tenant-wide platform health first (issue #175 A1).

test("an administrator sees a platform-health panel first, not just a reordered queue", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "admin"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();

  const healthPanel = page.getByRole("heading", { name: /fund periods by status/i });
  await expect(healthPanel).toBeVisible();
  // The health panel must precede the per-user metric grid in document order.
  const metricsRegion = page.getByRole("region", { name: /workspace metrics ordered for admin workflow/i });
  await expect(metricsRegion).toBeVisible();
  const order = await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("h3")).find((element) => /fund periods by status/i.test(element.textContent ?? ""));
    const metrics = document.querySelector('[aria-label*="workspace metrics ordered for admin workflow" i]');
    if (!heading || !metrics) return null;
    return heading.compareDocumentPosition(metrics) & Node.DOCUMENT_POSITION_FOLLOWING ? "health-first" : "metrics-first";
  });
  expect(order).toBe("health-first");

  const results = await new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]).analyze();
  const blocking = results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});

test("a Review Analyst's Overview leads with the needs-attention metric, but no platform-health panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /fund periods by status/i })).toHaveCount(0);
  const metricsRegion = page.getByRole("region", { name: /workspace metrics ordered for review workflow/i });
  await expect(metricsRegion).toBeVisible();
  await expect(metricsRegion.getByText("Needs attention")).toBeVisible();
});

test("a read-only allocator's Overview has neither the review-first ordering nor a platform-health panel", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "read_only"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /fund periods by status/i })).toHaveCount(0);
  await expect(page.getByRole("region", { name: /workspace metrics ordered for allocator workflow/i })).toBeVisible();
});
