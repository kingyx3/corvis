import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { accessibilityBudget } from "../quality/quality-budgets.ts";
import { openSurface, surfaces } from "../support/surfaces.ts";
import { warmApiRoutes } from "../support/warm.ts";

// Source connections (B5 #252, B8 #253). The demo composition serves /api/v1/source-connections from an
// in-memory store seeded per demo tenant, so every test below pins its own tenant: a pause, revoke or
// reauthorization in one test can never leak into another, whatever the worker count.

type Violation = { id: string; impact?: string | null; help: string; nodes: Array<{ target: unknown[] }> };

async function blockingViolations(page: Page, include?: string): Promise<Violation[]> {
  const builder = new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]);
  const results = await (include ? builder.include(include) : builder).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

function describe(violations: Violation[]): string {
  return violations.map((violation) => `${violation.impact}/${violation.id}: ${violation.help} (${violation.nodes.length} node(s), first: ${JSON.stringify(violation.nodes[0]?.target)})`).join("\n");
}

// The dev server compiles each API route the first time it is requested, which on a cold server can outlast an assertion's
// 10 s (the attention banner waits for the first call to the activity route). Request each route this file depends on once
// up front, under a tenant no test uses, so a test asserts on behavior and not on compile time.
test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  const missing = "00000000-0000-4000-8000-000000000000";
  await warmApiRoutes(request, [
    { path: "/api/v1/source-connections" },
    { path: "/api/v1/source-connections/activity" },
    { path: "/api/v1/source-connections/providers" },
    { method: "POST", path: `/api/v1/source-connections/${missing}`, data: { action: "pause" } },
    { method: "POST", path: `/api/v1/source-connections/${missing}/reauthorize`, data: {} },
    { method: "POST", path: `/api/v1/source-connections/${missing}/test`, data: {} },
  ]);
});

const sources = surfaces.find((surface) => surface.id === "sources")!;
const connectionId = (slot: number) => `00000000-0000-4000-8000-${String(slot).padStart(12, "d")}`;
const MERIDIAN = "Meridian LP portal"; // healthy
const HARBOR = "Harbor fund administrator"; // stale
const NORTHGATE = "Northgate data room"; // paused
const ATLAS = "Atlas investor portal"; // reauthorization required (auth)
const SUMMIT = "Summit virtual data room"; // suspended (permission), OAuth
const COBALT = "Cobalt GP site"; // transient network failure
const LEGACY = "Legacy SFTP drop"; // revoked

/** Gives this page its own seeded copy of the demo connections. */
async function isolate(page: Page): Promise<string> {
  const tenant = `e2e-${randomUUID()}`;
  await page.route("**/api/v1/source-connections**", (route) => route.continue({ headers: { ...route.request().headers(), "x-corvis-demo-tenant": tenant } }));
  return tenant;
}

async function openSources(page: Page, role: "admin" | "read_only" = "admin"): Promise<void> {
  await page.addInitScript((value) => window.sessionStorage.setItem("corvis:demo:role", value), role);
  await page.goto("/");
  await openSurface(page, sources);
}

const card = (page: Page, label: string): Locator => page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3, name: label }) });
const status = (page: Page): Locator => page.locator(".source-connections-status");

test("administrators see every connection with plain-language health, scope and last and next sync @matrix", async ({ page }) => {
  await isolate(page);
  await openSources(page);
  await expect(page.getByRole("heading", { name: /^source connections$/i })).toBeVisible();
  await expect(page.getByRole("list", { name: "Source connections" }).getByRole("listitem")).toHaveCount(7);

  const healthy = card(page, MERIDIAN);
  await expect(healthy).toContainText("Healthy");
  await expect(healthy).toContainText("Collecting normally.");
  await expect(healthy).toContainText("Quarterly reports and Capital account statements");
  await expect(healthy).toContainText("Last successful sync");
  await expect(healthy).toContainText("3 hours ago");
  await expect(healthy).toContainText("Next sync");
  await expect(healthy).toContainText("Scheduled in 3 hours");
  await expect(healthy).toContainText("Last run");
  await expect(healthy).toContainText("3 found: 2 new, 1 already collected, 0 not accepted.");
  await expect(healthy).toContainText("API token");
  await expect(healthy).toContainText("No action needed");

  await expect(card(page, NORTHGATE)).toContainText("Not scheduled — resume the connection to restart the schedule");
  await expect(card(page, LEGACY)).toContainText("Never — this connection was revoked");
  await expect(card(page, ATLAS)).toContainText("Sync is stopped until the connection is reauthorized");
  // A refused run reads as a refusal with the plain-language reason, not as a provider outage.
  await expect(card(page, ATLAS)).toContainText("Stopped before collecting");
  await expect(card(page, ATLAS)).toContainText("The provider rejected the saved credential");

  await healthy.getByText("Scope details").click();
  await expect(healthy.getByText("/Fund III/Quarterly")).toBeVisible();
});

