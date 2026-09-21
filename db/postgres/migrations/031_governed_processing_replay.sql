-- Corvis governed processing replay scope v1
-- Depends on migrations 001-030.
--
-- A correction replay must never reset/delete the original durable processing trail.
-- This migration gives correction journeys independent job identities while reusing
-- the same stage/effect contracts and immutable retained source evidence.

begin;

create or replace function corvis_control.scoped_processing_job_id(
  p_correlation_id text,
  p_stage text,
  p_document_id uuid
)
returns text
language sql
immutable
security invoker
as $$
  select case
    when coalesce(p_correlation_id,'') like 'data-correction:%'
      then 'correction:' || substring(p_correlation_id from length('data-correction:') + 1)
        || ':' || p_stage || ':' || p_document_id::text
    else p_stage || ':' || p_document_id::text
  end
$$;

create or replace function corvis_control.processing_job_for_effect_key(
  p_tenant_id uuid,
  p_document_id uuid,
  p_stage text,
  p_effect_key text
)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select e.job_id
  from corvis_control.processing_stage_effect e
  join corvis_control.processing_job j
    on j.tenant_id=e.tenant_id and j.job_id=e.job_id
  where e.tenant_id=p_tenant_id
    and e.document_id=p_document_id
    and e.stage=p_stage
    and e.effect_key=p_effect_key
    and j.document_id=p_document_id
    and j.stage=p_stage
  order by e.last_started_at desc,e.job_id
  limit 1
$$;

create or replace function corvis_control.processing_predecessor_job_for_job(
  p_tenant_id uuid,
  p_job_id text,
  p_expected_predecessor_stage text
)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select predecessor.job_id
  from corvis_control.processing_job current_job
  join corvis_control.processing_job predecessor
    on predecessor.tenant_id=current_job.tenant_id
   and predecessor.document_id=current_job.document_id
   and predecessor.correlation_id=current_job.correlation_id
   and predecessor.stage=p_expected_predecessor_stage
   and predecessor.state='succeeded'
  where current_job.tenant_id=p_tenant_id and current_job.job_id=p_job_id
  order by predecessor.updated_at desc,predecessor.job_id
  limit 1
$$;

create or replace function corvis_control.processing_predecessor_job_for_effect(
  p_tenant_id uuid,
  p_document_id uuid,
  p_current_stage text,
  p_effect_key text,
  p_expected_predecessor_stage text
)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select corvis_control.processing_predecessor_job_for_job(
    p_tenant_id,
    corvis_control.processing_job_for_effect_key(p_tenant_id,p_document_id,p_current_stage,p_effect_key),
    p_expected_predecessor_stage
  )
$$;

create or replace function corvis_control.processing_replay_scope_for_effect(
  p_tenant_id uuid,
  p_document_id uuid,
  p_stage text,
  p_effect_key text
)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select case
    when coalesce(j.correlation_id,'') like 'data-correction:%' then ':' || j.correlation_id
    else ''
  end
  from corvis_control.processing_stage_effect e
  join corvis_control.processing_job j
    on j.tenant_id=e.tenant_id and j.job_id=e.job_id
  where e.tenant_id=p_tenant_id
    and e.document_id=p_document_id
    and e.stage=p_stage
    and e.effect_key=p_effect_key
  order by e.last_started_at desc
  limit 1
$$;

