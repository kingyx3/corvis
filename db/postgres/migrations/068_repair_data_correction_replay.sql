-- Repair the data-correction replay path.
-- Depends on migrations 001-067.
--
-- 1. Enqueueing a replay always failed. Since migration 023 the trigger
--    outbox_processing_stage_predecessor_result rejects every ProcessingStageReady
--    outbox event without payload.predecessorJobId, but request_data_correction_replay
--    (022/031/065) announces its job with a `registered`-stage ProcessingStageReady
--    event, and the first stage has no predecessor. The registered handler consumes no
--    predecessor result, so the trigger now lets a first-stage event through when it
--    carries no predecessor; every later stage must still name one.
-- 2. The retained-job identity guard compared the column with itself. Under
--    #variable_conflict use_column (065) the bare `correlation_id` on the right of
--    `j.correlation_id=correlation_id` resolves to the column, so the guard was a
--    tautology. The function now compares against a distinctly named local variable
--    (qualifying by function name is rejected by the parser inside a subquery).
--
-- An audit of every ambiguous reference in the five functions repaired by 065 found
-- this to be the only site where the variable, not the column, was intended.

begin;

create or replace function corvis_control.attach_processing_stage_predecessor_result()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $function$
declare
  predecessor_job_id text;
  predecessor_result jsonb;
begin
  predecessor_job_id := new.payload ->> 'predecessorJobId';
  if predecessor_job_id is null or btrim(predecessor_job_id) = '' then
    -- The first stage (a correction replay restarts at `registered`) has no predecessor.
    if new.payload ->> 'stage' = 'registered' then
      return new;
    end if;
    raise exception 'processing stage ready event is missing predecessor job id';
  end if;

  select e.result
    into predecessor_result
  from corvis_control.processing_stage_effect e
  where e.tenant_id = new.tenant_id
    and e.job_id = predecessor_job_id
    and e.state = 'complete'
  order by e.completed_at desc nulls last, e.effect_key
  limit 1;

  if not found then
    raise exception 'processing stage predecessor effect is not complete';
  end if;

  new.payload := jsonb_set(
    new.payload,
    '{predecessorResult}',
    coalesce(predecessor_result, '{}'::jsonb),
    true
  );
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION corvis_control.request_data_correction_replay(p_tenant_id uuid, p_incident_id uuid, p_requested_by text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated', 'corvis_facts', 'corvis_source'
AS $function$
#variable_conflict use_column
declare
  current_row corvis_control.data_correction_incident%rowtype;
  computed_job_id text;
  computed_event_id uuid;
  correlation_id text;
  replay_correlation_id text;
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
  replay_correlation_id := correlation_id;
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
      and j.correlation_id=replay_correlation_id
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
$function$;

commit;