test("no raw lifecycle or error enum, provider key or secret material is rendered anywhere on the page", async ({ page }) => {
  await isolate(page);
  await openSources(page);
  await expect(card(page, ATLAS)).toBeVisible();
  // Open the run history too, so its states and failure classes are on the page.
  const runs = page.getByRole("region", { name: "Source connector run history" });
  await expect(runs).toBeVisible();
  for (const summary of await runs.locator("details > summary").all()) await summary.click();
  const text = await page.locator("main").innerText();
  const html = await page.locator("main").innerHTML();
  const forbidden = /\b(reauthorization_required|pending_authorization|scoped_api_token|oauth_authorization_code|oauth_client_credentials|service_account|browser_session|provider_change|rate_limit|dead_letter|secretReference|corvis-src-|projects\/)\b|demo-(lp-portal|administrator|data-room|vdr|gp-site|legacy-drop|investor-portal)/;
  expect(text).not.toMatch(forbidden);
  expect(html).not.toMatch(/secret_?reference|corvis-src-/i);
  // Failure wording in the run history is plain language, never the stored class or state.
  await expect(runs).not.toContainText(/\b(succeeded|refused|retryable|auth|network|permission)\b/);
  await expect(runs).toContainText("The provider rejected the saved credential");
});

test("a stale connection is visually distinct and says why, not just a dated text", async ({ page }) => {
  await isolate(page);
  await openSources(page);
  const stale = card(page, HARBOR);
  const healthy = card(page, MERIDIAN);
  await expect(stale).toHaveAttribute("data-stale", "true");
  await expect(stale).toHaveAttribute("data-severity", "stale");
  await expect(healthy).toHaveAttribute("data-stale", "false");
  await expect(stale.locator(".status-pill")).toHaveText("Stale");
  await expect(stale.locator(".source-connection-notice")).toContainText("No successful sync for 6 days.");
  await expect(stale.locator(".source-connection-notice svg")).toHaveCount(1);
  await expect(stale).toContainText("Required action");
  await expect(stale).toContainText("Contact support");
  const borderStyle = (locator: Locator) => locator.locator(".source-connection-notice").evaluate((element) => getComputedStyle(element).borderTopStyle);
  expect(await borderStyle(stale)).toBe("dotted");
  expect(await borderStyle(healthy)).toBe("solid");
});

test("reauthorization-required and suspended look and read differently from a transient failure", async ({ page }) => {
  await isolate(page);
  await openSources(page);
  const reauth = card(page, ATLAS);
  const suspended = card(page, SUMMIT);
  const transient = card(page, COBALT);

  await expect(reauth.locator(".status-pill")).toHaveText("Needs reauthorization");
  await expect(suspended.locator(".status-pill")).toHaveText("Suspended");
  await expect(transient.locator(".status-pill")).toHaveText("Retrying");

  await expect(reauth).toContainText("The provider rejected the saved credential");
  await expect(reauth.locator(".source-connection-required")).toContainText("Reauthorize");
  await expect(suspended).toContainText("The provider denied access to the folders or reports you confirmed");
  await expect(suspended.locator(".source-connection-required")).toContainText("Review access, then reauthorize");
  await expect(transient).toContainText("Corvis could not reach the provider. This is usually temporary.");
  await expect(transient.locator(".source-connection-required")).toContainText("Wait — Corvis retries automatically");
  await expect(transient).toContainText("did not succeed");

  const styles = async (locator: Locator) => locator.locator(".source-connection-notice").evaluate((element) => { const style = getComputedStyle(element); return `${style.borderTopStyle}/${style.borderTopWidth}`; });
  const looks = [await styles(reauth), await styles(suspended), await styles(transient)];
  expect(new Set(looks).size, `three distinct border treatments, got ${looks.join(", ")}`).toBe(3);
  const icons = await Promise.all([reauth, suspended, transient].map((locator) => locator.locator(".source-connection-notice svg").innerHTML()));
  expect(new Set(icons).size, "three distinct icons").toBe(3);

  // Only the transient failure tells the customer to wait; only the blocked ones offer the primary Reauthorize.
  await expect(transient.getByRole("button", { name: `Reauthorize ${COBALT}` })).toHaveCount(1);
  await expect(transient.getByRole("button", { name: `Reauthorize ${COBALT}` })).not.toHaveClass(/primary-button/);
  await expect(reauth.getByRole("button", { name: `Reauthorize ${ATLAS}` })).toHaveClass(/primary-button/);
});

