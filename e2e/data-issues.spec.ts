import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { accessibilityBudget } from "./quality-budgets.ts";
import { openSurface, surfaces } from "./support/surfaces.ts";

// Data issues (F5, #261). The demo composition serves /api/v1/data-issues from an in-memory store seeded per demo tenant
// and subject, so every test pins its own tenant: a report or a status change in one test can never leak into another.

type Violation = { id: string; impact?: string | null; help: string; nodes: Array<{ target: unknown[] }> };

async function blockingViolations(page: Page, include?: string): Promise<Violation[]> {
  const builder = new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]);
  const results = await (include ? builder.include(include) : builder).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

function describe(violations: Violation[]): string {
  return violations.map((violation) => `${violation.impact}/${violation.id}: ${violation.help} (${violation.nodes.length} node(s), first: ${JSON.stringify(violation.nodes[0]?.target)})`).join("\n");
}

const issues = surfaces.find((surface) => surface.id === "issues")!;

// The dev server compiles each route on first use and may reset module-level demo state while it does; touching every route
// once up front keeps a test's seeded cases from vanishing mid-test.
test.beforeAll(async ({ request }) => {
  const headers = { "x-corvis-demo-tenant": "e2e-warmup", "x-corvis-demo-roles": "admin" };
  const missing = "00000000-0000-4000-8000-000000000000";
  await request.get("/api/v1/data-issues", { headers });
  await request.get(`/api/v1/data-issues/${missing}`, { headers });
  await request.patch(`/api/v1/data-issues/${missing}`, { headers, data: { seen: true } });
  await request.get("/api/v1/admin/data-issues", { headers });
  await request.patch(`/api/v1/admin/data-issues/${missing}`, { headers, data: { action: "investigate" } });
});
type Role = "admin" | "analyst" | "read_only";

/** Gives this page its own seeded tenant (and the demo role the API should see), for every data-issue call it makes. */
async function isolate(page: Page, role: Role = "admin"): Promise<{ tenant: string; headers: Record<string, string> }> {
  const tenant = `e2e-${randomUUID()}`;
  const headers = { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": role };
  await page.route("**/api/v1/data-issues**", (route) => route.continue({ headers: { ...route.request().headers(), ...headers } }));
  await page.addInitScript((value) => window.sessionStorage.setItem("corvis:demo:role", value), role);
  return { tenant, headers };
}

const card = (page: Page, text: string | RegExp): Locator => page.getByRole("list", { name: "Data issue reports" }).getByRole("listitem").filter({ hasText: text });
const sidebarItem = (page: Page): Locator => page.getByRole("navigation", { name: /workspace sections/i }).getByRole("button", { name: /^data issues$/i });

test("Overview: a published fund period can be reported with its scope and a comment, and the report shows up under Data issues @matrix", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.getByRole("button", { name: "Report an issue" }).click();
  const dialog = page.getByRole("dialog", { name: "Report an issue" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Reporting does not change any data or publication/).first()).toBeVisible();
  // Only published fund periods are offered: Nordic Capital Fund V Q2 2026 is still in review.
  await expect(dialog.getByRole("combobox", { name: "Fund period" }).locator("option")).toHaveText([
    "Advent International GPE VIII · Q2 2026 · snapshot v1", "EQT IX · Q1 2026 · snapshot v1", "Hg Genesis 9 · Q1 2026 · snapshot v1",
  ]);
  await dialog.getByRole("combobox", { name: "Fund period" }).selectOption({ label: "EQT IX · Q1 2026 · snapshot v1" });
  await expect(dialog.getByRole("group", { name: "What you are reporting" }).or(dialog.getByLabel("What you are reporting"))).toContainText("EQT IX · Q1 2026 · Snapshot v1");
  const send = dialog.getByRole("button", { name: "Send report" });
  await expect(send).toBeDisabled();
  await dialog.getByRole("textbox", { name: "What looks wrong?" }).fill("The fund value is about 3% lower than our own records.");
  const violations = await blockingViolations(page, '[role="dialog"]');
  expect(violations, describe(violations)).toEqual([]);

  const posted = page.waitForRequest((request) => request.url().endsWith("/api/v1/data-issues") && request.method() === "POST");
  await send.click();
  const payload = (await posted).postDataJSON() as Record<string, unknown>;
  expect(payload).toMatchObject({
    figure: "overview", comment: "The fund value is about 3% lower than our own records.",
    scope: { fundId: "fund-eqt-ix", fundLabel: "EQT IX", reportPeriod: "Q1 2026", snapshotId: "seed-snapshot-3", snapshotVersion: 1 },
  });
  expect(typeof payload.idempotencyKey).toBe("string");
  const received = page.getByRole("dialog", { name: "Report received" });
  await expect(received).toContainText("Data Operations has your report");
  await expect(received).toContainText("EQT IX · Q1 2026 · Snapshot v1");
  await received.getByRole("button", { name: "View my reports" }).click();

  await expect(page.getByRole("heading", { name: /^data issues$/i })).toBeVisible();
  await expect(page).toHaveURL(/#\/issues$/);
  const created = card(page, "The fund value is about 3% lower than our own records.");
  await expect(created).toContainText("Received");
  await expect(created).toContainText("EQT IX · Q1 2026 · Snapshot v1");
  await expect(created).toContainText("Overview");
});

test("reporting changes nothing a customer sees: published values and fund-period statuses are the same afterwards", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  const figures = page.locator("#customer-overview");
  await expect(figures).toContainText("Advent International GPE VIII");
  // The attention filter's "Assigned to me" count (F3) loads after the figures; wait for it so the baseline is the settled page.
  await expect(figures).toContainText(/Assigned to me \(\d+\)/);
  const before = await figures.innerText();
  await page.getByRole("button", { name: "Report an issue" }).click();
  const dialog = page.getByRole("dialog", { name: "Report an issue" });
  await dialog.getByRole("textbox", { name: "What looks wrong?" }).fill("Please double check this value.");
  await dialog.getByRole("button", { name: "Send report" }).click();
  await page.getByRole("dialog", { name: "Report received" }).getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The "Assigned to me" count is momentarily blank while the workspace refreshes; the settled page must equal the baseline.
  await expect.poll(() => figures.innerText()).toBe(before);
  await page.reload();
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await expect(page.locator("#customer-overview")).toContainText("Advent International GPE VIII");
  await expect.poll(() => page.locator("#customer-overview").innerText()).toBe(before);
});

