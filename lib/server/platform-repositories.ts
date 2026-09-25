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
import { SECTOR_TAXONOMY_VERSION } from "../../core/sector-taxonomy.ts";
import { MIXED_INSTRUMENT_TYPES } from "../../core/workspace-summary.ts";
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

  /**
   * Portfolio-value rollup for the Overview (issue #175 A3/A4): for each
   * snapshot whose *current* version is published, the summed nav/fair_value
   * consolidated facts per metric, subject level and currency. Draft,
   * blocked, withdrawn and superseded versions never contribute. Three kinds
   * of fact are left out because they re-slice value already counted: a
   * conflicting alternative (a second value at one semantic grain), a
   * breakdown row (e.g. fair value by sector) and a look-through row. The
   * caller keeps only the most aggregate subject level per snapshot.
   */
  portfolioValueFacts(identity: RequestIdentity): Promise<PostgresRow[]> {
    const fundIds = identity.entitlements.fundIds ?? [];
    if (fundIds.length === 0) return Promise.resolve([]);
    return this.db.query(`${PUBLISHED_VALUE_FACTS}
      select pf.snapshot_id, pf.fund_id, coalesce(fund.canonical_name, pf.fund_id) as fund_name,
             pf.report_period, pf.published_at, pf.metric_code, pf.subject_level, pf.currency,
             sum(pf.amount) as total_value, count(*)::integer as fact_count
      from published_fact pf
      left join corvis_identity.fund fund on fund.global_fund_id=pf.fund_id
      where pf.breakdown_category is null and pf.lookthrough_source is null
      group by pf.snapshot_id, pf.fund_id, fund.canonical_name, pf.report_period, pf.published_at, pf.metric_code, pf.subject_level, pf.currency
      order by pf.fund_id, pf.report_period, pf.snapshot_id`, [identity.tenantId, jsonIds(fundIds)]);
  }

  /**
   * Exposure-dimension rollup (issue #175 A4) over the same published facts:
   * - asset_type: holding/instrument fair values classified by the governed
   *   instrument_type of approved instruments (a holding whose instruments
   *   span several types is reported as mixed, never picked arbitrarily);
   * - sector: holding/instrument fair values classified by the tenant's
   *   current governed sector for the held company
   *   (corvis_serving.company_sectors, migration 055), plus the GP's own
   *   fund-level sector/industry breakdown rows mapped onto the same
   *   taxonomy through corvis_semantic.sector_alias. An unmapped GP label or
   *   an unclassified company yields a null category (unclassified), never a
   *   guess. The caller uses one subject level per snapshot, preferring the
   *   governed holding level, so the two sector sources never add up.
   * Look-through rows are excluded from both.
   */
  exposureDimensionFacts(identity: RequestIdentity): Promise<PostgresRow[]> {
    const fundIds = identity.entitlements.fundIds ?? [];
    if (fundIds.length === 0) return Promise.resolve([]);
    return this.db.query(`${PUBLISHED_VALUE_FACTS}, holding_type as (
        select i.holding_id::text as holding_id,
               case when count(distinct i.instrument_type)=1 then min(i.instrument_type) else '${MIXED_INSTRUMENT_TYPES}' end as instrument_type
        from corvis_serving.instruments i
        where i.tenant_id=$1::uuid
          and i.fund_id in (select jsonb_array_elements_text($2::jsonb))
        group by i.holding_id
      ), classified as (
        select pf.snapshot_id, pf.fund_id, pf.currency, 'asset_type' as dimension, pf.subject_level,
               case when pf.subject_level='instrument' then inst.instrument_type else ht.instrument_type end as category,
               null::text as label, pf.amount
        from published_fact pf
        left join corvis_serving.instruments inst
          on pf.subject_level='instrument' and inst.tenant_id=$1::uuid and inst.instrument_id::text=pf.subject_id
        left join holding_type ht
          on pf.subject_level='holding' and ht.holding_id=pf.subject_id
        where pf.metric_code='fair_value'
          and pf.subject_level in ('holding','instrument')
          and pf.breakdown_category is null and pf.lookthrough_source is null
        union all
        select pf.snapshot_id, pf.fund_id, pf.currency, 'sector' as dimension, pf.subject_level,
               cs.sector_code as category, cs.sector_name as label, pf.amount
        from published_fact pf
        left join corvis_serving.holdings h
          on pf.subject_level='holding' and h.tenant_id=$1::uuid and h.holding_id::text=pf.subject_id
        left join corvis_serving.instruments held
          on pf.subject_level='instrument' and held.tenant_id=$1::uuid and held.instrument_id::text=pf.subject_id
        left join corvis_serving.company_sectors cs
          on cs.tenant_id=$1::uuid
         and cs.company_id=case when pf.subject_level='holding' and h.target_type='company' then h.target_company_id else held.company_id end
        where pf.metric_code='fair_value'
          and pf.subject_level in ('holding','instrument')
          and pf.breakdown_category is null and pf.lookthrough_source is null
        union all
        select pf.snapshot_id, pf.fund_id, pf.currency, 'sector' as dimension, pf.subject_level,
               sector.sector_code as category, sector.display_name as label, pf.amount
        from published_fact pf
        left join corvis_semantic.sector_alias alias
          on alias.taxonomy_version='${SECTOR_TAXONOMY_VERSION}'
         and alias.alias_normalized=corvis_semantic.normalize_sector_label(pf.breakdown_value)
        left join corvis_semantic.sector sector
          on sector.taxonomy_version=alias.taxonomy_version and sector.sector_code=alias.sector_code
        where pf.metric_code='fair_value'
          and pf.subject_level='fund'
          and lower(pf.breakdown_category) in ('sector','industry')
          and pf.lookthrough_source is null
      )
      select snapshot_id, fund_id, currency, dimension, subject_level, category, label,
             sum(amount) as total_value, count(*)::integer as fact_count
      from classified
      group by snapshot_id, fund_id, currency, dimension, subject_level, category, label
      order by fund_id, snapshot_id, dimension, category`, [identity.tenantId, jsonIds(fundIds)]);
  }
}

