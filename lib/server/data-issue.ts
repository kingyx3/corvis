import { createHash, randomUUID } from "node:crypto";
import type { AuditEvent, RequestIdentity } from "../../core/enterprise.ts";
import type {
  DataIssueCase,
  DataIssueEvent,
  DataIssuePage,
  DataIssueScope,
  DataIssueStatus,
  DataIssueTransitionCommand,
  ReportDataIssueCommand,
} from "../../core/data-issue.ts";
import { bestEffortNotification, enqueueForUser } from "./notifications.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./pagination.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { logEvent } from "./telemetry.ts";

/**
 * Customer data-issue reports (F5, #261), Postgres side. A report only ever writes `corvis_control.data_issue_case`
 * and its history (migration 083): it cannot change observations, snapshots or publication, which stay with the
 * governed correction flow (`data-correction.ts`). Visibility is a predicate in every query below: a case is read by
 * its reporter (while still entitled to the fund) and by Organization Admins, never by anyone else in the tenant.
 */

export type DataIssueListQuery = {
  /** `mine`: the caller's own reports. `all`: every report in the tenant (Organization Admins only). */
  scope: "mine" | "all";
  status?: DataIssueStatus;
  limit: number;
  cursor?: string | null;
};

export type DataIssueList = DataIssuePage & {
  /** How many of the caller's own cases changed status since they last looked, whatever `scope` was listed. */
  unseenUpdateCount: number;
};

/** Where cases live. Postgres in production, an in-memory store in demo mode; both enforce the same visibility rules. */
export interface DataIssueBackend {
  readonly demo: boolean;
  report(identity: RequestIdentity, command: ReportDataIssueCommand, db?: PostgresSqlApi): Promise<{ item: DataIssueCase; created: boolean }>;
  list(identity: RequestIdentity, query: DataIssueListQuery, db?: PostgresSqlApi): Promise<DataIssueList>;
  get(identity: RequestIdentity, caseId: string, db?: PostgresSqlApi): Promise<DataIssueCase>;
  acknowledge(identity: RequestIdentity, caseId: string, db?: PostgresSqlApi): Promise<DataIssueCase>;
  transition(identity: RequestIdentity, caseId: string, command: DataIssueTransitionCommand, db?: PostgresSqlApi): Promise<DataIssueCase>;
}

