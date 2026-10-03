import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
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

async function isolate(page: Page, roles = "admin"): Promise<{ tenant: string; headers: Record<string, string> }> {
  const tenant = `e2e-${randomUUID()}`;
  const headers = { "x-corvis-demo-tenant": tenant, "x-corvis-demo-roles": roles };
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
  await expect(section(page)).toContainText("Identity-provider and SCIM setup is done with Corvis support, so it is read-only here.");
  // Read-only: nothing inside the provider table can be edited.
  await expect(provider.getByRole("textbox")).toHaveCount(0);
  await expect(provider.getByRole("button")).toHaveCount(0);
  const violations = await blockingViolations(page, "section[aria-labelledby='session-policy-heading']");
  expect(violations, describe(violations)).toEqual([]);
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
