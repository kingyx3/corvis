export type SavedScreen = "review" | "analytics" | "documents";
export type ViewConfiguration = Record<string, string | string[]>;
export type SavedView = { id: string; screen: SavedScreen; name: string; configuration: ViewConfiguration; shared: boolean; owned: boolean };
export const VIEW_COLUMNS: Record<SavedScreen, string[]> = {
  review: ["Company", "Metric", "Value", "Period", "Change", "Priority", "Confidence", "Source evidence", "State / action"],
  documents: ["Document", "Fund / period", "Source", "Status", "Quality", "Received", "Actions"],
  analytics: ["Metric", "Periods"],
};
const fields: Record<SavedScreen, Record<string, string[] | null>> = {
  review: { query: null, snapshotId: null, stateFilter: ["all", "Approved", "Needs review", "Rejected"], confidenceFilter: ["all", "under90", "under75"], materialityFilter: ["all", "unknown", "material", "immaterial"], dualControlFilter: ["all", "awaiting_second"], sortMode: ["risk", "company", "confidence", "materiality", "deadline"] },
  documents: { query: null, period: null, status: null, sortMode: ["name", "period", "status", "received"] },
  analytics: { periodicity: ["reported", "quarterly", "annual"], selectedPosition: null, selectedPortfolio: null, deltaDisplay: ["value", "percent", "both"], density: ["compact", "comfortable"], sortColumn: null, sortDirection: ["ascending", "descending"], focusedPeriod: null },
};
export function normalizeViewConfiguration(screen: SavedScreen, raw: unknown): ViewConfiguration {
  if (!fields[screen] || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_view_configuration");
  const result: ViewConfiguration = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "columns") {
      if (!Array.isArray(value) || !value.length || value.length > VIEW_COLUMNS[screen].length || value.some((v) => typeof v !== "string" || !VIEW_COLUMNS[screen].includes(v))) throw new Error("invalid_view_columns");
      result.columns = [...new Set(value)]; continue;
    }
    if (!Object.hasOwn(fields[screen], key) || typeof value !== "string" || value.length > 300 || (fields[screen][key] && !fields[screen][key]!.includes(value))) throw new Error("invalid_view_configuration");
    result[key] = value;
  }
  return result;
}
