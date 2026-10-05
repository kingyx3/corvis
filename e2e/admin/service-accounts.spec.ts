import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { accessibilityBudget } from "../quality/quality-budgets.ts";

// Service accounts (F6, #262), on the Organization Admin's access self-service page. The demo composition serves
// /api/v1/access/service-accounts from an in-memory store seeded per demo tenant, so every test pins its own tenant: a
// rotation or deactivation in one test can never leak into another. The rest of this page (invitations, support access,
// audit) needs a database and is not part of the demo composition, so its own "needs attention" banner is expected here.

type Violation = { id: string; impact?: string | null; help: string; nodes: Array<{ target: unknown[] }> };

async function blockingViolations(page: Page, include?: string): Promise<Violation[]> {
  const builder = new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]);
  const results = await (include ? builder.include(include) : builder).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

function describe(violations: Violation[]): string {
  return violations.map((violation) => `${violation.impact}/${violation.id}: ${violation.help} (${violation.nodes.length} node(s), first: ${JSON.stringify(violation.nodes[0]?.target)})`).join("\n");
}

// The dev server compiles each route on first use and may reset module-level demo state while it does; touching every
// route once up front keeps a test's seeded accounts from vanishing mid-test.
test.beforeAll(async ({ request }) => {
  const headers = { "x-corvis-demo-tenant": "e2e-warmup", "x-corvis-demo-roles": "admin" };
  const missing = "00000000-0000-4000-8000-000000000000";
  await request.get("/api/v1/access/service-accounts", { headers });
  await request.get(`/api/v1/access/service-accounts/${missing}`, { headers });
  await request.post(`/api/v1/access/service-accounts/${missing}`, { headers, data: { action: "issue" } });
});

/** Gives this page its own seeded tenant for every call it makes to the service-account routes. */
async function isolate(page: Page): Promise<string> {
  const tenant = `e2e-${randomUUID()}`;
  const headers = { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "admin" };
  await page.route(/\/api\/v1\/access\/service-accounts/, (route) => route.continue({ headers: { ...route.request().headers(), ...headers } }));
  return tenant;
}

const SECTION = "section[aria-labelledby='service-accounts-heading']";
const card = (page: Page, name: string | RegExp): Locator => page.getByRole("list", { name: "Service accounts" }).getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3, name }) });
const SECRET = /corvis_sa_[0-9a-f]{32}_[A-Za-z0-9_-]{43}/;

async function open(page: Page): Promise<void> {
  await isolate(page);
  await page.goto("/access-self-service");
  await expect(page.getByRole("heading", { name: /^service accounts$/i })).toBeVisible();
  await expect(card(page, "Nightly reporting sync")).toBeVisible();
}

test("the list shows role, workspace, creator, last used and expiry, and flags a credential nearing expiry @matrix", async ({ page }) => {
  await open(page);
  const nightly = card(page, "Nightly reporting sync");
  await expect(nightly).toContainText("Needs attention");
  await expect(nightly).toContainText("Expiring soon");
  const facts = nightly.getByRole("list", { name: /details of nightly reporting sync/i }).or(nightly.locator("dl"));
  await expect(facts).toContainText("Analyst");
  await expect(facts).toContainText("Primary Workspace");
  await expect(facts).toContainText("morgan.lee@meridian.example");
  await expect(facts.locator("div").filter({ hasText: /^Last used/ })).not.toContainText("Never used");
  await expect(facts.locator("div").filter({ hasText: /^Credential expires/ })).not.toContainText("No credential in use");
  // A healthy account is not flagged; a deactivated one shows who, when and why, and offers nothing.
  const reader = card(page, "Compliance export reader");
  await expect(reader).not.toContainText("Needs attention");
  await expect(reader).toContainText("Viewer");
  const retired = card(page, "Retired data bridge");
  await expect(retired).toContainText("Disabled");
  await expect(retired).toContainText("Replaced by the nightly reporting sync");
  await expect(retired.getByRole("button", { name: /rotate|revoke|issue|deactivate/i })).toHaveCount(0);
  // How a credential is used is on the page, not buried in documentation.
  await expect(page.getByText(/how your systems use a credential/i)).toBeVisible();
  await expect(page.getByText(/api\/v1\/auth\/service-account\/token/)).toBeVisible();
  const violations = await blockingViolations(page, SECTION);
  expect(violations, describe(violations)).toEqual([]);
});

