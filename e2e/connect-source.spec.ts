import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { accessibilityBudget } from "./quality-budgets.ts";
import { confirmReview, goToConsent, goToReauthorizeConsent, isolateSourceConnections, openConnectWizard, submitToken, DEMO_OAUTH_PROVIDER, DEMO_TOKEN_PROVIDER, REAUTHORIZE_SUMMIT } from "./support/surfaces.ts";

// Connect source (B1). The demo composition serves /api/v1/source-connections from an in-memory store and offers
// two clearly labelled demo providers, so the whole flow, including the OAuth redirect through a consent page
// and back, runs end to end. Every test pins its own demo tenant so a connection made in one never leaks into another.
// Every step and error state is also scanned by the shared axe matrix (e2e/support/surfaces.ts, "connect-*").

async function asAdmin(page: Page, role: "admin" | "read_only" = "admin"): Promise<void> {
  await page.addInitScript((value) => window.sessionStorage.setItem("corvis:demo:role", value), role);
  await page.goto("/");
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Connect source" });
const stepHeading = (page: Page, name: RegExp) => dialog(page).getByRole("heading", { name });
const card = (page: Page, label: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3, name: label }) });

async function blockingViolations(page: Page, include: string) {
  const results = await new AxeBuilder({ page }).include(include).withTags([...accessibilityBudget.tags]).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

test("the entry point is not offered to a person who is not an administrator", async ({ page }) => {
  await isolateSourceConnections(page);
  await asAdmin(page, "read_only");
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^connect source$/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^source connections$/i })).toHaveCount(0);
});

test("the entry point is offered to an administrator", async ({ page }) => {
  await isolateSourceConnections(page);
  await asAdmin(page, "admin");
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await expect(page.getByRole("button", { name: /^connect source$/i })).toBeVisible();
});

