import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { accessibilityBudget } from "../quality/quality-budgets.ts";
import { openSurface, surfaces } from "../support/surfaces.ts";

// Scheduled exports (F4, #260). The demo composition serves /api/v1/export-schedules from an in-memory store seeded per demo
// tenant and subject, so every test pins its own tenant: a schedule created or changed in one test can never leak into another.
// Demo mode has no worker, so schedules never run here; the seeded runs are illustrative, and the worker itself is covered
// against real Postgres (db/postgres/tests/export-schedules.mjs).

type Violation = { id: string; impact?: string | null; help: string; nodes: Array<{ target: unknown[] }> };

async function blockingViolations(page: Page, include?: string): Promise<Violation[]> {
  const builder = new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]);
  const results = await (include ? builder.include(include) : builder).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

function describe(violations: Violation[]): string {
  return violations.map((violation) => `${violation.impact}/${violation.id}: ${violation.help} (${violation.nodes.length} node(s), first: ${JSON.stringify(violation.nodes[0]?.target)})`).join("\n");
}

// The dev server compiles each route on first use and may reset module-level demo state while it does; touching every route
// once up front keeps a test's seeded schedules from vanishing mid-test.
test.beforeAll(async ({ request }) => {
  const headers = { "x-corvis-demo-tenant": "e2e-schedules-warmup", "x-corvis-demo-roles": "admin" };
  const missing = "00000000-0000-4000-8000-000000000000";
  await request.get("/api/v1/export-schedules", { headers });
  await request.get("/api/v1/export-schedules/runs", { headers });
  await request.get(`/api/v1/export-schedules/${missing}`, { headers });
  await request.patch(`/api/v1/export-schedules/${missing}`, { headers, data: { action: "pause" } });
  await request.delete(`/api/v1/export-schedules/${missing}`, { headers });
});

type Role = "admin" | "analyst";

/** Gives this page its own seeded tenant (and the demo role the API should see), for every schedule call it makes. */
async function isolate(page: Page, role: Role = "analyst"): Promise<{ tenant: string; headers: Record<string, string> }> {
  const tenant = `e2e-${randomUUID()}`;
  const headers = { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": role };
  await page.route("**/api/v1/export-schedules**", (route) => route.continue({ headers: { ...route.request().headers(), ...headers } }));
  await page.addInitScript((value) => window.sessionStorage.setItem("corvis:demo:role", value), role);
  return { tenant, headers };
}

const delivery = surfaces.find((surface) => surface.id === "delivery")!;
const schedules = (page: Page): Locator => page.getByRole("list", { name: "Export schedules" }).getByRole("listitem");
const card = (page: Page, text: string | RegExp): Locator => schedules(page).filter({ hasText: text });

async function openPublishedSnapshot(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Open EQT IX Q1 2026" }).click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
}

test("Data review: a published snapshot can be scheduled with a trigger and a format, and the schedule shows up under Data delivery", async ({ page }) => {
  await isolate(page);
  await openPublishedSnapshot(page);
  await page.getByRole("button", { name: "Schedule export" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule this export" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("What will be exported")).toContainText("Snapshot seed-snapshot-3");
  await expect(dialog.getByText(/checked again every time/).first()).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Run" }).locator("option")).toHaveText([
    "When a new version of this snapshot is published", "Monthly, on the 1st (UTC)", "Quarterly, on the 1st of January, April, July and October (UTC)",
  ]);
  await expect(dialog.getByRole("combobox", { name: "Format" }).locator("option")).toHaveText(["CSV", "Excel", "Parquet"]);
  await dialog.getByRole("combobox", { name: "Run" }).selectOption("on_publish");
  await dialog.getByRole("combobox", { name: "Format" }).selectOption("xlsx");
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue(/^On publish · Snapshot seed-snapshot-3$/);
  await dialog.getByRole("textbox", { name: "Name" }).fill("EQT IX on publish");
  const violations = await blockingViolations(page, '[role="dialog"]');
  expect(violations, describe(violations)).toEqual([]);

  const posted = page.waitForRequest((request) => request.url().endsWith("/api/v1/export-schedules") && request.method() === "POST");
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  const payload = (await posted).postDataJSON() as Record<string, unknown>;
  expect(payload).toMatchObject({ label: "EQT IX on publish", scope: { snapshotId: "seed-snapshot-3" }, format: "xlsx", trigger: "on_publish" });
  expect(typeof payload.idempotencyKey).toBe("string");
  const saved = page.getByRole("dialog", { name: "Schedule saved" });
  await expect(saved).toContainText("EQT IX on publish");
  await expect(saved).toContainText("Nothing was exported now");
  await saved.getByRole("button", { name: "Close" }).click();

  await page.getByRole("navigation", { name: /workspace sections/i }).getByRole("button", { name: /^data delivery$/i }).click();
  await expect(page.getByRole("heading", { name: /deliver structured data/i })).toBeVisible();
  const created = card(page, "EQT IX on publish");
  await expect(created).toContainText("Active");
  await expect(created).toContainText("Snapshot seed-snapshot-3 · Excel");
  await expect(created).toContainText("When a matching snapshot is published");
  await expect(created).toContainText("It has not run yet.");
});

test("Position financials: the schedule carries the exact position, portfolio scope and periodicity of the view", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await openSurface(page, surfaces.find((surface) => surface.id === "analytics")!);
  await expect(page.getByRole("heading", { name: /^position financials$/i })).toBeVisible();
  const open = page.getByRole("button", { name: "Schedule export" });
  await expect(open).toBeEnabled();
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Schedule this export" });
  await expect(dialog.getByLabel("What will be exported")).toContainText("Position financials ·");
  await expect(dialog.getByRole("combobox", { name: "Run" }).locator("option").first()).toHaveText("When a snapshot of this fund is published");
  await dialog.getByRole("combobox", { name: "Run" }).selectOption("quarterly");
  const posted = page.waitForRequest((request) => request.url().endsWith("/api/v1/export-schedules") && request.method() === "POST");
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  const payload = (await posted).postDataJSON() as { scope: { positionFinancials: Record<string, unknown> }; trigger: string; format: string };
  expect(payload).toMatchObject({ trigger: "quarterly", format: "csv" });
  expect(payload.scope.positionFinancials).toMatchObject({ fundId: expect.any(String), holdingId: expect.any(String), companyId: expect.any(String), periodicity: "quarterly" });
  await expect(page.getByRole("dialog", { name: "Schedule saved" })).toContainText("The first run is on");
});

