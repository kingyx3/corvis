import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { accessibilityBudget } from "./quality-budgets.ts";

// Pages that live outside the workspace shell (and so outside e2e/support/surfaces.ts):
// /access-self-service, /invite and the tenant-provisioning confirmation on /admin (#178 E9).
// Their API calls are fulfilled with route mocks so every state (loaded, failed, accepted,
// invalid) is scanned deterministically, in both colour schemes.

type Violation = { id: string; impact?: string | null; help: string; nodes: Array<{ target: unknown[] }> };

async function blockingViolations(page: Page, include?: string): Promise<Violation[]> {
  const builder = new AxeBuilder({ page }).withTags([...accessibilityBudget.tags]);
  const results = await (include ? builder.include(include) : builder).analyze();
  return results.violations.filter((violation) => (accessibilityBudget.blockedImpacts as readonly string[]).includes(violation.impact ?? ""));
}

function describe(violations: Violation[]): string {
  return violations.map((violation) => `${violation.impact}/${violation.id}: ${violation.help} (${violation.nodes.length} node(s), first: ${JSON.stringify(violation.nodes[0]?.target)})`).join("\n");
}

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const invitation = {
  invitationId: "inv-1", tenantId: "tenant-1", workspaceId: "workspace-1", workspaceName: "Primary Workspace",
  email: "new.analyst@example.test", roleName: "analyst", status: "pending",
  createdAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-08T00:00:00.000Z",
};

async function mockAccessApi(page: Page, mode: "loaded" | "failed"): Promise<void> {
  await page.route("**/api/v1/access/**", async (route) => {
    if (mode === "failed") return route.fulfill(json({ error: "temporarily_unavailable" }, 503));
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/audit")) {
      return route.fulfill(json({ data: [{ auditEventId: "a1", occurredAt: "2026-09-02T10:00:00.000Z", actorSubject: "admin@example.test", action: "invitation.created", targetType: "invitation", targetId: "inv-1", outcome: "success", metadata: {} }] }));
    }
    if (path.endsWith("/support")) {
      return route.fulfill(json({ data: {
        grants: [{ supportGrantId: "g1", workspaceId: "workspace-1", roleName: "support", purpose: "Investigate a data incident", validFrom: "2026-09-01T00:00:00.000Z", validUntil: "2026-09-02T00:00:00.000Z", status: "pending_ack", requiresTenantAck: true, subject: "support@corvis.example" }],
        notifications: [{ notificationId: "n1", kind: "support_access", supportGrantId: "g1", title: "Support access requested", message: "Corvis support asked for temporary access.", createdAt: "2026-09-01T00:00:00.000Z" }],
      } }));
    }
    return route.fulfill(json({ data: [invitation] }));
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`access self-service (loaded) passes axe in ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await mockAccessApi(page, "loaded");
    await page.goto("/access-self-service");
    await expect(page.getByRole("heading", { name: /tenant access controls/i })).toBeVisible();
    await expect(page.getByText("new.analyst@example.test").first()).toBeVisible();
    const violations = await blockingViolations(page);
    expect(violations, describe(violations)).toEqual([]);
  });

  test(`access self-service (load failed) passes axe in ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await mockAccessApi(page, "failed");
    await page.goto("/access-self-service");
    await expect(page.getByRole("heading", { name: /tenant access controls/i })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: /access controls need attention/i })).toBeVisible();
    const violations = await blockingViolations(page);
    expect(violations, describe(violations)).toEqual([]);
  });

  test(`invitation page (accepted) passes axe in ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.route("**/api/v1/invitations/accept", (route) => route.fulfill(json({ data: { tenantId: "tenant-1", workspaceId: "workspace-1" } })));
    await page.goto("/invite?tenantId=tenant-1&workspaceId=workspace-1#one-time-token");
    await expect(page.getByRole("heading", { name: /invitation accepted/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /continue to corvis/i })).toBeVisible();
    const violations = await blockingViolations(page);
    expect(violations, describe(violations)).toEqual([]);
  });

  test(`invitation page (rejected, with retry) passes axe in ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.route("**/api/v1/invitations/accept", (route) => route.fulfill(json({ error: "invitation_expired" }, 410)));
    await page.goto("/invite?tenantId=tenant-1&workspaceId=workspace-1#one-time-token");
    await expect(page.getByRole("alert").filter({ hasText: /couldn.t accept the invitation/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
    const violations = await blockingViolations(page);
    expect(violations, describe(violations)).toEqual([]);
  });

  test(`invitation page (incomplete link) passes axe in ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/invite");
    await expect(page.getByRole("alert").filter({ hasText: /incomplete/i })).toBeVisible();
    const violations = await blockingViolations(page);
    expect(violations, describe(violations)).toEqual([]);
  });

  test(`tenant-provisioning confirmation dialog passes axe in ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: /admin console/i })).toBeVisible();
    const card = page.locator("section.admin-card").filter({ has: page.getByRole("heading", { name: "Client tenant provisioning" }) });
    const trigger = card.getByRole("button", { name: /review change/i });
    // The admin console is server-rendered, so the fields exist before React hydrates. Input typed
    // before hydration is reset to the (empty) controlled state, leaving the button disabled; that
    // race only showed on WebKit, which hydrates slower. Refill until the hydrated form accepts it.
    await expect(async () => {
      await card.getByLabel("Tenant slug").fill("acme-capital");
      await card.getByLabel("Tenant display name").fill("Acme Capital Partners");
      await card.getByLabel("Initial workspace slug").fill("primary");
      await card.getByLabel("Initial workspace display name").fill("Primary Workspace");
      await card.getByLabel("First organization admin email").fill("admin@example.org");
      await card.getByLabel("Reason", { exact: true }).fill("Contracted onboarding");
      await expect(trigger).toBeEnabled({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: /confirm client tenant provisioning/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /confirm privileged change/i })).toBeVisible();
    await expect(dialog.getByText("POST /api/v1/admin/tenants", { exact: true })).toBeVisible();
    const violations = await blockingViolations(page, '[role="dialog"]');
    expect(violations, describe(violations)).toEqual([]);
  });
}

