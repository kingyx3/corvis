import { FREE_TEXT_FORBIDDEN, TENANT_EXPORT_MAX_TEXT_LENGTH, TENANT_EXPORT_MIN_REASON_LENGTH } from "./tenant-export.ts";

/**
 * Data retention, legal holds and deletion requests as an Organization Admin sees them (F10, #266 criterion 1; F10e, #325).
 *
 * Retention periods and legal holds are set and lifted by Corvis operations (`corvis_control.retention_policy`,
 * `corvis_control.legal_hold`, the admin deletion-request flow of #10). This module only describes them in plain
 * language. Nothing here can change a policy or a hold.
 *
 * Deletion requests (F10e) are listed alongside, whoever made them. A request Corvis operations made is shown by what
 * it covers, where it stands and its dates only: never the operator who made or ran it, an internal reason or note, an
 * error or the evidence of the run. An Organization Admin may also ask for a deletion themselves; like a full export
 * (`tenant-export.ts`) it needs a *different* Organization Admin to approve it, a legal hold on the data stops it, and it
 * is then carried out by Corvis operations through the same lifecycle as any other request:
 *
 *   pending_approval -> approved -> in_progress -> completed        (a customer request; `blocked` / `retrying` on the way)
 *   pending_approval -> rejected | cancelled | expired               (nothing is ever deleted)
 *   requested -> in_progress -> completed                            (a request Corvis operations made)
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

export const DELETION_REQUEST_STATUSES = [
  "pending_approval", "requested", "approved", "in_progress", "retrying", "blocked", "completed", "rejected", "cancelled", "expired",
] as const;
export type DeletionRequestStatus = (typeof DELETION_REQUEST_STATUSES)[number];

/** Short labels from the design system's status vocabulary (the status pill), so each gets its own tone. */
export const DELETION_REQUEST_STATUS_LABEL: Record<DeletionRequestStatus, string> = {
  pending_approval: "Pending",
  requested: "Queued",
  approved: "Approved",
  in_progress: "In progress",
  retrying: "Retrying",
  blocked: "Blocked",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Withdrawn",
  expired: "Expired",
};

/** Who asked: the organization's own admin, or Corvis operations (on the organization's behalf or under the contract). */
export type DeletionRequestOrigin = "customer" | "corvis";

/** A second Organization Admin has this long to approve a customer request, after which it lapses and a new one may be made. */
export const DELETION_APPROVAL_WINDOW_HOURS = 168;
/** A customer request names whole data classes only, and at most this many. */
export const DELETION_MAX_DATA_CLASSES = 20;

/** The actions a viewer may take on a request right now. Derived once, here, so the API and the UI cannot disagree. */
export type DeletionRequestActions = { canApprove: boolean; canReject: boolean; canCancel: boolean };

export type DeletionRequestView = {
  requestId: string;
  origin: DeletionRequestOrigin;
  status: DeletionRequestStatus;
  /** The data classes the request covers, by identifier (sorted). */
  dataClasses: string[];
  /** What it covers in plain language, e.g. "Source documents, financial data" or "2 documents within source documents". */
  scopeLabel: string;
  requestedAt: string;
  /** When it was approved or rejected; null until then. */
  decidedAt: string | null;
  /** When the data was deleted; null until then. */
  executedAt: string | null;
  /** True while a legal hold on the data stops this request from being carried out (never for one that has ended). */
  legalHoldBlocks: boolean;
  /** The next four are shown for a request an Organization Admin made, and are always null for one Corvis operations made. */
  reason: string | null;
  requestedBy: string | null;
  approvalExpiresAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  requestedByMe: boolean;
  actions: DeletionRequestActions;
};

export type RetentionView = {
  policies: RetentionPolicyView[];
  legalHolds: LegalHoldView[];
  /** The deletion requests that affect this organization, newest first (at most 100). */
  deletionRequests: DeletionRequestView[];
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

/** "3 documents, 1 fund within <within>", or just <within> when the scope names nothing narrower. */
function scopeSentence(within: string, scope: unknown): string {
  const named = SCOPE_NOUNS.flatMap(([key, one, many]) => {
    const value = jsonObject(scope)[key];
    const count = Array.isArray(value) ? value.length : 0;
    return count > 0 ? [`${count} ${count === 1 ? one : many}`] : [];
  });
  return named.length === 0 ? within : `${named.join(", ")} within ${within.toLowerCase()}`;
}

/** What a hold covers: the whole data class, or a count of the named documents, funds or people within it. */
export function legalHoldScopeLabel(dataClass: string | null, scope: unknown): string {
  return scopeSentence(dataClass === null ? "all data" : dataClassLabel(dataClass), scope);
}

/** The data classes a stored deletion scope names (blank and non-text entries are ignored, never trusted), sorted. */
export function deletionScopeDataClasses(scope: unknown): string[] {
  const value = jsonObject(scope).dataClasses;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))].sort();
}

/** What a deletion request covers: its data classes in plain language, narrowed by any named documents, funds or people. */
export function deletionScopeLabel(scope: unknown): string {
  const classes = deletionScopeDataClasses(scope).map(dataClassLabel);
  const within = classes.length === 0 ? "Unspecified data" : classes.map((label, index) => index === 0 ? label : label.toLowerCase()).join(", ");
  return scopeSentence(within, scope);
}

/**
 * Where a request stands, from its stored state. `approvalLapsed` is a pending customer request whose window has passed
 * (it is shown as expired before anything has rewritten the row). A state this code does not know is shown as in progress,
 * never as something it is not.
 */
export function deletionRequestStatus(state: string, approvalLapsed: boolean): DeletionRequestStatus {
  switch (state) {
    case "pending_customer_approval": return approvalLapsed ? "expired" : "pending_approval";
    case "requested": return "requested";
    case "approved": return "approved";
    case "retryable": return "retrying";
    case "blocked": return "blocked";
    case "completed": return "completed";
    case "rejected": return "rejected";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    default: return "in_progress";
  }
}

