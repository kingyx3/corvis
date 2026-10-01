export type DisplayPreferences = { timeZone: string; dateFormat: "day-first" | "month-first" | "iso"; numberFormat: "en-US" | "de-DE" | "fr-FR" };
export const DEFAULT_DISPLAY: DisplayPreferences = { timeZone: "UTC", dateFormat: "day-first", numberFormat: "en-US" };
export function normalizeDisplayPreferences(raw: unknown): DisplayPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_display_preferences");
  const v = raw as Record<string, unknown>;
  if (typeof v.timeZone !== "string" || v.timeZone.length > 100) throw new Error("invalid_time_zone");
  try { new Intl.DateTimeFormat("en", { timeZone: v.timeZone }); } catch { throw new Error("invalid_time_zone"); }
  if (!["day-first", "month-first", "iso"].includes(String(v.dateFormat)) || !["en-US", "de-DE", "fr-FR"].includes(String(v.numberFormat))) throw new Error("invalid_display_preferences");
  return { timeZone: v.timeZone, dateFormat: v.dateFormat as DisplayPreferences["dateFormat"], numberFormat: v.numberFormat as DisplayPreferences["numberFormat"] };
}
export function formatDisplayDate(value: string | Date, preferences: DisplayPreferences = DEFAULT_DISPLAY, options: Intl.DateTimeFormatOptions = {}): string {
  if (value instanceof Date && Number.isNaN(value.getTime())) return "Invalid date";
  const raw = value instanceof Date ? value.toISOString() : value;
  const calendar = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date = new Date(calendar ? `${raw}T12:00:00Z` : raw);
  if (Number.isNaN(date.getTime())) return raw;
  const timeZone = calendar ? "UTC" : preferences.timeZone;
  if (preferences.dateFormat === "iso") {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const part = (name: string) => parts.find((p) => p.type === name)?.value;
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    return options.timeStyle && !calendar ? `${day} ${new Intl.DateTimeFormat("en-GB", { timeZone, timeStyle: options.timeStyle }).format(date)}` : day;
  }
  return new Intl.DateTimeFormat(preferences.dateFormat === "day-first" ? "en-GB" : "en-US", {
    dateStyle: "medium", ...options, timeZone,
    ...(calendar ? { timeStyle: undefined } : {}),
  }).format(date);
}
export function formatDisplayNumber(value: number | string, preferences: DisplayPreferences = DEFAULT_DISPLAY, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(preferences.numberFormat, options).format(value as number);
}
/** Reformat a numeric display token, never prose, IDs, query inputs or machine exports. */
export function formatDisplayValue(value: string | number, preferences: DisplayPreferences = DEFAULT_DISPLAY): string {
  if (typeof value === "number") return formatDisplayNumber(value, preferences);
  if (/^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(value)) {
    const parsed = new Date(`${value} 12:00:00 GMT`);
    if (!Number.isNaN(parsed.getTime())) return formatDisplayDate(parsed.toISOString().slice(0, 10), preferences);
  }
  // A bare year ("2026") or zero-padded identifier ("0042") is a label, not a quantity: grouping it would corrupt it.
  if (/^(?:0\d+|(?:19|20|21)\d{2})$/.test(value)) return value;
  const match = value.match(/^([+−-]?)([$€£]|[A-Z]{3} )?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)([%mbkx]|x)?$/);
  if (!match) return /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) ? formatDisplayDate(value, preferences) : value;
  const decimals = match[3].split(".")[1]?.length ?? 0;
  return `${match[1]}${match[2] ?? ""}${formatDisplayNumber(match[3].replaceAll(",", ""), preferences, { minimumFractionDigits: Math.min(decimals, 20), maximumFractionDigits: Math.min(decimals, 20) })}${match[4] ?? ""}`;
}
