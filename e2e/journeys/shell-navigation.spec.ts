import { expect, test } from "@playwright/test";

// Workspace shell behaviour: the active view in the URL, per-view titles/focus/announcements,
// session-expiry prompt, per-view error isolation and modal input protection (#237).

test("the active view is in the URL: Back, Forward and reload land on the same view", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await expect(page).toHaveTitle(/^Overview · Corvis$/);

  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
  await expect(page).toHaveURL(/#\/documents$/);
  await expect(page).toHaveTitle(/^Documents · Corvis$/);

  await page.getByRole("button", { name: /^data review$/i }).first().click();
  await expect(page).toHaveURL(/#\/review$/);
  await expect(page).toHaveTitle(/^Data review · Corvis$/);

  await page.goBack();
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
  await expect(page).toHaveTitle(/^Documents · Corvis$/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();

  await page.getByRole("button", { name: /^data review$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^data review$/i }).first()).toHaveAttribute("aria-current", "page");
});

test("a shared link opens its view", async ({ page }) => {
  await page.goto("/#/documents");
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
});

test("a shared link to a view the user cannot open falls back to Overview", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "read_only"));
  await page.goto("/#/delivery");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await expect(page).toHaveURL(/#\/overview$/);
});

test("changing view moves focus to the new h1 and announces it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  const heading = page.getByRole("heading", { name: /^documents$/i });
  await expect(heading).toBeFocused();
  await expect(page.locator("#main-content").getByRole("status").filter({ hasText: "Navigated to Documents" })).toHaveCount(1);
});

test("the skip link is not treated as a view route", async ({ page }) => {
  await page.goto("/#/documents");
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
  await page.getByRole("link", { name: /skip to content/i }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
});

test("the sidebar badge count is exposed as the accessible description, not hidden by the label", async ({ page }) => {
  await page.goto("/");
  const review = page.getByRole("button", { name: /^data review$/i }).first();
  await expect(review).toBeVisible();
  await expect(review).toHaveAccessibleDescription(/\d+ items? needs? attention/i);
});

test("an expired session shows a re-authentication prompt instead of raw module errors", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:fail:documents", "unauthenticated"));
  await page.goto("/");
  const prompt = page.getByRole("alert", { name: /session expired/i });
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText(/sign in again to continue/i);
  await expect(prompt.getByRole("button", { name: /sign in again/i })).toBeVisible();
  await expect(page.getByRole("status", { name: /workspace degraded/i })).toHaveCount(0);
  await expect(page.getByText(/module is intentionally unavailable|unauthenticated/i)).toHaveCount(0);
});

test("a render error in one view leaves the sidebar and other views working, and is reported without PII", async ({ page }) => {
  const reports: Array<Record<string, unknown>> = [];
  page.on("console", (message) => {
    if (message.type() !== "error" || !message.text().startsWith("Corvis client error")) return;
    void message.args()[1]?.jsonValue().then((value) => reports.push(value as Record<string, unknown>));
  });
  let corrupt = true;
  // A non-array payload makes Position Financials throw while rendering.
  await page.route("**/api/v1/position-financials**", (route) => corrupt
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) })
    : route.continue());

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.getByRole("button", { name: /^portfolio analytics$/i }).first().click();
  const fallback = page.getByTestId("view-error");
  await expect(fallback).toBeVisible();
  await expect(fallback.getByRole("heading", { name: /portfolio analytics couldn.t be displayed/i })).toBeVisible();

  // Sidebar and every other view are unaffected.
  await expect(page.getByRole("navigation", { name: /workspace sections/i })).toBeVisible();
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
  await expect(page.getByTestId("view-error")).toHaveCount(0);

  await expect.poll(() => reports.length).toBeGreaterThan(0);
  const report = reports[0]!;
  expect(report).toMatchObject({ event: "corvis.client_error", source: "view-boundary", view: "analytics" });
  expect(Object.keys(report).sort()).toEqual(expect.arrayContaining(["event", "name", "occurredAt", "source", "view"]));
  expect(Object.keys(report)).not.toContain("message");
  expect(Object.keys(report)).not.toContain("stack");

  // Retry re-renders the view once the cause is gone.
  await page.getByRole("button", { name: /^portfolio analytics$/i }).first().click();
  await expect(page.getByTestId("view-error")).toBeVisible();
  corrupt = false;
  await page.getByRole("button", { name: /retry this view/i }).click();
  await expect(page.getByRole("heading", { name: /^position financials$/i })).toBeVisible();
});

test("clicking outside a dialog with typed input asks before discarding it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^data review$/i }).first().click();
  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Correct" }) }).first();
  await row.getByRole("button", { name: "Correct" }).click();
  const dialog = page.getByRole("dialog", { name: /correct observation/i });
  await expect(dialog).toBeVisible();

  // Untouched form: a stray click still just closes it.
  await page.mouse.click(3, 3);
  await expect(dialog).toBeHidden();

  await row.getByRole("button", { name: "Correct" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Corrected value").fill("$77.7m");
  await page.mouse.click(3, 3);
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("alert").filter({ hasText: /discard what you entered/i });
  await expect(confirm).toBeVisible();
  await expect(dialog.getByLabel("Corrected value")).toHaveValue("$77.7m");

  await confirm.getByRole("button", { name: /keep editing/i }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeVisible();

  // Escape asks the same question; a second Escape dismisses the prompt and keeps the input.
  await dialog.getByLabel("Corrected value").press("Escape");
  await expect(confirm).toBeVisible();
  await expect(dialog.getByRole("button", { name: /keep editing/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(dialog.getByLabel("Corrected value")).toHaveValue("$77.7m");

  await page.mouse.click(3, 3);
  await confirm.getByRole("button", { name: /discard and close/i }).click();
  await expect(dialog).toBeHidden();
});

test("the Ask Corvis input keeps focus while an answer is pending", async ({ page }) => {
  await page.goto("/#/research");
  const box = page.getByRole("textbox", { name: /ask corvis a question/i });
  await box.fill("What changed this quarter?");
  await box.press("Enter");
  await expect(box).toBeFocused();
  await expect(page.getByText(/demo response for: what changed this quarter/i)).toBeVisible();
  await expect(box).toBeFocused();
});

test("robots.txt disallows all crawlers", async ({ request }) => {
  const response = await request.get("/robots.txt");
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).toMatch(/User-Agent: \*/i);
  expect(body).toMatch(/Disallow: \/\s*$/m);
});