-- Preserve primary journey IDs exactly, but namespace every correction replay stage
-- under the correction incident correlation. This keeps old job/effect rows immutable
-- and makes downstream outbox/event IDs naturally independent as well.
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
    computed_next_job_id := corvis_control.scoped_processing_job_id(
      current_job.correlation_id,computed_next_stage,current_job.document_id
    );

    insert into corvis_control.processing_job
      (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version,created_at,updated_at)
    values (
      p_tenant_id,computed_next_job_id,current_job.document_id,computed_next_stage,
      'queued',0,current_job.max_attempts,current_job.correlation_id,1,now(),now()
    )
    on conflict (tenant_id,job_id) do nothing;
    get diagnostics inserted_count = row_count;

    if inserted_count = 1 then
      insert into corvis_control.outbox_event
        (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
      values (
        p_tenant_id,
        md5(p_tenant_id::text || ':' || computed_next_job_id || ':ready')::uuid,
        'ProcessingStageReady','processing_job',computed_next_job_id,
        jsonb_build_object(
          'jobId',computed_next_job_id,
          'documentId',current_job.document_id,
          'stage',computed_next_stage,
          'correlationId',current_job.correlation_id,
          'predecessorJobId',p_job_id
        ),now()
      ) on conflict (tenant_id,event_id) do nothing;
    end if;
  end if;

  return query select true,current_job.version,computed_next_job_id,computed_next_stage;
end;
$$;

-- Replays start from the exact retained artifact lineage represented in the affected
-- published snapshot. Ambiguous/missing artifact lineage fails closed rather than
-- guessing a document version. The replacement snapshot identity is reserved up
-- front so only this incident's replacement can bypass its own publication block.
create or replace function corvis_control.request_data_correction_replay(
  p_tenant_id uuid,
  p_incident_id uuid,
  p_requested_by text
)
returns text
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_consolidated, corvis_facts, corvis_source
as $$
declare
  current_row corvis_control.data_correction_incident%rowtype;
  computed_job_id text;
  computed_event_id uuid;
  correlation_id text;
  replacement_id uuid;
  artifact_ids uuid[];
  artifact_id uuid;
  artifact_ingestion_id text;
begin
  select * into current_row from corvis_control.data_correction_incident
  where tenant_id=p_tenant_id and incident_id=p_incident_id for update;
  if not found then return null; end if;
  if current_row.state not in ('open','reprocessing') then raise exception 'correction incident is not replayable'; end if;
  if current_row.document_id is null then raise exception 'correction incident has no retained source document to replay'; end if;
  if current_row.snapshot_id is null or current_row.snapshot_version is null then
    raise exception 'correction incident has no retained snapshot lineage to replay';
  end if;
  if not exists (
    select 1 from corvis_consolidated.fund_period_snapshot s
    where s.tenant_id=p_tenant_id and s.snapshot_id=current_row.snapshot_id
      and s.version=current_row.snapshot_version
      and s.fund_id=current_row.fund_id and s.report_period=current_row.report_period
      and s.status in ('published','superseded','withdrawn')
  ) then
    raise exception 'correction incident snapshot lineage is not a retained published version';
  end if;

  select array_agg(distinct av.document_artifact_version_id order by av.document_artifact_version_id)
    into artifact_ids
  from corvis_consolidated.fund_period_snapshot s
  cross join lateral unnest(s.fact_ids) as snapshot_fact(consolidated_fact_id)
  join corvis_consolidated.consolidated_fact cf
    on cf.tenant_id=s.tenant_id and cf.consolidated_fact_id=snapshot_fact.consolidated_fact_id
  cross join lateral unnest(cf.source_observation_ids) as fact_observation(observation_id)
  join corvis_facts.observation_source_reference osr
    on osr.tenant_id=cf.tenant_id and osr.observation_id=fact_observation.observation_id
  join corvis_source.source_reference sr
    on sr.tenant_id=osr.tenant_id and sr.source_reference_id=osr.source_reference_id
  join corvis_source.document_artifact_version av
    on av.tenant_id=sr.tenant_id and av.document_artifact_version_id=sr.document_artifact_version_id
  where s.tenant_id=p_tenant_id
    and s.snapshot_id=current_row.snapshot_id
    and s.version=current_row.snapshot_version
    and sr.document_id=current_row.document_id
    and (current_row.metric_code is null or cf.metric_code=current_row.metric_code)
    and av.malware_scan_status='clean'
    and av.quarantine_status='released';

  if coalesce(cardinality(artifact_ids),0)=0 then
    raise exception 'correction replay has no exact retained clean artifact lineage';
  end if;
  if cardinality(artifact_ids)<>1 then
    raise exception 'correction replay artifact lineage is ambiguous';
  end if;
  artifact_id := artifact_ids[1];

  select av.ingestion_id into artifact_ingestion_id
  from corvis_source.document_artifact_version av
  where av.tenant_id=p_tenant_id
    and av.document_artifact_version_id=artifact_id
    and av.document_id=current_row.document_id
    and av.malware_scan_status='clean'
    and av.quarantine_status='released';
  if artifact_ingestion_id is null then raise exception 'correction replay retained artifact is unavailable'; end if;

  correlation_id := 'data-correction:' || p_incident_id::text;
  computed_job_id := corvis_control.scoped_processing_job_id(correlation_id,'registered',current_row.document_id);
  replacement_id := md5(
    p_tenant_id::text || ':' || current_row.fund_id || ':' || current_row.report_period || ':' || correlation_id
  )::uuid;

  insert into corvis_control.processing_job
    (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version,created_at,updated_at)
  values (p_tenant_id,computed_job_id,current_row.document_id,'registered','queued',0,5,
    correlation_id,1,now(),now())
  on conflict (tenant_id,job_id) do nothing;

  if not exists (
    select 1 from corvis_control.processing_job j
    where j.tenant_id=p_tenant_id and j.job_id=computed_job_id
      and j.document_id=current_row.document_id and j.stage='registered'
      and j.correlation_id=correlation_id
  ) then raise exception 'correction replay job identity conflicts with retained state'; end if;

  computed_event_id := md5(p_tenant_id::text || ':' || computed_job_id || ':ready')::uuid;
  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,computed_event_id,'ProcessingStageReady','processing_job',computed_job_id,
    jsonb_build_object(
      'jobId',computed_job_id,
      'documentId',current_row.document_id,
      'stage','registered',
      'correlationId',correlation_id,
      'artifactVersionId',artifact_id,
      'ingestionId',artifact_ingestion_id,
      'correctionIncidentId',p_incident_id,
      'requestedBy',p_requested_by
    ),now()
  ) on conflict (tenant_id,event_id) do nothing;

  update corvis_control.data_correction_incident
  set state='reprocessing',replay_job_id=computed_job_id,replacement_snapshot_id=replacement_id
  where tenant_id=p_tenant_id and incident_id=p_incident_id;
  return computed_job_id;