const OPEN_STATUSES: readonly DeletionRequestStatus[] = ["pending_approval", "requested", "approved", "in_progress", "retrying", "blocked"];

/** A hold only matters to a request that could still run. */
export function deletionLegalHoldBlocks(status: DeletionRequestStatus, held: boolean): boolean {
  return held && OPEN_STATUSES.includes(status);
}

export function deletionRequestActions(status: DeletionRequestStatus, origin: DeletionRequestOrigin, requestedByMe: boolean): DeletionRequestActions {
  const pending = origin === "customer" && status === "pending_approval";
  return { canApprove: pending && !requestedByMe, canReject: pending && !requestedByMe, canCancel: pending && requestedByMe };
}

/** One plain sentence saying where a request stands and what happens next. */
export function deletionStatusSummary(item: Pick<DeletionRequestView, "status" | "requestedByMe" | "decidedBy" | "decisionNote" | "legalHoldBlocks">): string {
  const hold = " A legal hold applies to this data, so it will not run until the hold is lifted.";
  const held = item.legalHoldBlocks ? hold : "";
  switch (item.status) {
    case "pending_approval":
      return item.requestedByMe
        ? "Waiting for a different Organization Admin to approve. You cannot approve your own request, and nothing is deleted until it is approved."
        : "A colleague asked for this deletion. A different Organization Admin (not the requester) must approve it before Corvis acts on it.";
    case "requested":
      return `Requested. Corvis operations have not carried it out yet.${held}`;
    case "approved":
      return `Approved${item.decidedBy ? ` by ${item.decidedBy}` : ""}. Corvis operations will carry out the deletion.${held}`;
    case "in_progress":
      return `Corvis is carrying out this deletion.${held}`;
    case "retrying":
      return `An attempt did not finish. Corvis operations will try again.${held}`;
    case "blocked":
      return item.legalHoldBlocks
        ? "Blocked by a legal hold. Nothing was deleted; it can proceed once the hold is lifted."
        : "Blocked because a precondition was not met, such as a retention policy for this data. Nothing was deleted.";
    case "completed":
      return "The data was deleted. Corvis keeps evidence that the deletion was carried out.";
    case "rejected":
      return `Rejected${item.decidedBy ? ` by ${item.decidedBy}` : ""}${item.decisionNote ? `: ${item.decisionNote}` : "."} Nothing was deleted.`;
    case "cancelled":
      return "Withdrawn by the requester before anyone approved it. Nothing was deleted.";
    case "expired":
      return "No second Organization Admin approved in time, so the request lapsed. Nothing was deleted. Make a new request if you still need it.";
  }
}

// ---------------------------------------------------------------------------
// Customer-initiated requests: validation
// ---------------------------------------------------------------------------

/** A request the caller got wrong (400): the same shape as the full export's, so the governance routes answer both alike. */
export class DeletionRequestValidationError extends Error {
  readonly code: string;
  readonly status = 400 as const;
  constructor(code: string) { super(code); this.name = "DeletionRequestValidationError"; this.code = code; }
}

function fail(code: string): never { throw new DeletionRequestValidationError(code); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freeText(value: unknown, min: number, code: string): string | undefined {
  if (value === undefined || value === null) return min > 0 ? fail(code) : undefined;
  if (typeof value !== "string") return fail(code);
  const clean = value.trim();
  if (clean.length === 0 && min === 0) return undefined;
  if (clean.length < min || clean.length > TENANT_EXPORT_MAX_TEXT_LENGTH || FREE_TEXT_FORBIDDEN.test(clean)) return fail(code);
  return clean;
}

const DATA_CLASS_IDENTIFIER = /^[A-Za-z0-9_.-]{1,100}$/;

export type DeletionRequestCommand = { dataClasses: string[]; reason: string };

/**
 * A customer request names whole data classes (never a document, fund or person: narrower scopes stay with Corvis
 * operations) and why. Unknown or malformed input is refused, never widened or guessed at.
 */
export function parseDeletionRequest(body: unknown): DeletionRequestCommand {
  if (!isRecord(body)) return fail("invalid_request");
  const raw = body.dataClasses;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > DELETION_MAX_DATA_CLASSES) return fail("invalid_data_classes");
  const dataClasses = [...new Set(raw.map((item) => {
    if (typeof item !== "string" || !DATA_CLASS_IDENTIFIER.test(item.trim())) return fail("invalid_data_classes");
    return item.trim();
  }))].sort();
  return { dataClasses, reason: freeText(body.reason, TENANT_EXPORT_MIN_REASON_LENGTH, "invalid_reason")! };
}

export type DeletionDecisionCommand =
  | { action: "approve" | "cancel"; note?: string; expectedStatus?: "pending_approval" }
  | { action: "reject"; note: string; expectedStatus?: "pending_approval" };

export function parseDeletionDecision(body: unknown): DeletionDecisionCommand {
  if (!isRecord(body)) return fail("invalid_request");
  if (body.action !== "approve" && body.action !== "reject" && body.action !== "cancel") return fail("invalid_action");
  const action = body.action;
  // Only a request still waiting for its second admin can be decided, so that is the one status a caller may insist on.
  if (body.expectedStatus !== undefined && body.expectedStatus !== "pending_approval") return fail("invalid_status");
  const expected = body.expectedStatus === undefined ? {} : { expectedStatus: "pending_approval" as const };
  const note = freeText(body.note, action === "reject" ? 1 : 0, "invalid_note");
  if (action === "reject") return { action, note: note!, ...expected };
  return { action, ...(note !== undefined ? { note } : {}), ...expected };
}
