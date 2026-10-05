import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { accessibilityBudget } from "./quality-budgets.ts";

// Data retention view, deletion requests (F10e, #325) and full tenant data export (F10, #266), on the Organization Admin's access self-service page.
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
  await request.post("/api/v1/access/deletion-requests", { headers, data: {} });
  await request.post(`/api/v1/access/deletion-requests/${missing}`, { headers, data: { action: "approve" } });
  await request.get("/api/v1/access/data-exports", { headers });
  await request.get(`/api/v1/access/data-exports/${missing}`, { headers });
  await request.post(`/api/v1/access/data-exports/${missing}`, { headers, data: { action: "approve" } });
  await request.get(`/api/v1/access/data-exports/${missing}/download?grant=x`, { headers });
});

/** Gives this page its own seeded tenant for every call it makes to the governance routes. */
async function isolate(page: Page): Promise<{ tenant: string; headers: Record<string, string> }> {
  const tenant = `e2e-${randomUUID()}`;
  const headers = { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "admin" };
  await page.route(/\/api\/v1\/access\/(retention|data-exports|deletion-requests)/, (route) => route.continue({ headers: { ...route.request().headers(), ...headers } }));
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
  // Read-only: nothing in the periods or the holds can change a period or a hold.
  await expect(periods.getByRole("button")).toHaveCount(0);
  await expect(holds.getByRole("button")).toHaveCount(0);
  await expect(periods.getByRole("textbox")).toHaveCount(0);
  await expect(holds.getByRole("textbox")).toHaveCount(0);
  const violations = await blockingViolations(page, "section[aria-labelledby='retention-heading']");
  expect(violations, describe(violations)).toEqual([]);
});

const deletionCard = (page: Page, text: string | RegExp): Locator => page.getByRole("list", { name: "Deletion requests" }).getByRole("listitem").filter({ hasText: text });
const COLLEAGUE_DELETION = /Contract ends this quarter/;

test("Organization Admins see the deletion requests that affect their organization with status and dates, and never an operator's detail (F10e) @matrix", async ({ page }) => {
  const { headers } = await isolate(page);
  await page.goto("/access-self-service");
  await expect(page.getByRole("heading", { name: "Deletion requests", level: 3 })).toBeVisible();
  const list = page.getByRole("list", { name: "Deletion requests" });
  await expect(list.getByRole("listitem")).toHaveCount(3);

  // A deletion Corvis operations carried out: what it covered, where it stands and when, and nothing about who ran it.
  const done = deletionCard(page, "Audit records");
  await expect(done).toContainText("Completed");
  await expect(done).toContainText("by Corvis operations");
  await expect(done).toContainText(/approved \d{1,2} [A-Z][a-z]{2} \d{4} · deleted \d{1,2} [A-Z][a-z]{2} \d{4}/);
  await expect(done).toContainText("The data was deleted");
  // One a legal hold blocks.
  const held = deletionCard(page, "Source documents");
  await expect(held).toContainText("Blocked");
  await expect(held).toContainText("On hold");
  await expect(held).toContainText("Blocked by a legal hold. Nothing was deleted");
  // Read-only: Corvis operations' requests offer no control at all.
  await expect(done.getByRole("button")).toHaveCount(0);
  await expect(held.getByRole("button")).toHaveCount(0);

  // The API returns the same, with every operator-only field empty.
  const view = (await (await page.request.get("/api/v1/access/retention", { headers })).json()) as { data: { deletionRequests: Array<Record<string, unknown>> } };
  const operator = view.data.deletionRequests.filter((item) => item.origin === "corvis");
  expect(operator).toHaveLength(2);
  for (const item of operator) {
    expect([item.reason, item.requestedBy, item.approvalExpiresAt, item.decidedBy, item.decisionNote]).toEqual([null, null, null, null, null]);
    expect(Object.keys(item).sort()).toEqual(["actions", "approvalExpiresAt", "dataClasses", "decidedAt", "decidedBy", "decisionNote", "executedAt", "legalHoldBlocks", "origin", "reason", "requestedAt", "requestedBy", "requestedByMe", "requestId", "scopeLabel", "status"].sort());
  }
  const violations = await blockingViolations(page, "[data-testid='deletion-requests']");
  expect(violations, describe(violations)).toEqual([]);
});

