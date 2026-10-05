/**
 * Customer data-issue reports (F5, #261): the domain contract shared by the API, the Postgres and demo
 * implementations, the notification templates and the UI.
 *
 * A customer who doubts a published figure reports it with the figure, its scope (fund, company, metric, period,
 * snapshot version) and a comment. The report becomes a tenant-scoped case routed to Data Operations and moves
 * received -> investigating -> corrected | no_change. Reporting records a claim only: it never changes data or
 * publication state. A corrected case links to the replacement publication produced by the governed correction
 * flow (data-correction incidents, migration 022), never to anything this module can create.
 */

export const DATA_ISSUE_FIGURES = ["overview", "position_financials", "review"] as const;
export type DataIssueFigure = (typeof DATA_ISSUE_FIGURES)[number];

export const DATA_ISSUE_FIGURE_LABEL: Record<DataIssueFigure, string> = {
  overview: "Overview",
  position_financials: "Position financials",
  review: "Data review",
};

export const DATA_ISSUE_STATUSES = ["received", "investigating", "corrected", "no_change"] as const;
export type DataIssueStatus = (typeof DATA_ISSUE_STATUSES)[number];

export const DATA_ISSUE_STATUS_LABEL: Record<DataIssueStatus, string> = {
  received: "Received",
  investigating: "Investigating",
  corrected: "Corrected",
  no_change: "No change",
};

export function isDataIssueStatus(value: unknown): value is DataIssueStatus {
  return DATA_ISSUE_STATUSES.some((status) => status === value);
}

/** What Data Operations can do to a case. `correct` and `no_change` close it. */
export const DATA_ISSUE_ACTIONS = ["investigate", "correct", "no_change"] as const;
export type DataIssueAction = (typeof DATA_ISSUE_ACTIONS)[number];

const TRANSITIONS: Record<DataIssueAction, { from: DataIssueStatus; to: DataIssueStatus }> = {
  investigate: { from: "received", to: "investigating" },
  correct: { from: "investigating", to: "corrected" },
  no_change: { from: "investigating", to: "no_change" },
};

/** The status an action leads to from `status`, or null when the case cannot take that action now. */
export function dataIssueTransition(status: DataIssueStatus, action: DataIssueAction): DataIssueStatus | null {
  const rule = TRANSITIONS[action];
  return rule.from === status ? rule.to : null;
}

/** The actions available from `status` (none once the case is closed). */
export function availableDataIssueActions(status: DataIssueStatus): DataIssueAction[] {
  return DATA_ISSUE_ACTIONS.filter((action) => dataIssueTransition(status, action) !== null);
}

export function isClosedDataIssue(status: DataIssueStatus): boolean {
  return status === "corrected" || status === "no_change";
}

/** The status a transition leaves behind, for the history row (a report starts from nothing). */
export function previousDataIssueStatus(action: DataIssueAction): DataIssueStatus {
  return TRANSITIONS[action].from;
}

export type DataIssueScope = {
  fundId: string;
  fundLabel?: string;
  companyId?: string;
  companyLabel?: string;
  metricCode?: string;
  metricLabel?: string;
  reportPeriod: string;
  snapshotId?: string;
  snapshotVersion?: number;
};

export type ReportDataIssueCommand = {
  idempotencyKey: string;
  figure: DataIssueFigure;
  scope: DataIssueScope;
  comment: string;
};

export type DataIssueTransitionCommand = {
  action: DataIssueAction;
  /** Optimistic guard: the transition is refused when the case is no longer in this status. */
  expectedStatus?: DataIssueStatus;
  /** The governed data-correction incident behind the case (required to correct unless already linked). */
  correctionIncidentId?: string;
  note?: string;
};

export type DataIssueEvent = {
  fromStatus: DataIssueStatus | null;
  toStatus: DataIssueStatus;
  at: string;
  note: string | null;
};

export type DataIssueCase = {
  caseId: string;
  figure: DataIssueFigure;
  scope: DataIssueScope;
  comment: string;
  status: DataIssueStatus;
  /** Always Data Operations: the team that investigates and, through the governed correction flow, corrects. */
  routedTo: "data_operations";
  reportedBy: string;
  reportedByMe: boolean;
  createdAt: string;
  statusChangedAt: string;
  resolutionNote: string | null;
  /** Set once the case is corrected: the publication that replaces the reported figure. */
  replacement: { snapshotId: string; snapshotVersion: number } | null;
  /** The governed correction incident the case is linked to. Only Organization Admins are shown it. */
  correctionIncidentId?: string;
  /** True for the reporter's own case whose status moved since they last looked at it. */
  hasUnseenUpdate: boolean;
  /** Present on the single-case read only. */
  history?: DataIssueEvent[];
};

