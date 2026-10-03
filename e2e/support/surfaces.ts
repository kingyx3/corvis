import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

// The critical customer flows. Every accessibility, performance and resilience assertion is driven
// from this list so a new surface cannot be added without being covered.
export type Surface = {
  id: "overview" | "analytics" | "scorecard" | "documents" | "sources" | "review" | "issues" | "review-discussion" | "delivery" | "schedule" | "research" | "access" | "help" | ConnectSurfaceId;
  label: string;
  role?: "admin";
  nav: RegExp | null;
  heading: RegExp;
  // Surfaces that are not a navigation button (dialogs such as Help) open themselves.
  open?: (page: Page) => Promise<void>;
};

// ---------------------------------------------------------------------------------------------------------
// Connect source wizard (B1). Every step and every error state is its own surface, so none can ship
// without being scanned. The wizard is a dialog opened from the Source connections section (admins only).
// Each surface walks to its state with the real controls; faults the demo server cannot produce on its
// own (an empty provider list, a refused save, a request that never finishes) are injected at the network.
// ---------------------------------------------------------------------------------------------------------
export type ConnectSurfaceId =
  | "connect-empty" | "connect-providers" | "connect-review" | "connect-unconfirmed" | "connect-credential"
  | "connect-credential-error" | "connect-save-error" | "connect-authorize" | "connect-testing" | "connect-success"
  | "connect-failed" | "connect-oauth-denied" | "connect-oauth-invalid" | "connect-reauthorize" | "connect-reauthorized";

export const DEMO_TOKEN_PROVIDER = /^demo gp portal \(api token\)/i;
export const DEMO_OAUTH_PROVIDER = /^demo data room \(sign-in with oauth\)/i;

/** Gives the page its own seeded copy of the demo connections, so a connection made by one test never shows up in another. */
export async function isolateSourceConnections(page: Page): Promise<string> {
  const tenant = `e2e-${randomUUID()}`;
  await page.route("**/api/v1/source-connections**", (route) => route.continue({ headers: { ...route.request().headers(), "x-corvis-demo-tenant": tenant } }));
  return tenant;
}

export async function openConnectWizard(page: Page): Promise<void> {
  await isolateSourceConnections(page);
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await page.getByRole("button", { name: /^connect source$/i }).click();
  await page.getByRole("list", { name: "Approved sources" }).waitFor();
}

async function chooseProvider(page: Page, provider: RegExp): Promise<void> {
  await openConnectWizard(page);
  await page.getByRole("button", { name: provider }).click();
  await page.getByRole("heading", { name: /^review what corvis will access$/i }).waitFor();
}

export async function confirmReview(page: Page): Promise<void> {
  await page.getByRole("checkbox", { name: /i am authorized to give corvis access/i }).check();
  await page.getByRole("button", { name: /^continue to /i }).click();
}

async function openCredentialStep(page: Page): Promise<void> {
  await chooseProvider(page, DEMO_TOKEN_PROVIDER);
  await confirmReview(page);
  await page.getByRole("heading", { name: /^enter the credential$/i }).waitFor();
}

export async function submitToken(page: Page, token: string): Promise<void> {
  await page.getByLabel(/^api token/i).fill(token);
  await page.getByRole("button", { name: /^save and test connection$/i }).click();
}

/** Starts the OAuth leg and lands on the demo provider's consent page. */
export async function goToConsent(page: Page): Promise<void> {
  await chooseProvider(page, DEMO_OAUTH_PROVIDER);
  await confirmReview(page);
  await page.getByRole("button", { name: /^go to the provider$/i }).click();
  await page.getByRole("link", { name: /^approve access$/i }).waitFor();
}

export const REAUTHORIZE_SUMMIT = "Summit virtual data room"; // the seeded OAuth connection that needs attention

/** Opens the "Reauthorize" dialog on the seeded OAuth connection's card. */
async function openOAuthReauthorize(page: Page): Promise<void> {
  await isolateSourceConnections(page);
  await page.getByRole("button", { name: /^documents$/i }).first().click();
  await page.getByRole("button", { name: `Reauthorize ${REAUTHORIZE_SUMMIT}` }).click();
  await page.getByRole("dialog", { name: `Reauthorize ${REAUTHORIZE_SUMMIT}` }).waitFor();
}

