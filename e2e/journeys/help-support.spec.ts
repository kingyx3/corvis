import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { accessibilityBudget } from "../quality/quality-budgets.ts";

// In-app help and support (F9): the Help menu, its Contact support pre-fill, the command-palette
// commands and the mobile route to the same entry point. The support context must stay limited to
// identifiers: no fund, document or metric data is ever attached.

const DOCS = "https://docs.corvis.example/";
const STATUS = "https://status.corvis.example/";
const RELEASE_NOTES = "https://docs.corvis.example/release-notes";
const PALETTE_SHORTCUT = process.platform === "darwin" ? "Meta+K" : "Control+K";

async function openHelp(page: Page) {
  await page.getByRole("button", { name: /^help and support$/i }).first().click();
  const dialog = page.getByRole("dialog", { name: /^help and support$/i });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The mailto body is what the mail client would show: decode it to assert on its content. */
function mailBody(href: string): string {
  return new URL(href).searchParams.get("body") ?? "";
}

async function blockingViolations(page: Page, include: string) {
  const results = await new AxeBuilder({ page }).include(include).withTags([...accessibilityBudget.tags]).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

test("the Help menu lists Contact support, documentation, service status and release notes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  const dialog = await openHelp(page);

  const contact = dialog.getByRole("link", { name: /^contact support$/i });
  await expect(contact).toBeFocused();
  await expect(contact).toHaveAttribute("href", /^mailto:support@corvis\.example\?subject=Corvis%20support%20request&body=/);

  for (const [name, href] of [["Documentation", DOCS], ["Service status", STATUS], ["Release notes", RELEASE_NOTES]] as const) {
    const link = dialog.getByRole("link", { name: new RegExp(`^${name}`, "i") });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
  }
  await expect(dialog.getByRole("list", { name: /help resources/i }).getByRole("link")).toHaveCount(4);
});

test("Contact support pre-fills the workspace and current view, and attaches no financial data", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();

  const dialog = await openHelp(page);
  const href = (await dialog.getByRole("link", { name: /^contact support$/i }).getAttribute("href"))!;
  const body = mailBody(href);
  expect(body).toContain("Workspace ID: demo-workspace");
  expect(body).toContain("Organization ID: demo-tenant");
  expect(body).toContain("Current view: documents");

  // The same identifiers are shown to the user before anything is sent.
  const included = dialog.getByRole("region", { name: /included when you contact support/i });
  await expect(included).toContainText("Workspace ID: demo-workspace");
  await expect(included).toContainText("Current view: documents");
  await expect(included).toContainText(/no financial data or documents are attached/i);

  // Nothing from the workspace's data (document and fund names, values) is in the request.
  const names = await page.locator("#main-content table tbody tr td:first-child").allInnerTexts();
  const meaningful = names.map((name) => name.trim()).filter((name) => name.length > 5);
  expect(meaningful.length, "the Documents view lists documents").toBeGreaterThan(0);
  for (const name of meaningful) expect(decodeURIComponent(href), name).not.toContain(name);
  for (const line of body.split("\n").filter((entry) => /^[A-Z][A-Za-z ]+: /.test(entry))) expect(line).toMatch(/^(Workspace ID|Organization ID|Current view|Error reference|Latest request ID): [\w.:/-]+$/);
});

test("Escape closes the Help menu and returns focus to the Help button", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  const trigger = page.getByRole("button", { name: /^help and support$/i }).first();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /^help and support$/i });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the Help menu has no serious or critical accessibility violations in ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
    await openHelp(page);
    const violations = await blockingViolations(page, '[role="dialog"]');
    expect(violations, violations.map((violation) => `${violation.impact}/${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
    const topbar = await blockingViolations(page, ".topbar");
    expect(topbar, topbar.map((violation) => `${violation.impact}/${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
  });
}

test("the command palette offers Help commands", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.keyboard.press(PALETTE_SHORTCUT);
  const palette = page.getByRole("dialog", { name: /command palette/i });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("help");
  const options = palette.getByRole("option");
  await expect(options).toHaveText([
    /Help: Contact support/,
    /Help: Documentation/,
    /Help: Service status/,
    /Help: Release notes/,
  ]);
  for (const option of await options.all()) await expect(option).toContainText("Help");
});

test("Help: Contact support in the palette opens the Help menu", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.keyboard.press(PALETTE_SHORTCUT);
  await page.getByRole("combobox", { name: /search workspace or run a command/i }).fill("contact support");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: /command palette/i })).toBeHidden();
  const dialog = page.getByRole("dialog", { name: /^help and support$/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: /^contact support$/i })).toBeFocused();
});

for (const [command, url] of [["Help: Documentation", DOCS], ["Help: Service status", STATUS], ["Help: Release notes", RELEASE_NOTES]] as const) {
  test(`${command} in the palette opens the configured page in a new tab`, async ({ page, context }) => {
    await context.route("https://*.corvis.example/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>stub</title>" }));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
    await page.keyboard.press(PALETTE_SHORTCUT);
    await page.getByRole("combobox", { name: /search workspace or run a command/i }).fill(command);
    const popup = context.waitForEvent("page");
    await page.keyboard.press("Enter");
    const opened = await popup;
    await opened.waitForLoadState("domcontentloaded");
    expect(opened.url()).toBe(url);
    await expect(page.getByRole("dialog", { name: /command palette/i })).toBeHidden();
  });
}

test("on a phone the Help menu is reachable from the top bar and from the workspace tab @matrix", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();

  // Top bar: icon-only on phones, still named.
  const topbarHelp = page.getByRole("banner").getByRole("button", { name: /^help and support$/i });
  await expect(topbarHelp).toBeVisible();
  const box = (await topbarHelp.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(40);
  expect(box.height).toBeGreaterThanOrEqual(40);

  // Bottom navigation: Workspace and access carries Help and support.
  await page.getByRole("button", { name: /^workspace and access$/i }).click();
  const workspace = page.getByRole("dialog", { name: /workspace and access/i });
  await expect(workspace).toBeVisible();
  await workspace.getByRole("button", { name: /^help and support$/i }).click();
  await expect(workspace).toBeHidden();
  const help = page.getByRole("dialog", { name: /^help and support$/i });
  await expect(help).toBeVisible();
  await expect(help.getByRole("link", { name: /^contact support$/i })).toHaveAttribute("href", /^mailto:/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a view error offers Contact support with the view and the error reference", async ({ page }) => {
  // A non-array payload makes Position Financials throw while rendering (see shell-navigation.spec.ts).
  await page.route("**/api/v1/position-financials**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.getByRole("button", { name: /^portfolio analytics$/i }).first().click();
  const fallback = page.getByTestId("view-error");
  await expect(fallback).toBeVisible();
  const link = fallback.getByRole("link", { name: /^contact support$/i });
  await expect(link).toHaveAttribute("href", /^mailto:/);
  const body = mailBody((await link.getAttribute("href"))!);
  expect(body).toContain("Current view: analytics");
  expect(body).toContain("Workspace ID: demo-workspace");
});
