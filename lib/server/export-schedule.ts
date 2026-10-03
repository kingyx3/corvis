import { createHash, randomUUID } from "node:crypto";
import type { ExportFormat } from "../../core/delivery.ts";
import { AuthorizationError, assertPermission, assertRedistributionAllowed, type AuditEvent, type RequestIdentity } from "../../core/enterprise.ts";
import {
  EXPORT_SCHEDULE_FORMATS,
  EXPORT_SCHEDULE_STATUSES,
  EXPORT_SCHEDULE_STOP_REASONS,
  EXPORT_SCHEDULE_TRIGGERS,
  exportScopeSummary,
  failureReasonForDenial,
  isExportScheduleFailureReason,
  type CreateExportScheduleCommand,
  type ExportSchedule,
  type ExportScheduleAction,
  type ExportScheduleFailureReason,
  type ExportScheduleRun,
  type ScheduledExportScope,
} from "../../core/export-schedule.ts";
import { PostgresMembershipAuthorizationRepository, type AuthorizationPrincipal, type MembershipAuthorization } from "./authorization.ts";
import { getServerConfig } from "./config.ts";
import { assertFeatureEnabled, FeatureFlagDeniedError } from "./feature-flags.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./pagination.ts";
import { createPhysicalExport } from "./physical-exports.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { postgres, withTransaction, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";
import { countMetric, logEvent } from "./telemetry.ts";

/**
 * Scheduled exports (F4, #260), Postgres side. A schedule only ever writes `corvis_control.export_schedule` and its run
 * history (migration 085); the export itself is requested through `createPhysicalExport` and delivered by the existing
 * export worker, never by a second export path. Visibility is a predicate in every query below: a schedule is changed by
 * its owner only and read by its owner and Organization Admins.
 */

export type ExportScheduleListQuery = {
  /** `mine`: the caller's own schedules. `all`: every schedule in the tenant (Organization Admins only). */
  scope: "mine" | "all";
  limit: number;
  cursor?: string | null;
};

export type ExportScheduleRunListQuery = ExportScheduleListQuery & { scheduleId?: string };

export type DeletedExportSchedule = Pick<ExportSchedule, "scheduleId" | "label" | "trigger" | "format">;
export type ExportSchedulePage = { items: ExportSchedule[]; nextCursor: string | null };
export type ExportScheduleRunPage = { items: ExportScheduleRun[]; nextCursor: string | null };

/** Where schedules live. Postgres in production, an in-memory store in demo mode; both enforce the same visibility rules. */
export interface ExportScheduleBackend {
  readonly demo: boolean;
  create(identity: RequestIdentity, command: CreateExportScheduleCommand, db?: PostgresSqlApi): Promise<{ item: ExportSchedule; created: boolean }>;
  list(identity: RequestIdentity, query: ExportScheduleListQuery, db?: PostgresSqlApi): Promise<ExportSchedulePage>;
  get(identity: RequestIdentity, scheduleId: string, db?: PostgresSqlApi): Promise<ExportSchedule>;
  /** The owner pauses or resumes a schedule. */
  setStatus(identity: RequestIdentity, scheduleId: string, action: ExportScheduleAction, db?: PostgresSqlApi): Promise<ExportSchedule>;
  /** The owner deletes a schedule: it never runs again; its runs stay in history. Returns what was deleted, for the audit event. */
  remove(identity: RequestIdentity, scheduleId: string, db?: PostgresSqlApi): Promise<DeletedExportSchedule>;
  listRuns(identity: RequestIdentity, query: ExportScheduleRunListQuery, db?: PostgresSqlApi): Promise<ExportScheduleRunPage>;
}

