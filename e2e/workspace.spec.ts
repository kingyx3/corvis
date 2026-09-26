import { test, expect } from "@playwright/test";

test("customer can navigate trusted workspace surfaces", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /portfolio|overview|reporting/i }).first()).toBeVisible();
  await page.getByRole("button", { name: /portfolio analytics/i }).first().click();
  await expect(page.getByRole("heading", { name: /position financials/i })).toBeVisible();
  await page.getByRole("button", { name: /documents/i }).first().click();
  await expect(page.getByRole("heading", { name: /documents/i })).toBeVisible();
  await page.getByRole("button", { name: /data review/i }).first().click();
  await expect(page.getByRole("heading", { name: /data review/i })).toBeVisible();
  await page.getByRole("button", { name: /data delivery/i }).first().click();
  await expect(page.getByRole("heading", { name: /deliver structured data/i })).toBeVisible();
  await page.getByRole("button", { name: /ask corvis/i }).first().click();
  await expect(page.getByRole("heading", { name: /ask corvis/i })).toBeVisible();
});

test("the sidebar shows the real workspace/tenant identity, not the static placeholder", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  const workspaceSection = page.locator(".sidebar-section", { has: page.getByText("WORKSPACE") });
  await expect(workspaceSection.getByText("Current workspace")).toHaveCount(0);
  await expect(workspaceSection.getByText("Tenant-scoped")).toHaveCount(0);
  await expect(workspaceSection.getByText("Primary Workspace")).toBeVisible();
  await expect(workspaceSection.getByText("Meridian Capital Partners")).toBeVisible();
  // The avatar-style initial derives from the real name, not a hardcoded letter.
  await expect(workspaceSection.locator(".workspace-dot")).toHaveText("P");
});

test("global workspace search is actionable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /search entitled workspace data/i }).click();
  const dialog = page.getByRole("dialog", { name: /global workspace search/i });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Search workspace").fill("Advent");
  const result = dialog.getByRole("option").filter({ hasText: /Advent International GPE VIII — Q2 2026\.pdf/i }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
  await expect(page.getByRole("dialog", { name: /document details for advent international gpe viii/i })).toBeVisible();
});

test("global search results are keyboard navigable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: /global workspace search/i });
  const input = dialog.getByRole("combobox", { name: "Search workspace" });
  await expect(input).toBeFocused();
  await input.fill("Advent");
  const options = dialog.getByRole("listbox", { name: /search results/i }).getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
  await expect(input).toHaveAttribute("aria-activedescendant", (await options.nth(1).getAttribute("id")) ?? "");
  await input.press("ArrowUp");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("dialog", { name: /document details for advent international gpe viii/i })).toBeVisible();
});

test("observation search drills through to the focused row in the review queue", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /search entitled workspace data/i }).click();
  const dialog = page.getByRole("dialog", { name: /global workspace search/i });
  await dialog.getByLabel("Search workspace").fill("842");
  await expect(dialog.getByRole("option").filter({ hasText: /ABC Corp · Revenue/ })).toHaveCount(1);
  await dialog.getByLabel("Search workspace").press("Enter");
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
  const focusedRow = page.getByRole("region", { name: /data review observations table/i }).locator('tr[aria-current="true"]');
  await expect(focusedRow).toHaveCount(1);
  await expect(focusedRow).toContainText("Revenue");
  await expect(focusedRow).toContainText("$842.0m");
  await expect(focusedRow).toBeInViewport();
  await expect(page.getByRole("status", { name: /focused review item/i })).toContainText("ABC Corp · Revenue");

  // Previous/Next move the highlighted queue position from the drilled-through row.
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(focusedRow).not.toContainText("$842.0m");
  await expect(focusedRow).toBeInViewport();
});

test("a read-only identity only sees the workflows its capabilities allow", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:role", "read_only"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  const nav = page.getByRole("navigation", { name: /workspace sections/i });
  await expect(nav.getByRole("button")).toHaveCount(4);
  await expect(nav.getByRole("button", { name: /portfolio analytics/i })).toHaveCount(1);
  await expect(nav.getByRole("button", { name: /data delivery/i })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: /ask corvis/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /upload documents/i })).toHaveCount(0);

  await nav.getByRole("button", { name: /portfolio analytics/i }).click();
  await expect(page.getByRole("heading", { name: /position financials/i })).toBeVisible();

  await nav.getByRole("button", { name: /^documents$/i }).click();
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /upload documents/i })).toHaveCount(0);

  await nav.getByRole("button", { name: /^data review$/i }).click();
  await expect(page.getByRole("heading", { name: /^data review$/i })).toBeVisible();
  await expect(page.getByText(/read-only trusted data/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /export this snapshot/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /publish snapshot/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  const table = page.getByRole("region", { name: /data review observations table/i });
  await expect(table.getByText("p. 18 · Portfolio Company Summary").first()).toBeVisible();
  await expect(table.locator("button.source-link")).toHaveCount(0);
});

test("document period and status filters are functional", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  const bodyRows = page.getByRole("region", { name: /documents table/i }).locator("tbody tr");
  await expect(bodyRows).toHaveCount(4);
  await page.getByLabel("Document status").selectOption({ label: "Review" });
  await expect(page.getByRole("status").filter({ hasText: /^1 of 4$/ })).toBeVisible();
  await expect(bodyRows).toHaveCount(1);
  await expect(bodyRows.first()).toContainText("Nordic Capital Fund V");
  await page.getByLabel("Search documents").fill("Advent");
  await expect(bodyRows).toHaveCount(1);
  await expect(bodyRows.first()).toContainText(/no documents match/i);
  await page.getByRole("button", { name: /clear filters/i }).click();
  await expect(page.getByLabel("Document status")).toHaveValue("all");
  await expect(bodyRows).toHaveCount(4);
  await page.getByLabel("Reporting period").selectOption({ label: "Q2 2026" });
  await expect(page.getByRole("status").filter({ hasText: /^4 of 4$/ })).toBeVisible();
});

