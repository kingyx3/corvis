import type { ActivityRecord } from "@/shared/domain/contracts";

export type DemoUiFixtures = { recentActivity: ActivityRecord[]; researchSuggestions: string[] };

export const NO_DEMO_FIXTURES: DemoUiFixtures = { recentActivity: [], researchSuggestions: [] };

/**
 * Demo-only presentation fixtures (recent-activity feed, Ask Corvis suggestions). Loaded through a
 * dynamic import behind the inline build-time demo flag, so production bundles carry no demo
 * fund/company names; see tools/dev/check-bundle-demo-free.ts.
 */
export async function loadDemoUiFixtures(): Promise<DemoUiFixtures> {
  if (process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true") {
    const catalog = await import("@/platform/demo/catalog");
    return { recentActivity: catalog.recentActivity, researchSuggestions: catalog.researchSuggestions };
  }
  return NO_DEMO_FIXTURES;
}
