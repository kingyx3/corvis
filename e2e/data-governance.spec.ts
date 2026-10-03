import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { accessibilityBudget } from "./quality-budgets.ts";

// Data retention view and full tenant data export (F10, #266), on the Organization Admin's access self-service page.
// The demo composition serves /api/v1/access/retention and /api/v1/access/data-exports from in-memory stores seeded per
// demo tenant, so every test pins its own tenant: an approval or rejection in one test can never leak into another.
// The rest of this page (invitations, support access, audit) needs a database and is not part of the demo composition,
// so its own "needs attention" banner is expected here and ignored.

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
// once up front keeps a test's seeded requests from vanishing mid-test.
test.beforeAll(async ({ request }) => {
  const headers = { "x-corvis-demo-tenant": "e2e-warmup", "x-corvis-demo-roles": "admin" };
  const missing = "00000000-0000-4000-8000-000000000000";
  await request.get("/api/v1/access/retention", { headers });
  await request.get("/api/v1/access/data-exports", { headers });
  await request.get(`/api/v1/access/data-exports/${missing}`, { headers });
  await request.post(`/api/v1/access/data-exports/${missing}`, { headers, data: { action: "approve" } });
  await request.get(`/api/v1/access/data-exports/${missing}/download?grant=x`, { headers });
});

/** Gives this page its own seeded tenant for every call it makes to the governance routes. */
async function isolate(page: Page): Promise<{ tenant: string; headers: Record<string, string> }> {
  const tenant = `e2e-${randomUUID()}`;
  const headers = { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "admin" };
  await page.route(/\/api\/v1\/access\/(retention|data-exports)/, (route) => route.continue({ headers: { ...route.request().headers(), ...headers } }));
  return { tenant, headers };
}

const card = (page: Page, text: string | RegExp): Locator => page.getByRole("list", { name: "Data export requests" }).getByRole("listitem").filter({ hasText: text });
const COLLEAGUE_REASON = /Contract renewal due diligence/;

test("Organization Admins see retention periods and the legal holds that apply, read-only @matrix", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  await expect(page.getByRole("heading", { name: /data retention and legal holds/i })).toBeVisible();
  const periods = page.getByRole("region", { name: "Retention periods" });
  await expect(periods).toBeVisible();
  await expect(periods.getByRole("row", { name: /Financial data/ })).toContainText("7 years");
  await expect(periods.getByRole("row", { name: /Published data/ })).toContainText("No fixed retention period");
  await expect(periods.getByRole("row", { name: /Published data/ })).toContainText("Deleted");
  await expect(periods.getByRole("row", { name: /Source documents/ })).toContainText("10 years");
  await expect(periods.getByRole("row", { name: /Source documents/ })).toContainText("On hold");
  const holds = page.getByRole("region", { name: "Legal holds", exact: true });
  await expect(holds).toContainText("MATTER-2026-014");
  await expect(holds).toContainText("3 documents within source documents");
  // Read-only: the section offers no control that could change a period or a hold.
  const section = page.locator("section[aria-labelledby='retention-heading']");
  await expect(section.getByRole("button")).toHaveCount(0);
  await expect(section.getByRole("textbox")).toHaveCount(0);
  const violations = await blockingViolations(page, "section[aria-labelledby='retention-heading']");
  expect(violations, describe(violations)).toEqual([]);
});

