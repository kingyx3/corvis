import { expect, test, type Page } from "@playwright/test";

// The App Router only applies a CSP nonce to framework/page scripts during a real production,
// dynamically-rendered response (see lib/server/content-security-policy.ts and proxy.ts). `next
// dev` never sends the header at all, so this regression only means something against a real
// production server: `npm run build && CORVIS_E2E_TARGET=production npm run test:e2e:csp`.
test.skip(process.env.CORVIS_E2E_TARGET !== "production", "requires the production server (npm run test:e2e:csp)");

const NONCE_PATTERN = /'nonce-([A-Za-z0-9+/=]+)'/;

function scriptSrcOf(csp: string): string {
  const directive = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src"));
  expect(directive, `no script-src directive in: ${csp}`).toBeTruthy();
  return directive!;
}

async function loadWithCspCapture(page: Page, path: string): Promise<{ csp: string; violations: string[] }> {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy/i.test(message.text())) violations.push(message.text());
  });
  const response = await page.goto(path);
  const csp = response?.headers()["content-security-policy"];
  expect(csp, `expected a Content-Security-Policy header for ${path}`).toBeTruthy();
  return { csp: csp!, violations };
}

test("customer workspace serves a strict, nonce-based script-src with no unsafe-inline and hydrates cleanly", async ({ page }) => {
  const { csp, violations } = await loadWithCspCapture(page, "/");
  const scriptSrc = scriptSrcOf(csp);
  expect(scriptSrc).toContain("'strict-dynamic'");
  expect(scriptSrc).not.toContain("unsafe-inline");
  expect(scriptSrc, scriptSrc).toMatch(NONCE_PATTERN);

  // Hydration actually ran under this policy: the shell is server-rendered, but reaching the
  // "Loading..." -> real content transition and responding to a click both require the client
  // bundle (and its React runtime) to have executed, which strict-dynamic would block if the
  // nonce weren't wired through correctly.
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.getByRole("button", { name: /portfolio analytics/i }).first().click();
  await expect(page.getByRole("heading", { name: /position financials/i })).toBeVisible();

  expect(violations, violations.join("\n")).toEqual([]);
});

test("admin console serves the same strict script-src and hydrates cleanly", async ({ page }) => {
  const { csp, violations } = await loadWithCspCapture(page, "/admin");
  const scriptSrc = scriptSrcOf(csp);
  expect(scriptSrc).toContain("'strict-dynamic'");
  expect(scriptSrc).not.toContain("unsafe-inline");
  expect(scriptSrc, scriptSrc).toMatch(NONCE_PATTERN);

  await expect(page.getByRole("heading", { name: /admin console/i })).toBeVisible();
  // next/link intercepts this client-side, which only happens once React has hydrated.
  await page.getByRole("link", { name: /back to workspace/i }).click();
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();

  expect(violations, violations.join("\n")).toEqual([]);
});

test("every request receives its own fresh nonce", async ({ page }) => {
  const first = await loadWithCspCapture(page, "/");
  const second = await loadWithCspCapture(page, "/");
  const firstNonce = scriptSrcOf(first.csp).match(NONCE_PATTERN)?.[1];
  const secondNonce = scriptSrcOf(second.csp).match(NONCE_PATTERN)?.[1];
  expect(firstNonce).toBeTruthy();
  expect(secondNonce).toBeTruthy();
  expect(firstNonce).not.toEqual(secondNonce);
});