/** A request the caller can fix (400), is not allowed (403), names no visible schedule (404) or cannot be accepted in the schedule's current state (409). */
export class ExportScheduleRequestError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409;
  constructor(code: string, status: 400 | 403 | 404 | 409) {
    super(code);
    this.name = "ExportScheduleRequestError";
    this.code = code;
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean { return UUID.test(value); }

export function isTenantAdminIdentity(identity: RequestIdentity): boolean { return identity.isTenantAdmin === true; }

export function assertCanViewAll(identity: RequestIdentity): void {
  if (!isTenantAdminIdentity(identity)) throw new ExportScheduleRequestError("tenant_admin_required", 403);
}

/** The synthetic session a scheduled run is made under: stable per schedule, so it is never a user's revocable session. */
export function scheduleSessionId(scheduleId: string): string { return `export-schedule:${scheduleId}`; }

/** Key-order independent fingerprint of a schedule, so a reused idempotency key with different content is refused. */
export function scheduleFingerprint(command: CreateExportScheduleCommand): string {
  const scope = "snapshotId" in command.scope
    ? ["snapshot", command.scope.snapshotId]
    : ["position", command.scope.positionFinancials.fundId, command.scope.positionFinancials.holdingId, command.scope.positionFinancials.companyId,
      command.scope.positionFinancials.periodicity, command.scope.positionFinancials.portfolioId ?? null];
  return createHash("sha256").update(JSON.stringify([command.label, scope, command.format, command.trigger])).digest("hex");
}

/** The audit event for a schedule command. Identifiers, the label and the trigger only: never data. */
export function exportScheduleAuditEvent(identity: RequestIdentity, correlationId: string, action: string, item: DeletedExportSchedule & { status: string }): AuditEvent {
  return {
    id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
    actorSubject: identity.subject, sessionId: identity.sessionId, action, targetType: "export_schedule", targetId: item.scheduleId,
    outcome: "success", correlationId,
    metadata: { label: item.label, trigger: item.trigger, format: item.format, status: item.status },
  };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function str(row: PostgresRow, key: string): string { return String(row[key]); }
function optionalStr(row: PostgresRow, key: string): string | undefined { return row[key] == null ? undefined : String(row[key]); }
/** Postgres timestamptz text (`2026-10-01 10:00:00.123456+00`) as RFC 3339. */
function iso(row: PostgresRow, key: string): string { return new Date(str(row, key)).toISOString(); }

function oneOf<T extends string>(allowed: readonly T[], value: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`unexpected export schedule value`);
  return found;
}

export function toExportScheduleRun(row: PostgresRow): ExportScheduleRun {
  const reason = optionalStr(row, "failure_reason");
  const run: ExportScheduleRun = {
    runId: str(row, "run_id"),
    scheduleId: str(row, "schedule_id"),
    scheduleLabel: str(row, "schedule_label"),
    scopeLabel: str(row, "scope_label"),
    format: oneOf<ExportFormat>(EXPORT_SCHEDULE_FORMATS, str(row, "format")),
    triggerKey: str(row, "trigger_key"),
    createdAt: iso(row, "created_at"),
    outcome: str(row, "outcome") === "failed" ? "failed" : "requested",
  };
  if (row.export_id != null) run.exportId = str(row, "export_id");
  if (row.export_state != null) run.exportState = str(row, "export_state");
  if (isExportScheduleFailureReason(reason)) run.failureReason = reason;
  return run;
}

export function toExportSchedule(row: PostgresRow, identity: RequestIdentity, lastRun: ExportScheduleRun | null): ExportSchedule {
  const stopReason = optionalStr(row, "stop_reason");
  return {
    scheduleId: str(row, "schedule_id"),
    label: str(row, "label"),
    scope: row.scope as ScheduledExportScope,
    scopeLabel: str(row, "scope_label"),
    format: oneOf<ExportFormat>(EXPORT_SCHEDULE_FORMATS, str(row, "format")),
    trigger: oneOf(EXPORT_SCHEDULE_TRIGGERS, str(row, "trigger_kind")),
    status: oneOf(EXPORT_SCHEDULE_STATUSES, str(row, "status")),
    stopReason: stopReason === undefined ? null : oneOf(EXPORT_SCHEDULE_STOP_REASONS, stopReason),
    ownedByMe: str(row, "owner_auth_method") === identity.authMethod && str(row, "owner_subject") === identity.subject,
    owner: str(row, "owner_subject"),
    createdAt: iso(row, "created_at"),
    updatedAt: iso(row, "updated_at"),
    nextRunAt: row.next_run_at == null ? null : iso(row, "next_run_at"),
    lastRun,
  };
}

// ---------------------------------------------------------------------------
// Keyset cursor: newest first, (created_at desc, id desc)
// ---------------------------------------------------------------------------

/** Microsecond-precision UTC text of `created_at`, the exact value the keyset compares against. */
const CURSOR_TIMESTAMP = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function decodeListCursor(cursor: string): { createdAt: string; id: string } {
  const key = decodeCursor(cursor);
  const separator = key.indexOf("|");
  const createdAt = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (separator === -1 || !CURSOR_TIMESTAMP.test(createdAt) || !isUuid(id)) throw new InvalidCursorError();
  // Date.parse rolls impossible dates over (Feb 30, hour 24) and the Postgres cast would reject them with a 500: a round trip catches them here.
  const millis = `${createdAt.slice(0, 23)}Z`;
  const parsed = Date.parse(millis);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== millis) throw new InvalidCursorError();
  return { createdAt, id: id.toLowerCase() };
}