test("a second Organization Admin approves a colleague's request, the export is built, and its checksummed archive downloads once per link @matrix", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  await expect(page.getByRole("heading", { name: /^full data export$/i })).toBeVisible();
  const waiting = card(page, COLLEAGUE_REASON);
  await expect(waiting).toContainText("Pending");
  await expect(waiting).toContainText("by morgan.lee@meridian.example");
  await expect(waiting).toContainText("A different Organization Admin (not the requester) must approve");
  // One request is open at a time, so the form says so instead of letting a second be started.
  await expect(page.getByRole("button", { name: "Request full export" })).toBeDisabled();
  await expect(page.getByText(/Another request is open/)).toBeVisible();

  const violations = await blockingViolations(page, "section[aria-labelledby='export-heading']");
  expect(violations, describe(violations)).toEqual([]);

  // Approval needs an explicit confirmation naming what is being released.
  await waiting.getByRole("button", { name: "Approve export" }).click();
  await expect(waiting.getByRole("group", { name: "Confirm approval" })).toContainText("complete copy of your organization's data");
  await waiting.getByRole("button", { name: "Confirm approval" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approved. The export is being prepared." })).toBeVisible();
  await expect(waiting).toContainText("Ready");
  await expect(waiting).toContainText("single-use and short-lived");
  await expect(waiting).toContainText("SHA-256");

  await waiting.getByText("Contents and checksums").click();
  const files = waiting.getByRole("region", { name: /^Files in the export requested/ });
  await expect(files).toContainText("published-data/observations.csv");
  await expect(files).toContainText("access-audit/access-audit.csv");
  await expect(files).toContainText("source-documents/inventory.csv");
  // Contractual data rights: what was left out is a count, and the files that are not delivered yet are said so.
  await expect(waiting).toContainText("Funds: 2 included, 1 left out.");
  await expect(waiting).toContainText("Not included: Source document files.");
  await waiting.getByText("History", { exact: true }).click();
  await expect(waiting.getByRole("listitem").filter({ hasText: /approved by demo-user/ })).toHaveCount(1);
  await expect(waiting.getByRole("listitem").filter({ hasText: /build completed by system:tenant-export/ })).toHaveCount(1);

  const [download] = await Promise.all([page.waitForEvent("download"), waiting.getByRole("button", { name: "Download export" }).click()]);
  expect(download.suggestedFilename()).toBe("corvis-tenant-export.zip");
  const path = await download.path();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  const shown = (await waiting.locator("code").first().innerText()).trim();
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(shown);

  // Each click issues a fresh single-use link, so downloading again works too.
  const [again] = await Promise.all([page.waitForEvent("download"), waiting.getByRole("button", { name: "Download export" }).click()]);
  expect(again.suggestedFilename()).toBe("corvis-tenant-export.zip");
});

test("the requester can never approve their own request: no control is offered, and the API refuses it", async ({ page }) => {
  const { headers } = await isolate(page);
  await page.goto("/access-self-service");
  await expect(card(page, COLLEAGUE_REASON)).toBeVisible();
  // Resolve the colleague's request so this admin can make their own.
  await card(page, COLLEAGUE_REASON).getByRole("button", { name: "Reject" }).click();
  await expect(card(page, COLLEAGUE_REASON).getByRole("button", { name: "Confirm rejection" })).toBeDisabled();
  await card(page, COLLEAGUE_REASON).getByRole("textbox", { name: "Why are you rejecting it?" }).fill("Superseded by our own request.");
  await card(page, COLLEAGUE_REASON).getByRole("button", { name: "Confirm rejection" }).click();
  await expect(card(page, COLLEAGUE_REASON)).toContainText("Rejected by demo-user: Superseded by our own request.");

  const submit = page.getByRole("button", { name: "Request full export" });
  await expect(submit).toBeDisabled();
  await page.getByRole("textbox", { name: "Why do you need this export?" }).fill("ab");
  await expect(submit).toBeDisabled();
  await page.getByRole("textbox", { name: "Why do you need this export?" }).fill("Records review at contract end");
  await submit.click();
  const mine = card(page, "Records review at contract end");
  await expect(mine).toContainText("by you");
  await expect(mine).toContainText("Pending");
  await expect(mine).toContainText("You cannot approve your own request");
  await expect(mine.getByRole("button", { name: "Approve export" })).toHaveCount(0);
  await expect(mine.getByRole("button", { name: "Reject" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Request full export" })).toBeDisabled();

  const id = ((await (await page.request.get("/api/v1/access/data-exports", { headers })).json()) as { data: Array<{ requestId: string; reason: string }> }).data.find((item) => item.reason === "Records review at contract end")!.requestId;
  const self = await page.request.post(`/api/v1/access/data-exports/${id}`, { headers, data: { action: "approve" } });
  expect(self.status()).toBe(403);
  expect(((await self.json()) as { error: string }).error).toBe("data_export_independent_approver_required");

  // A different admin can; the requester then sees it ready.
  const approved = await page.request.post(`/api/v1/access/data-exports/${id}`, { headers: { ...headers, "x-corvis-demo-subject": "second-admin" }, data: { action: "approve" } });
  expect(approved.status()).toBe(200);
  await page.reload();
  await expect(card(page, "Records review at contract end")).toContainText("Ready");
  await expect(card(page, "Records review at contract end")).toContainText("approved by second-admin");
});

test("the requester can withdraw a pending request, and a withdrawn request frees the slot", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  await card(page, COLLEAGUE_REASON).getByRole("button", { name: "Reject" }).click();
  await card(page, COLLEAGUE_REASON).getByRole("textbox", { name: "Why are you rejecting it?" }).fill("Not needed.");
  await card(page, COLLEAGUE_REASON).getByRole("button", { name: "Confirm rejection" }).click();
  await page.getByRole("textbox", { name: "Why do you need this export?" }).fill("Records review at contract end");
  await page.getByRole("button", { name: "Request full export" }).click();
  const mine = card(page, "Records review at contract end");
  await mine.getByRole("button", { name: "Withdraw request" }).click();
  await expect(mine).toContainText("Withdrawn");
  await expect(mine).toContainText("Withdrawn by the requester before it was built.");
  await expect(page.getByRole("button", { name: "Request full export" })).toBeDisabled(); // empty reason
  await page.getByRole("textbox", { name: "Why do you need this export?" }).fill("A narrower request");
  await expect(page.getByRole("button", { name: "Request full export" })).toBeEnabled();
});

test("only Organization Admins get these routes: another role is refused, and nothing is rendered for a failed load", async ({ page }) => {
  const { tenant } = await isolate(page);
  const denied = await page.request.get("/api/v1/access/retention", { headers: { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "analyst" } });
  expect(denied.status()).toBe(403);
  const deniedList = await page.request.get("/api/v1/access/data-exports", { headers: { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "read_only" } });
  expect(deniedList.status()).toBe(403);

  await page.unroute(/\/api\/v1\/access\/(retention|data-exports)/);
  await page.route(/\/api\/v1\/access\/(retention|data-exports)/, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporarily_unavailable" }) }));
  await page.goto("/access-self-service");
  await expect(page.getByRole("alert").filter({ hasText: "Retention settings are unavailable" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Export requests are unavailable" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Retention periods" })).toHaveCount(0);
  const violations = await blockingViolations(page, "section[aria-labelledby='export-heading']");
  expect(violations, describe(violations)).toEqual([]);
});