end;
$$;

-- Reconciliation is intentionally allowed to run more than once over the same
-- canonicalization when each run belongs to a distinct durable correction journey.
-- Primary duplicates remain prevented by deterministic run identity/idempotency.
alter table corvis_consolidated.reconciliation_run
  drop constraint if exists reconciliation_run_tenant_id_canonicalization_run_id_key;
create index if not exists reconciliation_run_canonicalization_idx
  on corvis_consolidated.reconciliation_run (tenant_id,canonicalization_run_id,created_at desc);

-- Patch the large, already-reviewed stage functions in place. pg_get_functiondef is
-- used only to replace narrow job-identity assumptions; every replacement is asserted
-- so a future migration drift fails loudly instead of silently weakening a gate.
do $migration$
declare source text; patched text;
begin
  source := pg_get_functiondef('corvis_facts.canonicalize_reviewed_extraction(uuid,uuid,uuid,text,text,text,text)'::regprocedure);
  patched := replace(source,
    $$j.job_id='reviewed:' || p_document_id::text$$,
    $$j.job_id=corvis_control.processing_predecessor_job_for_effect(p_tenant_id,p_document_id,'canonicalized',p_idempotency_key,'reviewed')$$);
  if patched=source then raise exception 'migration 031 could not scope canonicalization predecessor'; end if;
  execute patched;
end
$migration$;

do $migration$
declare source text; patched text; next_text text;
begin
  source := pg_get_functiondef('corvis_consolidated.reconcile_canonicalization(uuid,uuid,uuid,uuid,text,text,integer,integer,text)'::regprocedure);
  patched := replace(source,
    $$j.job_id='canonicalized:' || p_document_id::text$$,
    $$j.job_id=corvis_control.processing_predecessor_job_for_effect(p_tenant_id,p_document_id,'reconciled',p_idempotency_key,'canonicalized')$$);
  if patched=source then raise exception 'migration 031 could not scope reconciliation predecessor'; end if;
  next_text := replace(patched,
    $$run_id := md5(p_tenant_id::text || ':' || p_canonicalization_run_id::text || ':reconciliation-v1')::uuid;$$,
    $$run_id := md5(p_tenant_id::text || ':' || p_canonicalization_run_id::text || ':reconciliation-v1' || corvis_control.processing_replay_scope_for_effect(p_tenant_id,p_document_id,'reconciled',p_idempotency_key))::uuid;$$);
  if next_text=patched then raise exception 'migration 031 could not scope reconciliation run identity'; end if;
  patched := next_text;
  next_text := replace(patched,
    $$target_snapshot_id := md5(p_tenant_id::text || ':' || resolved_fund_id || ':' || resolved_report_period)::uuid;$$,
    $$target_snapshot_id := md5(p_tenant_id::text || ':' || resolved_fund_id || ':' || resolved_report_period || corvis_control.processing_replay_scope_for_effect(p_tenant_id,p_document_id,'reconciled',p_idempotency_key))::uuid;$$);
  if next_text=patched then raise exception 'migration 031 could not scope replacement snapshot identity'; end if;
  execute next_text;
