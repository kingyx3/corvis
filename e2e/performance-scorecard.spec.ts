import { expect, test, type Page } from "@playwright/test";

async function openScorecard(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /^portfolio analytics$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^position financials$/i })).toBeVisible();
  await page.getByRole("button", { name: /^performance scorecard$/i }).click();
  await expect(page.getByRole("heading", { name: /^performance scorecard$/i })).toBeVisible();
  await expect(page.getByRole("region", { name: /fund performance table/i })).toBeVisible();
}

function fundRow(page: Page, fund: string) {
  return page.getByRole("region", { name: /fund performance table/i }).getByRole("row").filter({ has: page.getByRole("button", { name: new RegExp(`^${fund}`, "i") }) });
}

test("Portfolio analytics keeps Position financials as its default lens and offers the scorecard without a new navigation entry", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^portfolio analytics$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^position financials$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^position financials$/i })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^performance scorecard$/i })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("navigation", { name: /workspace sections/i }).getByRole("button", { name: /scorecard/i })).toHaveCount(0);
  await page.getByRole("button", { name: /^performance scorecard$/i }).click();
  await expect(page.getByRole("heading", { name: /^performance scorecard$/i })).toBeVisible();
  await page.getByRole("button", { name: /^position financials$/i }).click();
  await expect(page.getByRole("heading", { name: /^position financials$/i })).toBeVisible();
});

test("the fund table shows each entitled fund's latest GP-reported metrics with as-of date and flag, and Not reported instead of 0", async ({ page }) => {
  await openScorecard(page);
  const table = page.getByRole("region", { name: /fund performance table/i });
  await expect(table.getByRole("columnheader")).toContainText(["Fund", "NAV", "TVPI", "DPI", "RVPI", "Net IRR", "Net MOIC"]);
  for (const fund of ["Advent International GPE VIII", "EQT IX", "Hg Genesis 9", "Nordic Capital Fund V"]) await expect(fundRow(page, fund)).toHaveCount(1);

  const advent = fundRow(page, "Advent International GPE VIII");
  await expect(advent).toContainText("USD 1,958,000,000");
  await expect(advent).toContainText("1.62x");
  await expect(advent).toContainText("14.2%");
  await expect(advent).toContainText("As of 30 Jun 2026");
  await expect(advent).toContainText("As of 31 Mar 2026");
  await expect(advent.getByText("Final").first()).toBeVisible();
  await expect(advent).not.toContainText("USD 1,903,000,000");

  const nordic = fundRow(page, "Nordic Capital Fund V");
  await expect(nordic.getByText("Not reported")).toHaveCount(6);
  await expect(nordic).not.toContainText(/\b0(\.0+)?x?\b/);
});

test("every flag is shown: Final, Preliminary, Restated and Derived; a currency is never merged or converted", async ({ page }) => {
  await openScorecard(page);
  const eqt = fundRow(page, "EQT IX");
  await expect(eqt.getByText("Restated")).toBeVisible();
  await expect(eqt.getByText("Preliminary")).toBeVisible();
  await expect(eqt).toContainText("11.8%");
  await expect(eqt.getByText("Not reported")).toHaveCount(2);

  const hg = fundRow(page, "Hg Genesis 9");
  await expect(hg.getByText("Derived")).toBeVisible();
  await expect(hg).toContainText("USD 719 millions");
  await expect(hg).toContainText("EUR 664 millions");
  await expect(hg).toContainText("NM");
  await expect(hg).not.toContainText(/USD 1,[0-9]{3}/);
});

test("expanding a fund lists its underlying investments with their own metrics, flags and Not reported", async ({ page }) => {
  await openScorecard(page);
  const toggle = page.getByRole("button", { name: /^advent international gpe viii/i });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const investments = page.getByRole("region", { name: /underlying investments of advent international gpe viii/i });
  await expect(investments.getByRole("columnheader")).toContainText(["Investment", "Cost", "Fair value", "Gross MOIC", "Gross IRR", "Ownership"]);
  const abc = investments.getByRole("row").filter({ hasText: "ABC Corp" });
  await expect(abc).toContainText("USD 450,000,000");
  await expect(abc).toContainText("USD 702,000,000");
  await expect(abc).not.toContainText("USD 676,000,000");
  await expect(abc).toContainText("1.56x");
  await expect(abc).toContainText("18.4%");
  await expect(abc).toContainText("12.5%");
  await expect(abc).toContainText("As of 30 Jun 2026");
  await expect(investments.getByRole("row").filter({ hasText: "Atlas Industrial" }).getByText("Preliminary")).toBeVisible();
  await expect(investments.getByRole("row").filter({ hasText: "Harbor Logistics" }).getByText("Restated")).toBeVisible();
  await expect(investments.getByRole("row").filter({ hasText: "Harbor Logistics" }).getByText("Not reported")).toHaveCount(3);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(investments).toHaveCount(0);

  await page.getByRole("region", { name: /fund performance table/i }).getByRole("button", { name: /^nordic capital fund v/i }).click();
  await expect(page.getByText(/no underlying investments have a published figure for nordic capital fund v/i)).toBeVisible();
});

