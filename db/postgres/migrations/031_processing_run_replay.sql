-- Corvis durable processing-run namespace and deterministic replay v1
-- Depends on migrations 001-030.
--
-- Primary processing retains the historical stage:<document> job IDs. Replay runs
-- receive an explicit run_key and carry it through every downstream stage so they
-- cannot collide with a previously completed primary journey.

begin;

alter table corvis_control.processing_job
  add column if not exists run_key text not null default 'primary';

-- Backfill any replay jobs created by migration 022 before this migration existed.
-- Their correlation ID already contains the stable correction-incident identity.
update corvis_control.processing_job
set run_key=correlation_id
where run_key='primary'
  and correlation_id like 'data-correction:%'
  and job_id like 'correction:%';

alter table corvis_control.processing_job
  drop constraint if exists processing_job_run_key_check;
alter table corvis_control.processing_job
  add constraint processing_job_run_key_check
  check (length(btrim(run_key)) between 1 and 160);

create index if not exists processing_job_run_stage_idx
  on corvis_control.processing_job
    (tenant_id,document_id,run_key,stage,created_at);

create or replace function corvis_control.processing_job_id(
  p_run_key text,
  p_stage text,
  p_document_id uuid
)
returns text
language sql
immutable
strict
security invoker
set search_path = pg_catalog
as $$
  select case
    when p_run_key='primary' then p_stage || ':' || p_document_id::text
    else p_run_key || ':' || p_stage || ':' || p_document_id::text
  end;
$$;

-- Preserve the processing run across the complete stage chain. The event payload
-- carries run identity explicitly so handlers never need to infer it from job_id.
create or replace function corvis_control.complete_processing_stage_delivery(
  p_tenant_id uuid,
  p_consumer_name text,
  p_event_id uuid,
  p_lease_token uuid,
  p_job_id text
)
returns table(
  completed boolean,
  completed_job_version integer,
  next_job_id text,
  next_stage text
)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  current_job corvis_control.processing_job%rowtype;
  computed_next_stage text;
  computed_next_job_id text;
  inserted_count integer := 0;
  completion_ok boolean;
