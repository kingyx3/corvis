/**
 * Data retention and legal holds as an Organization Admin sees them (F10, #266, criterion 1): a read-only view.
 *
 * Retention periods and legal holds are set and lifted by Corvis operations (`corvis_control.retention_policy`,
 * `corvis_control.legal_hold`, the admin deletion-request flow of #10). This module only describes them in plain
 * language. Nothing here can change a policy or a hold.
 */

export type RetentionPolicyView = {
  dataClass: string;
  label: string;
  /** Whole days the class is kept, or null when no fixed period is recorded. */
  retentionDays: number | null;
  retentionLabel: string;
  deleteOnTermination: boolean;
  /** True when a hold on the class blocks deletion (the same rule deletion execution applies). */
  legalHold: boolean;
  policyVersion: string;
  effectiveFrom: string;
  /** False for a version that takes effect in the future and has no earlier version to stand in for it. */
  inEffect: boolean;
};

export type LegalHoldView = {
  holdId: string;
  /** Null when the hold covers every data class. */
  dataClass: string | null;
  label: string;
  scopeLabel: string;
  matterReference: string;
  placedAt: string;
};

export type RetentionView = {
  policies: RetentionPolicyView[];
  legalHolds: LegalHoldView[];
};

const DATA_CLASS_LABELS: Record<string, string> = {
  financials: "Financial data",
  source_documents: "Source documents",
  documents: "Source documents",
  published_data: "Published data",
  audit: "Audit records",
  audit_events: "Audit records",
};

/** A known data class by its plain name, otherwise the identifier made readable ("fund_reports" -> "Fund reports"). */
export function dataClassLabel(dataClass: string): string {
  const known = DATA_CLASS_LABELS[dataClass];
  if (known !== undefined) return known;
  const words = dataClass.replace(/[_-]+/g, " ").trim();
  return words.length === 0 ? dataClass : `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

function plural(count: number, unit: string): string { return `${count} ${unit}${count === 1 ? "" : "s"}`; }

/** "7 years", "3 months", "45 days"; null is "no fixed retention period". */
export function retentionPeriodLabel(days: number | null): string {
  if (days === null) return "No fixed retention period";
  if (days > 0 && days % 365 === 0) return plural(days / 365, "year");
  if (days > 0 && days % 30 === 0) return plural(days / 30, "month");
  return plural(days, "day");
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return jsonObject(JSON.parse(value)); } catch { return {}; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const SCOPE_NOUNS: Array<[string, string, string]> = [
  ["documentIds", "document", "documents"],
  ["fundIds", "fund", "funds"],
  ["subjectIds", "person", "people"],
];

/** What a hold covers: the whole data class, or a count of the named documents, funds or people within it. */
export function legalHoldScopeLabel(dataClass: string | null, scope: unknown): string {
  const named = SCOPE_NOUNS.flatMap(([key, one, many]) => {
    const value = jsonObject(scope)[key];
    const count = Array.isArray(value) ? value.length : 0;
    return count > 0 ? [`${count} ${count === 1 ? one : many}`] : [];
  });
  const within = dataClass === null ? "all data" : dataClassLabel(dataClass);
  return named.length === 0 ? within : `${named.join(", ")} within ${within.toLowerCase()}`;
}