const cursorCreatedAt = (alias: string) => `to_char(${alias}.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at`;

const RUN_COLUMNS = `r.run_id,r.schedule_id,r.trigger_key,r.outcome,r.export_id,r.failure_reason,r.created_at,
  s.label as schedule_label,s.scope_label,s.format,j.state as export_state`;
const RUN_FROM = `corvis_control.export_schedule_run r
  join corvis_control.export_schedule s on s.tenant_id=r.tenant_id and s.schedule_id=r.schedule_id
  left join corvis_serving.export_job j on j.tenant_id=r.tenant_id and j.export_id=r.export_id`;

// ---------------------------------------------------------------------------
// Authorization at creation and at every run
// ---------------------------------------------------------------------------

export type FormatGate = (identity: RequestIdentity, format: ExportFormat, db: PostgresSqlApi) => Promise<void>;

/** Parquet is behind the `exports.parquet_delivery` flag, exactly as for an interactive export request. */
export const defaultFormatGate: FormatGate = async (identity, format, db) => {
  if (format === "parquet") await assertFeatureEnabled(identity, "exports.parquet_delivery", "export", db);
};

/**
 * The caller must be entitled to the fund behind the scope. A position scope names its fund; a snapshot scope is
 * resolved to the fund of that published snapshot. A snapshot that does not exist (or is not published) is refused the
 * same way, so the answer never reveals whether another organization's snapshot exists.
 */
export async function assertScopeEntitled(identity: RequestIdentity, scope: ScheduledExportScope, db: PostgresSqlApi): Promise<void> {
  const entitled = identity.entitlements.fundIds ?? [];
  if ("positionFinancials" in scope) {
    if (!entitled.includes(scope.positionFinancials.fundId)) throw new ExportScheduleRequestError("export_scope_not_entitled", 403);
    return;
  }
  if (!isUuid(scope.snapshotId)) throw new ExportScheduleRequestError("invalid_scope", 400);
  const rows = await db.query(`select distinct s.fund_id from corvis_consolidated.fund_period_snapshot s
    where s.tenant_id=$1::uuid and s.snapshot_id=$2::uuid and s.status='published'`, [identity.tenantId, scope.snapshotId]);
  if (rows.length === 0 || !rows.every((row) => entitled.includes(str(row, "fund_id")))) throw new ExportScheduleRequestError("export_scope_not_entitled", 403);
}

// ---------------------------------------------------------------------------
// The Postgres backend
// ---------------------------------------------------------------------------

export class PostgresExportScheduleBackend implements ExportScheduleBackend {
  readonly demo = false;
  private readonly defaultDb: () => PostgresSqlApi;
  private readonly formatGate: FormatGate;

  constructor(defaultDb: () => PostgresSqlApi, formatGate: FormatGate = defaultFormatGate) {
    this.defaultDb = defaultDb;
    this.formatGate = formatGate;
  }