test("a credential is shown exactly once: at creation, never again, not even after a reload @matrix", async ({ page }) => {
  await open(page);
  const form = page.locator(`${SECTION} form`);
  await form.getByLabel("Name").fill("Warehouse loader");
  await form.getByLabel("What it is for").fill("Loads published fund data into our warehouse");
  await expect(form.getByRole("button", { name: /create service account/i })).toBeEnabled();
  await form.getByLabel("Role").selectOption({ label: "Viewer" });
  await form.getByRole("button", { name: /create service account/i }).click();

  const reveal = page.getByRole("group", { name: "New API credential" });
  await expect(reveal).toBeVisible();
  const secret = await reveal.getByLabel("API credential (shown once)").inputValue();
  expect(secret).toMatch(SECRET);
  await expect(page.getByRole("status").filter({ hasText: /Warehouse loader created/ })).toBeVisible();
  const violations = await blockingViolations(page, SECTION);
  expect(violations, describe(violations)).toEqual([]);

  // The new account is listed with the role chosen and no credential use yet.
  const created = card(page, "Warehouse loader");
  await expect(created).toContainText("Viewer");
  await expect(created.locator("dl")).toContainText("Never used");
  // Nothing the page lists or the API returns for it carries the secret again.
  await expect(created).not.toContainText(secret);
  await created.getByText(/^Credentials \(1\)/).click();
  await expect(created.getByRole("region", { name: /credentials of warehouse loader/i })).toContainText("Active");
  await expect(reveal.getByLabel("API credential (shown once)")).toHaveValue(secret); // still in the reveal panel until dismissed
  await reveal.getByRole("button", { name: /i have stored it/i }).click();
  await expect(reveal).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(secret);
  expect(await page.content()).not.toContain(secret);

  await page.reload();
  await expect(card(page, "Warehouse loader")).toBeVisible();
  expect(await page.content()).not.toContain(secret);
});

test("rotating issues a new credential and leaves the old one working for the overlap @matrix", async ({ page }) => {
  await open(page);
  const nightly = card(page, "Nightly reporting sync");
  await nightly.getByRole("button", { name: "Rotate credential" }).click();
  const rotation = nightly.getByRole("group", { name: /rotate the credential of nightly reporting sync/i });
  await expect(rotation).toBeVisible();
  await rotation.getByLabel("Keep the old credential working for").selectOption({ label: "1 hour" });
  const violations = await blockingViolations(page, SECTION);
  expect(violations, describe(violations)).toEqual([]);
  await nightly.getByRole("button", { name: "Confirm rotation" }).click();

  const reveal = page.getByRole("group", { name: "New API credential" });
  await expect(reveal).toContainText("Copy the rotated API credential now");
  expect(await reveal.getByLabel("API credential (shown once)").inputValue()).toMatch(SECRET);
  await expect(page.getByRole("status").filter({ hasText: "Credential rotated." })).toBeVisible();
  await nightly.getByText(/^Credentials \(2\)/).click();
  const credentials = nightly.getByRole("region", { name: /credentials of nightly reporting sync/i });
  await expect(credentials).toContainText("Rotating out");
  await expect(credentials).toContainText("Active");
  await expect(nightly).not.toContainText("Needs attention"); // the replacement is a fresh 90 day credential
});

