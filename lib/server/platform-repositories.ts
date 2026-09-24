import {
  hasPermission,
  type AuditEvent,
  type ExportManifest,
  type ProcessingJob,
  type ReconciliationResolutionCommand,
  type RequestIdentity,
  type ReviewDecision,
  type SnapshotPublication,
} from "../../core/enterprise.ts";
import { keysetFetchLimit, sqlKeyBound, sqlKeyset, type KeysetPage } from "./pagination.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

function jsonIds(values: string[] | undefined): string { return JSON.stringify(values ?? []); }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Customer-supplied ids reach `::uuid` casts below. A malformed id can never
 * name a row, so it is treated as not-found instead of letting Postgres raise
 * an invalid-input error (surfaced as a 500).
 */
function isUuid(value: unknown): value is string { return typeof value === "string" && UUID_PATTERN.test(value); }

/** Zero-pad width of the version half of the `/snapshots` cursor key (see snapshotPaginationKey). */
export const SNAPSHOT_VERSION_KEY_WIDTH = 10;

export class PostgresWorkspaceRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  /** Without `page`, the legacy capped list (most recent first); with it, one keyset page by document id. */
  listDocuments(identity: RequestIdentity, page?: KeysetPage): Promise<PostgresRow[]> {
    const documentIds = identity.entitlements.documentIds ?? [];
    if (documentIds.length === 0) return Promise.resolve([]);
    const parameters: PostgresPrimitive[] = [identity.tenantId, jsonIds(documentIds)];
    const keyset = page ? sqlKeyset("document_id::text", page, parameters) : { where: "", tail: "order by created_at desc limit 1000" };
    return this.db.query(`select * from corvis_serving.documents
      where tenant_id=$1
        and document_id::text in (select jsonb_array_elements_text($2::jsonb))${keyset.where}
      ${keyset.tail}`, parameters);
  }

  /** Without `page`, the legacy capped list (most recently updated first); with it, one keyset page by observation id. */
  listObservations(identity: RequestIdentity, page?: KeysetPage): Promise<PostgresRow[]> {
    const fundIds = identity.entitlements.fundIds ?? [];
    const documentIds = identity.entitlements.documentIds ?? [];
    if (fundIds.length === 0 || documentIds.length === 0) return Promise.resolve([]);
    const parameters: PostgresPrimitive[] = [identity.tenantId, jsonIds(fundIds), jsonIds(documentIds)];
    const keyset = page ? sqlKeyset("o.observation_id::text", page, parameters) : { where: "", tail: "order by o.updated_at desc limit 5000" };
    return this.db.query(`select o.*
      from corvis_serving.observations o
      join corvis_source.source_reference r
        on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
      where o.tenant_id=$1
        and o.fund_id in (select jsonb_array_elements_text($2::jsonb))
        and r.document_id::text in (select jsonb_array_elements_text($3::jsonb))${keyset.where}
      ${keyset.tail}`, parameters);
  }

  /**
   * Without `page`, the legacy capped list (newest first); with it, one keyset
   * page in snapshotPaginationKey order: (snapshot id, zero-padded version).
   */
  listSnapshots(identity: RequestIdentity, page?: KeysetPage): Promise<PostgresRow[]> {
    const fundIds = identity.entitlements.fundIds ?? [];
    if (fundIds.length === 0) return Promise.resolve([]);
    const parameters: PostgresPrimitive[] = [identity.tenantId, jsonIds(fundIds)];
    let where = "";
    let tail = "order by s.created_at desc limit 1000";
    if (page) {
      const id = `s.snapshot_id::text collate "C"`;
      const version = `lpad(s.version::text, ${SNAPSHOT_VERSION_KEY_WIDTH}, '0') collate "C"`;
      if (page.afterKey !== undefined) {
        // The key is `${id}\u0000${version}` (neither half holds NUL). Against a cursor key with
        // no NUL, `key > cursor` holds exactly when id >= cursor; otherwise compare the
        // (id, version) tuple, the version half truncated at any further NUL (see sqlKeyBound).
        const nul = page.afterKey.indexOf("\u0000");
        if (nul === -1) {
          parameters.push(page.afterKey);
          where = `\n        and ${id} >= $${parameters.length}`;
        } else {
          parameters.push(page.afterKey.slice(0, nul), sqlKeyBound(page.afterKey.slice(nul + 1)));
          const idParameter = `$${parameters.length - 1}`;
          const versionParameter = `$${parameters.length}`;
          where = `\n        and (${id} > ${idParameter} or (${id} = ${idParameter} and ${version} > ${versionParameter}))`;
        }
      }
      parameters.push(keysetFetchLimit(page));
      tail = `order by ${id}, ${version} limit $${parameters.length}`;
    }
    return this.db.query(`select s.*,
        (select count(*) from corvis_facts.holding h where h.tenant_id=s.tenant_id and h.fund_id=s.fund_id) as holding_count
      from corvis_serving.fund_period_snapshots s
      where s.tenant_id=$1
        and s.fund_id in (select jsonb_array_elements_text($2::jsonb))${where}
      ${tail}`, parameters);
  }
}