test("a retry of the same report is idempotent: one case, not two", async ({ page }) => {
  const { headers } = await isolate(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  const body = { idempotencyKey: "retry-1", figure: "overview", comment: "Value looks wrong.", scope: { fundId: "fund-eqt-ix", reportPeriod: "Q1 2026" } };
  const first = await page.request.post("/api/v1/data-issues", { headers, data: body });
  const second = await page.request.post("/api/v1/data-issues", { headers, data: body });
  expect([first.status(), second.status()]).toEqual([201, 200]);
  expect(((await first.json()) as { data: { caseId: string } }).data.caseId).toBe(((await second.json()) as { data: { caseId: string } }).data.caseId);
  const listed = (await (await page.request.get("/api/v1/data-issues?scope=mine", { headers })).json()) as { data: unknown[] };
  expect(listed.data).toHaveLength(4);
});

test("Position financials: the report carries the position, line item and reporting period", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await openSurface(page, surfaces.find((surface) => surface.id === "analytics")!);
  await expect(page.getByRole("heading", { name: /^position financials$/i })).toBeVisible();
  const open = page.getByRole("button", { name: "Report an issue" });
  await expect(open).toBeEnabled();
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Report an issue" });
  await expect(dialog.getByRole("combobox", { name: "Line item" }).locator("option").first()).toHaveText("Whole income statement");
  const lineOptions = await dialog.getByRole("combobox", { name: "Line item" }).locator("option").allTextContents();
  expect(lineOptions.length).toBeGreaterThan(1);
  await dialog.getByRole("combobox", { name: "Line item" }).selectOption({ index: 1 });
  await dialog.getByRole("textbox", { name: "What looks wrong?" }).fill("This line does not match the company's statement.");
  const posted = page.waitForRequest((request) => request.url().endsWith("/api/v1/data-issues") && request.method() === "POST");
  await dialog.getByRole("button", { name: "Send report" }).click();
  const payload = (await posted).postDataJSON() as { figure: string; scope: Record<string, unknown> };
  expect(payload.figure).toBe("position_financials");
  expect(payload.scope).toMatchObject({ metricLabel: lineOptions[1] });
  expect(payload.scope.fundId).toEqual(expect.any(String));
  expect(payload.scope.companyId).toEqual(expect.any(String));
  expect(payload.scope.reportPeriod).toEqual(expect.any(String));
  await expect(page.getByRole("dialog", { name: "Report received" })).toBeVisible();
});

