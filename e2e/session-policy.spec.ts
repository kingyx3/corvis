import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { accessibilityBudget } from "./quality-budgets.ts";

// Sign-in and session policy (F7, #263), on the Organization Admin's access self-service page. The demo composition
// serves /api/v1/access/session-policy from an in-memory store seeded per demo tenant, so every test pins its own
// tenant: a change or a sign-out in one test can never leak into another. The rest of the page needs a database and is
// not part of the demo composition, so its own "needs attention" banner is expected here and ignored.

type Violation = { id: string; impact?: string | null; help: string; nodes: Array<{ target: unknown[] }> };

async function blockingViolations(page: Page, include?: string): Promise<Violation[]> {
  const builder = new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]);
  const results = await (include ? builder.include(include) : builder).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

function describe(violations: Violation[]): string {
  return violations.map((violation) => `${violation.impact}/${violation.id}: ${violation.help} (${violation.nodes.length} node(s), first: ${JSON.stringify(violation.nodes[0]?.target)})`).join("\n");
}

// The dev server compiles each route on first use and may reset module-level demo state while it does.
test.beforeAll(async ({ request }) => {
  const headers = { "x-corvis-demo-tenant": "e2e-warmup", "x-corvis-demo-roles": "admin" };
  await request.get("/api/v1/access/session-policy", { headers });
  await request.put("/api/v1/access/session-policy", { headers, data: {} });
  await request.post("/api/v1/access/session-policy/sign-out", { headers, data: {} });
});

// A tenant whose id starts with "sso-ready-" illustrates an organization whose provider is recorded with token binding on, with
// MFA enforcement and a sign-out endpoint recorded (src/modules/identity-access/adapters/session-policy-store.ts); any other illustrates none of that.
async function isolate(page: Page, roles = "admin", options: { ssoReady?: boolean; extraHeaders?: Record<string, string> } = {}): Promise<{ tenant: string; headers: Record<string, string> }> {
  const tenant = `${options.ssoReady ? "sso-ready-" : "e2e-"}${randomUUID()}`;
  const headers = { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": roles, ...options.extraHeaders };
  await page.route(/\/api\/v1\/access\/session-policy/, (route) => route.continue({ headers: { ...route.request().headers(), ...headers } }));
  return { tenant, headers };
}

const section = (page: Page) => page.locator("section[aria-labelledby='session-policy-heading']");

test("an Organization Admin sees the identity provider, SCIM status and sign-in methods, read-only @matrix", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  await expect(page.getByRole("heading", { name: /^sign-in and session policy$/i })).toBeVisible();
  const provider = page.getByRole("region", { name: "Identity provider and provisioning" });
  await expect(provider).toContainText("OpenID Connect");
  await expect(provider).toContainText("https://login.meridian.example/demo");
  await expect(provider).toContainText("Enabled · 12 active users");
  await expect(provider).toContainText("OpenID Connect: 4");
  // F7e (#338): the organization's own recorded provider, with its audience, status and whether binding is enforced.
  await expect(provider).toContainText("corvis-meridian");
  await expect(provider).toContainText("Active · tokens are not restricted to this issuer and audience");
  // F7b (#335): the verified email domains, and what they mean for new invitations.
  await expect(provider).toContainText("meridian.example");
  await expect(provider).toContainText("new invitations and provisioned users must use one of these");
  await expect(section(page)).toContainText("Identity-provider, verified-domain and SCIM setup is done with Corvis support, so it is read-only here.");
  // Read-only: nothing inside the provider table can be edited.
  await expect(provider.getByRole("textbox")).toHaveCount(0);
  await expect(provider.getByRole("button")).toHaveCount(0);
  const violations = await blockingViolations(page, "section[aria-labelledby='session-policy-heading']");
  expect(violations, describe(violations)).toEqual([]);
});