export class PostgresReviewPublicationRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  async observation(identity: RequestIdentity, observationId: string): Promise<PostgresRow | undefined> {
    const fundIds = identity.entitlements.fundIds ?? [];
    const documentIds = identity.entitlements.documentIds ?? [];
    if (fundIds.length === 0 || documentIds.length === 0 || !isUuid(observationId)) return undefined;
    const rows = await this.db.query(`select o.observation_id,o.version,o.review_state,o.value_number,o.value_string,o.risk_tier
      from corvis_facts.observation o
      join corvis_source.source_reference r
        on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
      where o.tenant_id=$1 and o.observation_id=$2::uuid
        and o.fund_id in (select jsonb_array_elements_text($3::jsonb))
        and r.document_id::text in (select jsonb_array_elements_text($4::jsonb))
      limit 1`, [identity.tenantId, observationId, jsonIds(fundIds), jsonIds(documentIds)]);
    return rows[0];
  }

  async applyReview(identity: RequestIdentity, decision: ReviewDecision, reviewEventId: string): Promise<PostgresRow | undefined> {
    const rows = await this.db.query(`select * from corvis_facts.apply_review_decision(
      $1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8)`,
    [identity.tenantId,decision.observationId,decision.expectedVersion,reviewEventId,identity.subject,decision.decision,decision.reasonCode,decision.correctedValue ?? null]);
    return rows[0];
  }

  async reconciliationExceptions(identity: RequestIdentity, snapshotId: string, snapshotVersion: number): Promise<PostgresRow[]> {
    const fundIds = identity.entitlements.fundIds ?? [];
    if (fundIds.length === 0 || !isUuid(snapshotId)) return [];
    const sourceDocumentIds = identity.entitlements.sourceDocumentAccessAllowed
      ? identity.entitlements.sourceDocumentIds ?? []
      : [];
    return this.db.query(`select e.*,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'sourceReferenceId',r.source_reference_id::text,
            'documentId',r.document_id::text,
            'page',r.page_number,
            'sheetName',r.sheet_name,
            'cellRange',r.cell_range,
            'excerpt',r.excerpt
          ) order by r.source_reference_id::text)
          from corvis_source.source_reference r
          where r.tenant_id=e.tenant_id
            and r.source_reference_id=any(e.competing_source_reference_ids)
            and r.document_id::text in (select jsonb_array_elements_text($5::jsonb))
        ),'[]'::jsonb) as source_references
      from corvis_serving.reconciliation_exceptions e
      where e.tenant_id=$1 and e.snapshot_id=$2::uuid and e.snapshot_version=$3
        and e.fund_id in (select jsonb_array_elements_text($4::jsonb))
      order by case e.status when 'open' then 0 else 1 end, e.created_at, e.exception_id`,
    [identity.tenantId,snapshotId,snapshotVersion,jsonIds(fundIds),jsonIds(sourceDocumentIds)]);
  }

  async reconciliationExceptionForResolution(
    identity: RequestIdentity,
    command: ReconciliationResolutionCommand,
  ): Promise<PostgresRow | undefined> {
    const fundIds = identity.entitlements.fundIds ?? [];
    if (fundIds.length === 0 || !isUuid(command.exceptionId)) return undefined;
    const selectingSource = command.action === "select_source";
    const sourceDocumentIds = identity.entitlements.sourceDocumentAccessAllowed
      ? identity.entitlements.sourceDocumentIds ?? []
      : [];
    if (selectingSource && (!isUuid(command.selectedSourceReferenceId) || sourceDocumentIds.length === 0)) return undefined;
    const rows = await this.db.query(`select e.*
      from corvis_consolidated.reconciliation_exception e
      where e.tenant_id=$1 and e.exception_id=$2::uuid and e.version=$3 and e.status='open'
        and e.fund_id in (select jsonb_array_elements_text($4::jsonb))
        and ($5::uuid is null or exists (
          select 1 from corvis_source.source_reference r
          where r.tenant_id=e.tenant_id
            and r.source_reference_id=$5::uuid
            and r.source_reference_id=any(e.competing_source_reference_ids)
            and r.document_id::text in (select jsonb_array_elements_text($6::jsonb))
        ))
      limit 1`, [
      identity.tenantId,command.exceptionId,command.expectedVersion,jsonIds(fundIds),
      selectingSource ? command.selectedSourceReferenceId ?? null : null,jsonIds(sourceDocumentIds),
    ]);
    return rows[0];
  }

  async applyReconciliationResolution(
    identity: RequestIdentity,
    command: ReconciliationResolutionCommand,
    resolutionEventId: string,
  ): Promise<PostgresRow | undefined> {
    const rows = await this.db.query(`select * from corvis_consolidated.resolve_reconciliation_exception(
      $1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8::uuid,$9)`, [
      identity.tenantId,command.exceptionId,command.expectedVersion,resolutionEventId,identity.subject,
      command.action,command.reasonCode,command.selectedSourceReferenceId ?? null,command.note ?? null,
    ]);
    return rows[0];
  }

  async snapshot(identity: RequestIdentity, snapshotId: string, version: number): Promise<PostgresRow | undefined> {
    const fundIds = identity.entitlements.fundIds ?? [];
    if (fundIds.length === 0 || !isUuid(snapshotId)) return undefined;
    // Only the current (highest) version of a snapshot may transition. A stale
    // expectedVersion would otherwise pass this preflight and then collide on
    // the (tenant_id, snapshot_id, version) primary key inside
    // append_snapshot_transition, surfacing a lost update as a 500.
    const rows = await this.db.query(`select * from corvis_serving.fund_period_snapshots s
      where s.tenant_id=$1 and s.snapshot_id=$2::uuid and s.version=$3
        and s.fund_id in (select jsonb_array_elements_text($4::jsonb))
        and not exists (
          select 1 from corvis_serving.fund_period_snapshots n
          where n.tenant_id=s.tenant_id and n.snapshot_id=s.snapshot_id and n.version>s.version
        )
      limit 1`, [identity.tenantId,snapshotId,version,jsonIds(fundIds)]);
    return rows[0];
  }

  async publicationCounts(tenantId: string, fundId: string): Promise<PostgresRow> {
    const rows = await this.db.query(`select
      count(*) filter (where review_state<>'approved') as needs_review_count,
      count(*) filter (where risk_tier='critical' and review_state='approved') as critical_count,
      count(*) filter (where source_reference_id is not null) as lineage_count,
      count(*) as total_count
      from corvis_facts.observation where tenant_id=$1 and fund_id=$2`, [tenantId,fundId]);
    return rows[0] ?? {};
  }

  async independentlyReviewedCriticalCount(tenantId: string, fundId: string): Promise<number> {
    const rows = await this.db.query(`select count(*) as independently_reviewed from (
      select o.observation_id
      from corvis_facts.observation o
      join corvis_facts.review_event r on r.tenant_id=o.tenant_id and r.observation_id=o.observation_id
      where o.tenant_id=$1 and o.fund_id=$2 and o.risk_tier='critical' and o.review_state='approved'
        and r.decision='approve'
        and r.observation_version > coalesce((
          select max(c.observation_version)
          from corvis_facts.review_event c
          where c.tenant_id=o.tenant_id and c.observation_id=o.observation_id and c.decision='correct'
        ),0)
      group by o.observation_id having count(distinct r.actor_subject)>=2
    ) reviewed`, [tenantId,fundId]);
    return Number(rows[0]?.independently_reviewed ?? 0);
  }

  async appendSnapshotTransition(identity: RequestIdentity, command: SnapshotPublication, eventId: string): Promise<boolean> {
    let rows: PostgresRow[];
    try {
      rows = await this.db.query(`select corvis_consolidated.append_snapshot_transition(
        $1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7) as new_version`,
      [identity.tenantId,command.snapshotId,command.expectedVersion,eventId,command.action,identity.subject,command.reason ?? null]);
    } catch (error) {
      // Two concurrent transitions of the same version both pass the row lock
      // in turn; the loser's insert of expectedVersion+1 hits the primary key.
      // That is an optimistic-concurrency conflict, not a server fault.
      if ((error as { code?: unknown } | null)?.code === "23505") return false;
      throw error;
    }
    return Number(rows[0]?.new_version ?? 0) === command.expectedVersion + 1;
  }
}