test("upload dialog is accessible and reports lifecycle", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /documents/i }).first().click();
  await page.getByRole("button", { name: /upload/i }).first().click();
  const dialog = page.getByRole("dialog", { name: /upload documents/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /choose source documents/i })).toBeVisible();
  await expect(dialog.getByText(/register.*interpret.*extract.*review.*reconcile.*publish/i)).toBeVisible();
  await dialog.getByRole("button", { name: /close upload dialog/i }).click();
  await expect(dialog).toBeHidden();
});

test("closing the upload dialog mid-upload asks before cancelling", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /documents/i }).first().click();
  await page.getByRole("button", { name: /upload documents/i }).first().click();

  const dialog = page.getByRole("dialog", { name: /upload documents/i });
  await dialog.locator('input[type="file"]').setInputFiles(["One", "Two", "Three"].map((name) => ({
    name: `In-flight ${name}.pdf`,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nCorvis end-to-end fixture\n"),
  })));

  await dialog.getByRole("button", { name: /close upload dialog/i }).click();
  await expect(dialog.getByRole("alert")).toContainText(/still in progress/i);
  await expect(dialog.getByRole("button", { name: /keep uploading/i })).toBeFocused();
  await dialog.getByRole("button", { name: /keep uploading/i }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toBeHidden();
  await expect(dialog.getByRole("button", { name: /^done$/i })).toBeFocused();

  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: /cancel uploads/i }).click();
  await expect(dialog).toBeHidden();
});

test("customer can upload, review, publish and request structured delivery", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /documents/i }).first().click();
  await page.getByRole("button", { name: /upload documents/i }).first().click();
  const dialog = page.getByRole("dialog", { name: /upload documents/i });
  await dialog.locator('input[type="file"]').setInputFiles({ name: "Demo Fund — Q3 2026.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nCorvis end-to-end fixture\n") });
  await expect(dialog.getByLabel("Upload complete")).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: /view documents/i }).click();
  await expect(page.getByText("Demo Fund — Q3 2026.pdf")).toBeVisible();
  await page.getByRole("button", { name: /data review/i }).first().click();
  await expect(page.getByRole("heading", { name: /data review/i })).toBeVisible();
  const reviewRow = page.getByRole("row").filter({ hasText: "Adjusted EBITDA" });
  const approveButton = reviewRow.getByRole("button", { name: "Approve" });
  await expect(approveButton).toBeVisible();
  await approveButton.click();
  await expect(page.getByText("Observation approval recorded.")).toBeVisible();
  const publishButton = page.getByRole("button", { name: /publish snapshot/i });
  await expect(publishButton).toBeEnabled();
  await publishButton.click();
  await expect(page.getByText(/snapshot publication accepted/i)).toBeVisible();
  // The reviewer stays on the snapshot they published and cannot re-publish it.
  await expect(page.getByText(/demo fund · q3 2026 · snapshot v2/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^published$/i })).toBeDisabled();
  await page.getByRole("button", { name: /data delivery/i }).first().click();
  await expect(page.getByRole("heading", { name: /deliver structured data/i })).toBeVisible();
  await page.getByRole("button", { name: /request csv/i }).click();
  await expect(page.getByRole("status", { name: /export requested/i })).toContainText(/CSV/i);
  await expect(page.getByRole("status", { name: /export requested/i })).toContainText(/observations/i);
  await expect(page.getByRole("region", { name: /recent export history/i })).toContainText(/Complete/i);
  await expect(page.getByRole("region", { name: /recent export history/i })).toContainText(/CSV/i);
});

test("reviewer correction uses a structured dialog instead of a browser prompt", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /data review/i }).first().click();
  const needsReviewRow = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Correct" }) }).first();
  await needsReviewRow.getByRole("button", { name: "Correct" }).click();
  const dialog = page.getByRole("dialog", { name: /correct observation/i });
  await expect(dialog).toBeVisible();
  const value = dialog.getByLabel("Corrected value");
  await value.fill("$99.0m");
  await dialog.getByRole("button", { name: /record decision/i }).click();
  await expect(page.getByText(/correction recorded/i)).toBeVisible();
});

test("one failed read module does not blank unrelated customer workflows", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("corvis:demo:fail:observations", "true"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /reporting overview/i })).toBeVisible();
  const degraded = page.getByRole("status", { name: /workspace degraded/i });
  await expect(degraded).toContainText("observations");
  await page.getByRole("button", { name: /documents/i }).first().click();
  await expect(page.getByRole("heading", { name: /^documents$/i })).toBeVisible();
  await page.getByRole("button", { name: /data review/i }).first().click();
  await expect(page.getByRole("heading", { name: /data review is temporarily unavailable/i })).toBeVisible();
  await page.getByRole("button", { name: /ask corvis/i }).first().click();
  await expect(page.getByRole("heading", { name: /ask corvis/i })).toBeVisible();
});

test("Ask Corvis uses the research port rather than hard-coded evidence", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /ask corvis/i }).first().click();
  const box = page.getByPlaceholder(/ask about a fund/i);
  await box.fill("What changed this quarter?");
  await box.press("Control+Enter").catch(() => undefined);
  await page.locator("form.ask-box button").click();
  await expect(page.getByText(/demo response for: what changed this quarter/i)).toBeVisible();
  await expect(page.getByText(/demo mode/i)).toBeVisible();
});
