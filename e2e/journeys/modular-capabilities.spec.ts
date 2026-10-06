import { test, expect } from "@playwright/test";

test("fund analytics remains usable when portfolio attribution is disabled", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:feature:portfolio_attribution", "disabled"));
  const portfolioRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/portfolios") portfolioRequests.push(request.url());
  });

  await page.goto("/");
  // The view's data request is issued in the same effect pass that would request portfolios, so
  // once it has responded, an unwanted portfolios request would already have been sent.
  const positionsLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/position-financials");
  await page.getByRole("button", { name: /portfolio analytics/i }).first().click();
  await expect(page.getByRole("heading", { name: /position financials/i })).toBeVisible();
  await expect(page.getByText(/portfolio attribution is not required/i)).toBeVisible();
  await expect(page.getByRole("combobox", { name: /portfolio/i })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: /position/i })).toHaveCount(1);
  await positionsLoaded;
  expect(portfolioRequests).toHaveLength(0);
});
