/**
 * Scheduled exports (F4, #260): the domain contract shared by the API, the Postgres and demo implementations, the
 * scheduled-run worker and the UI.
 *
 * A schedule saves one "Export this view" scope (D3) with a format and a trigger: run when a matching snapshot is
 * published, or on the first day of every month or quarter (UTC). It never exports anything itself. Each due trigger
 * becomes one governed export request made *as the schedule's owner*, re-authorized at that moment through the same
 * membership, entitlement and contractual-data-right resolution an interactive request goes through, and then
 * delivered by the existing export worker. A run that cannot be authorized is recorded as failed with one of the
 * stable reasons below and exports nothing.
 */

import type { ExportFormat, PositionFinancialsExportScope, SnapshotExportScope } from "./delivery.ts";

/** What can be scheduled today: the performance scorecard export (F1) is not a schedulable scope yet. */
export type ScheduledExportScope = SnapshotExportScope | PositionFinancialsExportScope;

export const EXPORT_SCHEDULE_TRIGGERS = ["on_publish", "monthly", "quarterly"] as const;
export type ExportScheduleTrigger = (typeof EXPORT_SCHEDULE_TRIGGERS)[number];
export type CalendarExportScheduleTrigger = Exclude<ExportScheduleTrigger, "on_publish">;

export const EXPORT_SCHEDULE_TRIGGER_LABEL: Record<ExportScheduleTrigger, string> = {
  on_publish: "When a matching snapshot is published",
  monthly: "Monthly, on the 1st (UTC)",
  quarterly: "Quarterly, on the 1st of January, April, July and October (UTC)",
};

export const EXPORT_SCHEDULE_FORMATS = ["csv", "xlsx", "parquet"] as const satisfies readonly ExportFormat[];

export const EXPORT_SCHEDULE_FORMAT_LABEL: Record<ExportFormat, string> = { csv: "CSV", xlsx: "Excel", parquet: "Parquet" };

/**
 * `active` runs, `paused` is the owner's reversible hold, `stopped` is set by the system when the owner's access ended
 * and is never reversed (the owner can no longer act; their schedule can only be deleted).
 */
export const EXPORT_SCHEDULE_STATUSES = ["active", "paused", "stopped"] as const;
export type ExportScheduleStatus = (typeof EXPORT_SCHEDULE_STATUSES)[number];

export const EXPORT_SCHEDULE_STATUS_LABEL: Record<ExportScheduleStatus, string> = { active: "Active", paused: "Paused", stopped: "Stopped" };

export const EXPORT_SCHEDULE_STOP_REASONS = ["owner_inactive"] as const;
export type ExportScheduleStopReason = (typeof EXPORT_SCHEDULE_STOP_REASONS)[number];

export const EXPORT_SCHEDULE_STOP_REASON_LABEL: Record<ExportScheduleStopReason, string> = {
  owner_inactive: "The owner's access ended, so this schedule stopped and will not run again.",
};

/** What the owner can do to a schedule they own. Deleting is a separate verb (`DELETE`), not an action. */
export const EXPORT_SCHEDULE_ACTIONS = ["pause", "resume"] as const;
export type ExportScheduleAction = (typeof EXPORT_SCHEDULE_ACTIONS)[number];

/**
 * Why a run did not export. Stable codes: they are stored, shown to the owner and never carry data. Authorization
 * failures are recorded rather than retried: nothing is exported and the owner sees why.
 */
export const EXPORT_SCHEDULE_FAILURE_REASONS = [
  "owner_inactive",
  "export_permission_revoked",
  "redistribution_not_permitted",
  "scope_not_entitled",
  "scope_unavailable",
  "format_unavailable",
] as const;
export type ExportScheduleFailureReason = (typeof EXPORT_SCHEDULE_FAILURE_REASONS)[number];

export const EXPORT_SCHEDULE_FAILURE_REASON_LABEL: Record<ExportScheduleFailureReason, string> = {
  owner_inactive: "The owner's access had ended.",
  export_permission_revoked: "The owner no longer has permission to create exports.",
  redistribution_not_permitted: "Contractual data rights no longer permit redistribution.",
  scope_not_entitled: "The owner is no longer entitled to the data in this scope.",
  scope_unavailable: "The scope no longer resolves to published data.",
  format_unavailable: "This format is not enabled for the organization.",
};

export function isExportScheduleFailureReason(value: unknown): value is ExportScheduleFailureReason {
  return EXPORT_SCHEDULE_FAILURE_REASONS.some((reason) => reason === value);
}

/**
 * The stable failure reason for an authorization denial raised while re-authorizing or creating the export (the
 * `requiredPermission` of an `AuthorizationError`). Anything not specifically known is the most general data-access
 * reason, never a free-form message.
 */
export function failureReasonForDenial(requiredPermission: string): ExportScheduleFailureReason {
  switch (requiredPermission) {
    case "exports:create": return "export_permission_revoked";
    case "data_rights:redistribution": return "redistribution_not_permitted";
    case "exports:scope": return "scope_unavailable";
    default: return "scope_not_entitled";
  }
}

