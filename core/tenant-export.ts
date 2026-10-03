/**
 * Full tenant data export (F10, #266): the domain contract shared by the API, the Postgres and demo implementations,
 * the export build and the UI.
 *
 * An Organization Admin asks for a complete export of the organization's data (published data, the access audit and
 * the source-document inventory). A second, different Organization Admin must approve it before anything is built.
 * The build runs in the governed delivery worker, and the result is a checksum-manifested archive behind an
 * expiring, single-use download link. The archive only ever holds data the organization may redistribute under its
 * contractual data rights; what was left out is reported in the manifest, never silently dropped.
 *
 *   pending_approval -> approved -> building -> complete | failed
 *   pending_approval -> rejected | cancelled | expired
 *   approved         -> cancelled        (the requester, before the build starts)
 *   complete         -> download_expired (derived: the artifact's link lifetime has passed)
 */

export const TENANT_EXPORT_STATES = ["pending_approval", "approved", "building", "complete", "failed", "rejected", "cancelled", "expired"] as const;
export type TenantExportState = (typeof TENANT_EXPORT_STATES)[number];

/** What a request is shown as: the stored state, except a complete export whose download has lapsed. */
export type TenantExportStatus = TenantExportState | "download_expired";

/** Short labels from the design system's status vocabulary (the status pill), so each gets its own tone. */
export const TENANT_EXPORT_STATUS_LABEL: Record<TenantExportStatus, string> = {
  pending_approval: "Pending",
  approved: "Approved",
  building: "Processing",
  complete: "Ready",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Withdrawn",
  expired: "Expired",
  download_expired: "Expired",
};

/** A request that no second Organization Admin approved within this window lapses, and a new one may be made. */
export const TENANT_EXPORT_APPROVAL_WINDOW_HOURS = 168;

/** The export build gives up after this many attempts (the delivery worker retries with backoff in between). */
export const TENANT_EXPORT_MAX_BUILD_ATTEMPTS = 5;

export const TENANT_EXPORT_ARCHIVE_NAME = "corvis-tenant-export.zip";

export function tenantExportStatus(state: string, approvalLapsed: boolean, downloadAvailable: boolean): TenantExportStatus {
  if (state === "pending_approval" && approvalLapsed) return "expired";
  if (state === "complete" && !downloadAvailable) return "download_expired";
  return TENANT_EXPORT_STATES.find((candidate) => candidate === state) ?? "failed";
}

/** The actions a viewer may take on a request right now. Derived once, here, so the API and the UI cannot disagree. */
export type TenantExportActions = { canApprove: boolean; canReject: boolean; canCancel: boolean; canDownload: boolean };

export function tenantExportActions(status: TenantExportStatus, requestedByMe: boolean, downloadAvailable: boolean): TenantExportActions {
  return {
    canApprove: status === "pending_approval" && !requestedByMe,
    canReject: status === "pending_approval" && !requestedByMe,
    canCancel: (status === "pending_approval" || status === "approved") && requestedByMe,
    canDownload: status === "complete" && downloadAvailable,
  };
}

export type TenantExportFile = {
  path: string;
  description: string;
  sha256: string;
  sizeBytes: number;
  rowCount: number;
};

/** The checksum manifest: every file in the archive with its SHA-256, and exactly what the archive leaves out. */
export type TenantExportManifest = {
  manifestVersion: 1;
  requestId: string;
  tenantId: string;
  generatedAt: string;
  requestedBy: string;
  approvedBy: string;
  files: TenantExportFile[];
  dataRights: {
    basis: string;
    funds: { included: number; excluded: number };
    documents: { included: number; excluded: number };
  };
  notIncluded: Array<{ item: string; reason: string }>;
};

export type TenantExportArtifact = {
  checksumSha256: string;
  sizeBytes: number;
  /** When the artifact (and so every download link for it) stops being available. */
  expiresAt: string;
  manifest: TenantExportManifest;
};

export type TenantExportEvent = {
  eventType: string;
  fromState: TenantExportState | null;
  toState: TenantExportState;
  actor: string;
  note: string | null;
  at: string;
};