/** A request the caller can fix (400), is not allowed (403), names no visible case (404) or lost a race and is safe to retry (409). */
export class DataIssueRequestError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409;
  constructor(code: string, status: 400 | 403 | 404 | 409) {
    super(code);
    this.name = "DataIssueRequestError";
    this.code = code;
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean { return UUID.test(value); }

export function isTenantAdminIdentity(identity: RequestIdentity): boolean { return identity.isTenantAdmin === true; }

/** The funds a caller may report on or see their own reports for. Demo identities have no fund list and see every demo fund. */
export function entitledToFund(identity: RequestIdentity, fundId: string): boolean {
  return identity.authMethod === "demo" || (identity.entitlements.fundIds ?? []).includes(fundId);
}

/** Reporting needs a published figure the caller may read: refuse a fund outside their entitlement. */
export function assertCanReport(identity: RequestIdentity, fundId: string): void {
  if (!entitledToFund(identity, fundId)) throw new DataIssueRequestError("fund_not_entitled", 403);
}

export function assertCanViewAll(identity: RequestIdentity): void {
  if (!isTenantAdminIdentity(identity)) throw new DataIssueRequestError("tenant_admin_required", 403);
}

/** Whether `identity` is the person (or service identity) that filed the case. */
export function isReporter(identity: RequestIdentity, reporter: { authMethod: string; subject: string }): boolean {
  return reporter.authMethod === identity.authMethod && reporter.subject === identity.subject;
}

/** The one visibility rule: the reporter (still entitled to the fund) or an Organization Admin. */
export function canViewDataIssue(identity: RequestIdentity, item: { reporter: { authMethod: string; subject: string }; fundId: string }): boolean {
  return isTenantAdminIdentity(identity) || (isReporter(identity, item.reporter) && entitledToFund(identity, item.fundId));
}

/** The audit event for a case command. Never carries the comment or a note: identifiers and the status only. */
export function dataIssueAuditEvent(identity: RequestIdentity, correlationId: string, action: string, item: DataIssueCase): AuditEvent {
  return {
    id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
    actorSubject: identity.subject, sessionId: identity.sessionId, action, targetType: "data_issue_case", targetId: item.caseId,
    outcome: "success", correlationId,
    metadata: {
      status: item.status, figure: item.figure, fundId: item.scope.fundId, reportPeriod: item.scope.reportPeriod,
      snapshotVersion: item.scope.snapshotVersion ?? null, replacementSnapshotVersion: item.replacement?.snapshotVersion ?? null,
    },
  };
}

/** Key-order independent fingerprint of a report, so a reused idempotency key with different content is refused. */
export function reportFingerprint(command: ReportDataIssueCommand): string {
  const { scope } = command;
  const canonical = JSON.stringify([
    command.figure, scope.fundId, scope.fundLabel ?? null, scope.companyId ?? null, scope.companyLabel ?? null,
    scope.metricCode ?? null, scope.metricLabel ?? null, scope.reportPeriod, scope.snapshotId ?? null, scope.snapshotVersion ?? null, command.comment,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function str(row: PostgresRow, key: string): string { return String(row[key]); }
function optionalStr(row: PostgresRow, key: string): string | undefined { return row[key] == null ? undefined : String(row[key]); }

export function toDataIssueCase(row: PostgresRow, identity: RequestIdentity, history?: DataIssueEvent[]): DataIssueCase {
  const reportedByMe = isReporter(identity, { authMethod: str(row, "reporter_auth_method"), subject: str(row, "reporter_subject") });
  const status = str(row, "status") as DataIssueStatus;
  const scope: DataIssueScope = { fundId: str(row, "fund_id"), reportPeriod: str(row, "report_period") };
  for (const [key, column] of [
    ["fundLabel", "fund_label"], ["companyId", "company_id"], ["companyLabel", "company_label"], ["metricCode", "metric_code"],
    ["metricLabel", "metric_label"], ["snapshotId", "snapshot_id"],
  ] as const) {
    const value = optionalStr(row, column);
    if (value !== undefined) (scope as Record<string, unknown>)[key] = value;
  }
  if (row.snapshot_version != null) scope.snapshotVersion = Number(row.snapshot_version);
  const item: DataIssueCase = {
    caseId: str(row, "case_id"),
    figure: str(row, "figure") as DataIssueCase["figure"],
    scope,
    comment: str(row, "comment"),
    status,
    routedTo: "data_operations",
    reportedBy: str(row, "reporter_subject"),
    reportedByMe,
    createdAt: str(row, "created_at"),
    statusChangedAt: str(row, "status_changed_at"),
    resolutionNote: optionalStr(row, "resolution_note") ?? null,
    replacement: row.replacement_snapshot_id == null ? null
      : { snapshotId: str(row, "replacement_snapshot_id"), snapshotVersion: Number(row.replacement_snapshot_version) },
    hasUnseenUpdate: reportedByMe && str(row, "reporter_seen_status") !== status,
  };
  if (isTenantAdminIdentity(identity) && row.correction_incident_id != null) item.correctionIncidentId = str(row, "correction_incident_id");
  if (history) item.history = history;
  return item;
}

function toEvent(row: PostgresRow): DataIssueEvent {
  return {
    fromStatus: row.from_status == null ? null : str(row, "from_status") as DataIssueStatus,
    toStatus: str(row, "to_status") as DataIssueStatus,
    at: str(row, "occurred_at"),
    note: optionalStr(row, "note") ?? null,
  };
}

// ---------------------------------------------------------------------------
// Keyset cursor: newest first, (created_at desc, case_id desc)
// ---------------------------------------------------------------------------

/** Microsecond-precision UTC text of `created_at`, the exact value the keyset compares against. */
const CURSOR_TIMESTAMP = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function decodeListCursor(cursor: string): { createdAt: string; caseId: string } {
  const key = decodeCursor(cursor);
  const separator = key.indexOf("|");
  const createdAt = key.slice(0, separator);
  const caseId = key.slice(separator + 1);
  if (separator === -1 || !CURSOR_TIMESTAMP.test(createdAt) || !isUuid(caseId)) throw new InvalidCursorError();
  // Date.parse rolls impossible dates over (Feb 30, hour 24) and the Postgres cast would reject them with a 500: a round trip catches them here.
  const millis = `${createdAt.slice(0, 23)}Z`;
  const parsed = Date.parse(millis);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== millis) throw new InvalidCursorError();
  return { createdAt, caseId: caseId.toLowerCase() };
}

const CURSOR_CREATED_AT = `to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at`;

export class PostgresDataIssueBackend implements DataIssueBackend {
  readonly demo = false;
  private readonly defaultDb: () => PostgresSqlApi;

  constructor(defaultDb: () => PostgresSqlApi) { this.defaultDb = defaultDb; }

  private fundList(identity: RequestIdentity): string { return JSON.stringify(identity.entitlements.fundIds ?? []); }

  async report(identity: RequestIdentity, command: ReportDataIssueCommand, db: PostgresSqlApi = this.defaultDb()): Promise<{ item: DataIssueCase; created: boolean }> {
    const { scope } = command;
    if (!isUuid(identity.workspaceId) || (scope.snapshotId !== undefined && !isUuid(scope.snapshotId))) throw new DataIssueRequestError("invalid_scope", 400);
    const caseId = randomUUID();
    let rows: PostgresRow[];
    try {
      rows = await db.query(`select * from corvis_control.report_data_issue(
        $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::uuid,$17,$18)`, [
        identity.tenantId, caseId, identity.workspaceId, identity.authMethod, identity.subject, command.idempotencyKey, reportFingerprint(command),
        command.figure, scope.fundId, scope.fundLabel ?? null, scope.companyId ?? null, scope.companyLabel ?? null, scope.metricCode ?? null,
        scope.metricLabel ?? null, scope.reportPeriod, scope.snapshotId ?? null, scope.snapshotVersion ?? null, command.comment,
      ]);
    } catch (error) {
      // Two concurrent first reports with one key both miss the function's lookup and the loser hits the key's unique
      // index. That is a retryable conflict (the retry finds the winner's case), not a server failure.
      if ((error as { code?: unknown } | null)?.code === "23505") throw new DataIssueRequestError("data_issue_report_conflict", 409);
      throw error;
    }
    const row = rows[0];
    if (!row) throw new Error("data issue case was not created");
    return { item: toDataIssueCase(row, identity), created: str(row, "case_id") === caseId };
  }

  async list(identity: RequestIdentity, query: DataIssueListQuery, db: PostgresSqlApi = this.defaultDb()): Promise<DataIssueList> {
    // Decoded before any query: a tampered cursor never reaches the `::timestamptz` / `::uuid` casts.
    const after = query.cursor ? decodeListCursor(query.cursor) : null;
    const parameters: PostgresPrimitive[] = [identity.tenantId];
    const next = (value: PostgresPrimitive) => { parameters.push(value); return `$${parameters.length}`; };
    let where = "c.tenant_id=$1::uuid";
    if (query.scope === "mine") where += ` and ${this.ownPredicate(identity, next)}`;
    if (query.status) where += ` and c.status=${next(query.status)}`;
    if (after) where += ` and (c.created_at,c.case_id) < (${next(after.createdAt)}::timestamptz,${next(after.caseId)}::uuid)`;
    const limit = next(query.limit + 1);
    const [rows, unseen] = await Promise.all([
      db.query(`select c.*,${CURSOR_CREATED_AT} from corvis_control.data_issue_case c where ${where}
        order by c.created_at desc,c.case_id desc limit ${limit}::integer`, parameters),
      this.unseenUpdateCount(identity, db),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toDataIssueCase(row, identity)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(`${str(last, "cursor_created_at")}|${str(last, "case_id")}`) : null,
      unseenUpdateCount: unseen,
    };
  }

  private ownPredicate(identity: RequestIdentity, next: (value: PostgresPrimitive) => string): string {
    return `c.reporter_auth_method=${next(identity.authMethod)} and c.reporter_subject=${next(identity.subject)}
      and c.fund_id in (select jsonb_array_elements_text(${next(this.fundList(identity))}::jsonb))`;
  }

  private async unseenUpdateCount(identity: RequestIdentity, db: PostgresSqlApi): Promise<number> {
    const parameters: PostgresPrimitive[] = [identity.tenantId];
    const next = (value: PostgresPrimitive) => { parameters.push(value); return `$${parameters.length}`; };
    const rows = await db.query(`select count(*)::integer as unseen from corvis_control.data_issue_case c
      where c.tenant_id=$1::uuid and ${this.ownPredicate(identity, next)} and c.reporter_seen_status<>c.status`, parameters);
    return Number(rows[0]?.unseen ?? 0);
  }

  /** The case row if the caller may see it. A missing, foreign or malformed id is the same 404: existence is not leaked. */
  private async visibleRow(identity: RequestIdentity, caseId: string, db: PostgresSqlApi): Promise<PostgresRow> {
    if (!isUuid(caseId)) throw new DataIssueRequestError("data_issue_not_found", 404);
    const row = (await db.query(`select c.* from corvis_control.data_issue_case c where c.tenant_id=$1::uuid and c.case_id=$2::uuid
      and ($3::boolean or (c.reporter_auth_method=$4 and c.reporter_subject=$5 and c.fund_id in (select jsonb_array_elements_text($6::jsonb))))`,
    [identity.tenantId, caseId, isTenantAdminIdentity(identity), identity.authMethod, identity.subject, this.fundList(identity)]))[0];
    if (!row) throw new DataIssueRequestError("data_issue_not_found", 404);
    return row;
  }

  async get(identity: RequestIdentity, caseId: string, db: PostgresSqlApi = this.defaultDb()): Promise<DataIssueCase> {
    const row = await this.visibleRow(identity, caseId, db);
    const events = await db.query(`select from_status,to_status,occurred_at,note from corvis_control.data_issue_case_event
      where tenant_id=$1::uuid and case_id=$2::uuid order by event_seq`, [identity.tenantId, caseId]);
    return toDataIssueCase(row, identity, events.map(toEvent));
  }

  async acknowledge(identity: RequestIdentity, caseId: string, db: PostgresSqlApi = this.defaultDb()): Promise<DataIssueCase> {
    if (!isUuid(caseId)) throw new DataIssueRequestError("data_issue_not_found", 404);
    // Only the reporter's own marker moves; an Organization Admin looking at someone else's case acknowledges nothing.
    const row = (await db.query(`update corvis_control.data_issue_case c set reporter_seen_status=c.status
      where c.tenant_id=$1::uuid and c.case_id=$2::uuid and c.reporter_auth_method=$3 and c.reporter_subject=$4
        and c.fund_id in (select jsonb_array_elements_text($5::jsonb))
      returning c.*`, [identity.tenantId, caseId, identity.authMethod, identity.subject, this.fundList(identity)]))[0];
    if (!row) throw new DataIssueRequestError("data_issue_not_found", 404);
    return toDataIssueCase(row, identity);
  }

  async transition(identity: RequestIdentity, caseId: string, command: DataIssueTransitionCommand, db: PostgresSqlApi = this.defaultDb()): Promise<DataIssueCase> {
    if (!isUuid(caseId)) throw new DataIssueRequestError("data_issue_not_found", 404);
    const row = (await db.query(`select * from corvis_control.transition_data_issue_case($1::uuid,$2::uuid,$3,$4,$5,$6,$7::uuid)`, [
      identity.tenantId, caseId, command.action, command.expectedStatus ?? null, identity.subject, command.note ?? null, command.correctionIncidentId ?? null,
    ]))[0];
    if (!row) throw new DataIssueRequestError("data_issue_not_found", 404);
    await notifyReporter(db, row);
    return toDataIssueCase(row, identity);
  }
}

/**
 * Queues the in-app/email notice for a status change (category `data_issue_update`). Best effort inside the caller's
 * transaction: a notification fault must never block the status change. A reporter with no active human identity
 * (`reporter_user_id` null) has nobody to email and keeps only the in-app badge. The email carries the status only;
 * names and figures are never in it (core/notifications.ts).
 */
async function notifyReporter(db: PostgresSqlApi, row: PostgresRow): Promise<void> {
  if (row.reporter_user_id == null) return;
  const status = str(row, "status");
  const caseId = str(row, "case_id");
  await bestEffortNotification(db, `data_issue_update:${caseId}:${status}`, () => enqueueForUser(db, {
    tenantId: str(row, "tenant_id"), userId: str(row, "reporter_user_id"), category: "data_issue_update", workspaceId: str(row, "workspace_id"),
    fundId: str(row, "fund_id"), params: { status }, dedupeKey: `data_issue_update:${caseId}:${status}`,
  }), { inTransaction: true });
}

/**
 * Called by the governed correction flow when an incident resolves: every investigating case linked to it becomes
 * corrected, exposing the replacement snapshot. Isolated by a savepoint so a fault here can never fail or roll back the
 * correction itself (an operator can still close the case by hand against the same incident). Returns the closed cases.
 */
export async function closeDataIssuesForCorrection(
  db: PostgresSqlApi,
  identity: RequestIdentity,
  incidentId: string,
  correlationId: string,
  audit: (event: AuditEvent) => Promise<void>,
): Promise<DataIssueCase[]> {
  let savepoint = false;
  try { await db.execute("savepoint corvis_data_issue_close"); savepoint = true; } catch { /* not in a transaction: run best effort */ }
  try {
    const rows = await db.query(`select * from corvis_control.close_data_issue_cases_for_correction($1::uuid,$2::uuid,$3)`,
      [identity.tenantId, incidentId, identity.subject]);
    const closed: DataIssueCase[] = [];
    for (const row of rows) {
      const item = toDataIssueCase(row, identity);
      await audit(dataIssueAuditEvent(identity, correlationId, "data_issue.correct", item));
      await notifyReporter(db, row);
      closed.push(item);
    }
    if (savepoint) await db.execute("release savepoint corvis_data_issue_close");
    return closed;
  } catch (error) {
    if (savepoint) await db.execute("rollback to savepoint corvis_data_issue_close").catch(() => undefined);
    logEvent("error", "data_issue.close_for_correction_failed", { correlationId }, { errorName: error instanceof Error ? error.name : typeof error });
    return [];
  }
}
