-- Governed data-quality correction, replay and republication control v1.
-- Depends on migrations 001-021. Original observations/snapshots remain immutable.
begin;

create table if not exists corvis_control.data_correction_incident (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  incident_id uuid primary key,
  idempotency_key text not null check (length(idempotency_key) between 1 and 256),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  fund_id text not null,
  report_period text not null,
  metric_code text,
  snapshot_id uuid,
  snapshot_version integer check (snapshot_version is null or snapshot_version > 0),
  document_id uuid,
  state text not null check (state in ('open','reprocessing','resolved','cancelled')),
  root_cause text not null,
  correction_intent text not null,
  opened_by text not null,
  opened_at timestamptz not null default now(),
  replay_job_id text,
  replacement_snapshot_id uuid,
  replacement_snapshot_version integer,
  resolved_by text,
  resolved_at timestamptz,
  resolution_evidence jsonb,
  unique (tenant_id, incident_id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, document_id) references corvis_source.document(tenant_id, document_id)
);

alter table corvis_control.data_correction_incident enable row level security;
alter table corvis_control.data_correction_incident force row level security;
create policy data_correction_incident_tenant_select on corvis_control.data_correction_incident
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists data_correction_open_scope_idx
  on corvis_control.data_correction_incident (tenant_id, fund_id, report_period, opened_at desc)
  where state in ('open','reprocessing');

create or replace function corvis_control.open_data_correction_incident(
  p_tenant_id uuid,
  p_incident_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_fund_id text,
  p_report_period text,
  p_metric_code text,
  p_snapshot_id uuid,
  p_snapshot_version integer,
  p_document_id uuid,
  p_root_cause text,
  p_correction_intent text,
  p_opened_by text
)
returns table(incident_id uuid, state text)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_source
as $$
declare
  existing corvis_control.data_correction_incident%rowtype;
begin
  select * into existing
  from corvis_control.data_correction_incident
  where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key
  for update;

  if found then
    if existing.request_hash <> p_request_hash then
      raise exception 'idempotency key reused with different correction scope';
    end if;
    return query select existing.incident_id, existing.state;
    return;
  end if;

  insert into corvis_control.data_correction_incident
    (tenant_id,incident_id,idempotency_key,request_hash,fund_id,report_period,metric_code,snapshot_id,snapshot_version,
     document_id,state,root_cause,correction_intent,opened_by)
  values
    (p_tenant_id,p_incident_id,p_idempotency_key,p_request_hash,p_fund_id,p_report_period,p_metric_code,p_snapshot_id,
     p_snapshot_version,p_document_id,'open',p_root_cause,p_correction_intent,p_opened_by);

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,
    md5(p_tenant_id::text || ':' || p_incident_id::text || ':opened')::uuid,
    'DataCorrectionOpened','data_correction',p_incident_id::text,
    jsonb_build_object('incidentId',p_incident_id,'fundId',p_fund_id,'reportPeriod',p_report_period,
      'snapshotId',p_snapshot_id,'snapshotVersion',p_snapshot_version,'documentId',p_document_id),now()
  ) on conflict (tenant_id,event_id) do nothing;

  return query select p_incident_id, 'open'::text;
end;
$$;

create or replace function corvis_control.request_data_correction_replay(
  p_tenant_id uuid,
  p_incident_id uuid,
  p_requested_by text
)
returns text
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_source
as $$
declare
  current_row corvis_control.data_correction_incident%rowtype;
  computed_job_id text;
  computed_event_id uuid;
begin
  select * into current_row from corvis_control.data_correction_incident
  where tenant_id=p_tenant_id and incident_id=p_incident_id for update;
  if not found then return null; end if;
  if current_row.state not in ('open','reprocessing') then raise exception 'correction incident is not replayable'; end if;
  if current_row.document_id is null then raise exception 'correction incident has no retained source document to replay'; end if;

  computed_job_id := 'correction:' || p_incident_id::text || ':registered';
  insert into corvis_control.processing_job
    (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version,created_at,updated_at)
  values (p_tenant_id,computed_job_id,current_row.document_id,'registered','queued',0,5,
    'data-correction:' || p_incident_id::text,1,now(),now())
  on conflict (tenant_id,job_id) do nothing;

  computed_event_id := md5(p_tenant_id::text || ':' || computed_job_id || ':ready')::uuid;
  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,computed_event_id,'ProcessingStageReady','processing_job',computed_job_id,
    jsonb_build_object('jobId',computed_job_id,'documentId',current_row.document_id,'stage','registered',
      'correctionIncidentId',p_incident_id,'requestedBy',p_requested_by),now()
  ) on conflict (tenant_id,event_id) do nothing;

  update corvis_control.data_correction_incident
  set state='reprocessing', replay_job_id=computed_job_id
  where tenant_id=p_tenant_id and incident_id=p_incident_id;
  return computed_job_id;
end;
$$;