export type ExportScheduleRun = {
  runId: string;
  scheduleId: string;
  scheduleLabel: string;
  scopeLabel: string;
  format: ExportFormat;
  /** `publish:<snapshot id>:v<version>`, `monthly:2026-10` or `quarterly:2026-Q4`: one run per key, ever. */
  triggerKey: string;
  createdAt: string;
  /** `requested`: handed to the governed export worker (see `exportId`). `failed`: nothing was exported. */
  outcome: "requested" | "failed";
  exportId?: string;
  /** The export's own delivery state when it is known (queued, delivering, complete, failed...). */
  exportState?: string;
  failureReason?: ExportScheduleFailureReason;
};

export type ExportSchedule = {
  scheduleId: string;
  label: string;
  scope: ScheduledExportScope;
  scopeLabel: string;
  format: ExportFormat;
  trigger: ExportScheduleTrigger;
  status: ExportScheduleStatus;
  stopReason: ExportScheduleStopReason | null;
  /** Only the owner can pause, resume or delete. Organization Admins see every schedule but change none. */
  ownedByMe: boolean;
  owner: string;
  createdAt: string;
  updatedAt: string;
  /** The next calendar run while the schedule is active; null for an on-publish schedule or one that is not active. */
  nextRunAt: string | null;
  lastRun: ExportScheduleRun | null;
};

/** Marks an export in delivery history as requested by a schedule: which one, and the trigger that fired it. */
export type ScheduledExportMarker = { scheduleId: string; label: string; triggerKey: string };