test("Data review: a published snapshot can be reported, narrowed to the focused observation", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open EQT IX Q1 2026" }).click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
  await page.getByRole("button", { name: "Report an issue" }).click();
  const dialog = page.getByRole("dialog", { name: "Report an issue" });
  await expect(dialog.getByRole("combobox", { name: "Figure" })).toHaveValue(/obs-5/);
  await expect(dialog.getByLabel("What you are reporting")).toContainText("EQT IX · Project Sparrow · Ownership · Q1 2026 · Snapshot v1");
  await dialog.getByRole("textbox", { name: "What looks wrong?" }).fill("Ownership should be 59.9%.");
  const posted = page.waitForRequest((request) => request.url().endsWith("/api/v1/data-issues") && request.method() === "POST");
  await dialog.getByRole("button", { name: "Send report" }).click();
  expect(((await posted).postDataJSON() as { figure: string; scope: Record<string, unknown> })).toMatchObject({
    figure: "review", scope: { fundId: "fund-eqt-ix", companyId: "company-project-sparrow", metricLabel: "Ownership", snapshotId: "seed-snapshot-3" },
  });
  await expect(page.getByRole("dialog", { name: "Report received" })).toBeVisible();
});

test("Data review: a snapshot still in review is not a published figure, so there is nothing to report", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await openSurface(page, surfaces.find((surface) => surface.id === "review")!);
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Report an issue" })).toHaveCount(0);
});

test("a failed report keeps the dialog open with a plain message and retries with the same reference", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  const keys: string[] = [];
  let failures = 1;
  await page.route("**/api/v1/data-issues", async (route) => {
    if (route.request().method() === "POST") {
      keys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey);
      if (failures-- > 0) { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "service_unavailable" }) }); return; }
    }
    await route.fallback();
  });
  await page.getByRole("button", { name: "Report an issue" }).click();
  const dialog = page.getByRole("dialog", { name: "Report an issue" });
  await dialog.getByRole("textbox", { name: "What looks wrong?" }).fill("Value looks wrong.");
  await dialog.getByRole("button", { name: "Send report" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Nothing was changed");
  await expect(dialog.getByRole("textbox", { name: "What looks wrong?" })).toHaveValue("Value looks wrong.");
  await dialog.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByRole("dialog", { name: "Report received" })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test("the case list shows each status, flags the update the reporter has not seen, and the sidebar counts it @matrix", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await expect(sidebarItem(page)).toContainText("1");
  await sidebarItem(page).click();
  await expect(page.getByRole("heading", { name: /^data issues$/i })).toBeVisible();
  const list = page.getByRole("list", { name: "Data issue reports" });
  await expect(list.getByRole("listitem")).toHaveCount(3);

  const corrected = card(page, "ABC Corp");
  await expect(corrected).toContainText("Corrected");
  await expect(corrected).toContainText("Updated");
  await expect(corrected).toContainText("Replacement publication: snapshot seed-snapshot-1, version 2.");
  await expect(card(page, "Ownership percentage")).toContainText("Investigating");
  await expect(card(page, "Ownership percentage")).not.toContainText("Updated");
  await expect(card(page, "fund value on the Overview")).toContainText("Received");

  const violations = await blockingViolations(page);
  expect(violations, describe(violations)).toEqual([]);

  await corrected.getByRole("button", { name: /mark the update on .* as seen/i }).click();
  await expect(corrected).not.toContainText("Updated");
  await expect(page.locator(".data-issues-status")).toHaveText("Marked as seen.");
  await expect(sidebarItem(page)).not.toContainText("1");
});

test("opening a case's history shows the steps and clears its update indicator", async ({ page }) => {
  await isolate(page);
  await page.goto("/#/issues");
  const corrected = card(page, "ABC Corp");
  await expect(corrected).toContainText("Updated");
  await corrected.getByText("History", { exact: true }).click();
  await expect(corrected.getByRole("list").filter({ hasText: "Investigating" }).getByRole("listitem")).toHaveCount(3);
  await expect(corrected).not.toContainText("Updated");
  await expect(sidebarItem(page)).not.toContainText("1");
});

test("the status filter narrows the list", async ({ page }) => {
  await isolate(page);
  await page.goto("/#/issues");
  const list = page.getByRole("list", { name: "Data issue reports" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await page.getByRole("combobox", { name: "Status" }).selectOption("investigating");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("Ownership percentage");
  await page.getByRole("combobox", { name: "Status" }).selectOption("no_change");
  await expect(page.getByText("No no change reports.")).toBeVisible();
});

test("a status change made by Data Operations reaches the reporter as an update", async ({ page }) => {
  const { headers } = await isolate(page, "analyst");
  await page.goto("/#/issues");
  const received = card(page, "fund value on the Overview");
  await expect(received).toContainText("Received");
  const caseId = ((await (await page.request.get("/api/v1/data-issues?scope=mine", { headers })).json()) as { data: Array<{ caseId: string; status: string }> }).data.find((item) => item.status === "received")!.caseId;

  // The reporter (an analyst) cannot move cases; an Organization Admin acting for Data Operations can.
  const denied = await page.request.patch(`/api/v1/admin/data-issues/${caseId}`, { headers, data: { action: "investigate" } });
  expect(denied.status()).toBe(403);
  const moved = await page.request.patch(`/api/v1/admin/data-issues/${caseId}`, { headers: { ...headers, "x-corvis-demo-roles": "admin" }, data: { action: "investigate", note: "Checking the source." } });
  expect(moved.status()).toBe(200);

  await page.reload();
  const updated = card(page, "fund value on the Overview");
  await expect(updated).toContainText("Investigating");
  await expect(updated).toContainText("Updated");
  await expect(sidebarItem(page)).toContainText("2");
});

test("Organization Admins can list everyone's reports; other roles only ever see their own", async ({ page, browser }) => {
  const admin = await isolate(page, "admin");
  await page.goto("/#/issues");
  await expect(page.getByRole("heading", { name: /^data issues$/i })).toBeVisible();
  await expect(page.getByText("Cases are moved by Data Operations")).toBeVisible();
  // Another person in the same tenant files a report; the admin sees it under "Everyone".
  const other = await page.request.post("/api/v1/data-issues", { headers: { ...admin.headers, "x-corvis-demo-subject": "colleague" }, data: { idempotencyKey: "colleague-1", figure: "overview", comment: "A colleague's concern.", scope: { fundId: "fund-eqt-ix", reportPeriod: "Q1 2026" } } });
  expect(other.status()).toBe(201);
  await expect(page.getByRole("list", { name: "Data issue reports" }).getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "Everyone in my organization" }).click();
  await expect(page.getByRole("list", { name: "Data issue reports" })).toContainText("A colleague's concern.");
  await expect(page.getByRole("list", { name: "Data issue reports" }).getByRole("listitem")).toHaveCount(7);

  const context = await browser.newContext();
  const analystPage = await context.newPage();
  await analystPage.route("**/api/v1/data-issues**", (route) => route.continue({ headers: { ...route.request().headers(), "x-corvis-demo-tenant": admin.tenant, "x-corvis-demo-roles": "analyst" } }));
  await analystPage.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "analyst"));
  await analystPage.goto("/#/issues");
  await expect(analystPage.getByRole("heading", { name: /^data issues$/i })).toBeVisible();
  await expect(analystPage.getByRole("button", { name: "Everyone in my organization" })).toHaveCount(0);
  await expect(analystPage.getByText("A colleague's concern.")).toHaveCount(0);
  await context.close();
});

