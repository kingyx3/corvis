import { createHash } from "crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

/**
 * Retention and deletion execution.
 *
 * Execution is default-deny: a deletion request only reaches the lifecycle
 * adapter when its scope names data classes that all have an effective
 * retention policy and none of those classes (or the named entities) are under
 * legal hold. Every attempt writes an immutable evidence row, and re-executing
 * a completed request replays the retained evidence instead of repeating the
 * destructive call.
 */

export const EXECUTABLE_DELETION_STATES: readonly string[] = ["requested", "approved", "retryable", "blocked"];

/** Upper bound on a single lifecycle-adapter call so a hung adapter cannot pin the request open. */
export const DATA_LIFECYCLE_ADAPTER_TIMEOUT_MS = 30_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DeletionExecutionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "DeletionExecutionError";
    this.code = code;
  }
}

export type LegalHoldMatch = { source: "retention_policy" | "legal_hold"; dataClass: string; reference: string };

export class LegalHoldError extends DeletionExecutionError {
  readonly holds: LegalHoldMatch[];
  constructor(holds: LegalHoldMatch[]) {
    super("deletion_blocked_by_legal_hold");
    this.name = "LegalHoldError";
    this.holds = holds;
  }
}

export type DeletionScope = {
  dataClasses: string[];
  documentIds?: string[];
  fundIds?: string[];
  subjectIds?: string[];
};

export type DeletionExecutionResult = {
  requestId: string;
  state: "completed";
  attempt: number;
  replayed: boolean;
  evidence: Record<string, unknown>;
  evidenceHash: string;
};

type Dependencies = {
  db?: PostgresSqlApi;
  fetchImpl?: typeof fetch;
};

function controlDb(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }
function bearer(token?: string): Record<string, string> { return token ? { authorization: `Bearer ${token}` } : {}; }

function text(row: PostgresRow, key: string): string {
  const value = row[key];
  return value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
}

function num(row: PostgresRow, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

function record(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))].sort();
}

export function evidenceHash(tenantId: string, requestId: string, attempt: number, evidence: unknown): string {
  return createHash("sha256").update(tenantId).update(requestId).update(String(attempt)).update(JSON.stringify(evidence ?? null)).digest("hex");
}

/**
 * Scope parsing is strict: an unbounded or class-less scope is rejected rather
 * than interpreted as "delete everything".
 */
export function parseDeletionScope(raw: unknown): DeletionScope {
  const scope = record(raw);
  const dataClasses = stringList(scope.dataClasses);
  if (dataClasses.length === 0) throw new DeletionExecutionError("deletion_scope_missing_data_classes");
  return {
    dataClasses,
    documentIds: stringList(scope.documentIds),
    fundIds: stringList(scope.fundIds),
    subjectIds: stringList(scope.subjectIds),
  };
}

async function retentionCoverage(db: PostgresSqlApi, tenantId: string, dataClasses: string[]): Promise<string[]> {
  const rows = await db.query(`select distinct data_class from corvis_control.retention_policy
    where tenant_id=$1
      and effective_from <= now()
      and data_class in (select jsonb_array_elements_text($2::jsonb))`,
  [tenantId, JSON.stringify(dataClasses)]);
  return rows.map((row) => text(row, "data_class"));
}

export async function activeLegalHolds(
  db: PostgresSqlApi,
  tenantId: string,
  dataClasses: string[],
): Promise<LegalHoldMatch[]> {
  const rows = await db.query(`select 'retention_policy' as source, data_class, policy_version as reference
      from corvis_control.retention_policy
      where tenant_id=$1
        and legal_hold
        and data_class in (select jsonb_array_elements_text($2::jsonb))
    union all
    select 'legal_hold' as source, coalesce(data_class,'*') as data_class, matter_reference as reference
      from corvis_control.legal_hold
      where tenant_id=$1
        and released_at is null
        and (data_class is null or data_class in (select jsonb_array_elements_text($2::jsonb)))
    order by source, data_class, reference`,
  [tenantId, JSON.stringify(dataClasses)]);
  return rows.map((row) => ({
    source: text(row, "source") === "legal_hold" ? "legal_hold" as const : "retention_policy" as const,
    dataClass: text(row, "data_class"),
    reference: text(row, "reference"),
  }));
}