export type DataIssuePage = { items: DataIssueCase[]; nextCursor: string | null };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class DataIssueValidationError extends Error {
  readonly code: string;
  readonly status = 400 as const;
  constructor(code: string) { super(code); this.name = "DataIssueValidationError"; this.code = code; }
}

export const MAX_COMMENT_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 2000;
const MAX_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Identifiers and labels are single-line; free text may also hold line breaks and tabs. Everything else in C0, DEL
// and the line/paragraph separators is rejected (Postgres text cannot hold NUL, and the rest only breaks layouts).
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029]/;
const FREE_TEXT_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A trimmed, bounded single-line string, or undefined when absent; anything else is `code`. */
function singleLine(value: unknown, max: number, code: string, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new DataIssueValidationError(code);
    return undefined;
  }
  if (typeof value !== "string") throw new DataIssueValidationError(code);
  const clean = value.trim();
  if (clean.length === 0 && !required) return undefined;
  if (clean.length === 0 || clean.length > max || SINGLE_LINE_FORBIDDEN.test(clean)) throw new DataIssueValidationError(code);
  return clean;
}

function freeText(value: unknown, max: number, code: string, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new DataIssueValidationError(code);
    return undefined;
  }
  if (typeof value !== "string") throw new DataIssueValidationError(code);
  const clean = value.trim();
  if (clean.length === 0 && !required) return undefined;
  if (clean.length === 0 || clean.length > max || FREE_TEXT_FORBIDDEN.test(clean)) throw new DataIssueValidationError(code);
  return clean;
}

function parseScope(value: unknown): DataIssueScope {
  if (!isRecord(value)) throw new DataIssueValidationError("invalid_scope");
  const snapshotId = singleLine(value.snapshotId, 128, "invalid_scope", false);
  let snapshotVersion: number | undefined;
  if (value.snapshotVersion !== undefined && value.snapshotVersion !== null) {
    const version = value.snapshotVersion;
    if (typeof version !== "number" || !Number.isInteger(version) || version <= 0 || version > 1_000_000 || snapshotId === undefined) {
      throw new DataIssueValidationError("invalid_scope");
    }
    snapshotVersion = version;
  }
  const scope: DataIssueScope = {
    fundId: singleLine(value.fundId, MAX_ID_LENGTH, "invalid_scope", true)!,
    reportPeriod: singleLine(value.reportPeriod, 128, "invalid_scope", true)!,
  };
  const optional: Array<[keyof DataIssueScope, string | undefined]> = [
    ["fundLabel", singleLine(value.fundLabel, MAX_LABEL_LENGTH, "invalid_scope", false)],
    ["companyId", singleLine(value.companyId, MAX_ID_LENGTH, "invalid_scope", false)],
    ["companyLabel", singleLine(value.companyLabel, MAX_LABEL_LENGTH, "invalid_scope", false)],
    ["metricCode", singleLine(value.metricCode, 256, "invalid_scope", false)],
    ["metricLabel", singleLine(value.metricLabel, MAX_LABEL_LENGTH, "invalid_scope", false)],
    ["snapshotId", snapshotId],
  ];
  for (const [key, entry] of optional) if (entry !== undefined) (scope as Record<string, unknown>)[key] = entry;
  if (snapshotVersion !== undefined) scope.snapshotVersion = snapshotVersion;
  return scope;
}

/**
 * Validates a report. The idempotency key comes from the body or, when absent there, the `Idempotency-Key` header
 * (one namespace: naming it in both places with different values is refused).
 */
export function parseReportCommand(body: unknown, headerKey?: string | null): ReportDataIssueCommand {
  if (!isRecord(body)) throw new DataIssueValidationError("invalid_request");
  const fromBody = singleLine(body.idempotencyKey, 256, "invalid_idempotency_key", false);
  const fromHeader = singleLine(headerKey ?? undefined, 256, "invalid_idempotency_key", false);
  if (fromBody !== undefined && fromHeader !== undefined && fromBody !== fromHeader) throw new DataIssueValidationError("invalid_idempotency_key");
  const idempotencyKey = fromBody ?? fromHeader;
  if (idempotencyKey === undefined) throw new DataIssueValidationError("idempotency_key_required");
  const figure = DATA_ISSUE_FIGURES.find((candidate) => candidate === body.figure);
  if (figure === undefined) throw new DataIssueValidationError("invalid_figure");
  return { idempotencyKey, figure, scope: parseScope(body.scope), comment: freeText(body.comment, MAX_COMMENT_LENGTH, "invalid_comment", true)! };
}

