import type { Page } from "@playwright/test";

// The critical customer flows. Every accessibility, performance and resilience assertion is driven
// from this list so a new surface cannot be added without being covered.
export type Surface = {
  id: "overview" | "analytics" | "documents" | "review" | "delivery" | "research";
  label: string;
  nav: RegExp | null;
  heading: RegExp;
};

export const surfaces: Surface[] = [
  { id: "overview", label: "Overview", nav: null, heading: /reporting overview/i },
  { id: "analytics", label: "Portfolio analytics", nav: /^portfolio analytics$/i, heading: /^position financials$/i },
  { id: "documents", label: "Documents", nav: /^documents$/i, heading: /^documents$/i },
  { id: "review", label: "Data review", nav: /^data review$/i, heading: /^data review$/i },
  { id: "delivery", label: "Data delivery", nav: /^data delivery$/i, heading: /deliver structured data/i },
  { id: "research", label: "Ask Corvis", nav: /^ask corvis$/i, heading: /^ask corvis$/i },
];

export async function openSurface(page: Page, surface: Surface): Promise<void> {
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