test("the attention banner counts connections that need attention and clears as they recover", async ({ page }) => {
  await isolate(page);
  await openSources(page);
  const banner = page.getByRole("alert").filter({ hasText: /source connections? needs? attention/i });
  await expect(banner).toContainText("2 source connections need attention.");
  await expect(banner).toContainText("Atlas investor portal: Connection authorization must be renewed before acquisition can continue.");

  await card(page, ATLAS).getByRole("button", { name: `Reauthorize ${ATLAS}` }).click();
  const dialog = page.getByRole("dialog", { name: `Reauthorize ${ATLAS}` });
  await dialog.getByLabel("New API token").fill("fresh-token-value");
  await dialog.getByRole("button", { name: "Replace credential" }).click();
  await expect(dialog).toBeHidden();
  await expect(banner).toContainText("1 source connection needs attention.");
  await expect(banner).not.toContainText("Atlas investor portal");
});

test("pause keeps the connection and its history; resume restarts it, with managed focus and an announcement", async ({ page }) => {
  await isolate(page);
  await openSources(page);
  const meridian = card(page, MERIDIAN);
  await expect(meridian.locator(".status-pill")).toHaveText("Healthy");

  const pauseButton = meridian.getByRole("button", { name: `Pause ${MERIDIAN}` });
  await pauseButton.click();
  const dialog = page.getByRole("dialog", { name: `Pause connection: ${MERIDIAN}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Pause this connection?" })).toBeVisible();
  await expect(dialog).toContainText("Scheduled collection stops until you resume the connection.");
  await expect(dialog).toContainText("The stored credential, documents already collected and the run history are kept.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

  // Cancel changes nothing and hands focus back to the control that opened the dialog.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(pauseButton).toBeFocused();
  await expect(meridian.locator(".status-pill")).toHaveText("Healthy");

  await pauseButton.click();
  await dialog.getByRole("button", { name: "Pause connection" }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toContainText(`${MERIDIAN}: Connection paused. Scheduled collection is stopped until you resume it.`);
  await expect(meridian.locator(".status-pill")).toHaveText("Paused");
  await expect(meridian).toContainText("Not scheduled — resume the connection to restart the schedule");
  await expect(meridian.getByRole("heading", { level: 3, name: MERIDIAN })).toBeFocused();
  await expect(meridian.getByRole("button", { name: `Pause ${MERIDIAN}` })).toHaveCount(0);
  // History is kept: the run-history link and the run-history rows are still there.
  await expect(meridian.getByRole("button", { name: `View run history for ${MERIDIAN}` })).toBeVisible();

  await meridian.getByRole("button", { name: `Resume ${MERIDIAN}` }).click();
  const resume = page.getByRole("dialog", { name: `Resume connection: ${MERIDIAN}` });
  await expect(resume).toContainText("Scheduled collection restarts using the stored credential.");
  await resume.getByRole("button", { name: "Resume connection" }).click();
  await expect(resume).toBeHidden();
  await expect(status(page)).toContainText("Connection resumed. Scheduled collection is restarted.");
  await expect(meridian.locator(".status-pill")).toHaveText("Healthy");
  await expect(meridian.getByRole("heading", { level: 3, name: MERIDIAN })).toBeFocused();
});

test("reauthorize replaces the credential: masked field, cleared afterwards, never echoed back", async ({ page }) => {
  await isolate(page);
  const secret = "tok-live-4f9a-DO-NOT-SHOW";
  const bodies: string[] = [];
  page.on("response", async (response) => {
    if (response.url().includes("/api/v1/source-connections")) bodies.push(await response.text().catch(() => ""));
  });
  let sentSecret = "";
  page.on("request", (request) => { if (request.url().endsWith("/reauthorize")) sentSecret = request.postData() ?? ""; });
  await openSources(page);

  const atlas = card(page, ATLAS);
  await atlas.getByRole("button", { name: `Reauthorize ${ATLAS}` }).click();
  const dialog = page.getByRole("dialog", { name: `Reauthorize ${ATLAS}` });
  await expect(dialog).toContainText("The previous credential is destroyed only after the new one is saved and the change is recorded in the audit log.");
  await expect(dialog).toContainText("Collected documents and the run history are kept.");
  const field = dialog.getByLabel("New API token");
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toHaveAttribute("autocomplete", "off");
  await field.fill(secret);
  await dialog.getByRole("button", { name: "Replace credential" }).click();

  await expect(dialog).toBeHidden();
  await expect(status(page)).toContainText("Credential replaced. Collection is active again and the previous credential was retired.");
  await expect(atlas.locator(".status-pill")).toHaveText("Healthy");
  await expect(atlas.getByRole("heading", { level: 3, name: ATLAS })).toBeFocused();
  expect(JSON.parse(sentSecret)).toEqual({ secret: { token: secret } });
  expect(await page.content()).not.toContain(secret);
  expect(await page.locator("main").innerText()).not.toContain(secret);
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) expect(body).not.toContain(secret);
  expect(await page.evaluate(() => JSON.stringify([window.localStorage, window.sessionStorage]))).not.toContain(secret);
});

test("a failed reauthorization keeps the dialog open with the field cleared and an actionable message", async ({ page }) => {
  await isolate(page);
  await page.route("**/api/v1/source-connections/*/reauthorize", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal_error" }) }));
  await openSources(page);
  await card(page, ATLAS).getByRole("button", { name: `Reauthorize ${ATLAS}` }).click();
  const dialog = page.getByRole("dialog", { name: `Reauthorize ${ATLAS}` });
  const field = dialog.getByLabel("New API token");
  await field.fill("will-be-cleared");
  await dialog.getByRole("button", { name: "Replace credential" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The change could not be completed. Nothing was changed; try again.");
  await expect(dialog.getByRole("alert")).toContainText("The credential field was cleared; enter it again to retry.");
  await expect(field).toHaveValue("");
  await expect(dialog.getByRole("alert")).not.toContainText("will-be-cleared");
  await expect(card(page, ATLAS).locator(".status-pill")).toHaveText("Needs reauthorization");
});

test("a service-account credential is entered as a masked JSON key and validated before it is sent", async ({ page }) => {
  await isolate(page);
  let requestBody = "";
  page.on("request", (request) => { if (request.url().endsWith("/reauthorize")) requestBody = request.postData() ?? ""; });
  await openSources(page);
  await card(page, HARBOR).getByRole("button", { name: `Reauthorize ${HARBOR}` }).click();
  const dialog = page.getByRole("dialog", { name: `Reauthorize ${HARBOR}` });
  const field = dialog.getByLabel("New service account key (JSON)");
  await expect(field).toBeFocused();
  await expect(field).toHaveCSS("-webkit-text-security", "disc");
  await field.fill("{ not json SECRET-PART");
  await dialog.getByRole("button", { name: "Replace credential" }).click();
  await expect(dialog.getByRole("alert")).toContainText("That is not valid JSON.");
  await expect(dialog.getByRole("alert")).not.toContainText("SECRET-PART");
  expect(requestBody).toBe("");
  await field.fill('{"client_email":"svc@example.test","private_key":"abc"}');
  await dialog.getByRole("button", { name: "Replace credential" }).click();
  await expect(dialog).toBeHidden();
  expect(JSON.parse(requestBody)).toEqual({ secret: { client_email: "svc@example.test", private_key: "abc" } });
});

test("reauthorizing a paused connection leaves it paused", async ({ page }) => {
  await isolate(page);
  await openSources(page);
  const northgate = card(page, NORTHGATE);
  await northgate.getByRole("button", { name: `Reauthorize ${NORTHGATE}` }).click();
  const dialog = page.getByRole("dialog", { name: `Reauthorize ${NORTHGATE}` });
  await expect(dialog).toContainText("This connection is paused and stays paused until you resume it.");
  await dialog.getByLabel("New API token").fill("rotated");
  await dialog.getByRole("button", { name: "Replace credential" }).click();
  await expect(status(page)).toContainText("Credential replaced. The connection stays paused until you resume it.");
  await expect(northgate.locator(".status-pill")).toHaveText("Paused");
});

test("an OAuth connection offers a real Reauthorize: a sign-in with the provider, not a form and not an \"unavailable\" note", async ({ page }) => {
  await isolate(page);
  await openSources(page);
  const summit = card(page, SUMMIT);
  const button = summit.getByRole("button", { name: `Reauthorize ${SUMMIT}` });
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await expect(summit).not.toContainText(/not available yet|redirect flow/);
  await button.click();
  const dialog = page.getByRole("dialog", { name: `Reauthorize ${SUMMIT}` });
  await expect(dialog).toContainText("sign in on the provider's own page");
  await expect(dialog).toContainText("The previous credential is destroyed only after the new one is saved and the change is recorded in the audit log.");
  await expect(dialog.locator("input, textarea")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(await blockingViolations(page, '[role="dialog"]')).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();

  // A refused start (here, the attempt budget) is reported in the dialog and nothing leaves the app.
  await page.route("**/api/v1/source-connections/oauth/start", (route) => route.fulfill({ status: 429, json: { error: "rate_limited" } }));
  await button.click();
  await dialog.getByRole("button", { name: "Go to the provider" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Too many sign-in attempts");
  await expect(page).not.toHaveURL(/demo-consent/);
});

test("revoke is confirmed with exactly what stops, can be cancelled, and is terminal", async ({ page }) => {
  await isolate(page);
  await openSources(page);
  const meridian = card(page, MERIDIAN);
  const revokeButton = meridian.getByRole("button", { name: `Revoke ${MERIDIAN}` });
  await revokeButton.click();
  const dialog = page.getByRole("dialog", { name: `Revoke connection: ${MERIDIAN}` });
  await expect(dialog.getByRole("heading", { name: "Revoke this connection permanently?" })).toBeVisible();
  await expect(dialog).toContainText("This cannot be undone.");
  await expect(dialog).toContainText("Scheduled collection stops immediately and can never be restarted for this connection.");
  await expect(dialog).toContainText("The stored credential is destroyed, so Corvis can no longer sign in to the provider.");
  await expect(dialog).toContainText("Documents already collected and the run history are retained.");
  await expect(dialog).toContainText("To collect from this source again you must create a new connection.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Revoke connection" })).toHaveClass(/danger-button/);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(revokeButton).toBeFocused();
  await expect(meridian.locator(".status-pill")).toHaveText("Healthy");

  await revokeButton.click();
  await dialog.getByRole("button", { name: "Revoke connection" }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toContainText("Connection revoked. Collection has stopped and the credential was destroyed.");
  await expect(meridian.locator(".status-pill")).toHaveText("Revoked");
  await expect(meridian.getByRole("button", { name: /^(Pause|Resume|Reauthorize|Revoke) / })).toHaveCount(0);
  await expect(meridian.locator(".source-connection-required")).toContainText("No action — create a new connection to collect again");
  await expect(meridian.getByRole("button", { name: `View run history for ${MERIDIAN}` })).toBeVisible();

  // Terminal on the server too: a fresh load of the page still shows it revoked.
  await page.reload();
  await openSurface(page, sources);
  await expect(card(page, MERIDIAN).locator(".status-pill")).toHaveText("Revoked");
  await expect(card(page, LEGACY).getByRole("button", { name: /^(Pause|Resume|Reauthorize|Revoke) / })).toHaveCount(0);
});

test("each connection links to its run history", async ({ page }) => {
  await isolate(page);
  await openSources(page);
  await expect(page.getByRole("heading", { name: "Source run history" })).toBeVisible();
  await card(page, COBALT).getByRole("button", { name: `View run history for ${COBALT}` }).click();
  const row = page.locator(`#source-run-history-${connectionId(6)}`);
  await expect(row).toBeFocused();
  await expect(row).toContainText(COBALT);
  await expect(row).toContainText("Failed, will retry");
});

test("a command that the server refuses is reported in plain language and changes nothing", async ({ page }) => {
  await isolate(page);
  await page.route(`**/api/v1/source-connections/${connectionId(1)}`, (route) => route.request().method() === "PATCH"
    ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "invalid_transition_from_concurrent_change" }) })
    : route.fallback());
  await openSources(page);
  await card(page, MERIDIAN).getByRole("button", { name: `Pause ${MERIDIAN}` }).click();
  const dialog = page.getByRole("dialog", { name: `Pause connection: ${MERIDIAN}` });
  await dialog.getByRole("button", { name: "Pause connection" }).click();
  await expect(dialog.getByRole("alert")).toContainText("This connection changed state while you were working. Refresh the list and try again.");
  await expect(dialog.getByRole("alert")).not.toContainText("invalid_transition");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(card(page, MERIDIAN).locator(".status-pill")).toHaveText("Healthy");
});

