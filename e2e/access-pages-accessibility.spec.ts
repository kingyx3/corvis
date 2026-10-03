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

const retention = {
  policies: [
    { dataClass: "financials", label: "Financial data", retentionDays: 2555, retentionLabel: "7 years", deleteOnTermination: false, legalHold: false, policyVersion: "2026-01", effectiveFrom: "2026-01-01T00:00:00.000Z", inEffect: true },
    { dataClass: "source_documents", label: "Source documents", retentionDays: null, retentionLabel: "No fixed retention period", deleteOnTermination: true, legalHold: true, policyVersion: "2026-03", effectiveFrom: "2026-03-01T00:00:00.000Z", inEffect: true },
  ],
  legalHolds: [{ holdId: "h1", dataClass: "source_documents", label: "Source documents", scopeLabel: "3 documents within source documents", matterReference: "MATTER-2026-014", placedAt: "2026-04-12T09:30:00.000Z" }],
};
const exportBase = {
  reason: "Records review at contract end", requestedAt: "2026-09-30T10:00:00.000Z", approvalExpiresAt: "2026-10-07T10:00:00.000Z", decidedBy: null, decidedAt: null,
  decisionNote: null, cancelledAt: null, statusChangedAt: "2026-09-30T10:00:00.000Z", artifact: null,
};
const dataExports = [
  { ...exportBase, requestId: "x1", status: "pending_approval", requestedBy: "morgan.lee@example.test", requestedByMe: false, actions: { canApprove: true, canReject: true, canCancel: false, canDownload: false } },
  {
    ...exportBase, requestId: "x2", status: "complete", requestedBy: "alex.chen@example.test", requestedByMe: false, decidedBy: "admin@example.test", decidedAt: "2026-09-30T11:00:00.000Z",
    artifact: {
      checksumSha256: "a".repeat(64), sizeBytes: 4694, expiresAt: "2026-10-04T10:00:00.000Z",
      manifest: { manifestVersion: 1, requestId: "x2", tenantId: "tenant-1", generatedAt: "2026-09-30T11:05:00.000Z", requestedBy: "alex.chen@example.test", approvedBy: "admin@example.test",
        files: [{ path: "published-data/observations.csv", description: "Approved observations", sha256: "b".repeat(64), sizeBytes: 702, rowCount: 5 }],
        dataRights: { basis: "Only redistributable data.", funds: { included: 2, excluded: 1 }, documents: { included: 2, excluded: 2 } },
        notIncluded: [{ item: "Source document files", reason: "Not included in this release." }] },
    },
    actions: { canApprove: false, canReject: false, canCancel: false, canDownload: true },
  },
  { ...exportBase, requestId: "x3", status: "rejected", requestedBy: "alex.chen@example.test", requestedByMe: false, decidedBy: "admin@example.test", decisionNote: "Not authorised.", actions: { canApprove: false, canReject: false, canCancel: false, canDownload: false } },
];

const sessionPolicy = {
  policy: { idleTimeoutMinutes: 30, maxSessionMinutes: 480, version: 2, updatedAt: "2026-10-01T09:00:00.000Z", updatedBy: "admin@example.test" },
  bounds: { idleTimeoutMinutes: { min: 15, max: 480 }, maxSessionMinutes: { min: 60, max: 10080 } },
  identityProvider: { protocol: "oidc", issuer: "https://login.example.test" },
  scim: { configured: true, enabled: true, authMethod: "oidc", defaultWorkspaceName: "Primary Workspace", defaultRole: "viewer", activeUsers: 12, updatedAt: "2026-08-14T09:00:00.000Z" },
  signInMethods: [{ authMethod: "oidc", users: 7 }, { authMethod: "saml", users: 2 }],
  members: [
    { userId: "00000000-0000-4000-8000-0000000000d1", label: "admin@example.test", isCurrentUser: true, activeSessions: 1 },
    { userId: "00000000-0000-4000-8000-0000000000d2", label: "morgan.lee@example.test", isCurrentUser: false, activeSessions: 2 },
  ],
};

async function mockAccessApi(page: Page, mode: "loaded" | "failed"): Promise<void> {
  await page.route("**/api/v1/access/**", async (route) => {
    if (mode === "failed") return route.fulfill(json({ error: "temporarily_unavailable" }, 503));
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/audit")) {
      return route.fulfill(json({ data: [{ auditEventId: "a1", occurredAt: "2026-09-02T10:00:00.000Z", actorSubject: "admin@example.test", action: "invitation.created", targetType: "invitation", targetId: "inv-1", outcome: "success", metadata: {} }] }));
    }
    if (path.endsWith("/retention")) return route.fulfill(json({ data: retention }));
    if (path.endsWith("/session-policy")) return route.fulfill(json({ data: sessionPolicy }));
    if (path.endsWith("/data-exports")) return route.fulfill(json({ data: dataExports }));
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
    // The retention and full-export sections (F10) are part of the scan, with every request state and an open manifest.
    await expect(page.getByRole("region", { name: "Retention periods" })).toContainText("Financial data");
    await expect(page.getByRole("region", { name: "Legal holds", exact: true })).toContainText("MATTER-2026-014");
    // The sign-in and session policy section (F7): identity provider, session limits and the sign-out confirmation are part of the scan.
    await expect(page.getByRole("region", { name: "Identity provider and provisioning" })).toContainText("https://login.example.test");
    await page.getByRole("button", { name: "Sign out morgan.lee@example.test everywhere" }).click();
    await expect(page.getByRole("group", { name: "Confirm signing out morgan.lee@example.test" })).toBeVisible();
    const ready = page.getByRole("list", { name: "Data export requests" }).getByRole("listitem").filter({ hasText: "Ready" });
    await ready.getByText("Contents and checksums").click();
    await expect(ready.getByRole("region", { name: /^Files in the export requested/ })).toContainText("published-data/observations.csv");
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
