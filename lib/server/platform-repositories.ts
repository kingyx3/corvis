import type {
  AuditEvent,
  ExportManifest,
  ProcessingJob,
  ReconciliationResolutionCommand,
  RequestIdentity,
  ReviewDecision,
  SnapshotPublication,
} from "../../core/enterprise.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

function jsonIds(values: string[] | undefined): string { return JSON.stringify(values ?? []); }

export class PostgresWorkspaceRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  listDocuments(identity: RequestIdentity): Promise<PostgresRow[]> {
    const documentIds = identity.entitlements.documentIds ?? [];
    if (documentIds.length === 0) return Promise.resolve([]);
    return this.db.query(`select * from corvis_serving.documents
      where tenant_id=$1
        and document_id::text in (select jsonb_array_elements_text($2::jsonb))
      order by created_at desc limit 1000`, [identity.tenantId, jsonIds(documentIds)]);
  }

  listObservations(identity: RequestIdentity): Promise<PostgresRow[]> {
    const fundIds = identity.entitlements.fundIds ?? [];
    const documentIds = identity.entitlements.documentIds ?? [];
    if (fundIds.length === 0 || documentIds.length === 0) return Promise.resolve([]);
    return this.db.query(`select o.*
      from corvis_serving.observations o
      join corvis_source.source_reference r
        on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
      where o.tenant_id=$1
        and o.fund_id in (select jsonb_array_elements_text($2::jsonb))
        and r.document_id::text in (select jsonb_array_elements_text($3::jsonb))
      order by o.updated_at desc limit 5000`, [identity.tenantId, jsonIds(fundIds), jsonIds(documentIds)]);
  }

  listSnapshots(identity: RequestIdentity): Promise<PostgresRow[]> {
    const fundIds = identity.entitlements.fundIds ?? [];
    if (fundIds.length === 0) return Promise.resolve([]);
    return this.db.query(`select s.*,
        (select count(*) from corvis_facts.holding h where h.tenant_id=s.tenant_id and h.fund_id=s.fund_id) as holding_count
      from corvis_serving.fund_period_snapshots s
      where s.tenant_id=$1
        and s.fund_id in (select jsonb_array_elements_text($2::jsonb))
      order by s.created_at desc limit 1000`, [identity.tenantId, jsonIds(fundIds)]);
  }
}

export class PostgresReviewPublicationRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  async observation(identity: RequestIdentity, observationId: string): Promise<PostgresRow | undefined> {
    const fundIds = identity.entitlements.fundIds ?? [];
    const documentIds = identity.entitlements.documentIds ?? [];
    if (fundIds.length === 0 || documentIds.length === 0) return undefined;
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
    if (fundIds.length === 0) return [];
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
    if (fundIds.length === 0) return undefined;
    const selectingSource = command.action === "select_source";
    const sourceDocumentIds = identity.entitlements.sourceDocumentAccessAllowed
      ? identity.entitlements.sourceDocumentIds ?? []
      : [];
    if (selectingSource && (!command.selectedSourceReferenceId || sourceDocumentIds.length === 0)) return undefined;
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
    if (fundIds.length === 0) return undefined;
    const rows = await this.db.query(`select * from corvis_serving.fund_period_snapshots
      where tenant_id=$1 and snapshot_id=$2::uuid and version=$3
        and fund_id in (select jsonb_array_elements_text($4::jsonb))
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
    const rows = await this.db.query(`select corvis_consolidated.append_snapshot_transition(
      $1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7) as new_version`,
    [identity.tenantId,command.snapshotId,command.expectedVersion,eventId,command.action,identity.subject,command.reason ?? null]);
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

  async jobs(identity: RequestIdentity): Promise<ProcessingJob[]> {
    const documentIds = identity.entitlements.documentIds ?? [];
    if (documentIds.length === 0) return [];
    const rows = await this.db.query(`select * from corvis_control.processing_job
      where tenant_id=$1
        and document_id::text in (select jsonb_array_elements_text($2::jsonb))
      order by updated_at desc limit 1000`, [identity.tenantId, jsonIds(documentIds)]);
    return rows.map((row) => ({
      id: String(row.job_id ?? ""), documentId: String(row.document_id ?? ""), tenantId: identity.tenantId,
      stage: String(row.stage ?? "registered") as ProcessingJob["stage"], state: String(row.state ?? "queued") as ProcessingJob["state"],
      attempt: Number(row.attempt ?? 0), maxAttempts: Number(row.max_attempts ?? 0), correlationId: String(row.correlation_id ?? ""),
      version: Number(row.version ?? 1), createdAt: String(row.created_at ?? ""), updatedAt: String(row.updated_at ?? ""),
      lastError: row.last_error == null ? undefined : String(row.last_error),
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