test("a person whose session the organization's policy ended is told so, not shown a code or a generic failure @matrix", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  const form = section(page);
  await form.getByRole("checkbox", { name: "No idle limit" }).uncheck();
  await form.getByLabel("Minutes without activity before a session ends").fill("30");
  await form.getByLabel("Why are you changing this?").fill("Align with our information security policy");
  // The save is answered with the stable 401 reason for a policy-ended session (a pre-isolation route continues the demo call; this one answers it).
  const answer = (error: string) => async (route: Route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error, correlationId: "e2e-401" }) });
  };
  const saveRoute = /\/api\/v1\/access\/session-policy$/;
  await page.route(saveRoute, answer("session_ended_by_policy"));
  await form.getByRole("button", { name: "Save session policy" }).click();
  const ended = form.getByRole("alert").filter({ hasText: "Something went wrong" });
  await expect(ended).toContainText("Your session ended because of your organization's sign-in policy. Sign in again to continue.");
  await expect(ended).not.toContainText("session_ended_by_policy");
  const violations = await blockingViolations(page, "section[aria-labelledby='session-policy-heading']");
  expect(violations, describe(violations)).toEqual([]);

  // A generic 401 (a missing, invalid or revoked token) keeps the plain expiry copy: it must not look like a policy decision.
  await page.unroute(saveRoute);
  await page.route(saveRoute, answer("authentication_required"));
  // A failed save reloads the server's policy into the form, so the change is entered again.
  const noIdle = form.getByRole("checkbox", { name: "No idle limit" });
  if (await noIdle.isChecked()) await noIdle.uncheck();
  await form.getByLabel("Minutes without activity before a session ends").fill("30");
  await form.getByLabel("Why are you changing this?").fill("Align with our information security policy");
  await form.getByRole("button", { name: "Save session policy" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "Something went wrong" })).toContainText("Your session has expired. Sign in again to continue.");
  await expect(form.getByRole("alert")).not.toContainText("organization's sign-in policy");
});

test("limits can be set within the Corvis bounds, need a reason, and are kept @matrix", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  const form = section(page);
  await expect(form.getByText("No limit has been set yet.")).toBeVisible();
  const save = form.getByRole("button", { name: "Save session policy" });
  await expect(save).toBeDisabled();

  await form.getByRole("checkbox", { name: "No idle limit" }).uncheck();
  const idle = form.getByLabel("Minutes without activity before a session ends");
  await expect(idle).toHaveAttribute("min", "15");
  await expect(idle).toHaveAttribute("max", "480");
  await idle.fill("5");
  await expect(form.getByRole("alert").filter({ hasText: "idle timeout must be a whole number of minutes within the allowed range" })).toBeVisible();
  await form.getByLabel("Why are you changing this?").fill("Align with our information security policy");
  await expect(save).toBeDisabled();

  await idle.fill("30");
  await form.getByRole("checkbox", { name: "No maximum length" }).uncheck();
  const max = form.getByLabel("Minutes after which a session ends, however active");
  await max.fill("20");
  await expect(form.getByRole("alert").filter({ hasText: "maximum session length must be a whole number of minutes" })).toBeVisible();
  await max.fill("120");
  await idle.fill("240");
  await expect(form.getByRole("alert").filter({ hasText: "idle timeout cannot be longer than the maximum session length" })).toBeVisible();
  await expect(save).toBeDisabled();
  await idle.fill("30");
  await expect(form.getByRole("alert")).toHaveCount(0);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "Session policy saved." })).toBeVisible();
  await expect(form.getByText("Now: 30 minutes.")).toBeVisible();
  await expect(form.getByText("Now: 2 hours.")).toBeVisible();
  await expect(form.getByText(/Last changed .* by demo-user\./)).toBeVisible();
  await expect(save).toBeDisabled();

  // The policy is the server's, not the page's: a reload shows it again.
  await page.reload();
  await expect(form.getByLabel("Minutes without activity before a session ends")).toHaveValue("30");
  await expect(form.getByLabel("Minutes after which a session ends, however active")).toHaveValue("120");
  // A limit can be cleared again.
  await form.getByRole("checkbox", { name: "No maximum length" }).check();
  await form.getByLabel("Why are you changing this?").fill("Back to the identity provider's own limit");
  await form.getByRole("button", { name: "Save session policy" }).click();
  await expect(form.getByText("Now: No limit set.")).toBeVisible();
  const violations = await blockingViolations(page, "section[aria-labelledby='session-policy-heading']");
  expect(violations, describe(violations)).toEqual([]);
});