create or replace function corvis_control.resolve_data_correction_incident(
  p_tenant_id uuid,
  p_incident_id uuid,
  p_replacement_snapshot_id uuid,
  p_replacement_snapshot_version integer,
  p_resolved_by text,
  p_resolution_evidence jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_consolidated
as $$
declare
  current_row corvis_control.data_correction_incident%rowtype;
  replacement corvis_consolidated.fund_period_snapshot%rowtype;
begin
  select * into current_row from corvis_control.data_correction_incident
  where tenant_id=p_tenant_id and incident_id=p_incident_id for update;
  if not found then return false; end if;
  if current_row.state not in ('open','reprocessing') then raise exception 'correction incident is not resolvable'; end if;

  select * into replacement from corvis_consolidated.fund_period_snapshot
  where tenant_id=p_tenant_id and snapshot_id=p_replacement_snapshot_id
    and version=p_replacement_snapshot_version and status='published';
  if not found then raise exception 'replacement snapshot must already be published'; end if;
  if replacement.fund_id <> current_row.fund_id or replacement.report_period <> current_row.report_period then
    raise exception 'replacement snapshot scope does not match correction incident';
  end if;

  update corvis_control.data_correction_incident
  set state='resolved',replacement_snapshot_id=p_replacement_snapshot_id,
      replacement_snapshot_version=p_replacement_snapshot_version,resolved_by=p_resolved_by,resolved_at=now(),
      resolution_evidence=coalesce(p_resolution_evidence,'{}'::jsonb)
  where tenant_id=p_tenant_id and incident_id=p_incident_id;

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,md5(p_tenant_id::text || ':' || p_incident_id::text || ':resolved')::uuid,
    'DataCorrectionResolved','data_correction',p_incident_id::text,
    jsonb_build_object('incidentId',p_incident_id,'supersededSnapshotId',current_row.snapshot_id,
      'supersededSnapshotVersion',current_row.snapshot_version,'replacementSnapshotId',p_replacement_snapshot_id,
      'replacementSnapshotVersion',p_replacement_snapshot_version,'resolvedBy',p_resolved_by),now()
  ) on conflict (tenant_id,event_id) do nothing;

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,md5(p_tenant_id::text || ':' || p_incident_id::text || ':replacement-delivery')::uuid,
    'CorrectionReplacementDeliveryRequested','data_correction',p_incident_id::text,
    jsonb_build_object('incidentId',p_incident_id,'supersededSnapshotId',current_row.snapshot_id,
      'replacementSnapshotId',p_replacement_snapshot_id,'replacementSnapshotVersion',p_replacement_snapshot_version),now()
  ) on conflict (tenant_id,event_id) do nothing;
  return true;
end;
$$;

-- Persistence is authoritative: an active material correction blocks a fresh publish even
-- if an application caller accidentally omits the corresponding preflight check.
create or replace function corvis_consolidated.append_snapshot_transition(
  p_tenant_id uuid,
  p_snapshot_id uuid,
  p_expected_version integer,
  p_publication_event_id uuid,
  p_action text,
  p_actor_subject text,
  p_reason text default null
)
returns integer
language plpgsql
security invoker
as $$
declare
  current_row corvis_consolidated.fund_period_snapshot%rowtype;
  next_status text;
  next_version integer;
begin
  select * into current_row
  from corvis_consolidated.fund_period_snapshot
  where tenant_id=p_tenant_id and snapshot_id=p_snapshot_id and version=p_expected_version
  for update;
  if not found then return null; end if;
  if p_action not in ('publish','withdraw','supersede') then raise exception 'invalid publication action'; end if;
  if p_action='publish' and exists (
    select 1 from corvis_control.data_correction_incident c
    where c.tenant_id=p_tenant_id and c.fund_id=current_row.fund_id and c.report_period=current_row.report_period
      and c.state in ('open','reprocessing')
  ) then raise exception 'active data correction incident blocks publication'; end if;

  next_status := case p_action when 'publish' then 'published' when 'withdraw' then 'withdrawn' else 'superseded' end;
  next_version := p_expected_version + 1;
  insert into corvis_consolidated.fund_period_snapshot
    (tenant_id,snapshot_id,fund_id,report_period,version,status,fact_ids,blocking_exception_count,schema_version,taxonomy_version,created_at,published_at)
  values (current_row.tenant_id,current_row.snapshot_id,current_row.fund_id,current_row.report_period,next_version,next_status,
    current_row.fact_ids,current_row.blocking_exception_count,current_row.schema_version,current_row.taxonomy_version,now(),
    case when next_status='published' then now() else current_row.published_at end);
  insert into corvis_consolidated.snapshot_publication_event
    (tenant_id,publication_event_id,snapshot_id,from_version,to_version,action,actor_subject,reason)
  values (p_tenant_id,p_publication_event_id,p_snapshot_id,p_expected_version,next_version,p_action,p_actor_subject,p_reason);
  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (p_tenant_id,gen_random_uuid(),'SnapshotPublicationChanged','fund_period_snapshot',p_snapshot_id::text,
    jsonb_build_object('action',p_action,'actor',p_actor_subject,'reason',p_reason,'version',next_version),now());
  return next_version;
end;
$$;

commit;
