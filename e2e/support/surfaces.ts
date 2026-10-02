import type { Page } from "@playwright/test";

// The critical customer flows. Every accessibility, performance and resilience assertion is driven
// from this list so a new surface cannot be added without being covered.
export type Surface = {
  id: "overview" | "analytics" | "documents" | "sources" | "review" | "delivery" | "research" | "access" | "help";
  label: string;
  role?: "admin";
  nav: RegExp | null;
  heading: RegExp;
  // Surfaces that are not a navigation button (dialogs such as Help) open themselves.
  open?: (page: Page) => Promise<void>;
};

export const surfaces: Surface[] = [
  { id: "access", label: "Access administration", role: "admin", nav: /^access administration$/i, heading: /^access administration$/i },
  { id: "overview", label: "Overview", nav: null, heading: /reporting overview/i },
  { id: "analytics", label: "Portfolio analytics", nav: /^portfolio analytics$/i, heading: /^position financials$/i },
  { id: "documents", label: "Documents", nav: /^documents$/i, heading: /^documents$/i },
  // Source connections live in the Documents view and only exist for administrators (B5/B8).
  { id: "sources", label: "Source connections", role: "admin", nav: /^documents$/i, heading: /^source connections$/i },
  { id: "review", label: "Data review", nav: /^data review$/i, heading: /^data review$/i },
  { id: "delivery", label: "Data delivery", nav: /^data delivery$/i, heading: /deliver structured data/i },
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