end
$migration$;

do $migration$
declare source text; patched text;
begin
  source := pg_get_functiondef('corvis_consolidated.consolidate_reconciliation(uuid,uuid,uuid,uuid,integer,integer,text)'::regprocedure);
  patched := replace(source,
    $$j.job_id='reconciled:' || p_document_id::text$$,
    $$j.job_id=corvis_control.processing_predecessor_job_for_effect(p_tenant_id,p_document_id,'consolidated',p_idempotency_key,'reconciled')$$);
  if patched=source then raise exception 'migration 031 could not scope consolidation predecessor'; end if;
  execute patched;
end
$migration$;

do $migration$
declare source text; patched text;
begin
  source := pg_get_functiondef('corvis_consolidated.publish_consolidation(uuid,uuid,uuid,uuid,integer,text)'::regprocedure);
  patched := replace(source,
    $$j.job_id='consolidated:' || p_document_id::text$$,
    $$j.job_id=corvis_control.processing_predecessor_job_for_effect(p_tenant_id,p_document_id,'published',p_idempotency_key,'consolidated')$$);
  if patched=source then raise exception 'migration 031 could not scope publication predecessor'; end if;
  execute patched;
end
$migration$;

-- The active correction blocks ordinary publication, but its own reserved replacement
-- snapshot is exactly what must be publishable before the incident can be resolved.
do $migration$
declare source text; patched text;
begin
  source := pg_get_functiondef('corvis_consolidated.assert_snapshot_publishable(uuid,uuid,integer)'::regprocedure);
  patched := replace(source,
    $$and c.state in ('open','reprocessing')$$,
    $$and c.state in ('open','reprocessing')
      and not (c.state='reprocessing' and c.replacement_snapshot_id=p_snapshot_id)$$);
  if patched=source then raise exception 'migration 031 could not scope correction publication gate'; end if;
  execute patched;
end
$migration$;

-- Candidate-review lifecycle must follow the reviewed job belonging to the extraction
-- run's own processing correlation, not a historical primary reviewed:<document> job.
create or replace function corvis_review.guard_review_event_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_review, corvis_source, corvis_control
as $$
declare
  run_document_id uuid;
  reviewed_state text;
  extraction_correlation text;
begin
  select r.document_id into run_document_id
  from corvis_source.extraction_run r
  where r.tenant_id=new.tenant_id
    and r.extraction_run_id=new.extraction_run_id
    and r.status='ready';
  if not found then raise exception 'candidate review requires finalized extraction run'; end if;

  select j.correlation_id into extraction_correlation
  from corvis_control.processing_stage_effect e
  join corvis_control.processing_job j
    on j.tenant_id=e.tenant_id and j.job_id=e.job_id
  where e.tenant_id=new.tenant_id
    and e.document_id=run_document_id
    and e.stage='extracted'
    and e.state='complete'
    and e.result ->> 'extractionRunId'=new.extraction_run_id::text
  order by e.completed_at desc nulls last
  limit 1;
  if extraction_correlation is null then
    raise exception 'candidate review requires committed extracted-stage lineage';
  end if;

  select j.state into reviewed_state
  from corvis_control.processing_job j
  where j.tenant_id=new.tenant_id
    and j.document_id=run_document_id
    and j.stage='reviewed'
    and j.correlation_id=extraction_correlation
  order by j.updated_at desc
  limit 1
  for share;

  if reviewed_state is null then raise exception 'candidate review requires scoped reviewed processing job'; end if;
  if reviewed_state='running' then
    raise exception 'candidate review is temporarily closed while reviewed stage is running';
  end if;
  if reviewed_state='succeeded' then
    raise exception 'candidate review is closed after reviewed stage completion';
  end if;

  update corvis_review.extraction_review_gate
  set status='pending',blocking_candidate_count=greatest(blocking_candidate_count,1),evaluated_at=now()
  where tenant_id=new.tenant_id
    and extraction_run_id=new.extraction_run_id
    and review_policy_version=new.review_policy_version;
  return new;
