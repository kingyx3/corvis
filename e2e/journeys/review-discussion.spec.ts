import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { accessibilityBudget } from "../quality/quality-budgets.ts";

// Assign and discuss review items (F3, #259). The demo composition serves /api/v1/review-items from an in-memory store
// scoped to the demo tenant and workspace, so every test pins its own tenant: an assignment or a comment in one test can
// never leak into another. The demo people are the signed-in person and two review teammates.

type Violation = { id: string; impact?: string | null; help: string; nodes: Array<{ target: unknown[] }> };

async function blockingViolations(page: Page, include?: string): Promise<Violation[]> {
  const builder = new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]);
  const results = await (include ? builder.include(include) : builder).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

function describe(violations: Violation[]): string {
  return violations.map((violation) => `${violation.impact}/${violation.id}: ${violation.help} (${violation.nodes.length} node(s), first: ${JSON.stringify(violation.nodes[0]?.target)})`).join("\n");
}

const PRIYA = "priya.nair@example.test";
const MARCUS = "marcus.chen@example.test";

// The dev server compiles each route on first use and may reset module-level demo state while it does; touching every
// route once up front keeps a test's assignments from vanishing mid-test.
test.beforeAll(async ({ request }) => {
  const headers = { "x-corvis-demo-tenant": "e2e-review-warmup", "x-corvis-demo-roles": "reviewer" };
  await request.get("/api/v1/review-items", { headers });
  await request.get("/api/v1/review-items/assigned", { headers });
  await request.get("/api/v1/review-items/observation/obs-4", { headers });
  await request.put("/api/v1/review-items/observation/obs-4/assignee", { headers, data: { assigneeUserId: null, expectedVersion: 0 } });
  await request.post("/api/v1/review-items/observation/obs-4/comments", { headers, data: { idempotencyKey: "warmup", body: "warmup" } });
});

type Role = "admin" | "analyst" | "read_only";