test("revoking needs a reason, takes effect for every credential at once, and lets a new one be issued @matrix", async ({ page }) => {
  await open(page);
  const reader = card(page, "Compliance export reader");
  await reader.getByRole("button", { name: "Revoke credential" }).click();
  const confirm = reader.getByRole("button", { name: "Confirm revocation" });
  await expect(confirm).toBeDisabled();
  const violations = await blockingViolations(page, SECTION);
  expect(violations, describe(violations)).toEqual([]);
  await reader.getByLabel("Reason").fill("Credential found in a log file");
  await confirm.click();
  await expect(page.getByRole("status").filter({ hasText: /stopped working immediately/ })).toBeVisible();
  await reader.getByText(/^Credentials \(1\)/).click();
  await expect(reader.getByRole("region", { name: /credentials of compliance export reader/i })).toContainText("Revoked");
  await expect(reader.getByRole("button", { name: "Rotate credential" })).toHaveCount(0);
  await expect(reader.getByRole("button", { name: "Revoke credential" })).toHaveCount(0);

  await reader.getByRole("button", { name: "Issue credential" }).click();
  await reader.getByRole("button", { name: "Confirm issue" }).click();
  const reveal = page.getByRole("group", { name: "New API credential" });
  expect(await reveal.getByLabel("API credential (shown once)").inputValue()).toMatch(SECRET);
  await expect(reader.getByRole("button", { name: "Rotate credential" })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Issue credential" })).toHaveCount(0);
});

test("deactivating an account removes it everywhere after a reason and a confirmation, and is final @matrix", async ({ page }) => {
  await open(page);
  const reader = card(page, "Compliance export reader");
  await reader.getByRole("button", { name: "Deactivate account" }).click();
  await expect(reader.getByText("Deactivate this account everywhere?")).toBeVisible();
  const confirm = reader.getByRole("button", { name: "Confirm deactivation" });
  await expect(confirm).toBeDisabled();
  await reader.getByLabel("Reason").fill("Integration retired");
  await confirm.click();
  await expect(page.getByRole("status").filter({ hasText: /Compliance export reader deactivated everywhere/ })).toBeVisible();
  await expect(reader).toContainText("Disabled");
  await expect(reader).toContainText("Integration retired");
  await expect(reader.getByRole("button", { name: /rotate|revoke|issue|deactivate/i })).toHaveCount(0);
  const violations = await blockingViolations(page, SECTION);
  expect(violations, describe(violations)).toEqual([]);
});

test("the form refuses what the server would refuse, and a duplicate name is explained @matrix", async ({ page }) => {
  await open(page);
  const form = page.locator(`${SECTION} form`);
  const submit = form.getByRole("button", { name: /create service account/i });
  await expect(submit).toBeDisabled();
  await form.getByLabel("Name").fill("ab");
  await form.getByLabel("What it is for").fill("Loads data");
  await expect(submit).toBeDisabled();
  // The role list offers only the ordinary roles: a machine is never an administrator.
  await expect(form.getByLabel("Role").locator("option")).toHaveText(["Review Analyst", "Analyst", "Viewer"]);
  await form.getByLabel("Name").fill("Nightly reporting sync");
  await submit.click();
  await expect(page.getByRole("alert").filter({ hasText: /another active service account already has this name/i })).toBeVisible();
  await expect(page.getByRole("group", { name: "New API credential" })).toHaveCount(0);
});

test("an admin extends an account's expiry within the maximum, with the new date shown before confirming and an audited result @matrix", async ({ page }) => {
  await open(page);
  const nightly = card(page, "Nightly reporting sync");
  const facts = nightly.locator("dl");
  await expect(facts.locator("div").filter({ hasText: /^Owner/ })).toContainText("morgan.lee@meridian.example");
  const before = await facts.locator("div").filter({ hasText: /^Account expires/ }).innerText();

  await nightly.getByRole("button", { name: "Extend expiry" }).click();
  const panel = nightly.getByRole("group", { name: "Extend Nightly reporting sync" });
  const days = panel.getByLabel("New expiry, in days from today");
  await expect(days).toHaveValue("365");
  await expect(panel).toContainText("The account will expire on");
  await expect(panel).toContainText("its review date moves with it");
  // Fewer days than would move the expiry later is refused before anything is sent.
  await days.fill("10");
  await expect(panel).toContainText(/Choose at least \d+ days/);
  await expect(days).toHaveAttribute("aria-invalid", "true");
  await expect(nightly.getByRole("button", { name: "Confirm extension" })).toBeDisabled();
  await days.fill("365");
  await expect(days).not.toHaveAttribute("aria-invalid", "true");
  const violations = await blockingViolations(page, SECTION);
  expect(violations, describe(violations)).toEqual([]);

  await nightly.getByRole("button", { name: "Confirm extension" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Expiry extended to / })).toBeVisible();
  await expect(facts.locator("div").filter({ hasText: /^Account expires/ })).not.toHaveText(before);
  // As far out as an account can be: nothing further to offer, and the other actions are untouched.
  await expect(nightly.getByRole("button", { name: "Extend expiry" })).toHaveCount(0);
  await expect(nightly.getByRole("button", { name: "Rotate credential" })).toBeVisible();
});

