import { expect, test } from "@playwright/test";

test("Organization Admin can preview and deactivate a user everywhere", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "admin"));
  await page.goto("/");

  const nav = page.getByRole("navigation", { name: /workspace sections/i });
  await nav.getByRole("button", { name: /access administration/i }).click();
  await expect(page.getByRole("heading", { name: /access administration/i })).toBeVisible();

  const memberRow = page.getByRole("row").filter({ hasText: "jordan.lee@example.test" });
  await expect(memberRow).toContainText("Primary Workspace");
  await expect(memberRow).toContainText("Secondary Workspace");
  await memberRow.getByRole("button", { name: /deactivate everywhere/i }).click();

  const dialog = page.getByRole("dialog", { name: /deactivate jordan\.lee@example\.test everywhere/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("region", { name: /memberships to revoke/i })).toContainText("Primary Workspace");
  await expect(dialog.getByRole("region", { name: /memberships to revoke/i })).toContainText("Secondary Workspace");
  await expect(dialog.getByRole("region", { name: /entitlements to expire/i })).toContainText("fund-demo-1");
  await expect(dialog.getByRole("region", { name: /entitlements to expire/i })).toContainText("document-demo-2");

  await dialog.getByLabel("Offboarding reason").fill("Employment ended; revoke all organization access");
  await dialog.getByRole("button", { name: "Deactivate everywhere", exact: true }).click();

  await expect(page.getByRole("status", { name: /user deactivated everywhere/i })).toContainText("2 memberships revoked");
  await expect(page.getByText("jordan.lee@example.test")).toHaveCount(0);
});

test("access administration is not exposed to a non-admin user", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "read_only"));
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: /workspace sections/i }).getByRole("button", { name: /access administration/i })).toHaveCount(0);
});