export function parseTransitionCommand(body: unknown): DataIssueTransitionCommand {
  if (!isRecord(body)) throw new DataIssueValidationError("invalid_request");
  const action = DATA_ISSUE_ACTIONS.find((candidate) => candidate === body.action);
  if (action === undefined) throw new DataIssueValidationError("invalid_action");
  const command: DataIssueTransitionCommand = { action };
  if (body.expectedStatus !== undefined) {
    const expected = DATA_ISSUE_STATUSES.find((candidate) => candidate === body.expectedStatus);
    if (expected === undefined) throw new DataIssueValidationError("invalid_status");
    command.expectedStatus = expected;
  }
  if (body.correctionIncidentId !== undefined && body.correctionIncidentId !== null) {
    if (action === "no_change" || typeof body.correctionIncidentId !== "string" || !UUID.test(body.correctionIncidentId)) {
      throw new DataIssueValidationError("invalid_correction");
    }
    command.correctionIncidentId = body.correctionIncidentId.toLowerCase();
  }
  const note = freeText(body.note, MAX_NOTE_LENGTH, "invalid_note", action === "no_change");
  if (note !== undefined) command.note = note;
  return command;
}

// ---------------------------------------------------------------------------
// Presentation helpers (UI, CSV export and the demo store share them)
// ---------------------------------------------------------------------------

/** "Fund · Company · Metric · Period · Snapshot v3", preferring display labels over ids. */
export function dataIssueScopeSummary(scope: DataIssueScope): string {
  return [
    scope.fundLabel ?? scope.fundId,
    scope.companyId !== undefined ? scope.companyLabel ?? scope.companyId : undefined,
    scope.metricCode !== undefined ? scope.metricLabel ?? scope.metricCode : undefined,
    scope.reportPeriod,
    scope.snapshotVersion !== undefined ? `Snapshot v${scope.snapshotVersion}` : undefined,
  ].filter((part): part is string => part !== undefined).join(" · ");
}

/** One plain sentence saying where a case stands and what happens next. */
export function dataIssueStatusSummary(item: Pick<DataIssueCase, "status" | "replacement" | "resolutionNote">): string {
  switch (item.status) {
    case "received":
      return "Received. Data Operations will pick it up and the status will change here.";
    case "investigating":
      return "Data Operations is investigating. Nothing has changed in the published figure.";
    case "corrected":
      return item.replacement
        ? `Corrected. A replacement publication (snapshot v${item.replacement.snapshotVersion}) now supersedes the figure you reported.`
        : "Corrected. A replacement publication now supersedes the figure you reported.";
    case "no_change":
      return item.resolutionNote ? `Reviewed, no change needed: ${item.resolutionNote}` : "Reviewed, no change needed.";
  }
}

export function unseenDataIssueCount(items: readonly Pick<DataIssueCase, "hasUnseenUpdate">[]): number {
  return items.filter((item) => item.hasUnseenUpdate).length;
}

export const DATA_ISSUE_EXPORT_COLUMNS = [
  "case_id", "status", "figure", "fund", "fund_id", "company", "company_id", "metric", "metric_code", "report_period",
  "snapshot_id", "snapshot_version", "comment", "reported_by", "reported_at", "status_changed_at", "resolution_note",
  "replacement_snapshot_id", "replacement_snapshot_version", "correction_incident_id",
] as const;

/** One export row per case, in {@link DATA_ISSUE_EXPORT_COLUMNS} order (empty string for anything absent). */
export function dataIssueExportRow(item: DataIssueCase): string[] {
  return [
    item.caseId, DATA_ISSUE_STATUS_LABEL[item.status], DATA_ISSUE_FIGURE_LABEL[item.figure],
    item.scope.fundLabel ?? "", item.scope.fundId, item.scope.companyLabel ?? "", item.scope.companyId ?? "",
    item.scope.metricLabel ?? "", item.scope.metricCode ?? "", item.scope.reportPeriod,
    item.scope.snapshotId ?? "", item.scope.snapshotVersion === undefined ? "" : String(item.scope.snapshotVersion),
    item.comment, item.reportedBy, item.createdAt, item.statusChangedAt, item.resolutionNote ?? "",
    item.replacement?.snapshotId ?? "", item.replacement ? String(item.replacement.snapshotVersion) : "", item.correctionIncidentId ?? "",
  ];
}