test("an account whose owner was deactivated is surfaced as needing a new owner, is not extended, and is handed to an active admin @matrix", async ({ page }) => {
  await open(page);
  const feed = card(page, "Partner data feed");
  await expect(feed).toContainText("Needs a new owner.");
  await expect(feed).toContainText("Needs attention");
  await expect(feed.locator("dl")).toContainText("alex.rivera@meridian.example (no longer active)");
  await expect(feed).toContainText("it cannot be extended until an active Organization Admin takes it over");
  // It keeps working: its credential is still manageable. But it is not renewed while it has no owner.
  await expect(feed.getByRole("button", { name: "Rotate credential" })).toBeVisible();
  await expect(feed.getByRole("button", { name: "Extend expiry" })).toHaveCount(0);
  let violations = await blockingViolations(page, SECTION);
  expect(violations, describe(violations)).toEqual([]);

  await feed.getByRole("button", { name: "Assign a new owner" }).click();
  const panel = feed.getByRole("group", { name: "Change the owner of Partner data feed" });
  const choice = panel.getByLabel("New owner");
  await expect(feed.getByRole("button", { name: "Confirm new owner" })).toBeDisabled();
  // Only active Organization Admins are offered, and not the person who no longer is one.
  const offered = await choice.locator("option").allTextContents();
  expect(offered).toContain("priya.nair@meridian.example");
  expect(offered).not.toContain("alex.rivera@meridian.example");
  violations = await blockingViolations(page, SECTION);
  expect(violations, describe(violations)).toEqual([]);
  await choice.selectOption("priya.nair@meridian.example");
  await feed.getByRole("button", { name: "Confirm new owner" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Partner data feed is now owned by priya.nair@meridian.example." })).toBeVisible();
  await expect(feed).not.toContainText("Needs a new owner.");
  await expect(feed.locator("dl")).toContainText("priya.nair@meridian.example");
  await expect(feed.locator("dl")).not.toContainText("no longer active");

  // With an owner again it can be extended.
  await feed.getByRole("button", { name: "Extend expiry" }).click();
  await feed.getByRole("button", { name: "Confirm extension" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Expiry extended to / })).toBeVisible();
});

test("a healthy account's owner can be changed, never to the current owner, and a refused change is explained @matrix", async ({ page }) => {
  await open(page);
  const reader = card(page, "Compliance export reader");
  await reader.getByRole("button", { name: "Change owner" }).click();
  const choice = reader.getByRole("group", { name: "Change the owner of Compliance export reader" }).getByLabel("New owner");
  expect(await choice.locator("option").allTextContents()).not.toContain("morgan.lee@meridian.example");
  // The owner is changed under another page's feet: the server's refusal is explained, and nothing changes.
  await page.route(/\/api\/v1\/access\/service-accounts\/[0-9a-f-]+$/, (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "service_account_owner_unchanged" }) })
    : route.fallback());
  await choice.selectOption("priya.nair@meridian.example");
  await reader.getByRole("button", { name: "Confirm new owner" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That person already owns this account" })).toBeVisible();
  await expect(reader.locator("dl")).toContainText("morgan.lee@meridian.example");
});