test("a colleague's deletion request needs this admin's explicit approval, and approving hands it to Corvis operations (F10e)", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  const waiting = deletionCard(page, COLLEAGUE_DELETION);
  await expect(waiting).toContainText("Pending");
  await expect(waiting).toContainText("by morgan.lee@meridian.example");
  await expect(waiting).toContainText("A different Organization Admin (not the requester) must approve");
  await waiting.getByRole("button", { name: "Approve deletion" }).click();
  await expect(waiting.getByRole("group", { name: "Confirm approval" })).toContainText("Deletion cannot be undone");
  const violations = await blockingViolations(page, "[data-testid='deletion-requests']");
  expect(violations, describe(violations)).toEqual([]);
  await waiting.getByRole("button", { name: "Confirm deletion approval" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approved. Corvis operations will carry out the deletion." })).toBeVisible();
  await expect(waiting).toContainText("Approved");
  await expect(waiting).toContainText("Approved by demo-user. Corvis operations will carry out the deletion.");
  await expect(waiting.getByRole("button")).toHaveCount(0);
});

test("a colleague's deletion request can be rejected with a note, which is kept (F10e)", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  const waiting = deletionCard(page, COLLEAGUE_DELETION);
  await waiting.getByRole("button", { name: "Reject deletion" }).click();
  await expect(waiting.getByRole("button", { name: "Confirm deletion rejection" })).toBeDisabled();
  await waiting.getByRole("textbox", { name: "Why are you rejecting it?" }).fill("We still need the published data.");
  await waiting.getByRole("button", { name: "Confirm deletion rejection" }).click();
  await expect(waiting).toContainText("Rejected by demo-user: We still need the published data. Nothing was deleted.");
});