export class PostgresOperationsRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  audit(event: AuditEvent): Promise<void> {
    return this.db.execute(`insert into corvis_control.audit_event
      (tenant_id,audit_event_id,occurred_at,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
      values ($1,$2::uuid,$3::timestamptz,$4::uuid,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [event.tenantId,event.id,event.occurredAt,event.workspaceId,event.actorSubject,event.action,event.targetType,event.targetId ?? null,event.outcome,event.correlationId,JSON.stringify({ sessionId: event.sessionId, ...(event.metadata ?? {}) })]);
  }

  /** Without `page`, the legacy capped list (most recently updated first); with it, one keyset page by job id. */
  async jobs(identity: RequestIdentity, page?: KeysetPage): Promise<ProcessingJob[]> {
    const documentIds = identity.entitlements.documentIds ?? [];
    if (documentIds.length === 0) return [];
    const parameters: PostgresPrimitive[] = [identity.tenantId, jsonIds(documentIds)];
    const keyset = page ? sqlKeyset("j.job_id::text", page, parameters) : { where: "", tail: "order by j.updated_at desc limit 1000" };
    const rows = await this.db.query(`select j.*,
        retry.next_attempt_at,
        recovery.created_at as last_recovery_at,
        recovery.reason_code as last_recovery_reason_code
      from corvis_control.processing_job j
      left join lateral (
        select i.next_attempt_at
        from corvis_control.event_inbox i
        where i.tenant_id=j.tenant_id
          and i.consumer_name='processing-stage-worker'
          and i.aggregate_id=j.document_id::text
          and i.state='retryable'
        order by i.last_received_at desc,i.event_id desc
        limit 1
      ) retry on true
      left join lateral (
        select r.created_at,r.reason_code
        from corvis_control.processing_recovery_event r
        where r.tenant_id=j.tenant_id and r.job_id=j.job_id
        order by r.created_at desc,r.recovery_event_id desc
        limit 1
      ) recovery on true
      where j.tenant_id=$1
        and j.document_id::text in (select jsonb_array_elements_text($2::jsonb))${keyset.where}
      ${keyset.tail}`, parameters);
    const admin = hasPermission(identity,"admin:manage");
    return rows.map((row) => ({
      id: String(row.job_id ?? ""), documentId: String(row.document_id ?? ""), tenantId: identity.tenantId,
      stage: String(row.stage ?? "registered") as ProcessingJob["stage"], state: String(row.state ?? "queued") as ProcessingJob["state"],
      attempt: Number(row.attempt ?? 0), maxAttempts: Number(row.max_attempts ?? 0), correlationId: String(row.correlation_id ?? ""),
      version: Number(row.version ?? 1), createdAt: String(row.created_at ?? ""), updatedAt: String(row.updated_at ?? ""),
      blockedReason: row.blocked_reason == null ? undefined : String(row.blocked_reason),
      nextAttemptAt: row.next_attempt_at == null ? undefined : String(row.next_attempt_at),
      recoveryCount: Number(row.recovery_count ?? 0),
      lastRecoveryAt: row.last_recovery_at == null ? undefined : String(row.last_recovery_at),
      lastRecoveryReasonCode: row.last_recovery_reason_code == null ? undefined : String(row.last_recovery_reason_code),
      // Raw provider/worker errors are an operator diagnostic and may contain internal
      // implementation detail. Customer/read-only job status receives state only.
      lastError: admin && row.last_error != null ? String(row.last_error) : undefined,
    }));
  }

  async exportManifest(identity: RequestIdentity): Promise<{ snapshots: PostgresRow[]; observationCount: number }> {
    const fundIds = identity.entitlements.fundIds ?? [];
    const documentIds = identity.entitlements.documentIds ?? [];
    if (fundIds.length === 0 || documentIds.length === 0) return { snapshots: [], observationCount: 0 };
    const snapshots = await this.db.query(`select snapshot_id,schema_version,taxonomy_version
      from corvis_serving.fund_period_snapshots
      where tenant_id=$1 and status='published'
        and fund_id in (select jsonb_array_elements_text($2::jsonb))
      order by published_at desc`, [identity.tenantId, jsonIds(fundIds)]);
    const counts = await this.db.query(`select count(*) as row_count
      from corvis_serving.observations o
      join corvis_source.source_reference r
        on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
      where o.tenant_id=$1 and o.review_state='approved'
        and o.fund_id in (select jsonb_array_elements_text($2::jsonb))
        and r.document_id::text in (select jsonb_array_elements_text($3::jsonb))`,
    [identity.tenantId, jsonIds(fundIds), jsonIds(documentIds)]);
    return { snapshots, observationCount: Number(counts[0]?.row_count ?? 0) };
  }

  async enqueueExport(identity: RequestIdentity, manifest: ExportManifest): Promise<void> {
    await this.db.execute(`insert into corvis_serving.export_job
        (tenant_id,export_id,requested_by,format,snapshot_ids,state,checksum_sha256,manifest,created_at)
      values ($1,$2::uuid,$3,$4,array(select jsonb_array_elements_text($5::jsonb)::uuid),'queued',$6,$7::jsonb,now())`,
    [identity.tenantId,manifest.exportId,identity.subject,manifest.format,JSON.stringify(manifest.snapshotIds),manifest.checksumSha256,JSON.stringify(manifest)]);
    await this.db.execute(`insert into corvis_control.outbox_event
        (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
      values ($1,gen_random_uuid(),'ExportRequested','export',$2,$3::jsonb,now())`,
    [identity.tenantId,manifest.exportId,JSON.stringify(manifest)]);
  }
}