async function recordEvidence(
  db: PostgresSqlApi,
  identity: RequestIdentity,
  requestId: string,
  attempt: number,
  outcome: "completed" | "blocked" | "failed",
  evidence: Record<string, unknown>,
): Promise<string> {
  const hash = evidenceHash(identity.tenantId, requestId, attempt, evidence);
  await db.execute(`insert into corvis_control.deletion_execution_evidence
      (tenant_id, deletion_request_id, attempt, outcome, evidence, evidence_hash, recorded_by)
    values ($1,$2::uuid,$3,$4,$5::jsonb,$6,$7)
    on conflict (tenant_id, deletion_request_id, attempt) do nothing`,
  [identity.tenantId, requestId, attempt, outcome, JSON.stringify(evidence), hash, identity.subject]);
  return hash;
}

async function retainedCompletion(
  db: PostgresSqlApi,
  identity: RequestIdentity,
  requestId: string,
): Promise<{ attempt: number; evidence: Record<string, unknown>; evidenceHash: string } | undefined> {
  const rows = await db.query(`select attempt, evidence, evidence_hash
    from corvis_control.deletion_execution_evidence
    where tenant_id=$1 and deletion_request_id=$2::uuid and outcome='completed'
    order by attempt desc limit 1`, [identity.tenantId, requestId]);
  const row = rows[0];
  if (!row) return undefined;
  return { attempt: num(row, "attempt"), evidence: record(row.evidence), evidenceHash: text(row, "evidence_hash") };
}