export type TenantExportRequest = {
  requestId: string;
  status: TenantExportStatus;
  reason: string;
  requestedBy: string;
  requestedByMe: boolean;
  requestedAt: string;
  approvalExpiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  cancelledAt: string | null;
  statusChangedAt: string;
  artifact: TenantExportArtifact | null;
  actions: TenantExportActions;
  /** Present on the single-request read only. */
  history?: TenantExportEvent[];
};

export type TenantExportDownload = { downloadUrl: string; downloadExpiresAt: string };

export type TenantExportCommand =
  | { action: "approve" | "cancel"; note?: string; expectedStatus?: TenantExportState }
  | { action: "reject"; note: string; expectedStatus?: TenantExportState }
  | { action: "prepare_download" };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class TenantExportValidationError extends Error {
  readonly code: string;
  readonly status = 400 as const;
  constructor(code: string) { super(code); this.name = "TenantExportValidationError"; this.code = code; }
}

export const TENANT_EXPORT_MIN_REASON_LENGTH = 3;
export const TENANT_EXPORT_MAX_TEXT_LENGTH = 1000;
// Free text may hold line breaks and tabs; every other C0 control, DEL and the line/paragraph separators is refused
// (Postgres text cannot hold NUL, and the rest only breaks layouts and CSV/log consumers).
const FREE_TEXT_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;

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

function fail(code: string): never { throw new TenantExportValidationError(code); }

/** A request names only why the export is needed: what it contains is fixed, so nothing else can widen it. */
export function parseTenantExportRequest(body: unknown): { reason: string } {
  if (!isRecord(body)) return fail("invalid_request");
  return { reason: freeText(body.reason, TENANT_EXPORT_MIN_REASON_LENGTH, "invalid_reason")! };
}

export function parseTenantExportCommand(body: unknown): TenantExportCommand {
  if (!isRecord(body)) return fail("invalid_request");
  if (body.action === "prepare_download") return { action: "prepare_download" };
  if (body.action !== "approve" && body.action !== "reject" && body.action !== "cancel") return fail("invalid_action");
  const action = body.action;
  let expectedStatus: TenantExportState | undefined;
  if (body.expectedStatus !== undefined) {
    expectedStatus = TENANT_EXPORT_STATES.find((candidate) => candidate === body.expectedStatus);
    if (expectedStatus === undefined) return fail("invalid_status");
  }
  const note = freeText(body.note, action === "reject" ? 1 : 0, "invalid_note");
  if (action === "reject") return { action, note: note!, ...(expectedStatus ? { expectedStatus } : {}) };
  return { action, ...(note !== undefined ? { note } : {}), ...(expectedStatus ? { expectedStatus } : {}) };
}

// ---------------------------------------------------------------------------
// Presentation helpers (UI and the demo store share them)
// ---------------------------------------------------------------------------

/** One plain sentence saying where a request stands and what happens next. */
export function tenantExportStatusSummary(item: Pick<TenantExportRequest, "status" | "requestedByMe" | "decidedBy" | "decisionNote">): string {
  switch (item.status) {
    case "pending_approval":
      return item.requestedByMe
        ? "Waiting for a different Organization Admin to approve. You cannot approve your own request."
        : "A colleague asked for this export. A different Organization Admin (not the requester) must approve it before anything is built.";
    case "approved":
      return `Approved${item.decidedBy ? ` by ${item.decidedBy}` : ""}. The export is queued and will be built shortly.`;
    case "building":
      return "The export is being built. This page updates when it is ready.";
    case "complete":
      return "The export is ready. Download links are single-use and short-lived: request a new link whenever you need one.";
    case "download_expired":
      return "The export is no longer available to download. Request a new export if you still need one.";
    case "failed":
      return "The export could not be built. Nothing was delivered. Request a new export, or contact Corvis support if it happens again.";
    case "rejected":
      return `Rejected${item.decidedBy ? ` by ${item.decidedBy}` : ""}${item.decisionNote ? `: ${item.decisionNote}` : "."}`;
    case "cancelled":
      return "Withdrawn by the requester before it was built.";
    case "expired":
      return "No second Organization Admin approved in time, so the request lapsed. Make a new request if you still need the export.";
  }
}

/** One page of requests, newest first. `nextCursor` is opaque and `null` on the last page. */
export type TenantExportPage = { items: TenantExportRequest[]; nextCursor: string | null };