/**
 * Nav/fair_value consolidated facts of every entitled snapshot whose current
 * version is published, with the semantic dimensions the Overview rollups
 * filter and group on. Conflicting alternatives are dropped here, once.
 * Parameters: $1 tenant id, $2 JSON array of entitled fund ids.
 */
const PUBLISHED_VALUE_FACTS = `with current_snapshot as (
        select distinct on (s.snapshot_id)
               s.tenant_id, s.snapshot_id, s.version, s.fund_id, s.report_period, s.status, s.fact_ids, s.published_at
        from corvis_consolidated.fund_period_snapshot s
        where s.tenant_id=$1::uuid
          and s.fund_id in (select jsonb_array_elements_text($2::jsonb))
        order by s.snapshot_id, s.version desc
      ), published_fact as (
        select cs.snapshot_id, cs.fund_id, cs.report_period, cs.published_at, f.metric_code, f.subject_id,
               coalesce(nullif(btrim(f.value->'semanticDimensions'->>'subjectLevel'),''), f.subject_type) as subject_level,
               nullif(btrim(f.value->'semanticDimensions'->>'breakdownCategory'),'') as breakdown_category,
               nullif(btrim(f.value->'semanticDimensions'->>'breakdownValue'),'') as breakdown_value,
               nullif(btrim(f.value->'semanticDimensions'->>'lookthroughSource'),'') as lookthrough_source,
               f.value->>'currency' as currency,
               (f.value->>'number')::numeric as amount
        from current_snapshot cs
        cross join lateral unnest(cs.fact_ids) as published(fact_id)
        join corvis_consolidated.consolidated_fact f
          on f.tenant_id=cs.tenant_id and f.consolidated_fact_id=published.fact_id and f.fund_id=cs.fund_id
        where cs.status='published'
          and f.metric_code in ('nav','fair_value')
          and jsonb_typeof(f.value->'number')='number'
          and coalesce(f.value->>'semanticGrainRelationship','')<>'conflicting_alternative'
      )`;

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