test("bulk invite requires explicit confirmation for tenant_admin rows (#244)", async ({ page }) => {
  const bulkUrls: string[] = [];
  await mockAccessApi(page, "loaded");
  await page.route("**/api/v1/access/invitations/bulk**", (route) => {
    bulkUrls.push(route.request().url());
    return route.fulfill(json({ data: {
      created: [{ row: 2, name: "", token: "t2", invitation: { ...invitation, invitationId: "inv-2", email: "boss@example.test", roleName: "tenant_admin" } }],
      errors: [{ row: 3, error: "invitation_already_pending" }],
      summary: { total: 2, created: 1, failed: 1 },
    } }, 201));
  });
  await page.goto("/access-self-service");
  await expect(page.getByText("new.analyst@example.test").first()).toBeVisible();
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  await page.getByLabel("CSV file").setInputFiles({ name: "invite.csv", mimeType: "text/csv", buffer: Buffer.from(`email,role,workspaceId\nboss@example.test,tenant_admin,${workspaceId}\nanalyst@example.test,analyst,${workspaceId}\n`) });
  const group = page.getByRole("group", { name: /1 row\(s\) grant organization admin/i });
  await expect(group).toContainText("Row 2: boss@example.test");
  const submit = page.getByRole("button", { name: /validate & invite/i });
  await expect(submit).toBeDisabled();
  const violations = await blockingViolations(page);
  expect(violations, describe(violations)).toEqual([]);
  await group.getByRole("checkbox").check();
  await submit.click();
  await expect(page.getByText(/1 created · 1 failed/)).toBeVisible();
  expect(bulkUrls).toHaveLength(1);
  expect(new URL(bulkUrls[0]).searchParams.get("confirmTenantAdmin")).toBe("true");
  await expect(page.getByRole("region", { name: /rows that were not invited/i })).toContainText("An invitation for this address is already pending.");
});