/** Gives this page its own tenant (and the demo role the API should see), for every review-item call it makes. */
async function isolate(page: Page, role: Role = "admin"): Promise<{ tenant: string; headers: Record<string, string> }> {
  const tenant = `e2e-${randomUUID()}`;
  const headers = { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": role === "admin" ? "admin" : role };
  await page.route("**/api/v1/review-items**", (route) => route.continue({ headers: { ...route.request().headers(), ...headers } }));
  await page.addInitScript((value) => window.sessionStorage.setItem("corvis:demo:role", value), role);
  return { tenant, headers };
}

async function openReview(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.getByRole("button", { name: /^data review$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
}

// The observation and the exception both mention Northstar Health: tell their buttons apart by what follows "fair value".
const OBS_BUTTON = /^assign or discuss northstar health fair value(,|$)/i;
const EXC_BUTTON = /^assign or discuss northstar health fair value differs/i;
const northstar = (page: Page): Locator => page.getByRole("row").filter({ hasText: "Northstar Health" }).filter({ has: page.getByRole("button", { name: OBS_BUTTON }) });
const dialogOf = (page: Page): Locator => page.getByRole("dialog", { name: /^assign and discuss: northstar health fair value$/i });

test("Data review: an observation is assigned, discussed with an @mention, reassigned and unassigned, and the filters follow @matrix", async ({ page }) => {
  await isolate(page);
  await openReview(page);
  const row = northstar(page);
  await expect(row.getByText("Unassigned")).toBeVisible();

  await row.getByRole("button", { name: OBS_BUTTON }).click();
  const dialog = dialogOf(page);
  await expect(dialog.getByRole("heading", { name: "Assign and discuss" })).toBeVisible();
  await expect(dialog.getByText("Discussion does not decide anything")).toBeVisible();
  // Only people with review access can be offered: the demo person and the two review teammates.
  const assignee = dialog.getByRole("combobox", { name: "Assignee" });
  await expect(assignee.locator("option")).toHaveText(["Unassigned", "demo-user (you) · Organization Admin", `${PRIYA} · Review Analyst`, `${MARCUS} · Review Analyst`]);
  await expect(dialog.getByRole("button", { name: "Save assignment" })).toBeDisabled();

  const assigned = page.waitForRequest((request) => request.url().includes("/review-items/observation/obs-4/assignee") && request.method() === "PUT");
  await assignee.selectOption({ label: `${PRIYA} · Review Analyst` });
  await dialog.getByRole("button", { name: "Save assignment" }).click();
  expect((await assigned).postDataJSON()).toMatchObject({ assigneeUserId: "demo-member-priya", expectedVersion: 0 });
  await expect(dialog.getByText(`Assigned to ${PRIYA}.`, { exact: true })).toBeVisible();

  // Comment with a mention picked from the people who can be mentioned.
  await dialog.getByRole("combobox", { name: "Mention a teammate" }).selectOption({ label: `${PRIYA} · Review Analyst` });
  const composer = dialog.getByRole("textbox", { name: "Add a comment" });
  await expect(composer).toHaveValue(`@${PRIYA} `);
  await composer.pressSequentially("which source page is authoritative for <b>this</b> value?");
  const violations = await blockingViolations(page, '[role="dialog"]');
  expect(violations, describe(violations)).toEqual([]);
  const posted = page.waitForRequest((request) => request.url().endsWith("/review-items/observation/obs-4/comments") && request.method() === "POST");
  await dialog.getByRole("button", { name: "Post comment" }).click();
  const payload = (await posted).postDataJSON() as Record<string, unknown>;
  expect(payload).toMatchObject({ body: `@${PRIYA} which source page is authoritative for <b>this</b> value?`, mentionUserIds: ["demo-member-priya"] });
  expect(typeof payload.idempotencyKey).toBe("string");
  const thread = dialog.getByRole("list", { name: "Comments, oldest first" });
  await expect(thread.getByRole("listitem")).toHaveCount(1);
  await expect(thread).toContainText("<b>this</b> value?");
  expect(await thread.locator("b").count(), "comment text is text, never markup").toBe(0);
  await expect(thread.locator(".review-mention")).toHaveText(`@${PRIYA}`);
  await expect(composer).toHaveValue("");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  // The row shows the assignee and the comment count; nothing about the observation changed.
  await expect(row.getByText(`Assigned to ${PRIYA}`)).toBeVisible();
  await expect(row.getByRole("button", { name: /, 1 comment$/ })).toBeVisible();
  await expect(row.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(row.getByText("$294.5m")).toBeVisible();

  // Filters: "Assigned to me" excludes it, "Unassigned" excludes it and keeps the rest.
  const filter = page.getByRole("combobox", { name: "Assignment" });
  await filter.selectOption("mine");
  await expect(page.getByText(/no observations match the current review filters, including the assignment filter/i)).toBeVisible();
  await filter.selectOption("unassigned");
  await expect(northstar(page)).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "ABC Corp" }).first()).toBeVisible();

  // Reassign to me: it now matches "Assigned to me" only.
  await filter.selectOption("all");
  await northstar(page).getByRole("button", { name: OBS_BUTTON }).click();
  await dialog.getByRole("combobox", { name: "Assignee" }).selectOption({ label: "demo-user (you) · Organization Admin" });
  await dialog.getByRole("button", { name: "Save assignment" }).click();
  await expect(dialog.getByText("Assigned to you.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(northstar(page).getByText("Assigned to you")).toBeVisible();
  await filter.selectOption("mine");
  await expect(page.getByRole("row").filter({ hasText: "Northstar Health" })).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: "ABC Corp" })).toHaveCount(0);

  // Unassign.
  await northstar(page).getByRole("button", { name: OBS_BUTTON }).click();
  await dialog.getByRole("combobox", { name: "Assignee" }).selectOption("");
  await dialog.getByRole("button", { name: "Save assignment" }).click();
  await expect(dialog.getByText("Assignment cleared.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await filter.selectOption("unassigned");
  await expect(northstar(page).getByText("Unassigned")).toBeVisible();
});

test("Data review: a reconciliation exception is assigned and discussed the same way", async ({ page }) => {
  await isolate(page);
  await openReview(page);
  const table = page.getByRole("region", { name: "Reconciliation exceptions table" });
  await expect(table.getByText("Unassigned")).toBeVisible();
  await table.getByRole("button", { name: EXC_BUTTON }).click();
  const dialog = page.getByRole("dialog", { name: /^assign and discuss: northstar health fair value differs/i });
  await dialog.getByRole("combobox", { name: "Assignee" }).selectOption({ label: `${MARCUS} · Review Analyst` });
  await dialog.getByRole("button", { name: "Save assignment" }).click();
  await expect(dialog.getByText(`Assigned to ${MARCUS}.`, { exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Add a comment" }).fill("Competing values come from two annexes.");
  await dialog.getByRole("button", { name: "Post comment" }).click();
  await expect(dialog.getByRole("list", { name: "Comments, oldest first" }).getByRole("listitem")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(table.getByText(`Assigned to ${MARCUS}`)).toBeVisible();
  // The exception is still open and still resolvable: discussion decided nothing.
  await expect(table.getByRole("button", { name: /select authoritative source|mark immaterial|accept reconciliation/i }).first()).toBeVisible();

  await page.getByRole("combobox", { name: "Assignment" }).selectOption("mine");
  await expect(page.getByText(/no reconciliation exceptions match the assignment filter/i)).toBeVisible();
});

test("Overview: the attention list narrows to the review items assigned to me, blocking exceptions first @matrix", async ({ page }) => {
  await isolate(page);
  await openReview(page);
  const assign = async (name: RegExp, dialogName: RegExp) => {
    await page.getByRole("button", { name }).first().click();
    const dialog = page.getByRole("dialog", { name: dialogName });
    await dialog.getByRole("combobox", { name: "Assignee" }).selectOption({ label: "demo-user (you) · Organization Admin" });
    await dialog.getByRole("button", { name: "Save assignment" }).click();
    await expect(dialog.getByText("Assigned to you.", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  };
  await assign(EXC_BUTTON, /^assign and discuss: northstar health fair value differs/i);
  await assign(OBS_BUTTON, /^assign and discuss: northstar health fair value$/i);

  await page.goto("/");
  const panel = page.locator("#needs-attention");
  await expect(panel.getByRole("button", { name: "All items" })).toHaveAttribute("aria-pressed", "true");
  const mine = panel.getByRole("button", { name: /^assigned to me/i });
  await expect(mine).toHaveText("Assigned to me (2)");
  await mine.click();
  await expect(panel.getByRole("heading", { name: "2 items assigned to you" })).toBeVisible();
  const list = panel.getByRole("list", { name: "Review items assigned to you" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first()).toContainText("Northstar Health fair value differs between source reports");
  await expect(list.getByRole("listitem").first()).toContainText("Blocking");
  await expect(list.getByRole("listitem").nth(1)).toContainText("Northstar Health · Fair value");
  const violations = await blockingViolations(page, "#needs-attention");
  expect(violations, describe(violations)).toEqual([]);

  await list.getByRole("listitem").nth(1).getByRole("button").click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Northstar Health" }).filter({ hasText: "Assigned to you" }).first()).toBeVisible();

  await page.goto("/");
  await page.locator("#needs-attention").getByRole("button", { name: /^all items/i }).click();
  await expect(page.locator("#needs-attention").getByRole("list").first().getByRole("listitem").first()).toBeVisible();
});

test("Overview: with nothing assigned the 'Assigned to me' view says so", async ({ page }) => {
  await isolate(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.locator("#needs-attention").getByRole("button", { name: /^assigned to me/i }).click();
  await expect(page.getByText("Nothing is assigned to you")).toBeVisible();
});

test("a role that cannot review sees no assignment controls and never calls the review-item API", async ({ page }) => {
  await isolate(page, "read_only");
  const calls: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/v1/review-items")) calls.push(request.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^assigned to me/i })).toHaveCount(0);
  await page.getByRole("button", { name: /^data review$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^assign or discuss/i })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Assignment" })).toHaveCount(0);
  expect(calls).toEqual([]);
});

test("when assignments cannot be loaded, review still works and the assignment filter is off", async ({ page }) => {
  await isolate(page);
  await page.route("**/api/v1/review-items?**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal_error", correlationId: "x" }) }));
  await openReview(page);
  await expect(page.getByText("Assignments unavailable")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Assignment" })).toBeDisabled();
  await expect(northstar(page).getByRole("button", { name: "Approve" })).toBeVisible();
});

test("API: assignment is compare-and-set, only reviewers with access are eligible, comments replay safely and nothing is decided", async ({ request }) => {
  const tenant = `e2e-${randomUUID()}`;
  const headers = { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "reviewer" };
  const url = "/api/v1/review-items/observation/obs-4";
  const thread = await (await request.get(url, { headers })).json() as { data: { version: number; members: Array<{ userId: string }> } };
  expect(thread.data.version).toBe(0);
  expect(thread.data.members).toHaveLength(3);
  expect(thread.data.members.map((member) => member.userId)).toEqual(expect.arrayContaining(["demo-member-priya", "demo-member-marcus"]));

  const ok = await request.put(`${url}/assignee`, { headers, data: { assigneeUserId: "demo-member-priya", expectedVersion: 0 } });
  expect(ok.status()).toBe(200);
  const stale = await request.put(`${url}/assignee`, { headers, data: { assigneeUserId: "demo-member-marcus", expectedVersion: 0 } });
  expect(stale.status()).toBe(409);
  expect(((await stale.json()) as { error: string }).error).toBe("assignment_changed");
  const ineligible = await request.put(`${url}/assignee`, { headers, data: { assigneeUserId: "demo-member-jordan", expectedVersion: 1 } });
  expect(ineligible.status()).toBe(422);
  expect(((await ineligible.json()) as { error: string }).error).toBe("assignee_not_eligible");

  const first = await request.post(`${url}/comments`, { headers, data: { idempotencyKey: "k-1", body: "hello", mentionUserIds: ["demo-member-priya"] } });
  expect(first.status()).toBe(201);
  const replay = await request.post(`${url}/comments`, { headers, data: { idempotencyKey: "k-1", body: "hello", mentionUserIds: ["demo-member-priya"] } });
  expect(replay.status()).toBe(200);
  expect(((await replay.json()) as { replayed: boolean }).replayed).toBe(true);
  const badMention = await request.post(`${url}/comments`, { headers, data: { idempotencyKey: "k-2", body: "hello", mentionUserIds: ["demo-member-jordan"] } });
  expect(badMention.status()).toBe(422);

  const analyst = await request.get(url, { headers: { ...headers, "x-corvis-demo-roles": "analyst" } });
  expect(analyst.status()).toBe(403);
  expect((await request.get("/api/v1/review-items/observation/does-not-exist", { headers })).status()).toBe(404);
});