begin
  select * into current_job
  from corvis_control.processing_job
  where tenant_id=p_tenant_id and job_id=p_job_id
  for update;

  if not found then return; end if;
  if current_job.state <> 'running' then return; end if;

  completion_ok := corvis_control.complete_event_delivery(
    p_tenant_id,p_consumer_name,p_event_id,p_lease_token
  );
  if completion_ok is not true then raise exception 'event lease no longer owns completion'; end if;

  computed_next_stage := case current_job.stage
    when 'registered' then 'represented'
    when 'represented' then 'extracted'
    when 'extracted' then 'reviewed'
    when 'reviewed' then 'canonicalized'
    when 'canonicalized' then 'reconciled'
    when 'reconciled' then 'consolidated'
    when 'consolidated' then 'published'
    else null
  end;

  update corvis_control.processing_job
  set state='succeeded',version=version+1,updated_at=now(),last_error=null
  where tenant_id=p_tenant_id and job_id=p_job_id
  returning * into current_job;

  if computed_next_stage is not null then
    computed_next_job_id := corvis_control.processing_job_id(
      current_job.run_key,computed_next_stage,current_job.document_id
    );

    insert into corvis_control.processing_job
      (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,
       version,created_at,updated_at,run_key)
    values (
      p_tenant_id,
      computed_next_job_id,
      current_job.document_id,
      computed_next_stage,
      'queued',
      0,
      current_job.max_attempts,
      current_job.correlation_id,
      1,
      now(),
      now(),
      current_job.run_key
    )
    on conflict (tenant_id,job_id) do nothing;
    get diagnostics inserted_count = row_count;

    if inserted_count = 1 then
      insert into corvis_control.outbox_event
        (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
      values (
        p_tenant_id,
        md5(p_tenant_id::text || ':' || computed_next_job_id || ':ready')::uuid,
        'ProcessingStageReady',
        'processing_job',
        computed_next_job_id,
        jsonb_build_object(
          'jobId',computed_next_job_id,
          'documentId',current_job.document_id,
          'stage',computed_next_stage,
          'correlationId',current_job.correlation_id,
          'processingRunKey',current_job.run_key,
          'predecessorJobId',p_job_id
        ),
        now()
      ) on conflict (tenant_id,event_id) do nothing;
    end if;
  end if;

  return query select true,current_job.version,computed_next_job_id,computed_next_stage;
end;
$$;

-- Replace the original correction replay starter. It now resolves one exact retained
-- source artifact, creates a namespaced registered job, and gives the registered
-- handler the immutable artifact/ingestion identity it already requires. The root
-- delivery is a DocumentRegistered event (not ProcessingStageReady) because there is
-- intentionally no predecessor effect at the beginning of a processing journey.
create or replace function corvis_control.request_data_correction_replay(
  p_tenant_id uuid,
  p_incident_id uuid,
  p_requested_by text
)
returns text
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_source, corvis_consolidated, corvis_facts
as $$
declare
  current_row corvis_control.data_correction_incident%rowtype;
  replay_run_key text;
  computed_job_id text;
  computed_event_id uuid;
  artifact_count integer := 0;
  artifact_ids uuid[];
  artifact_ingestion_ids text[];
  artifact_id uuid;
  artifact_ingestion_id text;
  existing_job corvis_control.processing_job%rowtype;
begin
  select * into current_row
  from corvis_control.data_correction_incident
  where tenant_id=p_tenant_id and incident_id=p_incident_id
  for update;
  if not found then return null; end if;
  if current_row.state not in ('open','reprocessing') then
    raise exception 'correction incident is not replayable';
  end if;
  if current_row.document_id is null then
    raise exception 'correction incident has no retained source document to replay';
  end if;

  -- Prefer the exact source artifact(s) that contributed to the incident snapshot.
  -- If the incident predates a snapshot, permit replay only when the document has
  -- exactly one clean/released retained artifact. Ambiguity fails closed.
  if current_row.snapshot_id is not null and current_row.snapshot_version is not null then
    select count(*)::integer,
           array_agg(c.document_artifact_version_id order by c.document_artifact_version_id),
           array_agg(c.ingestion_id order by c.document_artifact_version_id)
      into artifact_count,artifact_ids,artifact_ingestion_ids
    from (
      select distinct dav.document_artifact_version_id,dav.ingestion_id
      from corvis_consolidated.fund_period_snapshot s
      cross join lateral unnest(s.fact_ids) snapshot_fact_id
      join corvis_consolidated.consolidated_fact cf
        on cf.tenant_id=s.tenant_id and cf.consolidated_fact_id=snapshot_fact_id
      cross join lateral unnest(cf.source_observation_ids) source_observation_id
      join corvis_facts.observation_source_reference osr
        on osr.tenant_id=cf.tenant_id and osr.observation_id=source_observation_id
      join corvis_source.source_reference sr
        on sr.tenant_id=osr.tenant_id and sr.source_reference_id=osr.source_reference_id
      join corvis_source.document_artifact_version dav
        on dav.tenant_id=sr.tenant_id
       and dav.document_artifact_version_id=sr.document_artifact_version_id
      where s.tenant_id=p_tenant_id
        and s.snapshot_id=current_row.snapshot_id
        and s.version=current_row.snapshot_version
        and sr.document_id=current_row.document_id
        and dav.document_id=current_row.document_id
        and dav.malware_scan_status='clean'
        and dav.quarantine_status='released'
    ) c;
  else
    select count(*)::integer,
           array_agg(c.document_artifact_version_id order by c.document_artifact_version_id),
           array_agg(c.ingestion_id order by c.document_artifact_version_id)
      into artifact_count,artifact_ids,artifact_ingestion_ids
    from (
      select dav.document_artifact_version_id,dav.ingestion_id
      from corvis_source.document_artifact_version dav
      where dav.tenant_id=p_tenant_id
        and dav.document_id=current_row.document_id
        and dav.malware_scan_status='clean'
        and dav.quarantine_status='released'
    ) c;
  end if;

  if artifact_count <> 1 then
    raise exception 'correction replay requires exactly one retained clean source artifact; found %', artifact_count;
  end if;
  artifact_id := artifact_ids[1];
  artifact_ingestion_id := artifact_ingestion_ids[1];
  if artifact_id is null or artifact_ingestion_id is null or btrim(artifact_ingestion_id)='' then
    raise exception 'correction replay source artifact identity is incomplete';
  end if;

  replay_run_key := 'data-correction:' || p_incident_id::text;
  computed_job_id := corvis_control.processing_job_id(
    replay_run_key,'registered',current_row.document_id
  );

  insert into corvis_control.processing_job
    (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,
     version,created_at,updated_at,run_key)
  values (
    p_tenant_id,computed_job_id,current_row.document_id,'registered','queued',0,5,
    replay_run_key,1,now(),now(),replay_run_key
  ) on conflict (tenant_id,job_id) do nothing;

  select * into existing_job
  from corvis_control.processing_job
  where tenant_id=p_tenant_id and job_id=computed_job_id;
  if not found
    or existing_job.document_id <> current_row.document_id
    or existing_job.stage <> 'registered'
    or existing_job.run_key <> replay_run_key then
    raise exception 'correction replay job identity conflicts with existing durable state';
  end if;

  computed_event_id := md5(p_tenant_id::text || ':' || computed_job_id || ':document-registered-replay')::uuid;
  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,computed_event_id,'DocumentRegistered','document',current_row.document_id::text,
    jsonb_build_object(
      'jobId',computed_job_id,
      'documentId',current_row.document_id,
      'stage','registered',
      'correlationId',replay_run_key,
      'processingRunKey',replay_run_key,
      'artifactVersionId',artifact_id,
      'ingestionId',artifact_ingestion_id,
      'correctionIncidentId',p_incident_id,
      'requestedBy',p_requested_by
    ),now()
  ) on conflict (tenant_id,event_id) do nothing;

  update corvis_control.data_correction_incident
  set state='reprocessing', replay_job_id=computed_job_id
  where tenant_id=p_tenant_id and incident_id=p_incident_id;

  return computed_job_id;
end;
$$;

commit;