test("a deactivated account offers neither an extension nor a new owner @matrix", async ({ page }) => {
  await open(page);
  const retired = card(page, "Retired data bridge");
  await expect(retired.getByRole("button", { name: /extend expiry|change owner|assign a new owner/i })).toHaveCount(0);
  await expect(retired).not.toContainText("Needs a new owner.");
});

// ------------------------------------------------------------------ data access self-service (F6c, #342)
test("seeded accounts show what they can read, and flag access the organization's data rights no longer cover @matrix", async ({ page }) => {
  await open(page);
  const nightly = card(page, "Nightly reporting sync");
  const access = nightly.getByRole("group", { name: "Data access of Nightly reporting sync" });
  await expect(access).toContainText("Advent International GPE VIII");
  await expect(access).toContainText("EQT IX");
  await expect(access).toContainText("Can view");
  await expect(access).not.toContainText("Not covered");
  // This one was granted when the organization's right to the fund existed; it no longer does, and the screen says so.
  const reader = card(page, "Compliance export reader");
  await expect(reader.getByRole("group", { name: "Data access of Compliance export reader" })).toContainText("Not covered by your organization's data rights");
  // An account with nothing granted says so, and a deactivated one offers no way to grant.
  await expect(card(page, "Partner data feed").getByRole("group", { name: "Data access of Partner data feed" })).toContainText("It cannot see any fund or document yet.");
  const retired = card(page, "Retired data bridge");
  await expect(retired.getByRole("group", { name: "Data access of Retired data bridge" })).toContainText("Deactivated: it has no access.");
  await expect(retired.getByRole("button", { name: /grant data access|remove access/i })).toHaveCount(0);
  const violations = await blockingViolations(page, SECTION);
  expect(violations, describe(violations)).toEqual([]);
});

test("an Organization Admin scopes a new account's data access within the organization's rights, with a reason, and can remove it @matrix", async ({ page }) => {
  await open(page);
  const form = page.locator(`${SECTION} form`);
  await form.getByLabel("Name").fill("Scoped loader");
  await form.getByLabel("What it is for").fill("Reads one fund for the warehouse");
  await form.getByRole("button", { name: /create service account/i }).click();
  await page.getByRole("group", { name: "New API credential" }).getByRole("button", { name: /i have stored it/i }).click();

  const scoped = card(page, "Scoped loader");
  await expect(scoped.getByRole("group", { name: "Data access of Scoped loader" })).toContainText("It cannot see any fund or document yet.");
  await scoped.getByRole("button", { name: "Grant data access" }).click();
  const panel = scoped.getByRole("group", { name: "Grant data access to Scoped loader" });
  const confirm = scoped.getByRole("button", { name: "Confirm grant" });
  await expect(confirm).toBeDisabled();
  // Only what the organization is licensed to see is offered: the catalog also holds a fund and a document it is not licensed for.
  const offered = await panel.getByLabel("Fund or document").locator("option").allTextContents();
  expect(offered).toContain("Fund: Nordic Capital Fund V");
  expect(offered).toContain("Document: Advent International GPE VIII — Q2 2026.pdf");
  expect(offered.join("|")).not.toContain("Hg Genesis");
  expect(offered.join("|")).not.toContain("EQT IX — Schedule");
  let violations = await blockingViolations(page, SECTION);
  expect(violations, describe(violations)).toEqual([]);

  await panel.getByLabel("Fund or document").selectOption({ label: "Fund: Nordic Capital Fund V" });
  await expect(confirm).toBeDisabled(); // a reason is required: it is kept in the audit trail
  await panel.getByLabel("Reason").fill("Feeds the reporting warehouse");
  await confirm.click();
  await expect(page.getByRole("status").filter({ hasText: "Scoped loader can now read Nordic Capital Fund V." })).toBeVisible();
  const access = scoped.getByRole("group", { name: "Data access of Scoped loader" });
  await expect(access).toContainText("Nordic Capital Fund V");
  await expect(access).toContainText("Can view");
  await expect(access).not.toContainText("Not covered");

  // Granted, so no longer offered again.
  await scoped.getByRole("button", { name: "Grant data access" }).click();
  expect(await scoped.getByLabel("Fund or document").locator("option").allTextContents()).not.toContain("Fund: Nordic Capital Fund V");
  await scoped.getByRole("button", { name: "Back" }).click();

  // Remove it, with a reason.
  await scoped.getByRole("button", { name: "Remove access to Nordic Capital Fund V from Scoped loader" }).click();
  await expect(scoped.getByText("Remove access to Nordic Capital Fund V?")).toBeVisible();
  const remove = scoped.getByRole("button", { name: "Confirm removal" });
  await expect(remove).toBeDisabled();
  violations = await blockingViolations(page, SECTION);
  expect(violations, describe(violations)).toEqual([]);
  await scoped.getByLabel("Reason").fill("No longer needed");
  await remove.click();
  await expect(page.getByRole("status").filter({ hasText: "Scoped loader can no longer read Nordic Capital Fund V." })).toBeVisible();
  await expect(access).toContainText("It cannot see any fund or document yet.");
});