test("Performance scorecard: the schedule carries the scorecard scope and its filters, and shows up under Data delivery with the scorecard scope", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await openSurface(page, surfaces.find((surface) => surface.id === "scorecard")!);
  const filters = page.getByRole("group", { name: /scorecard filters/i });
  await filters.getByRole("combobox", { name: "Reporting period" }).selectOption("Q1 2026");
  await page.getByRole("button", { name: "Schedule export" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule this export" });
  await expect(dialog.getByLabel("What will be exported")).toContainText("Performance scorecard · all entitled funds · Q1 2026");
  await dialog.getByRole("combobox", { name: "Run" }).selectOption("on_publish");
  await dialog.getByRole("textbox", { name: "Name" }).fill("Scorecard Q1 on publish");
  const violations = await blockingViolations(page, '[role="dialog"]');
  expect(violations, describe(violations)).toEqual([]);
  const posted = page.waitForRequest((request) => request.url().endsWith("/api/v1/export-schedules") && request.method() === "POST");
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  expect((await posted).postDataJSON()).toMatchObject({ label: "Scorecard Q1 on publish", scope: { performanceScorecard: true, period: "Q1 2026" }, trigger: "on_publish" });
  await page.getByRole("dialog", { name: "Schedule saved" }).getByRole("button", { name: "Close" }).click();
  await page.getByRole("navigation", { name: /workspace sections/i }).getByRole("button", { name: /^data delivery$/i }).click();
  const created = card(page, "Scorecard Q1 on publish");
  await expect(created).toContainText("Performance scorecard · all entitled funds · Q1 2026 · CSV");
  await expect(created).toContainText("When a matching snapshot is published");
});

test("Data delivery lists the seeded schedules and every run with its scope and schedule label, including a refused run and why", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await openSurface(page, delivery);
  await expect(schedules(page)).toHaveCount(2);
  const monthly = card(page, "Monthly · Project Sparrow financials");
  await expect(monthly).toContainText("Active");
  await expect(monthly).toContainText("Position financials · company-project-sparrow · quarterly · CSV");
  await expect(monthly).toContainText("Next run:");
  const paused = card(page, "On publish · Hg Genesis 9 Q1 2026");
  await expect(paused).toContainText("Paused");
  await expect(paused).toContainText("Failed");
  await expect(paused).toContainText("Contractual data rights no longer permit redistribution.");

  const runs = page.getByRole("region", { name: "Scheduled runs" }).getByRole("row");
  // A header row and the three seeded runs.
  await expect(runs).toHaveCount(4);
  const refused = runs.filter({ hasText: "On publish · Hg Genesis 9 Q1 2026" }).filter({ hasText: "Failed" });
  await expect(refused).toContainText("Snapshot seed-snapshot-4");
  await expect(refused).toContainText("Contractual data rights no longer permit redistribution.");
  await expect(runs.filter({ hasText: "Monthly · Project Sparrow financials" })).toContainText("Complete");
});