test("only approved providers are listed, each with a one-line access description and a Demo label", async ({ page }) => {
  await asAdmin(page);
  await openConnectWizard(page);
  const list = page.getByRole("list", { name: "Approved sources" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("Demo GP portal (API token)");
  await expect(list).toContainText("Demo data room (sign-in with OAuth)");
  await expect(list).toContainText("Demonstration only: reads quarterly reports from a fictional GP portal");
  await expect(list.getByText("Demo", { exact: true })).toHaveCount(2);
  await expect(stepHeading(page, /^choose a source$/i)).toBeFocused();
});

test("an empty registry gets an honest empty state, not a broken wizard", async ({ page }) => {
  await isolateSourceConnections(page);
  // Registered after the tenant-pinning handler: Playwright runs the most recently registered matching handler first.
  await page.route("**/api/v1/source-connections/providers", (route) => route.fulfill({ json: { data: [] } }));
  await asAdmin(page);
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await page.getByRole("button", { name: /^connect source$/i }).click();
  await expect(page.getByTestId("connect-source-empty")).toContainText("No sources are approved for your workspace yet");
  await expect(dialog(page).getByRole("link", { name: /contact support/i })).toBeVisible();
  await dialog(page).getByRole("button", { name: /^close$/i }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole("button", { name: /^connect source$/i })).toBeFocused();
});

test("a failed provider list can be retried", async ({ page }) => {
  let failing = true;
  await isolateSourceConnections(page);
  await page.route("**/api/v1/source-connections/providers", (route) => (failing ? route.fulfill({ status: 500, json: { error: "x" } }) : route.fallback()));
  await asAdmin(page);
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await page.getByRole("button", { name: /^connect source$/i }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("could not be loaded");
  failing = false;
  await dialog(page).getByRole("button", { name: /^retry$/i }).click();
  await expect(page.getByRole("list", { name: "Approved sources" })).toBeVisible();
});

test("access is disclosed in plain language and confirmation is required before any credential field exists", async ({ page }) => {
  await asAdmin(page);
  await openConnectWizard(page);
  await page.getByRole("button", { name: DEMO_TOKEN_PROVIDER }).click();
  const heading = stepHeading(page, /^review what corvis will access$/i);
  await expect(heading).toBeFocused();
  for (const group of ["What Corvis will read", "How it works", "What Corvis will not do"]) await expect(dialog(page).getByRole("heading", { name: group })).toBeVisible();
  await expect(dialog(page)).toContainText("Quarterly reports and capital account statements for Fund III");
  await expect(dialog(page)).toContainText("/Fund III/Quarterly");
  const text = await dialog(page).innerText();
  expect(text, "plain language, not raw JSON or stored identifiers").not.toMatch(/[{}]|providerKey|sourceScope|scoped_api_token|oauth_authorization_code/);
  await expect(dialog(page).locator("input[type=password], textarea")).toHaveCount(0);

  await dialog(page).getByRole("button", { name: /^continue to enter credential$/i }).click();
  const confirm = dialog(page).getByRole("checkbox", { name: /i am authorized to give corvis access/i });
  await expect(dialog(page).getByRole("alert")).toContainText("Confirm that you are authorized");
  await expect(confirm).toBeFocused();
  await expect(confirm).toHaveAttribute("aria-invalid", "true");
  await expect(dialog(page).locator("input[type=password]")).toHaveCount(0);

  await dialog(page).getByRole("textbox", { name: /connection name/i }).fill("   ");
  await confirm.check();
  await dialog(page).getByRole("button", { name: /^continue to enter credential$/i }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Enter a name for this connection");
  await expect(dialog(page).getByRole("textbox", { name: /connection name/i })).toBeFocused();
});

test("focus follows the steps, Back keeps what was typed, and a valid token connects and tests straight away", async ({ page }) => {
  await isolateSourceConnections(page);
  const seen: string[] = [];
  page.on("response", async (response) => { if (response.url().includes("/api/v1/source-connections/connect")) seen.push(await response.text()); });
  await asAdmin(page);
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await page.getByRole("button", { name: /^connect source$/i }).click();
  await page.getByRole("button", { name: DEMO_TOKEN_PROVIDER }).click();
  await expect(stepHeading(page, /^review what corvis will access$/i)).toBeFocused();

  await dialog(page).getByRole("textbox", { name: /connection name/i }).fill("Fund III GP portal");
  await confirmReview(page);
  await expect(stepHeading(page, /^enter the credential$/i)).toBeFocused();
  const field = dialog(page).getByLabel(/^api token/i);
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toHaveAttribute("autocomplete", "off");
  await dialog(page).getByRole("button", { name: /^back$/i }).click();
  await expect(stepHeading(page, /^review what corvis will access$/i)).toBeFocused();
  await expect(dialog(page).getByRole("textbox", { name: /connection name/i })).toHaveValue("Fund III GP portal");
  await confirmReview(page);

  const token = "demo-valid-token";
  await submitToken(page, token);
  await expect(stepHeading(page, /^connection verified$/i)).toBeVisible();
  await expect(stepHeading(page, /^connection verified$/i)).toBeFocused();
  await expect(dialog(page)).toContainText("Fund III GP portal");
  await expect(dialog(page)).toContainText("Scheduled collection is not switched on yet");
  expect(await page.content(), "the credential is never rendered back").not.toContain(token);
  expect(await page.evaluate(() => JSON.stringify([window.localStorage, window.sessionStorage])), "nor kept in browser storage").not.toContain(token);
  expect(seen.join(""), "nor echoed by the API").not.toContain(token);
  expect(seen.join("")).not.toMatch(/secretReference/);

  expect(await blockingViolations(page, '[role="dialog"]')).toEqual([]);
  await dialog(page).getByRole("button", { name: /^done$/i }).click();
  await expect(dialog(page)).toBeHidden();
  const created = card(page, "Fund III GP portal");
  await expect(created).toBeVisible();
  await expect(created.getByRole("heading", { level: 3 })).toBeFocused();
  await expect(created).toContainText("Collecting normally.");
  await expect(created).toContainText("API token");
  await expect(page.getByRole("list", { name: "Source connections" }).getByRole("listitem")).toHaveCount(8);
});

test("a failed test says why in plain words, blocks scheduled collection and can be run again", async ({ page }) => {
  await isolateSourceConnections(page);
  await asAdmin(page);
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await page.getByRole("button", { name: /^connect source$/i }).click();
  await page.getByRole("button", { name: DEMO_TOKEN_PROVIDER }).click();
  await dialog(page).getByRole("textbox", { name: /connection name/i }).fill("Unreachable portal");
  await confirmReview(page);
  await submitToken(page, "demo-unreachable");

  await expect(stepHeading(page, /^the connection test did not pass$/i)).toBeFocused();
  const alert = dialog(page).getByRole("alert");
  await expect(alert).toContainText("Corvis could not reach the provider");
  await expect(alert).toContainText("Scheduled collection stays off");
  await expect(dialog(page)).not.toContainText(/network|pending_authorization|errorClass/);
  expect(await blockingViolations(page, '[role="dialog"]')).toEqual([]);

  await dialog(page).getByRole("button", { name: /^test again$/i }).click();
  await expect(stepHeading(page, /^the connection test did not pass$/i)).toBeVisible();
  await dialog(page).getByRole("button", { name: /^close$/i }).click();

  const pending = card(page, "Unreachable portal");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("Pending");
  await expect(pending).toContainText("Run a connection test to finish setup");
  await expect(pending).not.toContainText("Collecting normally");
  await expect(pending).toContainText("Not scheduled — sync starts after setup is finished");
});

test("a rejected credential leaves the connection needing reauthorization, never active", async ({ page }) => {
  await isolateSourceConnections(page);
  await asAdmin(page);
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await page.getByRole("button", { name: /^connect source$/i }).click();
  await page.getByRole("button", { name: DEMO_TOKEN_PROVIDER }).click();
  await dialog(page).getByRole("textbox", { name: /connection name/i }).fill("Mistyped token portal");
  await confirmReview(page);
  await submitToken(page, "demo-invalid-token");
  await expect(dialog(page).getByRole("alert")).toContainText("The provider rejected the saved credential");
  await expect(dialog(page)).toContainText("use Reauthorize on the connection");
  await dialog(page).getByRole("button", { name: /^close$/i }).click();
  const needs = card(page, "Mistyped token portal");
  await expect(needs).toContainText("Needs reauthorization");
  await expect(needs.getByRole("button", { name: "Reauthorize Mistyped token portal" })).toBeVisible();
});

test("a refused save returns to the credential step with the field cleared and a plain reason", async ({ page }) => {
  await asAdmin(page);
  await openConnectWizard(page);
  await page.route("**/api/v1/source-connections/connect", (route) => route.fulfill({ status: 500, json: { error: "internal_error" } }));
  await page.getByRole("button", { name: DEMO_TOKEN_PROVIDER }).click();
  await confirmReview(page);
  await submitToken(page, "demo-valid-token");
  await expect(stepHeading(page, /^enter the credential$/i)).toBeVisible();
  await expect(dialog(page).getByRole("alert")).toContainText("could not be created");
  await expect(dialog(page).getByLabel(/^api token/i)).toHaveValue("");
  await expect(stepHeading(page, /^enter the credential$/i)).toBeFocused();
  await dialog(page).getByRole("button", { name: /^back$/i }).click();
  await expect(dialog(page).getByRole("alert")).toHaveCount(0);
});

test("OAuth: redirect through the provider's consent page and back, then the test runs automatically", async ({ page }) => {
  await asAdmin(page);
  await goToConsent(page);
  await expect(page).toHaveURL(/\/api\/v1\/source-connections\/oauth\/demo-consent\?/);
  await expect(page.getByText("Demonstration only.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /demo data room: approve access\?/i })).toBeVisible();
  expect(await new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]).analyze().then((results) => results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? "")))).toEqual([]);
  await page.getByRole("link", { name: /^approve access$/i }).click();

  await expect(stepHeading(page, /^connection verified$/i)).toBeVisible();
  await expect(stepHeading(page, /^connection verified$/i)).toBeFocused();
  expect(new URL(page.url()).search, "the one-time code and state are removed from the URL").toBe("");
  await dialog(page).getByRole("button", { name: /^done$/i }).click();
  const created = card(page, "Demo data room (sign-in with OAuth)");
  await expect(created).toContainText("OAuth sign-in");
  await expect(created).toContainText("Collecting normally.");

  await page.reload();
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await expect(dialog(page)).toHaveCount(0);
});

test("OAuth: declining at the provider creates nothing and lets the administrator start over", async ({ page }) => {
  await asAdmin(page);
  await goToConsent(page);
  await page.getByRole("link", { name: /^deny access$/i }).click();
  await expect(stepHeading(page, /^authorization was not completed$/i)).toBeFocused();
  await expect(dialog(page)).toContainText("Access was not approved at the provider, so nothing was connected or changed and nothing was stored");
  expect(await blockingViolations(page, '[role="dialog"]')).toEqual([]);
  await dialog(page).getByRole("button", { name: /^start over$/i }).click();
  await expect(stepHeading(page, /^choose a source$/i)).toBeFocused();
  await expect(page.getByRole("list", { name: "Approved sources" })).toBeVisible();
  await dialog(page).getByRole("button", { name: /^close$/i }).click();
  await expect(page.getByRole("list", { name: "Source connections" }).getByRole("listitem")).toHaveCount(7);
});

test("OAuth: a replayed or forged redirect is refused and nothing is created", async ({ page }) => {
  await isolateSourceConnections(page);
  await asAdmin(page);
  await page.goto("/?source_oauth=return&code=forged&state=forged");
  await expect(stepHeading(page, /^authorization was not completed$/i)).toBeVisible();
  await expect(dialog(page)).toContainText("can no longer be used");
  expect(new URL(page.url()).search).toBe("");
  await dialog(page).getByRole("button", { name: /^close$/i }).click();
  await expect(page.getByRole("list", { name: "Source connections" }).getByRole("listitem")).toHaveCount(7);
  await expect(page.getByRole("button", { name: DEMO_OAUTH_PROVIDER })).toHaveCount(0);
});

test("the OAuth review step names the redirect before any sign-in and Back works", async ({ page }) => {
  await asAdmin(page);
  await openConnectWizard(page);
  await page.getByRole("button", { name: DEMO_OAUTH_PROVIDER }).click();
  await expect(dialog(page).getByRole("button", { name: /^continue to sign-in$/i })).toBeVisible();
  await confirmReview(page);
  await expect(stepHeading(page, /^authorize with the provider$/i)).toBeFocused();
  await expect(dialog(page)).toContainText("Corvis never sees your provider password");
  await dialog(page).getByRole("button", { name: /^back$/i }).click();
  await expect(stepHeading(page, /^review what corvis will access$/i)).toBeFocused();
});

test("a connection test can be run on demand from the list, with a plain-language result and focus on the connection", async ({ page }) => {
  await isolateSourceConnections(page);
  await asAdmin(page);
  await page.getByRole("button", { name: /^documents$/i }).first().click();

  const healthy = card(page, "Meridian LP portal");
  await healthy.getByRole("button", { name: "Test connection Meridian LP portal" }).click();
  await expect(page.locator(".source-connections-status")).toContainText("Meridian LP portal: the connection test passed");
  await expect(healthy.getByRole("heading", { level: 3 })).toBeFocused();

  const atlas = card(page, "Atlas investor portal");
  await atlas.getByRole("button", { name: "Test connection Atlas investor portal" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Connection test did not pass" });
  await expect(alert).toContainText("The provider rejected the saved credential");
  await expect(alert).toContainText("use Reauthorize on the connection");
  await expect(atlas).toContainText("Needs reauthorization");

  await expect(card(page, "Legacy SFTP drop").getByRole("button", { name: /^test connection/i })).toHaveCount(0);
});

test("a source the workspace is already connected to is refused with a clear reason, by token and by sign-in", async ({ page }) => {
  await asAdmin(page);
  await openConnectWizard(page);
  await page.getByRole("button", { name: DEMO_TOKEN_PROVIDER }).click();
  await confirmReview(page);
  await submitToken(page, "demo-valid-token");
  await expect(stepHeading(page, /^connection verified$/i)).toBeVisible();
  await dialog(page).getByRole("button", { name: /^done$/i }).click();

  // Same provider again: refused on the credential step, and nothing is created.
  await page.getByRole("button", { name: /^connect source$/i }).click();
  await page.getByRole("button", { name: DEMO_TOKEN_PROVIDER }).click();
  await confirmReview(page);
  await submitToken(page, "demo-valid-token");
  await expect(dialog(page).getByRole("alert")).toContainText("This workspace is already connected to this source");
  await expect(dialog(page).getByLabel(/^api token/i)).toHaveValue("");
  expect(await blockingViolations(page, '[role="dialog"]')).toEqual([]);
  await dialog(page).getByRole("button", { name: /^back$/i }).click();
  await dialog(page).getByRole("button", { name: /^back$/i }).click();

  // The sign-in provider: connect it once, then the start of a second sign-in is refused before leaving Corvis.
  await page.getByRole("button", { name: DEMO_OAUTH_PROVIDER }).click();
  await confirmReview(page);
  await dialog(page).getByRole("button", { name: /^go to the provider$/i }).click();
  await page.getByRole("link", { name: /^approve access$/i }).click();
  await expect(stepHeading(page, /^connection verified$/i)).toBeVisible();
  await dialog(page).getByRole("button", { name: /^done$/i }).click();
  await page.getByRole("button", { name: /^connect source$/i }).click();
  await page.getByRole("button", { name: DEMO_OAUTH_PROVIDER }).click();
  await confirmReview(page);
  await dialog(page).getByRole("button", { name: /^go to the provider$/i }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("This workspace is already connected to this source");
  await expect(stepHeading(page, /^authorize with the provider$/i)).toBeVisible();
  await expect(page).not.toHaveURL(/demo-consent/);
  await dialog(page).getByRole("button", { name: /^back$/i }).click();
  await dialog(page).getByRole("button", { name: /^back$/i }).click();
  await dialog(page).getByRole("button", { name: /^close$/i }).click();
  await expect(page.getByRole("list", { name: "Source connections" }).getByRole("listitem")).toHaveCount(9);
});

test("a suspended OAuth connection is reauthorized from its card through the provider and is active again once the test passes", async ({ page }) => {
  await asAdmin(page);
  await goToReauthorizeConsent(page);
  await expect(page).toHaveURL(/\/api\/v1\/source-connections\/oauth\/demo-consent\?/);
  await page.getByRole("link", { name: /^approve access$/i }).click();

  await expect(stepHeading(page, /^connection reauthorized$/i)).toBeVisible();
  await expect(stepHeading(page, /^connection reauthorized$/i)).toBeFocused();
  await expect(dialog(page)).toContainText("The new credential is saved and the previous one was retired");
  expect(new URL(page.url()).search, "the one-time code and state are removed from the URL").toBe("");
  expect(await blockingViolations(page, '[role="dialog"]')).toEqual([]);
  await dialog(page).getByRole("button", { name: /^done$/i }).click();

  const summit = card(page, REAUTHORIZE_SUMMIT);
  await expect(summit.getByRole("heading", { level: 3 })).toBeFocused();
  await expect(summit).not.toContainText("Suspended");
  await expect(summit).not.toContainText("Needs reauthorization");
  await expect(summit.getByRole("button", { name: `Reauthorize ${REAUTHORIZE_SUMMIT}` })).toBeVisible();
  await expect(page.getByRole("list", { name: "Source connections" }).getByRole("listitem")).toHaveCount(7);
});

test("declining at the provider leaves a connection that needs reauthorization exactly as it was", async ({ page }) => {
  await asAdmin(page);
  await goToReauthorizeConsent(page);
  await page.getByRole("link", { name: /^deny access$/i }).click();
  await expect(stepHeading(page, /^authorization was not completed$/i)).toBeFocused();
  await expect(dialog(page)).toContainText("nothing was connected or changed");
  await dialog(page).getByRole("button", { name: /^close$/i }).click();
  await expect(card(page, REAUTHORIZE_SUMMIT)).toContainText("Suspended");
});
