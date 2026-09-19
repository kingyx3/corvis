import type { AuditEvent, ExportManifest, ProcessingJob, RequestIdentity, ReviewDecision, SnapshotPublication } from "../../core/enterprise.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

export class PostgresWorkspaceRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  listDocuments(tenantId: string): Promise<PostgresRow[]> {
    return this.db.query(`select * from corvis_serving.documents where tenant_id=$1 order by created_at desc limit 1000`, [tenantId]);
  }

  listObservations(tenantId: string): Promise<PostgresRow[]> {
    return this.db.query(`select * from corvis_serving.observations where tenant_id=$1 order by updated_at desc limit 5000`, [tenantId]);
  }

  listSnapshots(tenantId: string): Promise<PostgresRow[]> {
    return this.db.query(`select s.*,
        (select count(*) from corvis_facts.holding h where h.tenant_id=s.tenant_id and h.fund_id=s.fund_id) as holding_count
      from corvis_serving.fund_period_snapshots s
      where s.tenant_id=$1
      order by s.created_at desc limit 1000`, [tenantId]);
  }
}

export class PostgresReviewPublicationRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  async observation(tenantId: string, observationId: string): Promise<PostgresRow | undefined> {
    const rows = await this.db.query(`select observation_id,version,review_state,value_number,value_string,risk_tier
      from corvis_facts.observation where tenant_id=$1 and observation_id=$2::uuid limit 1`, [tenantId, observationId]);
    return rows[0];
  }

  async applyReview(identity: RequestIdentity, decision: ReviewDecision, reviewEventId: string): Promise<boolean> {
    const rows = await this.db.query(`select * from corvis_facts.apply_review_decision(
      $1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8)`,
    [identity.tenantId,decision.observationId,decision.expectedVersion,reviewEventId,identity.subject,decision.decision,decision.reasonCode,decision.correctedValue ?? null]);
    return Number(rows[0]?.new_version ?? 0) === decision.expectedVersion + 1;
  }

  async snapshot(tenantId: string, snapshotId: string, version: number): Promise<PostgresRow | undefined> {
    const rows = await this.db.query(`select * from corvis_consolidated.fund_period_snapshot
      where tenant_id=$1 and snapshot_id=$2::uuid and version=$3 limit 1`, [tenantId,snapshotId,version]);
    return rows[0];
  }

  async publicationCounts(tenantId: string, fundId: string): Promise<PostgresRow> {
    const rows = await this.db.query(`select
      count(*) filter (where review_state='review_required') as needs_review_count,
      count(*) filter (where risk_tier='critical') as critical_count,
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
      where o.tenant_id=$1 and o.fund_id=$2 and o.risk_tier='critical' and r.decision='approve'
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
    const rows = await this.db.query(`select * from corvis_control.processing_job
      where tenant_id=$1 order by updated_at desc limit 1000`, [identity.tenantId]);
    return rows.map((row) => ({
      id: String(row.job_id ?? ""), documentId: String(row.document_id ?? ""), tenantId: identity.tenantId,
      stage: String(row.stage ?? "registered") as ProcessingJob["stage"], state: String(row.state ?? "queued") as ProcessingJob["state"],
      attempt: Number(row.attempt ?? 0), maxAttempts: Number(row.max_attempts ?? 0), correlationId: String(row.correlation_id ?? ""),
      version: Number(row.version ?? 1), createdAt: String(row.created_at ?? ""), updatedAt: String(row.updated_at ?? ""),
      lastError: row.last_error == null ? undefined : String(row.last_error),
    }));
  }

  async exportManifest(identity: RequestIdentity): Promise<{ snapshots: PostgresRow[]; observationCount: number }> {
    const snapshots = await this.db.query(`select snapshot_id,schema_version,taxonomy_version
      from corvis_serving.fund_period_snapshots where tenant_id=$1 and status='published'
      order by published_at desc`, [identity.tenantId]);
    const counts = await this.db.query(`select count(*) as row_count from corvis_serving.observations
      where tenant_id=$1 and review_state='approved'`, [identity.tenantId]);
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