test("the owner pauses, resumes and deletes a schedule, with a confirmation before the delete; past runs stay in history", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await openSurface(page, delivery);
  const monthly = card(page, "Monthly · Project Sparrow financials");
  await monthly.getByRole("button", { name: /^Pause Monthly/ }).click();
  await expect(monthly).toContainText("Paused");
  await expect(page.getByRole("status").filter({ hasText: "Nothing runs until you resume it." })).toBeVisible();
  await expect(monthly.getByRole("button", { name: /^Pause / })).toHaveCount(0);
  await monthly.getByRole("button", { name: /^Resume Monthly/ }).click();
  await expect(monthly).toContainText("Active");
  await expect(monthly).toContainText("Next run:");

  await monthly.getByRole("button", { name: /^Delete Monthly/ }).click();
  await expect(schedules(page)).toHaveCount(2);
  await monthly.getByRole("button", { name: "Keep it" }).click();
  await expect(schedules(page)).toHaveCount(2);
  await monthly.getByRole("button", { name: /^Delete Monthly/ }).click();
  await monthly.getByRole("button", { name: /^Confirm delete Monthly/ }).click();
  await expect(schedules(page)).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "Its past runs stay in history." })).toBeVisible();
  await expect(page.getByRole("region", { name: "Scheduled runs" }).getByRole("row").filter({ hasText: "Monthly · Project Sparrow financials" })).toHaveCount(1);
});

test("an Organization Admin sees every schedule in the organization and can change none of them, while an analyst has no such view", async ({ page }) => {
  const { tenant } = await isolate(page, "admin");
  await page.request.get("/api/v1/export-schedules", { headers: { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "analyst", "x-corvis-demo-subject": "colleague" } });
  await page.goto("/");
  await openSurface(page, delivery);
  await expect(schedules(page)).toHaveCount(2);
  // The workspace finishes loading for the admin role after the first paint and remounts the view once; let it settle before switching scope.
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Everyone in my organization" }).click();
  await expect(schedules(page)).toHaveCount(4);
  const theirs = schedules(page).filter({ hasText: "owned by colleague" });
  await expect(theirs).toHaveCount(2);
  await expect(theirs.getByRole("button")).toHaveCount(0);
  await expect(schedules(page).filter({ hasNotText: "owned by" }).first().getByRole("button", { name: /^Delete / })).toBeVisible();
  await page.getByRole("button", { name: "My schedules" }).click();
  await expect(schedules(page)).toHaveCount(2);

  const analyst = await page.request.get("/api/v1/export-schedules?scope=all", { headers: { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "analyst" } });
  expect(analyst.status()).toBe(403);
});

test("a failed save keeps the dialog open with a plain message and retries with the same reference", async ({ page }) => {
  await isolate(page);
  const keys: string[] = [];
  let failures = 1;
  await page.route("**/api/v1/export-schedules", async (route) => {
    if (route.request().method() === "POST") {
      keys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey);
      if (failures-- > 0) { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "service_unavailable" }) }); return; }
    }
    await route.fallback();
  });
  await openPublishedSnapshot(page);
  await page.getByRole("button", { name: "Schedule export" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule this export" });
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Nothing was exported");
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByRole("dialog", { name: "Schedule saved" })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test("a refused save (not entitled to the data) shows the reason and saves nothing", async ({ page }) => {
  await isolate(page);
  await page.route("**/api/v1/export-schedules", async (route) => {
    if (route.request().method() === "POST") { await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "export_scope_not_entitled" }) }); return; }
    await route.fallback();
  });
  await openPublishedSnapshot(page);
  await page.getByRole("button", { name: "Schedule export" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule this export" });
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await expect(dialog.getByRole("alert")).toContainText("You no longer have access to the data in this view");
  await expect(page.getByRole("dialog", { name: "Schedule saved" })).toHaveCount(0);
});

test("a retry of the same create request is idempotent: one schedule, not two", async ({ page }) => {
  const { headers } = await isolate(page);
  await page.goto("/");
  const body = { idempotencyKey: "retry-1", label: "Retry me", scope: { snapshotId: "seed-snapshot-3" }, format: "csv", trigger: "monthly" };
  const first = await page.request.post("/api/v1/export-schedules", { headers, data: body });
  const second = await page.request.post("/api/v1/export-schedules", { headers, data: body });
  expect([first.status(), second.status()]).toEqual([201, 200]);
  expect(((await first.json()) as { data: { scheduleId: string } }).data.scheduleId).toBe(((await second.json()) as { data: { scheduleId: string } }).data.scheduleId);
  const reused = await page.request.post("/api/v1/export-schedules", { headers, data: { ...body, label: "Different" } });
  expect(reused.status()).toBe(409);
  const listed = (await (await page.request.get("/api/v1/export-schedules", { headers })).json()) as { data: unknown[] };
  expect(listed.data).toHaveLength(3);
});