export async function executeDeletionRequest(
  identity: RequestIdentity,
  requestId: string,
  dependencies: Dependencies = {},
): Promise<DeletionExecutionResult> {
  const db = dependencies.db ?? controlDb();
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  // A malformed id can never name a request; reject it before the ::uuid cast turns it into a 500.
  if (!UUID.test(requestId)) throw new DeletionExecutionError("deletion_request_not_found");

  const rows = await db.query(`select scope, state, execution_attempts, completion_evidence, evidence_hash, requested_by
    from corvis_control.deletion_request
    where tenant_id=$1 and deletion_request_id=$2::uuid limit 1`, [identity.tenantId, requestId]);
  const request = rows[0];
  if (!request) throw new DeletionExecutionError("deletion_request_not_found");

  const state = text(request, "state");

  // Idempotent replay: a completed request never re-enters the adapter and the
  // originally retained evidence is returned unchanged.
  if (state === "completed") {
    const retained = await retainedCompletion(db, identity, requestId);
    const evidence = retained?.evidence ?? record(request.completion_evidence);
    return {
      requestId,
      state: "completed",
      attempt: retained?.attempt ?? num(request, "execution_attempts"),
      replayed: true,
      evidence,
      evidenceHash: retained?.evidenceHash || text(request, "evidence_hash") || evidenceHash(identity.tenantId, requestId, num(request, "execution_attempts"), evidence),
    };
  }
  if (!EXECUTABLE_DELETION_STATES.includes(state)) throw new DeletionExecutionError("deletion_request_not_executable");
  // Separation of duties: executing records the executor as approver, so the
  // requester can never approve and run their own irreversible deletion.
  if (text(request, "requested_by") === identity.subject) throw new DeletionExecutionError("deletion_requires_independent_approver");

  const scope = parseDeletionScope(jsonValue(request.scope));
  const previousAttempts = num(request, "execution_attempts");
  const attempt = previousAttempts + 1;

  // Compare-and-swap claim: only one concurrent caller can move the request
  // out of the state it was read in, so the destructive adapter call runs once.
  const claimed = await db.query(`update corvis_control.deletion_request set
      state='executing',
      approved_by=coalesce(approved_by,$1),
      approved_at=coalesce(approved_at,now()),
      execution_attempts=$4,
      blocked_reason=null,
      last_error=null
    where tenant_id=$2 and deletion_request_id=$3::uuid and state=$5 and execution_attempts=$6
    returning deletion_request_id`,
  [identity.subject, identity.tenantId, requestId, attempt, state, previousAttempts]);
  if (claimed.length === 0) throw new DeletionExecutionError("deletion_request_not_executable");

  const coveredDataClasses = new Set(await retentionCoverage(db, identity.tenantId, scope.dataClasses));
  const uncovered = scope.dataClasses.filter((dataClass) => !coveredDataClasses.has(dataClass));
  if (uncovered.length > 0) {
    await blockRequest(db, identity, requestId, attempt, "retention_policy_missing", { uncoveredDataClasses: uncovered, scope });
    throw new DeletionExecutionError("deletion_blocked_retention_policy_missing");
  }

  const holds = await activeLegalHolds(db, identity.tenantId, scope.dataClasses);
  if (holds.length > 0) {
    await blockRequest(db, identity, requestId, attempt, "legal_hold", { holds, scope });
    throw new LegalHoldError(holds);
  }

  const config = getServerConfig();
  if (!config.dataLifecycleEndpoint) {
    await failRequest(db, identity, requestId, attempt, "Data lifecycle adapter is not configured", scope);
    throw new DeletionExecutionError("data_lifecycle_adapter_not_configured");
  }

  try {
    const response = await fetchImpl(`${config.dataLifecycleEndpoint.replace(/\/$/, "")}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `${identity.tenantId}:${requestId}`, ...bearer(config.dataLifecycleToken) },
      body: JSON.stringify({ tenantId: identity.tenantId, requestId, attempt, scope, idempotencyKey: `${identity.tenantId}:${requestId}` }),
      cache: "no-store",
      signal: AbortSignal.timeout(DATA_LIFECYCLE_ADAPTER_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Lifecycle adapter rejected deletion (${response.status})`);
    const payload = await response.json() as { evidence?: unknown };
    const evidence: Record<string, unknown> = {
      ...record(payload.evidence),
      adapterStatus: "completed",
      scope,
      attempt,
      executedBy: identity.subject,
    };
    const hash = await recordEvidence(db, identity, requestId, attempt, "completed", evidence);
    await db.execute(`update corvis_control.deletion_request set
        state='completed', completed_at=now(), completion_evidence=$1::jsonb,
        evidence_hash=$4, evidence_recorded_at=now(), blocked_reason=null, last_error=null
      where tenant_id=$2 and deletion_request_id=$3::uuid`,
    [JSON.stringify(evidence), identity.tenantId, requestId, hash]);
    return { requestId, state: "completed", attempt, replayed: false, evidence, evidenceHash: hash };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    await failRequest(db, identity, requestId, attempt, message, scope);
    throw error;
  }
}

async function blockRequest(
  db: PostgresSqlApi,
  identity: RequestIdentity,
  requestId: string,
  attempt: number,
  reason: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const hash = await recordEvidence(db, identity, requestId, attempt, "blocked", { outcome: "blocked", reason, attempt, ...detail });
  await db.execute(`update corvis_control.deletion_request set
      state='blocked', blocked_reason=$1, evidence_hash=$4, evidence_recorded_at=now()
    where tenant_id=$2 and deletion_request_id=$3::uuid`,
  [reason, identity.tenantId, requestId, hash]);
}

async function failRequest(
  db: PostgresSqlApi,
  identity: RequestIdentity,
  requestId: string,
  attempt: number,
  message: string,
  scope: DeletionScope,
): Promise<void> {
  await recordEvidence(db, identity, requestId, attempt, "failed", { outcome: "failed", error: message, attempt, scope });
  await db.execute(`update corvis_control.deletion_request set state='retryable', last_error=$1
    where tenant_id=$2 and deletion_request_id=$3::uuid`, [message, identity.tenantId, requestId]);
}

export async function listDeletionExecutionEvidence(
  identity: RequestIdentity,
  requestId: string,
  db: PostgresSqlApi = controlDb(),
): Promise<PostgresRow[]> {
  return db.query(`select attempt, outcome, evidence, evidence_hash, recorded_by, recorded_at
    from corvis_control.deletion_execution_evidence
    where tenant_id=$1 and deletion_request_id=$2::uuid
    order by attempt`, [identity.tenantId, requestId]);
}