test("both tables sort by any column", async ({ page }) => {
  await openScorecard(page);
  const funds = page.getByRole("region", { name: /fund performance table/i });
  const fundOrder = async () => (await funds.locator(".scorecard-fund-name").allTextContents()).map((text) => text.trim());
  expect(await fundOrder()).toEqual(["Advent International GPE VIII", "EQT IX", "Hg Genesis 9", "Nordic Capital Fund V"]);
  const sortByFund = funds.getByRole("button", { name: /^sort by fund/i });
  await sortByFund.click();
  await sortByFund.click();
  expect((await fundOrder())[0]).toBe("Nordic Capital Fund V");
  // NAV at its stated scale: Advent (USD 1,958,000,000) above EQT (1,271,000,000) above Hg (USD 719 millions); no figure sorts last.
  await funds.getByRole("button", { name: /^sort by nav/i }).click();
  await funds.getByRole("button", { name: /^sort by nav/i }).click();
  expect(await fundOrder()).toEqual(["Advent International GPE VIII", "EQT IX", "Hg Genesis 9", "Nordic Capital Fund V"]);
  await expect(funds.getByRole("columnheader", { name: /nav/i })).toHaveAttribute("aria-sort", "descending");
  await funds.getByRole("button", { name: /^sort by nav/i }).click();
  expect((await fundOrder())[0]).toBe("Hg Genesis 9");

  await page.getByRole("button", { name: /^advent international gpe viii/i }).click();
  const investments = page.getByRole("region", { name: /underlying investments of advent international gpe viii/i });
  const investmentOrder = async () => (await investments.getByRole("rowheader").allTextContents()).map((text) => text.trim());
  expect(await investmentOrder()).toEqual(["ABC Corp", "Atlas Industrial", "Harbor Logistics", "Meridian Software"]);
  await investments.getByRole("button", { name: /^sort by fair value/i }).click();
  await investments.getByRole("button", { name: /^sort by fair value/i }).click();
  expect(await investmentOrder()).toEqual(["ABC Corp", "Meridian Software", "Atlas Industrial", "Harbor Logistics"]);
  await investments.getByRole("button", { name: /^sort by ownership/i }).click();
  expect(await investmentOrder()).toEqual(["Meridian Software", "ABC Corp", "Atlas Industrial", "Harbor Logistics"]);
});

test("one click on any figure opens its source document at the reported page", async ({ page }) => {
  await openScorecard(page);
  await page.getByRole("button", { name: /open source document for advent international gpe viii, nav: usd 1,958,000,000/i }).click();
  const drawer = page.getByRole("dialog", { name: /document details for advent international gpe viii — q2 2026\.pdf/i });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /original source document/i })).toBeVisible();
  await expect(drawer).toContainText("Page 4");
});

test("an investment-level figure drills through to its own source page", async ({ page }) => {
  await openScorecard(page);
  await page.getByRole("button", { name: /^advent international gpe viii/i }).click();
  await page.getByRole("button", { name: /open source document for abc corp in advent international gpe viii, fair value/i }).click();
  const drawer = page.getByRole("dialog", { name: /document details for advent international gpe viii/i });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Page 52");
});

test("Export this view goes through the governed export pipeline and appears in Data delivery history", async ({ page }) => {
  await openScorecard(page);
  await page.getByRole("button", { name: /^export this view$/i }).click();
  await expect(page.getByRole("status").filter({ hasText: /governed csv requested/i })).toBeVisible();
  await page.getByRole("button", { name: /^data delivery$/i }).first().click();
  await expect(page.getByRole("heading", { name: /deliver structured data/i })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: /performance scorecard · all entitled funds/i }).first()).toBeVisible();
});

test("a transient scorecard failure offers Retry and recovers", async ({ page }) => {
  let failing = true;
  await page.route("**/api/v1/performance-scorecard**", (route) => failing
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) })
    : route.continue());
  await page.goto("/");
  await page.getByRole("button", { name: /^portfolio analytics$/i }).first().click();
  await page.getByRole("button", { name: /^performance scorecard$/i }).click();
  const unavailable = page.getByRole("alert").filter({ hasText: /performance scorecard unavailable/i });
  await expect(unavailable).toBeVisible();
  failing = false;
  await unavailable.getByRole("button", { name: /^retry$/i }).click();
  await expect(unavailable).toHaveCount(0);
  await expect(page.getByRole("region", { name: /fund performance table/i })).toBeVisible();
});

test("a read-only viewer sees the figures but no drill-through and no export", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "read_only"));
  await openScorecard(page);
  await expect(page.getByText(/source documents restricted/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /open source document for/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^export this view$/i })).toHaveCount(0);
  await expect(fundRow(page, "Advent International GPE VIII")).toContainText("USD 1,958,000,000");
});

test("a drill-through from Data review lands on Position financials even when the scorecard was the last lens", async ({ page }) => {
  await openScorecard(page);
  await page.getByRole("button", { name: /^data review$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
  await page.getByRole("button", { name: /view position financials/i }).first().click();
  await expect(page.getByRole("heading", { name: /^position financials$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^position financials$/i })).toHaveAttribute("aria-pressed", "true");
});
