import { expect, test } from "@playwright/test";

// Smoke test of the real (non-demo) application: the HTTP workspace adapter, the API's
// authentication boundary and the production bundle, which every other spec replaces with the
// in-memory demo port. Run with `npm run test:e2e:non-demo` after a non-demo `npm run build`.
test.skip(process.env.CORVIS_E2E_DEMO !== "false", "requires a non-demo production server (npm run test:e2e:non-demo)");

const DEMO_FIXTURE = /Nordic Capital Fund V/;

test("the API refuses unauthenticated requests instead of serving demo data", async ({ request }) => {
  const response = await request.get("/api/v1/me");
  expect(response.status()).toBe(401);
  expect((await response.json()).error).toBe("authentication_required");
  const documents = await request.get("/api/v1/documents");
  expect(documents.status()).toBe(401);
});

test("an unauthenticated visit shows the sign-in prompt and no demo fixtures", async ({ page }) => {
  await page.goto("/");
  const prompt = page.getByRole("alert", { name: /session expired/i });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole("button", { name: /sign in again/i })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(DEMO_FIXTURE);
  expect(await page.content()).not.toMatch(DEMO_FIXTURE);
});

test("Contact support quotes the correlation id of the failed API request and attaches no demo data", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("alert", { name: /session expired/i })).toBeVisible();
  await page.getByRole("button", { name: /^help and support$/i }).first().click();
  const dialog = page.getByRole("dialog", { name: /^help and support$/i });
  const href = (await dialog.getByRole("link", { name: /^contact support$/i }).getAttribute("href"))!;
  const body = new URL(href).searchParams.get("body")!;
  // The 401 from /api/v1/me carries the server's correlation id, which support can find in the logs.
  expect(body).toMatch(/Latest request ID: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  expect(body).toContain("Current view: overview");
  expect(body).not.toMatch(DEMO_FIXTURE);
});
