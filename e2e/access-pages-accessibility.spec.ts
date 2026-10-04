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
      manifest: { manifestVersion: 2, requestId: "x2", tenantId: "tenant-1", generatedAt: "2026-09-30T11:05:00.000Z", requestedBy: "alex.chen@example.test", approvedBy: "admin@example.test",
        files: [{ path: "published-data/observations-0001.csv", description: "Approved observations", sha256: "b".repeat(64), sizeBytes: 702, rowCount: 5, dataset: "observations" }],
        fileCount: 6, sourceFiles: { included: 3, excluded: 1, totalBytes: 3_500_000 },
        dataRights: { basis: "Only redistributable data.", funds: { included: 2, excluded: 1 }, documents: { included: 4, excluded: 2 } },
        notIncluded: [{ item: "Source document files", reason: "1 document is listed in the inventory without its file." }] },
    },
    actions: { canApprove: false, canReject: false, canCancel: false, canDownload: true },
  },
  {
    // F10c: a build in progress shows its size estimate and how far it has got.
    ...exportBase, requestId: "x4", status: "building", requestedBy: "alex.chen@example.test", requestedByMe: false, decidedBy: "admin@example.test", decidedAt: "2026-09-30T09:00:00.000Z",
    progress: { phase: "documents", estimatedBytes: 1_500_000_000, bytesWritten: 600_000_000, estimatedRows: 450_000, rowsWritten: 450_000, estimatedDocuments: 40, documentsWritten: 16, percent: 40, updatedAt: "2026-09-30T09:10:00.000Z" },
    actions: { canApprove: false, canReject: false, canCancel: false, canDownload: false },
  },
  { ...exportBase, requestId: "x3", status: "rejected", requestedBy: "alex.chen@example.test", requestedByMe: false, decidedBy: "admin@example.test", decisionNote: "Not authorised.", actions: { canApprove: false, canReject: false, canCancel: false, canDownload: false } },
];

const sessionPolicy = {
  policy: { idleTimeoutMinutes: 30, maxSessionMinutes: 480, version: 2, updatedAt: "2026-10-01T09:00:00.000Z", updatedBy: "admin@example.test" },
  bounds: { idleTimeoutMinutes: { min: 15, max: 480 }, maxSessionMinutes: { min: 60, max: 10080 } },
  // F7e/F7b: the organization's own recorded provider (token binding on) and its verified email domains are part of the scan.
  identityProvider: { protocol: "oidc", issuer: "https://login.example.test", audience: "corvis-example", source: "tenant", status: "active", tokenBindingEnforced: true },
  verifiedDomains: [{ domain: "example.test", verificationMethod: "dns_txt", verifiedAt: "2026-08-12T09:00:00.000Z" }, { domain: "example.org", verificationMethod: "operator_attested", verifiedAt: "2026-09-01T09:00:00.000Z" }],
  scim: { configured: true, enabled: true, authMethod: "oidc", defaultWorkspaceName: "Primary Workspace", defaultRole: "viewer", activeUsers: 12, updatedAt: "2026-08-14T09:00:00.000Z" },
  signInMethods: [{ authMethod: "oidc", users: 7 }, { authMethod: "saml", users: 2 }],
  members: [
    { userId: "00000000-0000-4000-8000-0000000000d1", label: "admin@example.test", isCurrentUser: true, activeSessions: 1 },
    { userId: "00000000-0000-4000-8000-0000000000d2", label: "morgan.lee@example.test", isCurrentUser: false, activeSessions: 2 },
  ],
};