test("a person who is not an administrator gets no source connections section and no request is made", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/v1/source-connections")) requested.push(request.url()); });
  await openSources(page, "read_only");
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^source connections$/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Pause|Resume|Reauthorize|Revoke) / })).toHaveCount(0);
  expect(requested).toEqual([]);
});

test("when the API refuses the caller (403) the section simply does not exist", async ({ page }) => {
  await page.route("**/api/v1/source-connections**", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }));
  await openSources(page);
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^source connections$/i })).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: /unavailable/i })).toHaveCount(0);
});

test("a failed load says so, leaves the documents alone and can be retried", async ({ page }) => {
  let failing = true;
  await isolate(page);
  await page.route("**/api/v1/source-connections", (route) => failing ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : route.fallback());
  await openSources(page);
  const alert = page.getByRole("alert").filter({ hasText: "Source connections are unavailable." });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("The documents above are unaffected.");
  failing = false;
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("list", { name: "Source connections" })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`source connection dialogs have no serious or critical accessibility violations in the ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await isolate(page);
    await openSources(page);
    await expect(card(page, ATLAS)).toBeVisible();
    const list = await blockingViolations(page);
    expect(list, `connection list: ${describe(list)}`).toEqual([]);

    const dialogs: Array<[string, string, string]> = [
      [ATLAS, `Reauthorize ${ATLAS}`, `Reauthorize ${ATLAS}`],
      [HARBOR, `Reauthorize ${HARBOR}`, `Reauthorize ${HARBOR}`],
      [MERIDIAN, `Pause ${MERIDIAN}`, `Pause connection: ${MERIDIAN}`],
      [NORTHGATE, `Resume ${NORTHGATE}`, `Resume connection: ${NORTHGATE}`],
      [MERIDIAN, `Revoke ${MERIDIAN}`, `Revoke connection: ${MERIDIAN}`],
    ];
    for (const [label, buttonName, dialogName] of dialogs) {
      const opener = card(page, label).getByRole("button", { name: buttonName });
      await opener.click();
      const dialog = page.getByRole("dialog", { name: dialogName });
      await expect(dialog).toBeVisible();
      const violations = await blockingViolations(page, '[role="dialog"]');
      expect(violations, `${dialogName}: ${describe(violations)}`).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    }
  });
}

test("the Documents view with source connections does not scroll the page sideways on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await isolate(page);
  await openSources(page);
  await expect(card(page, ATLAS)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  // The cards themselves stay inside the viewport too.
  const overflowing = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    return Array.from(document.querySelectorAll<HTMLElement>(".source-connections, .source-connections *"))
      .filter((element) => element.getBoundingClientRect().right > limit)
      .map((element) => `${element.tagName}.${element.className}`);
  });
  expect(overflowing).toEqual([]);
});