test("reports can be exported as CSV or JSON for the customer's own records", async ({ page }) => {
  await isolate(page);
  await page.goto("/#/issues");
  await expect(page.getByRole("list", { name: "Data issue reports" }).getByRole("listitem")).toHaveCount(3);

  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toBe("corvis-data-issues.csv");
  const csvText = await readFile((await csv.path())!, "utf8");
  expect(csvText.split("\n")[0]).toContain('"case_id","status","figure"');
  expect(csvText).toContain("Revenue looks about 10% too high");
  expect(csvText.trim().split("\n")).toHaveLength(4);
  await expect(page.locator(".data-issues-status")).toContainText("Exported your reports as CSV.");

  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const json = JSON.parse(await readFile((await (await jsonDownload).path())!, "utf8")) as { data: Array<{ status: string }>; truncated: boolean };
  expect(json.data.map((item) => item.status).sort()).toEqual(["corrected", "investigating", "received"]);
  expect(json.truncated).toBe(false);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the report dialog and its confirmation pass the accessibility matrix in the ${colorScheme} theme @matrix`, async ({ page }) => {
    await isolate(page);
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
    await page.getByRole("button", { name: "Report an issue" }).click();
    const dialog = page.getByRole("dialog", { name: "Report an issue" });
    await expect(dialog).toBeVisible();
    let violations = await blockingViolations(page, '[role="dialog"]');
    expect(violations, describe(violations)).toEqual([]);
    await dialog.getByRole("textbox", { name: "What looks wrong?" }).fill("Value looks wrong.");
    await dialog.getByRole("button", { name: "Send report" }).click();
    await expect(page.getByRole("dialog", { name: "Report received" })).toBeVisible();
    violations = await blockingViolations(page, '[role="dialog"]');
    expect(violations, describe(violations)).toEqual([]);
  });
}

test("the Data issues surface is registered for the accessibility matrix and reachable by keyboard", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await openSurface(page, issues);
  await expect(page.getByRole("heading", { name: issues.heading }).first()).toBeVisible();
  await expect(sidebarItem(page)).toHaveAttribute("aria-current", "page");
  // Export is disabled until the list has loaded; keyboard users reach it once it is enabled.
  await expect(page.getByRole("list", { name: "Data issue reports" }).getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await page.getByRole("button", { name: "Export CSV" }).focus();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeFocused();
});