test("a named person is signed out everywhere after a confirmation with a reason; you cannot sign yourself out @matrix", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  const people = page.getByRole("region", { name: "Members and their sessions" });
  const morgan = people.getByRole("row", { name: /morgan\.lee@meridian\.example/ });
  await expect(morgan).toContainText("2");
  // Yourself: no button, a pointer to your own sign-out instead.
  await expect(people.getByRole("row", { name: /demo-user/ })).toContainText("Use your own sign-out");
  await expect(people.getByRole("row", { name: /demo-user/ }).getByRole("button")).toHaveCount(0);

  await morgan.getByRole("button", { name: "Sign out morgan.lee@meridian.example everywhere" }).click();
  const confirm = people.getByRole("group", { name: "Confirm signing out morgan.lee@meridian.example" });
  const go = confirm.getByRole("button", { name: "Confirm sign out everywhere" });
  await expect(go).toBeDisabled();
  await confirm.getByLabel(/Why are you signing morgan\.lee@meridian\.example out/).fill("Lost laptop");
  await expect(go).toBeEnabled();
  const violations = await blockingViolations(page, "section[aria-labelledby='session-policy-heading']");
  expect(violations, describe(violations)).toEqual([]);
  await go.click();
  await expect(page.getByRole("status").filter({ hasText: "morgan.lee@meridian.example was signed out of every session (2 ended)." })).toBeVisible();
  await expect(people.getByRole("row", { name: /morgan\.lee@meridian\.example/ })).toContainText("0");
  // Cancelling leaves everything as it was.
  const alex = people.getByRole("row", { name: /alex\.chen@meridian\.example/ });
  await alex.getByRole("button", { name: /Sign out alex\.chen@meridian\.example everywhere/ }).click();
  await people.getByRole("button", { name: "Cancel" }).click();
  await expect(alex.getByRole("button", { name: /Sign out alex\.chen@meridian\.example everywhere/ })).toBeVisible();
  await expect(alex).toContainText("1");
});

test("a person who is not an Organization Admin gets no policy and no controls", async ({ page }) => {
  const { headers } = await isolate(page, "analyst");
  await page.goto("/access-self-service");
  await expect(section(page).getByRole("alert").filter({ hasText: "Sign-in settings are unavailable" })).toBeVisible();
  await expect(section(page).getByRole("button", { name: "Save session policy" })).toHaveCount(0);
  await expect(section(page).getByRole("button", { name: /Sign out .* everywhere/ })).toHaveCount(0);
  // The server refuses regardless of what the page shows.
  const denied = await page.request.put("/api/v1/access/session-policy", { headers, data: { idleTimeoutMinutes: 30, maxSessionMinutes: 480, expectedVersion: 0, reason: "Trying anyway" } });
  expect(denied.status()).toBe(403);
  const signOut = await page.request.post("/api/v1/access/session-policy/sign-out", { headers, data: { userId: "00000000-0000-4000-8000-0000000000d2", reason: "Trying anyway" } });
  expect(signOut.status()).toBe(403);
});

test("the API holds the Corvis bounds whatever the page sends", async ({ request }) => {
  const headers = { "x-corvis-demo-tenant": `e2e-${randomUUID()}`, "x-corvis-demo-roles": "admin" };
  const base = { idleTimeoutMinutes: 30, maxSessionMinutes: 480, expectedVersion: 0, reason: "Align with our policy" };
  for (const [body, code] of [
    [{ ...base, idleTimeoutMinutes: 14 }, "invalid_idle_timeout"],
    [{ ...base, idleTimeoutMinutes: 481 }, "invalid_idle_timeout"],
    [{ ...base, maxSessionMinutes: 10081 }, "invalid_max_session"],
    [{ ...base, idleTimeoutMinutes: 400, maxSessionMinutes: 60 }, "idle_exceeds_max_session"],
  ] as const) {
    const response = await request.put("/api/v1/access/session-policy", { headers, data: body });
    expect(response.status()).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(code);
  }
  expect((await request.put("/api/v1/access/session-policy", { headers, data: base })).status()).toBe(200);
  const stale = await request.put("/api/v1/access/session-policy", { headers, data: { ...base, idleTimeoutMinutes: 60 } });
  expect(stale.status()).toBe(409);
  expect(((await stale.json()) as { error: string }).error).toBe("session_policy_version_conflict");
});