end;
$$;

create or replace function corvis_control.resume_blocked_reviewed_stage(
  p_tenant_id uuid,
  p_job_id text,
  p_extraction_run_id uuid,
  p_review_policy_version text
)
returns table(resumed boolean, resume_event_id uuid, job_version integer)
language plpgsql
security invoker
as $$
declare
  current_job corvis_control.processing_job%rowtype;
  run_row corvis_source.extraction_run%rowtype;
  signal_id uuid;
  predecessor_job_id text;
begin
  select * into current_job
  from corvis_control.processing_job
  where tenant_id=p_tenant_id and job_id=p_job_id
  for update;
  if not found then return; end if;
  if current_job.stage <> 'reviewed' or current_job.state <> 'blocked' then
    return query select false,null::uuid,current_job.version;
    return;
  end if;

  select * into run_row
  from corvis_source.extraction_run
  where tenant_id=p_tenant_id and extraction_run_id=p_extraction_run_id
    and document_id=current_job.document_id and status='ready';
  if not found then raise exception 'review resume requires finalized extraction run'; end if;

  if not exists (
    select 1 from corvis_review.extraction_review_gate g
    where g.tenant_id=p_tenant_id and g.extraction_run_id=p_extraction_run_id
      and g.review_policy_version=p_review_policy_version and g.status='ready'
      and g.blocking_candidate_count=0 and g.candidate_set_sha256=run_row.candidate_set_sha256
  ) then raise exception 'review gate is not ready'; end if;

  predecessor_job_id := corvis_control.processing_predecessor_job_for_job(
    p_tenant_id,p_job_id,'extracted'
  );
  if predecessor_job_id is null then raise exception 'review resume predecessor job is missing'; end if;

  update corvis_control.processing_job
  set state='queued',blocked_reason=null,last_error=null,version=version+1,updated_at=now()
  where tenant_id=p_tenant_id and job_id=p_job_id
  returning * into current_job;

  signal_id := md5(p_tenant_id::text || ':' || p_job_id || ':review-resume:' || current_job.version::text)::uuid;
  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,signal_id,'ProcessingStageReady','processing_job',p_job_id,
    jsonb_build_object(
      'jobId',p_job_id,'documentId',current_job.document_id,'stage','reviewed',
      'correlationId',current_job.correlation_id,'predecessorJobId',predecessor_job_id
    ),now()
  ) on conflict (tenant_id,event_id) do nothing;
  return query select true,signal_id,current_job.version;
end;
$$;

-- Reconciliation resume has the run's stage-effect idempotency key, so it can locate
-- the exact blocked scoped job and its same-correlation canonicalized predecessor.
do $migration$
declare source text; patched text; next_text text;
begin
  source := pg_get_functiondef('corvis_control.resume_blocked_reconciled_stage(uuid,uuid)'::regprocedure);
  patched := replace(source,
    $$where tenant_id=p_tenant_id and job_id='reconciled:' || run_row.document_id::text$$,
    $$where tenant_id=p_tenant_id and job_id=corvis_control.processing_job_for_effect_key(p_tenant_id,run_row.document_id,'reconciled',run_row.idempotency_key)$$);
  if patched=source then raise exception 'migration 031 could not scope reconciliation resume job'; end if;
  next_text := replace(patched,
    $$'predecessorJobId','canonicalized:' || current_job.document_id::text$$,
    $$'predecessorJobId',corvis_control.processing_predecessor_job_for_job(p_tenant_id,current_job.job_id,'canonicalized')$$);
  if next_text=patched then raise exception 'migration 031 could not scope reconciliation resume predecessor'; end if;
  execute next_text;
end
$migration$;

commit;