test("a grant beyond the organization's data rights is refused by the server, and the screen explains it @matrix", async ({ page, request }) => {
  const tenant = await isolate(page);
  const headers = { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": "admin" };
  const listed = await request.get("/api/v1/access/service-accounts", { headers });
  const body = (await listed.json()) as { data: { serviceAccounts: Array<{ serviceAccountId: string; name: string }>; grantable: Array<{ resourceId: string }> } };
  const feed = body.data.serviceAccounts.find((account) => account.name === "Partner data feed")!;
  expect(body.data.grantable.map((resource) => resource.resourceId)).not.toContain("fund-hg-genesis-9");
  const act = (command: unknown, extra: Record<string, string> = {}) => request.post(`/api/v1/access/service-accounts/${feed.serviceAccountId}`, { headers: { ...headers, ...extra }, data: command });

  // A fund in the catalog that the organization is not licensed for, one that does not exist, and a document id used as a fund: all one refusal.
  for (const [resourceType, resourceId] of [["fund", "fund-hg-genesis-9"], ["fund", "fund-of-another-organization"], ["fund", "doc-adv-viii-q2"], ["document", "doc-hg-genesis-q2"]]) {
    const refused = await act({ action: "grant_entitlement", resourceType, resourceId, reason: "Beyond our rights" });
    expect([refused.status(), ((await refused.json()) as { error: string }).error], `${resourceType} ${resourceId}`).toEqual([422, "entitlement_outside_data_rights"]);
  }
  // It is a customer action for an Organization Admin: a role without admin:manage is refused.
  expect((await act({ action: "grant_entitlement", resourceType: "fund", resourceId: "fund-nordic-v", reason: "Self service" }, { "x-corvis-demo-roles": "analyst" })).status()).toBe(403);
  const after = (await (await request.get("/api/v1/access/service-accounts", { headers })).json()) as { data: { serviceAccounts: Array<{ name: string; entitlements: unknown[] }> } };
  expect(after.data.serviceAccounts.find((account) => account.name === "Partner data feed")!.entitlements).toEqual([]);

  // The screen explains the refusal in words when it happens (here the grant is refused under the admin's feet).
  await page.route(/\/api\/v1\/access\/service-accounts\/[0-9a-f-]+$/, (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "entitlement_outside_data_rights" }) })
    : route.fallback());
  await page.goto("/access-self-service");
  const partner = card(page, "Partner data feed");
  await partner.getByRole("button", { name: "Grant data access" }).click();
  await partner.getByLabel("Fund or document").selectOption({ label: "Fund: EQT IX" });
  await partner.getByLabel("Reason").fill("Feeds the reporting warehouse");
  await partner.getByRole("button", { name: "Confirm grant" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /not licensed to share that fund or document/i })).toBeVisible();
});
