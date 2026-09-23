import { test, expect } from "@playwright/test";

test("customer can navigate trusted workspace surfaces", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /portfolio|overview|reporting/i }).first()).toBeVisible();

  await page.getByRole("button", { name: /documents/i }).first().click();
  await expect(page.getByRole("heading", { name: /documents/i })).toBeVisible();

  await page.getByRole("button", { name: /data review/i }).first().click();
  await expect(page.getByRole("heading", { name: /data review/i })).toBeVisible();

  await page.getByRole("button", { name: /data delivery/i }).first().click();
  await expect(page.getByRole("heading", { name: /deliver structured data/i })).toBeVisible();

  await page.getByRole("button", { name: /ask corvis/i }).first().click();
  await expect(page.getByRole("heading", { name: /ask corvis/i })).toBeVisible();
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
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "Demo Fund — Q3 2026.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nCorvis end-to-end fixture\n"),
  });

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

  await page.getByRole("button", { name: /data delivery/i }).first().click();
  await expect(page.getByRole("heading", { name: /deliver structured data/i })).toBeVisible();
  await page.getByRole("button", { name: /request csv/i }).click();
  await expect(page.getByRole("status", { name: /export requested/i })).toContainText(/CSV/i);
  await expect(page.getByRole("status", { name: /export requested/i })).toContainText(/observations/i);
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
