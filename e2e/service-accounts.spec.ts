import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { accessibilityBudget } from "./quality-budgets.ts";

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
  // The honest status of the credential mechanism is on the page, not buried in documentation.
  await expect(page.getByText(/credentials are not yet accepted by the api/i)).toBeVisible();
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