export type CreateExportScheduleCommand = {
  idempotencyKey: string;
  label: string;
  scope: ScheduledExportScope;
  format: ExportFormat;
  trigger: ExportScheduleTrigger;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ExportScheduleValidationError extends Error {
  readonly code: string;
  readonly status = 400 as const;
  constructor(code: string) { super(code); this.name = "ExportScheduleValidationError"; this.code = code; }
}

export const MAX_SCHEDULE_LABEL_LENGTH = 80;
const MAX_ID_LENGTH = 512;
// Identifiers and labels are single-line: C0, DEL and the line/paragraph separators are rejected (Postgres text cannot
// hold NUL, and the rest only breaks layouts).
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A trimmed, bounded, non-empty single-line string, or `code`. */
function requiredLine(value: unknown, max: number, code: string): string {
  if (typeof value !== "string") throw new ExportScheduleValidationError(code);
  const clean = value.trim();
  if (clean.length === 0 || clean.length > max || SINGLE_LINE_FORBIDDEN.test(clean)) throw new ExportScheduleValidationError(code);
  return clean;
}

function optionalLine(value: unknown, max: number, code: string): string | undefined {
  return value === undefined || value === null ? undefined : requiredLine(value, max, code);
}

/** The saved scope: exactly what an "Export this view" request carries (a published snapshot, or one Position Financials view). */
export function parseExportScheduleScope(value: unknown): ScheduledExportScope {
  if (!isRecord(value)) throw new ExportScheduleValidationError("invalid_scope");
  if (value.snapshotId !== undefined) return { snapshotId: requiredLine(value.snapshotId, MAX_ID_LENGTH, "invalid_scope") };
  const raw = value.positionFinancials;
  if (!isRecord(raw)) throw new ExportScheduleValidationError("invalid_scope");
  const periodicity = (["reported", "quarterly", "annual"] as const).find((candidate) => candidate === raw.periodicity);
  if (periodicity === undefined) throw new ExportScheduleValidationError("invalid_scope");
  const portfolioId = optionalLine(raw.portfolioId, MAX_ID_LENGTH, "invalid_scope");
  return {
    positionFinancials: {
      fundId: requiredLine(raw.fundId, MAX_ID_LENGTH, "invalid_scope"),
      holdingId: requiredLine(raw.holdingId, MAX_ID_LENGTH, "invalid_scope"),
      companyId: requiredLine(raw.companyId, MAX_ID_LENGTH, "invalid_scope"),
      periodicity,
      ...(portfolioId ? { portfolioId } : {}),
    },
  };
}

/**
 * Validates a new schedule. The idempotency key comes from the body or, when absent there, the `Idempotency-Key` header
 * (one namespace: naming it in both places with different values is refused).
 */
export function parseCreateScheduleCommand(body: unknown, headerKey?: string | null): CreateExportScheduleCommand {
  if (!isRecord(body)) throw new ExportScheduleValidationError("invalid_request");
  const fromBody = optionalLine(body.idempotencyKey, 256, "invalid_idempotency_key");
  const fromHeader = optionalLine(headerKey, 256, "invalid_idempotency_key");
  if (fromBody !== undefined && fromHeader !== undefined && fromBody !== fromHeader) throw new ExportScheduleValidationError("invalid_idempotency_key");
  const idempotencyKey = fromBody ?? fromHeader;
  if (idempotencyKey === undefined) throw new ExportScheduleValidationError("idempotency_key_required");
  const format = EXPORT_SCHEDULE_FORMATS.find((candidate) => candidate === body.format);
  if (format === undefined) throw new ExportScheduleValidationError("invalid_export_format");
  const trigger = EXPORT_SCHEDULE_TRIGGERS.find((candidate) => candidate === body.trigger);
  if (trigger === undefined) throw new ExportScheduleValidationError("invalid_trigger");
  return {
    idempotencyKey,
    label: requiredLine(body.label, MAX_SCHEDULE_LABEL_LENGTH, "invalid_label"),
    scope: parseExportScheduleScope(body.scope),
    format,
    trigger,
  };
}

export function parseScheduleAction(body: unknown): ExportScheduleAction {
  if (!isRecord(body)) throw new ExportScheduleValidationError("invalid_request");
  const action = EXPORT_SCHEDULE_ACTIONS.find((candidate) => candidate === body.action);
  if (action === undefined) throw new ExportScheduleValidationError("invalid_action");
  return action;
}

// ---------------------------------------------------------------------------
// Calendar triggers (UTC). Migration 085 computes the same values in SQL.
// ---------------------------------------------------------------------------

/** The first instant of the next month or quarter (UTC) strictly after `after`. */
export function nextScheduledRunAt(trigger: CalendarExportScheduleTrigger, after: Date): Date {
  const step = trigger === "monthly" ? 1 : 3;
  const month = after.getUTCMonth();
  const periodStartMonth = trigger === "monthly" ? month : month - (month % 3);
  return new Date(Date.UTC(after.getUTCFullYear(), periodStartMonth + step, 1));
}

/** The run key of the calendar period containing `at` (UTC): `2026-10` for monthly, `2026-Q4` for quarterly. */
export function calendarPeriodKey(trigger: CalendarExportScheduleTrigger, at: Date): string {
  const year = String(at.getUTCFullYear()).padStart(4, "0");
  if (trigger === "monthly") return `${year}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${year}-Q${Math.floor(at.getUTCMonth() / 3) + 1}`;
}

export function calendarTriggerKey(trigger: CalendarExportScheduleTrigger, at: Date): string {
  return `${trigger}:${calendarPeriodKey(trigger, at)}`;
}

export function publishTriggerKey(snapshotId: string, version: number): string {
  return `publish:${snapshotId}:v${version}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A run's trigger in words: "Published snapshot v3", "October 2026" or "Q4 2026". */
export function describeTriggerKey(triggerKey: string): string {
  const publish = /^publish:[^:]+:v(\d+)$/.exec(triggerKey);
  if (publish) return `Snapshot v${publish[1]} published`;
  const monthly = /^monthly:(\d{4})-(\d{2})$/.exec(triggerKey);
  if (monthly) return `${MONTHS[Number(monthly[2]) - 1] ?? monthly[2]} ${monthly[1]}`;
  const quarterly = /^quarterly:(\d{4})-Q([1-4])$/.exec(triggerKey);
  if (quarterly) return `Q${quarterly[2]} ${quarterly[1]}`;
  return triggerKey;
}

// ---------------------------------------------------------------------------
// Presentation helpers (UI, the worker's export request and the demo store share them)
// ---------------------------------------------------------------------------

/** The scope in words, identical to the "Scope" shown for the export it produces in delivery history. */
export function exportScopeSummary(scope: ScheduledExportScope): string {
  if ("snapshotId" in scope) return `Snapshot ${scope.snapshotId}`;
  const p = scope.positionFinancials;
  return `Position financials · ${p.companyId} · ${p.periodicity}${p.portfolioId ? ` · portfolio ${p.portfolioId}` : ""}`;
}

/** The fund whose publications can trigger an on-publish run, when the scope names one (a snapshot scope names the snapshot itself). */
export function scopeFundId(scope: ScheduledExportScope): string | null {
  return "positionFinancials" in scope ? scope.positionFinancials.fundId : null;
}

/** A suggested label for a new schedule, which the person can edit. */
export function defaultScheduleLabel(scope: ScheduledExportScope, trigger: ExportScheduleTrigger): string {
  const cadence = trigger === "on_publish" ? "On publish" : trigger === "monthly" ? "Monthly" : "Quarterly";
  return `${cadence} · ${exportScopeSummary(scope)}`.slice(0, MAX_SCHEDULE_LABEL_LENGTH);
}

/** One plain sentence saying when and as whom a schedule runs, and what holds it back. */
export function scheduleSummary(schedule: Pick<ExportSchedule, "status" | "trigger" | "stopReason" | "format">): string {
  const format = EXPORT_SCHEDULE_FORMAT_LABEL[schedule.format];
  if (schedule.status === "stopped") return schedule.stopReason ? EXPORT_SCHEDULE_STOP_REASON_LABEL[schedule.stopReason] : "Stopped. It will not run again.";
  const when = schedule.trigger === "on_publish" ? "each time a matching snapshot is published" : schedule.trigger === "monthly" ? "on the 1st of every month" : "on the 1st of every quarter";
  return schedule.status === "paused"
    ? `Paused. No ${format} export runs until it is resumed, and publications while paused are not caught up.`
    : `Requests a governed ${format} export ${when}, re-authorized as the owner each time.`;
}