test("the schedule dialog passes the accessibility matrix @matrix", async ({ page }) => {
  await isolate(page);
  const surface = surfaces.find((entry) => entry.id === "schedule")!;
  await page.goto("/");
  await openSurface(page, surface);
  await expect(page.getByRole("heading", { name: surface.heading }).first()).toBeVisible();
  const violations = await blockingViolations(page);
  expect(violations, describe(violations)).toEqual([]);
});

test("the schedules panel on Data delivery is usable at phone width without horizontal page scroll @matrix", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await openSurface(page, delivery);
  await expect(schedules(page)).toHaveCount(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(card(page, "Monthly · Project Sparrow financials").getByRole("button", { name: /^Pause / })).toBeVisible();
});

test("F4b: the dialog offers emails about the schedule, on by default, and an opt-out is saved with it and shown under Data delivery", async ({ page }) => {
  await isolate(page);
  await openPublishedSnapshot(page);
  await page.getByRole("button", { name: "Schedule export" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule this export" });
  const notify = dialog.getByRole("checkbox", { name: "Email me about this schedule" });
  await expect(notify).toBeChecked();
  await expect(dialog.getByText(/The emails never contain data/)).toBeVisible();
  const violations = await blockingViolations(page, '[role="dialog"]');
  expect(violations, describe(violations)).toEqual([]);
  await notify.uncheck();
  await dialog.getByRole("textbox", { name: "Name" }).fill("Quiet schedule");
  const posted = page.waitForRequest((request) => request.url().endsWith("/api/v1/export-schedules") && request.method() === "POST");
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  expect((await posted).postDataJSON()).toMatchObject({ label: "Quiet schedule", notifyOnCompletion: false });
  await page.getByRole("dialog", { name: "Schedule saved" }).getByRole("button", { name: "Close" }).click();

  await openSurface(page, delivery);
  const created = card(page, "Quiet schedule");
  await expect(created).toContainText("Emails about this schedule are off.");
  await expect(created.getByRole("button", { name: "Email me about Quiet schedule" })).toHaveAttribute("aria-pressed", "false");
});

test("F4b: the owner switches the emails about a schedule on and off under Data delivery, and an Organization Admin cannot", async ({ page }) => {
  const { tenant } = await isolate(page, "admin");
  await page.request.get("/api/v1/export-schedules", { headers: { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "analyst", "x-corvis-demo-subject": "colleague" } });
  await page.goto("/");
  await openSurface(page, delivery);
  await page.waitForLoadState("networkidle");
  const monthly = card(page, "Monthly · Project Sparrow financials").first();
  await expect(monthly).toContainText("The owner is emailed when a run is ready, and when a run is refused or fails.");
  const toggle = monthly.getByRole("button", { name: /^Email me about Monthly/ });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const patched = page.waitForRequest((request) => request.method() === "PATCH" && /\/api\/v1\/export-schedules\//.test(request.url()));
  await toggle.click();
  expect((await patched).postDataJSON()).toEqual({ notifyOnCompletion: false });
  await expect(page.getByRole("status").filter({ hasText: "Emails about “Monthly · Project Sparrow financials” are off." })).toBeVisible();
  await expect(monthly).toContainText("Emails about this schedule are off. Runs still appear below.");
  await expect(monthly.getByRole("button", { name: /^Email me about Monthly/ })).toHaveAttribute("aria-pressed", "false");
  await monthly.getByRole("button", { name: /^Email me about Monthly/ }).click();
  await expect(monthly).toContainText("The owner is emailed when a run is ready");
  await expect(page.getByRole("status").filter({ hasText: "are on." })).toBeVisible();

  await page.getByRole("button", { name: "Everyone in my organization" }).click();
  const theirs = schedules(page).filter({ hasText: "owned by colleague" });
  await expect(theirs).toHaveCount(2);
  await expect(theirs.first()).toContainText("The owner is emailed");
  await expect(theirs.getByRole("button", { name: /^Email me about/ })).toHaveCount(0);
  const violations = await blockingViolations(page, ".export-schedules");
  expect(violations, describe(violations)).toEqual([]);
});