  /** The newest run of each given schedule, with its export's delivery state. */
  private async lastRuns(identity: RequestIdentity, scheduleIds: readonly string[], db: PostgresSqlApi): Promise<Map<string, ExportScheduleRun>> {
    if (scheduleIds.length === 0) return new Map();
    const rows = await db.query(`select distinct on (r.schedule_id) ${RUN_COLUMNS} from ${RUN_FROM}
      where r.tenant_id=$1::uuid and r.schedule_id in (select jsonb_array_elements_text($2::jsonb)::uuid)
      order by r.schedule_id,r.created_at desc,r.run_id desc`, [identity.tenantId, JSON.stringify(scheduleIds)]);
    return new Map(rows.map((row) => [str(row, "schedule_id"), toExportScheduleRun(row)]));
  }

  private async withLastRun(identity: RequestIdentity, row: PostgresRow, db: PostgresSqlApi): Promise<ExportSchedule> {
    const scheduleId = str(row, "schedule_id");
    return toExportSchedule(row, identity, (await this.lastRuns(identity, [scheduleId], db)).get(scheduleId) ?? null);
  }

  async create(identity: RequestIdentity, command: CreateExportScheduleCommand, db: PostgresSqlApi = this.defaultDb()): Promise<{ item: ExportSchedule; created: boolean }> {
    if (!isUuid(identity.workspaceId)) throw new ExportScheduleRequestError("invalid_workspace", 400);
    // What the owner may export is decided now and again at every run: a schedule can never widen their access.
    assertRedistributionAllowed(identity);
    await this.formatGate(identity, command.format, db);
    await assertScopeEntitled(identity, command.scope, db);
    const scheduleId = randomUUID();
    const row = (await db.query(`select * from corvis_control.create_export_schedule($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`, [
      identity.tenantId, scheduleId, identity.workspaceId, identity.authMethod, identity.subject, command.idempotencyKey,
      scheduleFingerprint(command), command.label, JSON.stringify(command.scope), exportScopeSummary(command.scope), command.format, command.trigger,
    ]))[0];
    if (!row) throw new Error("export schedule was not created");
    return { item: await this.withLastRun(identity, row, db), created: str(row, "schedule_id") === scheduleId };
  }