test("F7d: the page says how long session records are kept, and the explanation stays accessible @matrix", async ({ page }) => {
  await isolate(page);
  await page.goto("/access-self-service");
  const form = section(page);
  const note = form.getByText(/Corvis keeps a record of each session/);
  await expect(note).toBeVisible();
  await expect(note).toContainText("for 90 days after its last use");
  await expect(note).toContainText("Older records are deleted automatically");
  await expect(note).toContainText("never data from your work");
  const violations = await blockingViolations(page, "section[aria-labelledby='session-policy-heading']");
  expect(violations, describe(violations)).toEqual([]);
});

test("F7a: the identity view says what Corvis knows about MFA and never more, and flags a reported second factor @matrix", async ({ page }) => {
  // Nothing recorded and nothing reported by the token: both rows say so rather than guessing.
  await isolate(page);
  await page.goto("/access-self-service");
  const provider = page.getByRole("region", { name: "Identity provider and provisioning" });
  await expect(provider.getByRole("row", { name: /MFA enforced by your identity provider/ })).toContainText("Not reported by your identity provider");
  await expect(provider.getByRole("row", { name: /^This session/ })).toContainText("Not reported by your identity provider");
  await expect(provider.getByRole("row", { name: /sign-out endpoint/ })).toContainText("Not recorded");
  await expect(provider).not.toContainText("MFA used");
  // Recorded by Corvis support, and the administrator's own token reported more than one factor.
  const reported = await page.context().newPage();
  await isolate(reported, "admin", { ssoReady: true, extraHeaders: { "x-corvis-demo-mfa": "true" } });
  await reported.goto("/access-self-service");
  const known = reported.getByRole("region", { name: "Identity provider and provisioning" });
  await expect(known.getByRole("row", { name: /MFA enforced by your identity provider/ })).toContainText("Yes (as recorded by Corvis support)");
  await expect(known.getByRole("row", { name: /^This session/ })).toContainText("MFA used (reported by your identity provider)");
  await expect(known.getByRole("row", { name: /sign-out endpoint/ })).toContainText("https://login.meridian.example/demo/logout");
  await expect(reported.getByRole("region", { name: "Members and their sessions" }).getByRole("row", { name: /morgan\.lee@meridian\.example/ })).toContainText("(1 with MFA reported)");
  const violations = await blockingViolations(reported, "section[aria-labelledby='session-policy-heading']");
  expect(violations, describe(violations)).toEqual([]);
  // A single factor is said to be a single factor, not "not reported".
  const single = await page.context().newPage();
  await isolate(single, "admin", { extraHeaders: { "x-corvis-demo-mfa": "false" } });
  await single.goto("/access-self-service");
  await expect(single.getByRole("region", { name: "Identity provider and provisioning" }).getByRole("row", { name: /^This session/ })).toContainText("without a second factor");
});