/** Starts the reauthorization of the seeded OAuth connection and lands on the demo provider's consent page. */
export async function goToReauthorizeConsent(page: Page): Promise<void> {
  await openOAuthReauthorize(page);
  await page.getByRole("button", { name: /^go to the provider$/i }).click();
  await page.getByRole("link", { name: /^approve access$/i }).waitFor();
}

async function openScorecard(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^portfolio analytics$/i }).first().click();
  await page.getByRole("button", { name: /^performance scorecard$/i }).click();
  await page.getByRole("button", { name: /^advent international gpe viii/i }).click();
  await page.getByRole("region", { name: /underlying investments of advent international gpe viii/i }).waitFor();
}

export const surfaces: Surface[] = [
  { id: "access", label: "Access administration", role: "admin", nav: /^access administration$/i, heading: /^access administration$/i },
  { id: "overview", label: "Overview", nav: null, heading: /reporting overview/i },
  { id: "analytics", label: "Portfolio analytics", nav: /^portfolio analytics$/i, heading: /^position financials$/i },
  // The GP-reported performance scorecard (F1) is the second lens of Portfolio analytics, not a navigation entry of its own.
  // It is scanned loaded and with a fund expanded, so both tables are in the matrix.
  { id: "scorecard", label: "Performance scorecard", nav: /^portfolio analytics$/i, heading: /^performance scorecard$/i, open: openScorecard },
  { id: "documents", label: "Documents", nav: /^documents$/i, heading: /^documents$/i },
  // Source connections live in the Documents view and only exist for administrators (B5/B8).
  { id: "sources", label: "Source connections", role: "admin", nav: /^documents$/i, heading: /^source connections$/i },
  { id: "review", label: "Data review", nav: /^data review$/i, heading: /^data review$/i },
  // Reports on published figures and their status (F5). Seeded per demo subject, so the unseen-update badge is present.
  { id: "issues", label: "Data issues", nav: /^data issues$/i, heading: /^data issues$/i },
  // Assign and discuss a review item (F3): a dialog opened from a row in Data review, so it is reachable from the surface above.
  { id: "review-discussion", label: "Review assignment and discussion", nav: null, heading: /^assign and discuss$/i, open: async (page) => {
    await page.getByRole("button", { name: /^data review$/i }).first().click();
    await page.getByRole("button", { name: /^assign or discuss/i }).first().click();
  } },
  { id: "delivery", label: "Data delivery", nav: /^data delivery$/i, heading: /deliver structured data/i },
  // "Schedule this export" (F4): a dialog opened from a published snapshot in Data review, reachable on every viewport.
  { id: "schedule", label: "Schedule this export", nav: null, heading: /^schedule this export$/i, open: async (page) => {
    await page.getByRole("button", { name: "Open EQT IX Q1 2026" }).click();
    await page.getByRole("button", { name: "Schedule export" }).click();
  } },
  // The Connect source wizard (B1): every step and error state, in order. All are administrator-only.
  { id: "connect-empty", label: "Connect source: no approved providers", role: "admin", nav: null, heading: /^choose a source$/i, open: async (page) => {
    await isolateSourceConnections(page);
    await page.route("**/api/v1/source-connections/providers", (route) => route.fulfill({ json: { data: [] } }));
    await page.getByRole("button", { name: /^documents$/i }).first().click();
    await page.getByRole("button", { name: /^connect source$/i }).click();
    await page.getByTestId("connect-source-empty").waitFor();
  } },
  { id: "connect-providers", label: "Connect source: choose a source", role: "admin", nav: null, heading: /^choose a source$/i, open: openConnectWizard },
  { id: "connect-review", label: "Connect source: review access", role: "admin", nav: null, heading: /^review what corvis will access$/i, open: (page) => chooseProvider(page, DEMO_TOKEN_PROVIDER) },
  { id: "connect-unconfirmed", label: "Connect source: confirmation required", role: "admin", nav: null, heading: /^review what corvis will access$/i, open: async (page) => {
    await chooseProvider(page, DEMO_TOKEN_PROVIDER);
    await page.getByRole("button", { name: /^continue to /i }).click();
    await page.getByRole("alert").filter({ hasText: /confirm that you are authorized/i }).waitFor();
  } },
  { id: "connect-credential", label: "Connect source: enter credential", role: "admin", nav: null, heading: /^enter the credential$/i, open: openCredentialStep },
  { id: "connect-credential-error", label: "Connect source: credential missing", role: "admin", nav: null, heading: /^enter the credential$/i, open: async (page) => {
    await openCredentialStep(page);
    await page.getByRole("button", { name: /^save and test connection$/i }).click();
    await page.getByRole("alert").filter({ hasText: /enter the credential to continue/i }).waitFor();
  } },
  { id: "connect-save-error", label: "Connect source: save failed", role: "admin", nav: null, heading: /^enter the credential$/i, open: async (page) => {
    await openCredentialStep(page);
    await page.route("**/api/v1/source-connections/connect", (route) => route.fulfill({ status: 500, json: { error: "internal_error" } }));
    await submitToken(page, "demo-valid-token");
    await page.getByRole("alert").filter({ hasText: /could not be created/i }).waitFor();
  } },
  { id: "connect-authorize", label: "Connect source: authorize with provider", role: "admin", nav: null, heading: /^authorize with the provider$/i, open: async (page) => {
    await chooseProvider(page, DEMO_OAUTH_PROVIDER);
    await confirmReview(page);
  } },
  { id: "connect-testing", label: "Connect source: testing the connection", role: "admin", nav: null, heading: /^testing the connection$/i, open: async (page) => {
    await openCredentialStep(page);
    // The test is still running: the request is held open for as long as the page lives.
    await page.route("**/api/v1/source-connections/connect", () => new Promise(() => undefined));
    await submitToken(page, "demo-valid-token");
    await page.getByRole("status").filter({ hasText: /checking that it can reach/i }).waitFor();
  } },
  { id: "connect-success", label: "Connect source: connection verified", role: "admin", nav: null, heading: /^connection verified$/i, open: async (page) => {
    await openCredentialStep(page);
    await submitToken(page, "demo-valid-token");
    await page.getByRole("button", { name: /^done$/i }).waitFor();
  } },
  { id: "connect-failed", label: "Connect source: test failed", role: "admin", nav: null, heading: /^the connection test did not pass$/i, open: async (page) => {
    await openCredentialStep(page);
    await submitToken(page, "demo-invalid-token");
    await page.getByRole("button", { name: /^test again$/i }).waitFor();
  } },
  { id: "connect-oauth-denied", label: "Connect source: provider access declined", role: "admin", nav: null, heading: /^authorization was not completed$/i, open: async (page) => {
    await goToConsent(page);
    await page.getByRole("link", { name: /^deny access$/i }).click();
    await page.getByText(/access was not approved at the provider/i).waitFor();
  } },
  { id: "connect-oauth-invalid", label: "Connect source: sign-in attempt unusable", role: "admin", nav: null, heading: /^authorization was not completed$/i, open: async (page) => {
    await isolateSourceConnections(page);
    // A redirect that carries a code and state the server never issued (forged, expired or replayed).
    await page.goto("/?source_oauth=return&code=forged-code&state=forged-state");
    await page.getByText(/can no longer be used/i).waitFor();
  } },
  { id: "connect-reauthorize", label: "Reauthorize an OAuth connection", role: "admin", nav: null, heading: /^reauthorize summit virtual data room$/i, open: openOAuthReauthorize },
  { id: "connect-reauthorized", label: "Connect source: connection reauthorized", role: "admin", nav: null, heading: /^connection reauthorized$/i, open: async (page) => {
    await goToReauthorizeConsent(page);
    await page.getByRole("link", { name: /^approve access$/i }).click();
    await page.getByRole("button", { name: /^done$/i }).waitFor();
  } },
  { id: "research", label: "Ask Corvis", nav: /^ask corvis$/i, heading: /^ask corvis$/i },
  // The Help menu (F9): a dialog opened from the top bar, reachable on every viewport.
  { id: "help", label: "Help and support", nav: null, heading: /^help and support$/i, open: async (page) => { await page.getByRole("button", { name: /^help and support$/i }).first().click(); } },
];

export async function openSurface(page: Page, surface: Surface): Promise<void> {
  if (surface.open) { await surface.open(page); return; }
  if (!surface.nav) return;
  await page.getByRole("button", { name: surface.nav }).first().click();
}

export async function failDemoModule(page: Page, module: string): Promise<void> {
  await page.addInitScript((name) => {
    window.sessionStorage.setItem(`corvis:demo:fail:${name}`, "true");
  }, module);
}

export async function clearDemoFaults(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith("corvis:demo:fail:")) window.sessionStorage.removeItem(key);
    }
  });
}