test("an admin's own deletion request: data under a legal hold cannot be chosen, the requester can never approve it, a different admin can, and it can be withdrawn (F10e)", async ({ page }) => {
  const { headers } = await isolate(page);
  await page.goto("/access-self-service");
  // Resolve the colleague's request so this admin can make their own.
  await deletionCard(page, COLLEAGUE_DELETION).getByRole("button", { name: "Reject deletion" }).click();
  await deletionCard(page, COLLEAGUE_DELETION).getByRole("textbox", { name: "Why are you rejecting it?" }).fill("Superseded by our own request.");
  await deletionCard(page, COLLEAGUE_DELETION).getByRole("button", { name: "Confirm deletion rejection" }).click();
  await expect(deletionCard(page, COLLEAGUE_DELETION)).toContainText("Rejected");

  // Blocked by a legal hold: the class is shown but cannot be chosen, and the API refuses it too.
  const held = page.getByRole("checkbox", { name: /Source documents/ });
  await expect(held).toBeDisabled();
  await expect(page.getByText("under a legal hold, so it cannot be deleted")).toBeVisible();
  const blocked = await page.request.post("/api/v1/access/deletion-requests", { headers, data: { dataClasses: ["financials", "source_documents"], reason: "Contract ended" } });
  expect(blocked.status()).toBe(409);
  expect(((await blocked.json()) as { error: string }).error).toBe("deletion_blocked_by_legal_hold");
  const unknown = await page.request.post("/api/v1/access/deletion-requests", { headers, data: { dataClasses: ["not_a_class"], reason: "Contract ended" } });
  expect(unknown.status()).toBe(400);

  const submit = page.getByRole("button", { name: "Request deletion" });
  await expect(submit).toBeDisabled();
  await page.getByRole("checkbox", { name: "Financial data" }).check();
  await page.getByRole("textbox", { name: "Why do you need this deletion?" }).fill("ab");
  await expect(submit).toBeDisabled();
  await page.getByRole("textbox", { name: "Why do you need this deletion?" }).fill("The contract has ended");
  await submit.click();
  const mine = deletionCard(page, "The contract has ended");
  await expect(mine).toContainText("by you");
  await expect(mine).toContainText("Pending");
  await expect(mine).toContainText("You cannot approve your own request");
  await expect(mine.getByRole("button", { name: "Approve deletion" })).toHaveCount(0);
  await expect(mine.getByRole("button", { name: "Reject deletion" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Request deletion" })).toBeDisabled();
  await expect(page.getByText("Another deletion request is waiting for approval")).toBeVisible();

  const id = ((await (await page.request.get("/api/v1/access/retention", { headers })).json()) as { data: { deletionRequests: Array<{ requestId: string; reason: string | null }> } }).data.deletionRequests.find((item) => item.reason === "The contract has ended")!.requestId;
  const self = await page.request.post(`/api/v1/access/deletion-requests/${id}`, { headers, data: { action: "approve" } });
  expect(self.status()).toBe(403);
  expect(((await self.json()) as { error: string }).error).toBe("deletion_independent_approver_required");
  const selfReject = await page.request.post(`/api/v1/access/deletion-requests/${id}`, { headers, data: { action: "reject", note: "No" } });
  expect(selfReject.status()).toBe(403);

  // A different admin can; the requester then sees it approved.
  const approved = await page.request.post(`/api/v1/access/deletion-requests/${id}`, { headers: { ...headers, "x-corvis-demo-subject": "second-admin" }, data: { action: "approve" } });
  expect(approved.status()).toBe(200);
  await page.reload();
  await expect(deletionCard(page, "The contract has ended")).toContainText("Approved by second-admin. Corvis operations will carry out the deletion.");
});

test("the requester can withdraw a pending deletion request, and a withdrawn request frees the slot (F10e)", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  await deletionCard(page, COLLEAGUE_DELETION).getByRole("button", { name: "Reject deletion" }).click();
  await deletionCard(page, COLLEAGUE_DELETION).getByRole("textbox", { name: "Why are you rejecting it?" }).fill("Not needed.");
  await deletionCard(page, COLLEAGUE_DELETION).getByRole("button", { name: "Confirm deletion rejection" }).click();
  await page.getByRole("checkbox", { name: "Audit records" }).check();
  await page.getByRole("textbox", { name: "Why do you need this deletion?" }).fill("Closing an old workspace");
  await page.getByRole("button", { name: "Request deletion" }).click();
  const mine = deletionCard(page, "Closing an old workspace");
  await mine.getByRole("button", { name: "Withdraw deletion request" }).click();
  await expect(mine).toContainText("Withdrawn");
  await expect(mine).toContainText("Withdrawn by the requester before anyone approved it. Nothing was deleted.");
  await page.getByRole("checkbox", { name: "Audit records" }).check();
  await page.getByRole("textbox", { name: "Why do you need this deletion?" }).fill("A narrower request");
  await expect(page.getByRole("button", { name: "Request deletion" })).toBeEnabled();
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
  // F10c: while it is built the request shows its size estimate and how far it has got, then settles by itself.
  await expect(waiting).toContainText("Processing");
  const progress = waiting.getByTestId("export-progress");
  await expect(progress.getByRole("progressbar", { name: /^Export build progress/ })).toBeVisible();
  await expect(progress).toContainText(/\d+% of an estimated \d/);
  await expect(progress).toContainText(/of about [\d,]+ data rows · \d+ of 1 source files/);
  await expect(waiting).toContainText("Ready", { timeout: 20_000 });
  await expect(waiting.getByTestId("export-progress")).toHaveCount(0);
  await expect(waiting).toContainText("single-use and short-lived");
  await expect(waiting).toContainText("SHA-256");

  await waiting.getByText("Contents and checksums").click();
  const files = waiting.getByRole("region", { name: /^Files in the export requested/ });
  await expect(files).toContainText("published-data/observations-0001.csv");
  await expect(files).toContainText("access-audit/access-audit-0001.csv");
  await expect(files).toContainText("source-documents/inventory-0001.csv");
  // F10b: the source document file the organization may redistribute is in the archive, and is counted; the individual file is listed in the archive's own manifest.
  await expect(waiting).toContainText("1 source document file (");
  await expect(waiting).toContainText("in the archive, each listed with its size and SHA-256 in manifest.json");
  // Contractual data rights: what was left out is a count, and the documents listed without their file are said so.
  await expect(waiting).toContainText("Funds: 2 included, 1 left out.");
  await expect(waiting).toContainText("Source files: 1 included, 1 left out");
  await expect(waiting).toContainText("Not included: Source document files.");
  await waiting.getByText("History", { exact: true }).click();
  await expect(waiting.getByRole("listitem").filter({ hasText: /approved by demo-user/ })).toHaveCount(1);
  await expect(waiting.getByRole("listitem").filter({ hasText: /build completed by system:tenant-export/ })).toHaveCount(1);

  const [download] = await Promise.all([page.waitForEvent("download"), waiting.getByRole("button", { name: "Download export" }).click()]);
  expect(download.suggestedFilename()).toBe("corvis-tenant-export.zip");
  const path = await download.path();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  // The archive names the source file it carries, and its manifest comes last.
  expect(bytes.includes(Buffer.from("source-documents/files/doc-adv-viii-q2/"))).toBe(true);
  expect(bytes.lastIndexOf(Buffer.from("manifest.json"))).toBeGreaterThan(bytes.indexOf(Buffer.from("source-documents/files/doc-adv-viii-q2/")));
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
  await expect(card(page, "Records review at contract end")).toContainText("Ready", { timeout: 20_000 });
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

test("a request waiting for this admin is flagged at the top of the page, links to it, and clears once it is decided (F10d)", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  const notice = page.getByRole("status").filter({ hasText: "A data export is awaiting your approval" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("only built if a different Organization Admin approves it");
  // No new navigation item: the indicator is on the page itself, above the sections, and links to the request.
  await expect(page.getByRole("link", { name: "Review the request" })).toHaveAttribute("href", "#export-heading");
  const violations = await blockingViolations(page, "[data-testid='export-approval-notice']");
  expect(violations, describe(violations)).toEqual([]);

  await card(page, COLLEAGUE_REASON).getByRole("button", { name: "Reject" }).click();
  await card(page, COLLEAGUE_REASON).getByRole("textbox", { name: "Why are you rejecting it?" }).fill("Not needed.");
  await card(page, COLLEAGUE_REASON).getByRole("button", { name: "Confirm rejection" }).click();
  await expect(card(page, COLLEAGUE_REASON)).toContainText("Rejected");
  await expect(notice).toHaveCount(0);

  // The admin's own pending request is not waiting for them: nothing to approve, so no notice.
  await page.getByRole("textbox", { name: "Why do you need this export?" }).fill("Records review at contract end");
  await page.getByRole("button", { name: "Request full export" }).click();
  await expect(card(page, "Records review at contract end")).toContainText("Pending");
  await expect(notice).toHaveCount(0);
});

test("the request list is paged with a cursor: older requests load on demand and each appears once (F10f)", async ({ page }) => {
  const { headers } = await isolate(page);
  // Page size one, so the seeded three requests span three pages.
  await page.route(/\/api\/v1\/access\/data-exports(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET") url.searchParams.set("limit", "1");
    return route.fallback({ url: url.toString() });
  });
  await page.goto("/access-self-service");
  const list = page.getByRole("list", { name: "Data export requests" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(card(page, COLLEAGUE_REASON)).toBeVisible();
  const older = page.getByRole("button", { name: "Show older requests" });
  await older.click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").nth(1)).toContainText("Ready");
  await older.click();
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list.getByRole("listitem").nth(2)).toContainText("Rejected");
  await expect(older).toHaveCount(0);
  const violations = await blockingViolations(page, "section[aria-labelledby='export-heading']");
  expect(violations, describe(violations)).toEqual([]);

  // The same contract over the API: a stable cursor, each request once, and a malformed cursor is refused.
  const first = (await (await page.request.get("/api/v1/access/data-exports?limit=2", { headers })).json()) as { data: Array<{ requestId: string }>; nextCursor: string | null };
  expect(first.data).toHaveLength(2);
  expect(first.nextCursor).toBeTruthy();
  const rest = (await (await page.request.get(`/api/v1/access/data-exports?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, { headers })).json()) as { data: Array<{ requestId: string }>; nextCursor: string | null };
  expect(rest.data).toHaveLength(1);
  expect(rest.nextCursor).toBeNull();
  expect(new Set([...first.data, ...rest.data].map((item) => item.requestId)).size).toBe(3);
  expect((await page.request.get("/api/v1/access/data-exports?cursor=garbage", { headers })).status()).toBe(400);
});

test("only Organization Admins get these routes: another role is refused, and nothing is rendered for a failed load", async ({ page }) => {
  const { tenant } = await isolate(page);
  const denied = await page.request.get("/api/v1/access/retention", { headers: { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "analyst" } });
  expect(denied.status()).toBe(403);
  const deniedList = await page.request.get("/api/v1/access/data-exports", { headers: { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "read_only" } });
  expect(deniedList.status()).toBe(403);

  await page.unroute(/\/api\/v1\/access\/(retention|data-exports|deletion-requests)/);
  await page.route(/\/api\/v1\/access\/(retention|data-exports|deletion-requests)/, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporarily_unavailable" }) }));
  await page.goto("/access-self-service");
  await expect(page.getByRole("alert").filter({ hasText: "Retention settings are unavailable" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Export requests are unavailable" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Retention periods" })).toHaveCount(0);
  const violations = await blockingViolations(page, "section[aria-labelledby='export-heading']");
  expect(violations, describe(violations)).toEqual([]);
});