  async list(identity: RequestIdentity, query: ExportScheduleListQuery, db: PostgresSqlApi = this.defaultDb()): Promise<ExportSchedulePage> {
    // Decoded before any query: a tampered cursor never reaches the `::timestamptz` / `::uuid` casts.
    const after = query.cursor ? decodeListCursor(query.cursor) : null;
    const parameters: PostgresPrimitive[] = [identity.tenantId];
    const next = (value: PostgresPrimitive) => { parameters.push(value); return `$${parameters.length}`; };
    let where = "s.tenant_id=$1::uuid and s.status<>'deleted'";
    if (query.scope === "mine") where += ` and s.owner_auth_method=${next(identity.authMethod)} and s.owner_subject=${next(identity.subject)}`;
    if (after) where += ` and (s.created_at,s.schedule_id) < (${next(after.createdAt)}::timestamptz,${next(after.id)}::uuid)`;
    const limit = next(query.limit + 1);
    const rows = await db.query(`select s.*,${cursorCreatedAt("s")} from corvis_control.export_schedule s where ${where}
      order by s.created_at desc,s.schedule_id desc limit ${limit}::integer`, parameters);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const runs = await this.lastRuns(identity, page.map((row) => str(row, "schedule_id")), db);
    return {
      items: page.map((row) => toExportSchedule(row, identity, runs.get(str(row, "schedule_id")) ?? null)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(`${str(last, "cursor_created_at")}|${str(last, "schedule_id")}`) : null,
    };
  }

  /** The schedule row if the caller may see it. A missing, foreign, deleted or malformed id is the same 404: existence is not leaked. */
  private async visibleRow(identity: RequestIdentity, scheduleId: string, db: PostgresSqlApi): Promise<PostgresRow> {
    if (!isUuid(scheduleId)) throw new ExportScheduleRequestError("export_schedule_not_found", 404);
    const row = (await db.query(`select s.* from corvis_control.export_schedule s
      where s.tenant_id=$1::uuid and s.schedule_id=$2::uuid and s.status<>'deleted'
        and ($3::boolean or (s.owner_auth_method=$4 and s.owner_subject=$5))`,
    [identity.tenantId, scheduleId, isTenantAdminIdentity(identity), identity.authMethod, identity.subject]))[0];
    if (!row) throw new ExportScheduleRequestError("export_schedule_not_found", 404);
    return row;
  }

  async get(identity: RequestIdentity, scheduleId: string, db: PostgresSqlApi = this.defaultDb()): Promise<ExportSchedule> {
    return this.withLastRun(identity, await this.visibleRow(identity, scheduleId, db), db);
  }

  private async change(identity: RequestIdentity, scheduleId: string, action: ExportScheduleAction | "delete", db: PostgresSqlApi): Promise<PostgresRow> {
    if (!isUuid(scheduleId)) throw new ExportScheduleRequestError("export_schedule_not_found", 404);
    const row = (await db.query(`select * from corvis_control.set_export_schedule_status($1::uuid,$2::uuid,$3,$4,$5)`,
      [identity.tenantId, scheduleId, identity.authMethod, identity.subject, action]))[0];
    // Only the owner may change a schedule: anyone else (an Organization Admin included) finds nothing here.
    if (!row) throw new ExportScheduleRequestError("export_schedule_not_found", 404);
    return row;
  }

  async setStatus(identity: RequestIdentity, scheduleId: string, action: ExportScheduleAction, db: PostgresSqlApi = this.defaultDb()): Promise<ExportSchedule> {
    return this.withLastRun(identity, await this.change(identity, scheduleId, action, db), db);
  }

  async remove(identity: RequestIdentity, scheduleId: string, db: PostgresSqlApi = this.defaultDb()): Promise<DeletedExportSchedule> {
    const row = await this.change(identity, scheduleId, "delete", db);
    return {
      scheduleId: str(row, "schedule_id"), label: str(row, "label"),
      trigger: oneOf(EXPORT_SCHEDULE_TRIGGERS, str(row, "trigger_kind")), format: oneOf<ExportFormat>(EXPORT_SCHEDULE_FORMATS, str(row, "format")),
    };
  }

  async listRuns(identity: RequestIdentity, query: ExportScheduleRunListQuery, db: PostgresSqlApi = this.defaultDb()): Promise<ExportScheduleRunPage> {
    const after = query.cursor ? decodeListCursor(query.cursor) : null;
    const parameters: PostgresPrimitive[] = [identity.tenantId];
    const next = (value: PostgresPrimitive) => { parameters.push(value); return `$${parameters.length}`; };
    let where = "r.tenant_id=$1::uuid";
    if (query.scope === "mine") where += ` and s.owner_auth_method=${next(identity.authMethod)} and s.owner_subject=${next(identity.subject)}`;
    if (query.scheduleId) {
      if (!isUuid(query.scheduleId)) throw new ExportScheduleRequestError("export_schedule_not_found", 404);
      where += ` and r.schedule_id=${next(query.scheduleId)}::uuid`;
    }
    if (after) where += ` and (r.created_at,r.run_id) < (${next(after.createdAt)}::timestamptz,${next(after.id)}::uuid)`;
    const limit = next(query.limit + 1);
    const rows = await db.query(`select ${RUN_COLUMNS},${cursorCreatedAt("r")} from ${RUN_FROM} where ${where}
      order by r.created_at desc,r.run_id desc limit ${limit}::integer`, parameters);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toExportScheduleRun),
      nextCursor: rows.length > query.limit && last ? encodeCursor(`${str(last, "cursor_created_at")}|${str(last, "run_id")}`) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// The worker: due triggers become governed export requests made as the owner
// ---------------------------------------------------------------------------

export type ExportScheduleRunnerDependencies = {
  /** Resolves the owner's current membership, entitlements and data rights (null: no active authorization context). */
  authorize?: (store: PostgresSqlApi, principal: AuthorizationPrincipal) => Promise<MembershipAuthorization | null>;
  /** The governed export request. Defaults to the same `createPhysicalExport` an interactive request uses. */
  requestExport?: typeof createPhysicalExport;
  formatGate?: FormatGate;
};

const DEFAULT_RUNNER_DEPENDENCIES: Required<ExportScheduleRunnerDependencies> = {
  authorize: (store, principal) => new PostgresMembershipAuthorizationRepository(store).resolve(principal, { applySessionPolicy: false }),
  requestExport: createPhysicalExport,
  formatGate: defaultFormatGate,
};

export type ExportScheduleRunSummary = {
  /** Schedules stopped because their owner is no longer active. */
  stopped: number;
  /** Runs that handed an export to the governed export worker. */
  requested: number;
  /** Runs that were refused (re-authorization failed): nothing was exported. */
  failed: number;
  /** Schedules whose run raised an unexpected error and will be retried on the next tick. */
  errors: number;
};

const SYSTEM_ACTOR = "system:export-scheduler";

async function auditSystem(tx: PostgresSqlApi, event: AuditEvent): Promise<void> {
  await new PostgresOperationsRepository(tx).audit(event);
}

function stoppedAuditEvent(row: PostgresRow): AuditEvent {
  const scheduleId = str(row, "schedule_id");
  return {
    id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: str(row, "tenant_id"), workspaceId: str(row, "workspace_id"),
    actorSubject: SYSTEM_ACTOR, sessionId: scheduleSessionId(scheduleId), action: "export_schedule.stop", targetType: "export_schedule", targetId: scheduleId,
    outcome: "success", correlationId: `export-schedule:${scheduleId}:stop`,
    metadata: { label: str(row, "label"), reason: str(row, "stop_reason"), owner: str(row, "owner_subject") },
  };
}

/** Stops every schedule whose owner was deactivated, auditing each. Idempotent: a second call finds nothing. */
export async function stopSchedulesOfInactiveOwners(store: PostgresSqlApi): Promise<number> {
  return withTransaction(store, async (tx) => {
    const rows = await tx.query(`select * from corvis_control.stop_export_schedules_for_inactive_owners()`);
    for (const row of rows) await auditSystem(tx, stoppedAuditEvent(row));
    return rows.length;
  });
}

function runAuditEvent(row: PostgresRow, triggerKey: string, outcome: "success" | "failure", metadata: Record<string, string>): AuditEvent {
  const scheduleId = str(row, "schedule_id");
  return {
    id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: str(row, "tenant_id"), workspaceId: str(row, "workspace_id"),
    // The run is made as the owner, so it is attributed to them, under the schedule's own synthetic session.
    actorSubject: str(row, "owner_subject"), sessionId: scheduleSessionId(scheduleId), action: "export_schedule.run", targetType: "export_schedule", targetId: scheduleId,
    outcome, correlationId: `export-schedule:${scheduleId}:${triggerKey}`,
    metadata: { triggerKey, format: str(row, "format"), ...metadata },
  };
}

function ownerIdentity(principal: AuthorizationPrincipal, authorization: MembershipAuthorization): RequestIdentity {
  return {
    ...principal,
    roles: authorization.roles,
    entitlements: {
      workspaceIds: authorization.workspaceIds,
      fundIds: authorization.fundIds,
      documentIds: authorization.documentIds,
      sourceDocumentIds: authorization.sourceDocumentIds,
      sourceDocumentAccessAllowed: authorization.sourceDocumentIds.length > 0,
      internalAnalyticsAllowed: authorization.internalAnalyticsAllowed,
      modelTrainingAllowed: authorization.modelTrainingAllowed,
      redistributionAllowed: authorization.redistributionAllowed,
    },
  };
}

/**
 * Handles one due schedule in one transaction: claim the trigger under a row lock, re-authorize the owner, request the
 * governed export, and record the run. Everything commits together, so a crash leaves nothing behind (the next tick
 * claims the trigger again) and two workers can never both run it. A refusal is recorded as a failed run with a stable
 * reason and nothing is exported; any other error rolls the transaction back and is retried on the next tick.
 */
async function runDueSchedule(
  store: PostgresSqlApi,
  tenantId: string,
  scheduleId: string,
  dependencies: Required<ExportScheduleRunnerDependencies>,
): Promise<"none" | "requested" | "failed"> {
  return withTransaction(store, async (tx) => {
    const claim = (await tx.query(`select * from corvis_control.claim_export_schedule_trigger($1::uuid,$2::uuid)`, [tenantId, scheduleId]))[0];
    if (!claim) return "none";
    const triggerKey = str(claim, "trigger_key");
    const schedule = (await tx.query(`select * from corvis_control.export_schedule where tenant_id=$1::uuid and schedule_id=$2::uuid`, [tenantId, scheduleId]))[0]!;
    const principal: AuthorizationPrincipal = {
      tenantId, workspaceId: str(schedule, "workspace_id"), subject: str(schedule, "owner_subject"),
      authMethod: oneOf(["oidc", "saml", "service_account"] as const, str(schedule, "owner_auth_method")), sessionId: scheduleSessionId(scheduleId),
    };
    const format = oneOf<ExportFormat>(EXPORT_SCHEDULE_FORMATS, str(schedule, "format"));
    let exportId: string | undefined;
    let failure: ExportScheduleFailureReason | undefined;

    const authorization = await dependencies.authorize(tx, principal);
    if (!authorization) {
      failure = "owner_inactive";
      for (const stopped of await tx.query(`select * from corvis_control.stop_export_schedule($1::uuid,$2::uuid)`, [tenantId, scheduleId])) await auditSystem(tx, stoppedAuditEvent(stopped));
    } else {
      const identity = ownerIdentity(principal, authorization);
      try {
        assertPermission(identity, "exports:create");
        await dependencies.formatGate(identity, format, tx);
        const scope = schedule.scope as ScheduledExportScope;
        await assertScopeEntitled(identity, scope, tx);
        exportId = (await dependencies.requestExport(identity, format, { scope, source: "delivery" }, tx)).exportId;
      } catch (error) {
        if (error instanceof AuthorizationError) failure = failureReasonForDenial(error.requiredPermission);
        else if (error instanceof ExportScheduleRequestError) failure = "scope_not_entitled";
        else if (error instanceof FeatureFlagDeniedError) failure = "format_unavailable";
        else throw error;
      }
    }

    await tx.execute(`insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome,export_id,failure_reason)
      values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7)`,
    [tenantId, randomUUID(), scheduleId, triggerKey, failure ? "failed" : "requested", exportId ?? null, failure ?? null]);
    await auditSystem(tx, failure
      ? runAuditEvent(schedule, triggerKey, "failure", { reason: failure })
      : runAuditEvent(schedule, triggerKey, "success", { exportId: exportId! }));
    return failure ? "failed" : "requested";
  });
}

/**
 * One tick of the scheduled-export worker, called from the private delivery tick. It first stops schedules whose owner
 * was deactivated, then runs every schedule with a due trigger. Bounded by `limit`; the rest wait for the next tick.
 * A schedule that raises an unexpected error is logged and retried next tick without holding back the others.
 */
export async function processDueExportSchedules(
  limit = 25,
  dependencies: ExportScheduleRunnerDependencies = {},
  store: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
): Promise<ExportScheduleRunSummary> {
  const resolved = { ...DEFAULT_RUNNER_DEPENDENCIES, ...dependencies };
  const summary: ExportScheduleRunSummary = { stopped: await stopSchedulesOfInactiveOwners(store), requested: 0, failed: 0, errors: 0 };
  const due = await store.query(`select tenant_id,schedule_id from corvis_control.list_due_export_schedules($1::integer)`, [limit]);
  for (const row of due) {
    const tenantId = str(row, "tenant_id");
    const scheduleId = str(row, "schedule_id");
    try {
      const outcome = await runDueSchedule(store, tenantId, scheduleId, resolved);
      if (outcome === "requested") summary.requested += 1;
      if (outcome === "failed") summary.failed += 1;
      if (outcome !== "none") countMetric("export_schedule.run", 1, { correlationId: `export-schedule:${scheduleId}`, tenantId }, { outcome });
    } catch (error) {
      summary.errors += 1;
      logEvent("error", "export_schedule.run_failed", { correlationId: `export-schedule:${scheduleId}`, tenantId }, { errorName: error instanceof Error ? error.name : typeof error });
    }
  }
  return summary;
}