const credentialFixture = (id: string, overrides: Record<string, unknown> = {}) => ({
  credentialId: id, status: "active", createdBy: "admin@example.test", createdAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-10-10T00:00:00.000Z",
  endsAt: null, revokedAt: null, lastUsedAt: "2026-10-02T08:00:00.000Z", expiringSoon: true, ...overrides,
});
const serviceAccountFixture = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  serviceAccountId: id, userId: "00000000-0000-4000-8000-0000000000aa", name, purpose: "Loads published fund data into the warehouse", workspaceId: "workspace-1", workspaceName: "Primary Workspace",
  roleName: "analyst", status: "active", createdBy: "admin@example.test", createdAt: "2026-06-01T00:00:00.000Z", expiresAt: "2027-06-01T00:00:00.000Z", disabledAt: null, disabledBy: null, disableReason: null,
  ownerSubject: "admin@example.test", ownerAssignedAt: "2026-06-01T00:00:00.000Z", ownerActive: true, needsOwner: false,
  lastUsedAt: "2026-10-02T08:00:00.000Z", credentialExpiresAt: "2026-10-10T00:00:00.000Z", expiringSoon: true,
  credentials: [credentialFixture("c1c1c1c1-0000-4000-8000-000000000001"), credentialFixture("c0c0c0c0-0000-4000-8000-000000000002", { status: "rotating_out", endsAt: "2026-10-03T12:00:00.000Z", expiringSoon: false })],
  actions: { canIssue: false, canRotate: true, canRevoke: true, canDisable: true, canExtend: true, canTransfer: true },
  // What the account can read (F6c): one fund within the organization's data rights, and one that lapsed with them.
  entitlements: [
    { resourceType: "fund", resourceId: "fund-advent-viii", label: "Advent International GPE VIII", permission: "read", grantedAt: "2026-06-02T00:00:00.000Z", withinDataRights: true },
    { resourceType: "document", resourceId: "doc-hg-genesis-q2", label: "Hg Genesis 9 - Investor Report Q2.pdf", permission: "read", grantedAt: "2026-06-02T00:00:00.000Z", withinDataRights: false },
  ],
  entitlementAccess: { canGrant: true, canRevoke: true }, ...overrides,
});
const serviceAccounts = {
  serviceAccounts: [
    serviceAccountFixture("a1a1a1a1-0000-4000-8000-000000000001", "Nightly reporting sync"),
    serviceAccountFixture("a2a2a2a2-0000-4000-8000-000000000002", "Retired data bridge", {
      status: "disabled", expiringSoon: false, credentialExpiresAt: null, disabledAt: "2026-09-01T00:00:00.000Z", disabledBy: "admin@example.test", disableReason: "Integration retired",
      credentials: [credentialFixture("c3c3c3c3-0000-4000-8000-000000000003", { status: "revoked", revokedAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-01T00:00:00.000Z", expiringSoon: false })],
      actions: { canIssue: false, canRotate: false, canRevoke: false, canDisable: false, canExtend: false, canTransfer: false },
      entitlements: [], entitlementAccess: { canGrant: false, canRevoke: false },
    }),
    // Owned by an administrator who has since been deactivated: it keeps working and needs a new owner.
    serviceAccountFixture("a4a4a4a4-0000-4000-8000-000000000004", "Partner data feed", {
      expiringSoon: false, ownerSubject: "former.admin@example.test", ownerActive: false, needsOwner: true,
      actions: { canIssue: false, canRotate: true, canRevoke: true, canDisable: true, canExtend: false, canTransfer: true },
    }),
  ],
  workspaces: [{ workspaceId: "workspace-1", name: "Primary Workspace" }],
  owners: [{ subject: "admin@example.test" }, { subject: "second.admin@example.test" }],
  grantable: [
    { resourceType: "fund", resourceId: "fund-advent-viii", label: "Advent International GPE VIII" },
    { resourceType: "fund", resourceId: "fund-nordic-v", label: "Nordic Capital Fund V" },
    { resourceType: "document", resourceId: "doc-adv-viii-q2", label: "Advent International GPE VIII - Q2 2026.pdf" },
  ],
};

async function mockAccessApi(page: Page, mode: "loaded" | "failed"): Promise<void> {
  await page.route("**/api/v1/access/**", async (route) => {
    if (mode === "failed") return route.fulfill(json({ error: "temporarily_unavailable" }, 503));
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/audit")) {
      return route.fulfill(json({ data: [{ auditEventId: "a1", occurredAt: "2026-09-02T10:00:00.000Z", actorSubject: "admin@example.test", action: "invitation.created", targetType: "invitation", targetId: "inv-1", outcome: "success", metadata: {} }] }));
    }
    if (path.endsWith("/service-accounts")) {
      if (route.request().method() === "POST") {
        return route.fulfill(json({ data: { serviceAccount: serviceAccountFixture("a3a3a3a3-0000-4000-8000-000000000003", "Warehouse loader", { expiringSoon: false }), credential: { credentialId: "c4c4c4c4-0000-4000-8000-000000000004", secret: `corvis_sa_${"c4".repeat(16)}_${"A".repeat(43)}`, expiresAt: "2026-12-30T00:00:00.000Z" } } }, 201));
      }
      return route.fulfill(json({ data: serviceAccounts }));
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
    // The service-account list (F6) is part of the scan: a flagged account with a rotating-out credential, and a deactivated one.
    const nightly = page.getByRole("list", { name: "Service accounts" }).getByRole("listitem").filter({ hasText: "Nightly reporting sync" });
    await expect(nightly).toContainText("Needs attention");
    await nightly.getByText(/^Credentials \(2\)/).click();
    await expect(nightly.getByRole("region", { name: /credentials of nightly reporting sync/i })).toContainText("Rotating out");
    await expect(page.getByRole("list", { name: "Service accounts" }).getByRole("listitem").filter({ hasText: "Retired data bridge" })).toContainText("Integration retired");
    // An account whose owner was deactivated is surfaced as needing a new owner (F6b).
    const orphaned = page.getByRole("list", { name: "Service accounts" }).getByRole("listitem").filter({ hasText: "Partner data feed" });
    await expect(orphaned).toContainText("Needs a new owner.");
    await expect(orphaned).toContainText("former.admin@example.test (no longer active)");
    // The retention and full-export sections (F10) are part of the scan, with every request state and an open manifest.
    await expect(page.getByRole("region", { name: "Retention periods" })).toContainText("Financial data");
    await expect(page.getByRole("region", { name: "Legal holds", exact: true })).toContainText("MATTER-2026-014");
    // The sign-in and session policy section (F7): identity provider, session limits and the sign-out confirmation are part of the scan.
    const provider = page.getByRole("region", { name: "Identity provider and provisioning" });
    await expect(provider).toContainText("https://login.example.test");
    await expect(provider).toContainText("tokens are accepted only from this issuer and audience");
    await expect(provider).toContainText("example.test, example.org");
    await page.getByRole("button", { name: "Sign out morgan.lee@example.test everywhere" }).click();
    await expect(page.getByRole("group", { name: "Confirm signing out morgan.lee@example.test" })).toBeVisible();
    // F10d: a colleague's request is waiting for this admin, so the approval notice sits at the top of the page and is part of the scan.
    await expect(page.getByRole("status").filter({ hasText: "A data export is awaiting your approval" })).toContainText("Review the request");
    const ready = page.getByRole("list", { name: "Data export requests" }).getByRole("listitem").and(page.locator("[data-status=complete]"));
    await ready.getByText("Contents and checksums").click();
    await expect(ready.getByRole("region", { name: /^Files in the export requested/ })).toContainText("published-data/observations-0001.csv");
    await expect(ready).toContainText("3 source document files (3.3 MB) are in the archive");
    // F10c: the running build shows its estimate and progress, and is part of the scan.
    const building = page.getByRole("list", { name: "Data export requests" }).getByRole("listitem").filter({ hasText: "Copying source documents" });
    await expect(building.getByRole("progressbar", { name: "Export build progress, 40%" })).toBeVisible();
    await expect(building).toContainText("40% of an estimated 1.4 GB");
    await expect(building).toContainText("450,000 of about 450,000 data rows · 16 of 40 source files");
    const violations = await blockingViolations(page);
    expect(violations, describe(violations)).toEqual([]);
  });

  test(`service-account forms and the one-time credential panel pass axe in ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await mockAccessApi(page, "loaded");
    await page.goto("/access-self-service");
    const section = page.locator("section[aria-labelledby='service-accounts-heading']");
    await expect(section.getByRole("list", { name: "Service accounts" })).toBeVisible();
    // Create form, then the one-time credential panel.
    await section.getByLabel("Name").fill("Warehouse loader");
    await section.getByLabel("What it is for").fill("Loads published fund data");
    await section.getByRole("button", { name: /create service account/i }).click();
    const reveal = page.getByRole("group", { name: "New API credential" });
    await expect(reveal.getByLabel("API credential (shown once)")).toHaveValue(/^corvis_sa_/);
    let violations = await blockingViolations(page, "section[aria-labelledby='service-accounts-heading']");
    expect(violations, describe(violations)).toEqual([]);
    await reveal.getByRole("button", { name: /i have stored it/i }).click();
    // The rotate and deactivate confirmations.
    const nightly = section.getByRole("list", { name: "Service accounts" }).getByRole("listitem").filter({ hasText: "Nightly reporting sync" });
    await nightly.getByRole("button", { name: "Rotate credential" }).click();
    await expect(nightly.getByRole("group", { name: /rotate the credential of nightly reporting sync/i })).toBeVisible();
    violations = await blockingViolations(page, "section[aria-labelledby='service-accounts-heading']");
    expect(violations, describe(violations)).toEqual([]);
    await nightly.getByRole("button", { name: "Back" }).click();
    // The extend and change-owner panels.
    await nightly.getByRole("button", { name: "Extend expiry" }).click();
    await expect(nightly.getByRole("group", { name: "Extend Nightly reporting sync" })).toBeVisible();
    violations = await blockingViolations(page, "section[aria-labelledby='service-accounts-heading']");
    expect(violations, describe(violations)).toEqual([]);
    await nightly.getByRole("button", { name: "Back" }).click();
    await nightly.getByRole("button", { name: "Change owner" }).click();
    await expect(nightly.getByRole("group", { name: "Change the owner of Nightly reporting sync" })).toBeVisible();
    violations = await blockingViolations(page, "section[aria-labelledby='service-accounts-heading']");
    expect(violations, describe(violations)).toEqual([]);
    await nightly.getByRole("button", { name: "Back" }).click();
    // The data-access list, the grant panel and the remove confirmation (F6c).
    await expect(nightly.getByRole("group", { name: "Data access of Nightly reporting sync" })).toContainText("Not covered by your organization's data rights");
    violations = await blockingViolations(page, "section[aria-labelledby='service-accounts-heading']");
    expect(violations, describe(violations)).toEqual([]);
    await nightly.getByRole("button", { name: "Grant data access" }).click();
    await expect(nightly.getByRole("group", { name: "Grant data access to Nightly reporting sync" })).toBeVisible();
    violations = await blockingViolations(page, "section[aria-labelledby='service-accounts-heading']");
    expect(violations, describe(violations)).toEqual([]);
    await nightly.getByRole("button", { name: "Back" }).click();
    await nightly.getByRole("button", { name: /Remove access to Advent International GPE VIII from Nightly reporting sync/ }).click();
    await expect(nightly.getByText("Remove access to Advent International GPE VIII?")).toBeVisible();
    violations = await blockingViolations(page, "section[aria-labelledby='service-accounts-heading']");
    expect(violations, describe(violations)).toEqual([]);
    await nightly.getByRole("button", { name: "Back" }).click();
    await nightly.getByRole("button", { name: "Deactivate account" }).click();
    await expect(nightly.getByText("Deactivate this account everywhere?")).toBeVisible();
    violations = await blockingViolations(page, "section[aria-labelledby='service-accounts-heading']");
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

  test(`operator view of tenant export builds (loaded, empty and refused) passes axe in ${colorScheme} theme @matrix`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    const issue = (requestId: string, overrides: Record<string, unknown> = {}) => ({
      tenantId: "tenant-1", tenantName: "Meridian Capital", requestId, status: "failed", attempts: 5, lastError: "GCS object write failed (503)",
      requestedAt: "2026-10-01T10:00:00.000Z", changedAt: "2026-10-02T10:00:00.000Z", nextAttemptAt: null, ...overrides,
    });
    let mode: "loaded" | "empty" | "refused" = "loaded";
    await page.route("**/api/v1/admin/tenant-export-builds**", (route) => {
      if (mode === "refused") return route.fulfill(json({ error: "operations_admin_required" }, 403));
      if (mode === "empty") return route.fulfill(json({ data: [], nextCursor: null }));
      const status = new URL(route.request().url()).searchParams.get("status");
      const items = [issue("b1", { lastError: "export build lease expired before completion" }), issue("b2", { status: "retrying", attempts: 2, nextAttemptAt: "2026-10-02T11:00:00.000Z" })];
      return route.fulfill(json({ data: status === null ? items : items.filter((item) => item.status === status), nextCursor: null }));
    });
    await page.goto("/admin/tenant-export-builds");
    await expect(page.getByRole("heading", { name: "Tenant export builds" })).toBeVisible();
    const table = page.getByRole("region", { name: "Tenant export builds" });
    await expect(table).toContainText("Meridian Capital");
    await expect(table).toContainText("export build lease expired before completion");
    await expect(table).toContainText("Retrying");
    let violations = await blockingViolations(page);
    expect(violations, describe(violations)).toEqual([]);
    await page.getByRole("button", { name: "Failed" }).click();
    await expect(table).not.toContainText("Retrying");
    await expect(page.getByRole("button", { name: "Failed" })).toHaveAttribute("aria-pressed", "true");
    mode = "empty";
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(table).toContainText("No failed or retrying export builds.");
    violations = await blockingViolations(page);
    expect(violations, describe(violations)).toEqual([]);
    mode = "refused";
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Only Corvis operations can view export builds." })).toBeVisible();
    violations = await blockingViolations(page);
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