test("F7a: Require SSO is unavailable until the provider is recorded with token binding, then can be turned on and off with a reason @matrix", async ({ page }) => {
  // Not recorded with binding: the control is off, says why, and the server refuses it however the page is driven.
  const { headers } = await isolate(page);
  await page.goto("/access-self-service");
  let form = section(page);
  const sso = form.getByRole("checkbox", { name: "Only accept sign-ins through our identity provider" });
  await expect(sso).toBeDisabled();
  await expect(form.getByText(/Not available yet: it needs your identity provider to be recorded/)).toBeVisible();
  const base = { idleTimeoutMinutes: 30, maxSessionMinutes: 480, expectedVersion: 0, reason: "Require SSO for everyone" };
  const refused = await page.request.put("/api/v1/access/session-policy", { headers, data: { ...base, requireSso: true } });
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("sso_requires_token_binding");
  const malformed = await page.request.put("/api/v1/access/session-policy", { headers, data: { ...base, requireSso: "yes" } });
  expect(malformed.status()).toBe(400);
  expect(((await malformed.json()) as { error: string }).error).toBe("invalid_require_sso");

  // Recorded with binding: it can be turned on.
  const ready = await page.context().newPage();
  const readyIsolation = await isolate(ready, "admin", { ssoReady: true });
  await ready.goto("/access-self-service");
  form = section(ready);
  const readySso = form.getByRole("checkbox", { name: "Only accept sign-ins through our identity provider" });
  await expect(readySso).toBeEnabled();
  await expect(form.getByText(/SAML and gateway-asserted sign-ins are refused/)).toBeVisible();
  await expect(form.getByText(/Now: not required\./)).toBeVisible();
  await readySso.check();
  const save = form.getByRole("button", { name: "Save session policy" });
  await expect(save).toBeDisabled();
  await form.getByLabel("Why are you changing this?").fill("Require our identity provider for every sign-in");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(ready.getByRole("status").filter({ hasText: "Session policy saved." })).toBeVisible();
  await expect(form.getByText(/Now: required\./)).toBeVisible();
  await ready.reload();
  await expect(form.getByRole("checkbox", { name: "Only accept sign-ins through our identity provider" })).toBeChecked();
  // A change that does not state it keeps it (never silently weakened).
  const kept = await ready.request.put("/api/v1/access/session-policy", { headers: readyIsolation.headers, data: { idleTimeoutMinutes: 60, maxSessionMinutes: 480, expectedVersion: 1, reason: "Shorter idle limit" } });
  expect(kept.status()).toBe(200);
  expect(((await kept.json()) as { data: { requireSso: boolean } }).data.requireSso).toBe(true);
  await ready.reload();
  // Turning it off is always possible.
  await form.getByRole("checkbox", { name: "Only accept sign-ins through our identity provider" }).uncheck();
  await form.getByLabel("Why are you changing this?").fill("Moving to a new identity provider");
  await form.getByRole("button", { name: "Save session policy" }).click();
  await expect(form.getByText(/Now: not required\./)).toBeVisible();
  const violations = await blockingViolations(ready, "section[aria-labelledby='session-policy-heading']");
  expect(violations, describe(violations)).toEqual([]);
});

test("F7a: a Require SSO change refused because this session would itself be refused is explained, not shown as a code @matrix", async ({ page }) => {
  await isolate(page, "admin", { ssoReady: true });
  await page.goto("/access-self-service");
  const form = section(page);
  await page.route(/\/api\/v1\/access\/session-policy$/, (route) => route.request().method() === "PUT"
    ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "sso_would_lock_out_current_session", correlationId: "e2e-409" }) })
    : route.fallback());
  await form.getByRole("checkbox", { name: "Only accept sign-ins through our identity provider" }).check();
  await form.getByLabel("Why are you changing this?").fill("Require our identity provider for every sign-in");
  await form.getByRole("button", { name: "Save session policy" }).click();
  const alert = form.getByRole("alert").filter({ hasText: "Something went wrong" });
  await expect(alert).toContainText("You cannot turn this on from this session");
  await expect(alert).not.toContainText("sso_would_lock_out_current_session");
});

test("F7c: after signing someone out, the page says their identity provider session must be ended there when an endpoint is recorded @matrix", async ({ page }) => {
  await isolate(page, "admin", { ssoReady: true });
  await page.goto("/access-self-service");
  const people = page.getByRole("region", { name: "Members and their sessions" });
  await people.getByRole("row", { name: /alex\.chen@meridian\.example/ }).getByRole("button", { name: /Sign out alex\.chen@meridian\.example everywhere/ }).click();
  await people.getByLabel(/Why are you signing alex\.chen@meridian\.example out/).fill("Lost laptop");
  await people.getByRole("button", { name: "Confirm sign out everywhere" }).click();
  const status = page.getByRole("status").filter({ hasText: "alex.chen@meridian.example was signed out of every session" });
  await expect(status).toContainText("Their session at your identity provider has not been ended: Corvis cannot do that.");
  await expect(status).toContainText("https://login.meridian.example/demo/logout");
});

test("F7c: the back-channel logout endpoint is POST-only and refuses anything but a valid signed logout token without saying why", async ({ request }) => {
  const url = "/api/v1/auth/oidc/backchannel-logout";
  expect((await request.get(url)).status()).toBe(405);
  for (const form of [{ other: "field" }, { logout_token: "not-a-token" }, { logout_token: "aaa.bbb.ccc" }] as Array<Record<string, string>>) {
    const response = await request.post(url, { form });
    expect(response.status()).toBe(400);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(JSON.stringify(body)).not.toContain("signature");
  }
  expect((await request.post(url, { data: { logout_token: "x.y.z" } })).status()).toBe(400);
});
