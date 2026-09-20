-- Corvis governed canonical-observation reconciliation v1
-- Depends on migrations 001-027.
--
-- Reconciliation preserves every canonical observation. It only groups observations
-- whose economically material semantic grain is exactly equal. Different grains
-- remain separate. Exact-grain disagreements become explicit exceptions instead of
-- silently selecting a source; source-authority selection remains a governed human
-- resolution until an authoritative ranking is modeled.

begin;

create table if not exists corvis_consolidated.reconciliation_run (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  reconciliation_run_id uuid not null,
  canonicalization_run_id uuid not null,
  document_id uuid not null,
  snapshot_id uuid not null,
  snapshot_version integer not null check (snapshot_version > 0),
  idempotency_key text not null,
  status text not null check (status in ('blocked','ready')),
  fund_id text not null,
  report_period text not null,
  schema_version text not null,
  taxonomy_version text not null,
  observation_count integer not null check (observation_count > 0),
  blocking_exception_count integer not null check (blocking_exception_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id,reconciliation_run_id),
  foreign key (tenant_id,canonicalization_run_id)
    references corvis_facts.canonicalization_run(tenant_id,canonicalization_run_id),
  foreign key (tenant_id,document_id)
    references corvis_source.document(tenant_id,document_id),
  foreign key (tenant_id,snapshot_id,snapshot_version)
    references corvis_consolidated.fund_period_snapshot(tenant_id,snapshot_id,version),
  unique (tenant_id,canonicalization_run_id),
  unique (tenant_id,idempotency_key),
  check (btrim(idempotency_key) <> ''),
  check (btrim(fund_id) <> ''),
  check (btrim(report_period) <> ''),
  check ((status='blocked' and blocking_exception_count > 0 and completed_at is null)
      or (status='ready' and blocking_exception_count=0 and completed_at is not null))
);

alter table corvis_consolidated.reconciliation_run enable row level security;
alter table corvis_consolidated.reconciliation_run force row level security;
-- Worker-managed state: no direct client policy is intentionally created.

create index if not exists reconciliation_run_snapshot_idx
  on corvis_consolidated.reconciliation_run
    (tenant_id,snapshot_id,snapshot_version,status,created_at);
create index if not exists reconciliation_run_document_idx
  on corvis_consolidated.reconciliation_run
    (tenant_id,document_id,created_at desc);

alter table corvis_consolidated.reconciliation_exception
  add column if not exists reconciliation_run_id uuid;

alter table corvis_consolidated.reconciliation_exception
  drop constraint if exists reconciliation_exception_reconciliation_run_fk;
alter table corvis_consolidated.reconciliation_exception
  add constraint reconciliation_exception_reconciliation_run_fk
  foreign key (tenant_id,reconciliation_run_id)
  references corvis_consolidated.reconciliation_run(tenant_id,reconciliation_run_id);

create index if not exists reconciliation_exception_run_idx
  on corvis_consolidated.reconciliation_exception
    (tenant_id,reconciliation_run_id,status,created_at)
  where reconciliation_run_id is not null;

create or replace function corvis_consolidated.reconcile_canonicalization(
  p_tenant_id uuid,
  p_document_id uuid,
  p_canonicalization_run_id uuid,
  p_extraction_run_id uuid,
  p_candidate_set_sha256 text,
  p_decision_set_sha256 text,
  p_observation_count integer,
  p_source_reference_count integer,
  p_idempotency_key text
)
returns table(
  reconciliation_run_id uuid,
  canonicalization_run_id uuid,
  snapshot_id uuid,
  snapshot_version integer,
  fund_id text,
  report_period text,
  schema_version text,
  taxonomy_version text,
  observation_count integer,
  blocking_exception_count integer,
  reconciliation_ready boolean
)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_consolidated, corvis_facts, corvis_source, corvis_semantic, corvis_control
as $$
declare
  canonical_row corvis_facts.canonicalization_run%rowtype;
  extraction_row corvis_source.extraction_run%rowtype;
  existing_run corvis_consolidated.reconciliation_run%rowtype;
  existing_snapshot corvis_consolidated.fund_period_snapshot%rowtype;
  run_id uuid;
  target_snapshot_id uuid;
  resolved_fund_id text;
  resolved_report_period text;
  resolved_schema_version text;
  resolved_taxonomy_version text;
  actual_observation_count integer;
  actual_reference_count integer;
  blocker_count integer;
  metric_count integer;
  definition_count integer;
  grain record;
begin
  if p_candidate_set_sha256 !~ '^[0-9a-f]{64}$'
    or p_decision_set_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'reconciliation requires valid reviewed hashes';
  end if;
  if p_observation_count <= 0 then
    raise exception 'reconciliation requires canonical observations';
  end if;
  if p_source_reference_count <= 0 then
    raise exception 'reconciliation requires canonical source references';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key)='' then
    raise exception 'reconciliation requires idempotency key';
  end if;

  select * into canonical_row
  from corvis_facts.canonicalization_run
  where tenant_id=p_tenant_id
    and canonicalization_run_id=p_canonicalization_run_id
    and extraction_run_id=p_extraction_run_id
    and document_id=p_document_id
    and status='ready'
    and candidate_set_sha256=p_candidate_set_sha256
    and decision_set_sha256=p_decision_set_sha256
  for share;
  if not found then
    raise exception 'reconciliation requires exact ready canonicalization run';
  end if;
  if canonical_row.observation_count <> p_observation_count
    or canonical_row.source_reference_count <> p_source_reference_count then
    raise exception 'reconciliation predecessor counts no longer match canonicalization';
  end if;

  -- The processing boundary is independently revalidated in Postgres so direct
  -- function invocation cannot bypass the completed canonicalized stage.
  if not exists (
    select 1
    from corvis_control.processing_job j
    join corvis_control.processing_stage_effect e
      on e.tenant_id=j.tenant_id and e.job_id=j.job_id
    where j.tenant_id=p_tenant_id
      and j.job_id='canonicalized:' || p_document_id::text
      and j.document_id=p_document_id
      and j.stage='canonicalized'
      and j.state='succeeded'
      and e.stage='canonicalized'
      and e.state='complete'
      and e.result ->> 'canonicalizationRunId'=p_canonicalization_run_id::text
      and e.result ->> 'extractionRunId'=p_extraction_run_id::text
      and e.result ->> 'candidateSetSha256'=p_candidate_set_sha256
      and e.result ->> 'decisionSetSha256'=p_decision_set_sha256
  ) then
    raise exception 'reconciliation requires committed canonicalized-stage predecessor effect';
  end if;

  select * into extraction_row
  from corvis_source.extraction_run
  where tenant_id=p_tenant_id and extraction_run_id=p_extraction_run_id
    and document_id=p_document_id and status='ready'
  for share;
  if not found then raise exception 'reconciliation requires finalized extraction run'; end if;

  select count(*)::integer,
         min(o.fund_id),
         min(o.economic_period),
         min(o.schema_version)
    into actual_observation_count,resolved_fund_id,resolved_report_period,resolved_schema_version
  from corvis_facts.observation o
  where o.tenant_id=p_tenant_id
    and o.canonicalization_run_id=p_canonicalization_run_id;

  if actual_observation_count <> p_observation_count then
    raise exception 'reconciliation canonical observation count is incomplete';
  end if;
  if (select count(distinct o.fund_id) from corvis_facts.observation o
      where o.tenant_id=p_tenant_id and o.canonicalization_run_id=p_canonicalization_run_id) <> 1
    or resolved_fund_id is null or btrim(resolved_fund_id)='' then
    raise exception 'reconciliation requires one resolved fund per canonicalization run';
  end if;
  if (select count(distinct o.economic_period) from corvis_facts.observation o
      where o.tenant_id=p_tenant_id and o.canonicalization_run_id=p_canonicalization_run_id) <> 1
    or resolved_report_period is null or btrim(resolved_report_period)='' then
    raise exception 'reconciliation requires one explicit report period per canonicalization run';
  end if;
  if (select count(distinct o.schema_version) from corvis_facts.observation o
      where o.tenant_id=p_tenant_id and o.canonicalization_run_id=p_canonicalization_run_id) <> 1
    or resolved_schema_version is null or btrim(resolved_schema_version)='' then
    raise exception 'reconciliation requires one canonical schema version';
  end if;
  if resolved_schema_version <> extraction_row.schema_version then
    raise exception 'reconciliation schema version no longer matches extraction lineage';
  end if;

  -- Every canonical observation must retain at least one exact source reference.
  select count(distinct osr.source_reference_id)::integer into actual_reference_count
  from corvis_facts.observation o
  join corvis_facts.observation_source_reference osr
    on osr.tenant_id=o.tenant_id and osr.observation_id=o.observation_id
  join corvis_source.source_reference sr
    on sr.tenant_id=osr.tenant_id and sr.source_reference_id=osr.source_reference_id
  where o.tenant_id=p_tenant_id
    and o.canonicalization_run_id=p_canonicalization_run_id
    and sr.document_id=p_document_id;
  if actual_reference_count <> p_source_reference_count then
    raise exception 'reconciliation source-reference lineage is incomplete';
  end if;
  if exists (
    select 1 from corvis_facts.observation o
    where o.tenant_id=p_tenant_id and o.canonicalization_run_id=p_canonicalization_run_id
      and not exists (
        select 1 from corvis_facts.observation_source_reference osr
        where osr.tenant_id=o.tenant_id and osr.observation_id=o.observation_id
      )
  ) then
    raise exception 'reconciliation observation is missing source lineage';
  end if;

  -- A metric may have only one active governed definition at this point. The
  -- snapshot records a deterministic definition-set fingerprint rather than
  -- inventing a semantic taxonomy release label.
  select count(distinct o.metric_code)::integer into metric_count
  from corvis_facts.observation o
  where o.tenant_id=p_tenant_id and o.canonicalization_run_id=p_canonicalization_run_id;

  select count(*)::integer into definition_count
  from (
    select o.metric_code
    from corvis_facts.observation o
    join corvis_semantic.metric_definition m
      on m.metric_code=o.metric_code and m.active=true
    where o.tenant_id=p_tenant_id and o.canonicalization_run_id=p_canonicalization_run_id
    group by o.metric_code
    having count(*)=1
  ) governed_metrics;
  if definition_count <> metric_count then
    raise exception 'reconciliation requires exactly one active metric definition per metric';
  end if;

  select 'metric-definitions-md5:' || md5(string_agg(definition_key,'|' order by definition_key))
    into resolved_taxonomy_version
  from (
    select distinct o.metric_code || ':' || m.definition_version as definition_key
    from corvis_facts.observation o
    join corvis_semantic.metric_definition m
      on m.metric_code=o.metric_code and m.active=true
    where o.tenant_id=p_tenant_id and o.canonicalization_run_id=p_canonicalization_run_id
  ) definitions;
  if resolved_taxonomy_version is null then
    raise exception 'reconciliation could not resolve metric-definition lineage';
  end if;

  run_id := md5(p_tenant_id::text || ':' || p_canonicalization_run_id::text || ':reconciliation-v1')::uuid;
  target_snapshot_id := md5(p_tenant_id::text || ':' || resolved_fund_id || ':' || resolved_report_period)::uuid;

  -- Reconciliation may accumulate multiple source documents into the same initial
  -- fund-period draft. Once a snapshot has entered publication history, new source
  -- material must use the governed correction/republication path rather than mutate
  -- an already-published version.
  select * into existing_snapshot
  from corvis_consolidated.fund_period_snapshot
  where tenant_id=p_tenant_id and snapshot_id=target_snapshot_id
  order by version desc
  limit 1
  for update;

  if found and (existing_snapshot.version <> 1 or existing_snapshot.status not in ('draft','blocked')) then
    raise exception 'reconciliation requires governed republication for an existing published fund-period snapshot';
  end if;

  if not found then
    insert into corvis_consolidated.fund_period_snapshot (
      tenant_id,snapshot_id,fund_id,report_period,version,status,fact_ids,
      blocking_exception_count,schema_version,taxonomy_version,created_at
    ) values (
      p_tenant_id,target_snapshot_id,resolved_fund_id,resolved_report_period,1,'draft','{}'::uuid[],
      0,resolved_schema_version,resolved_taxonomy_version,now()
    );
  else
    if existing_snapshot.fund_id <> resolved_fund_id
      or existing_snapshot.report_period <> resolved_report_period
      or existing_snapshot.schema_version <> resolved_schema_version
      or existing_snapshot.taxonomy_version <> resolved_taxonomy_version then
      raise exception 'existing fund-period draft conflicts with reconciliation lineage';
    end if;
  end if;

  insert into corvis_consolidated.reconciliation_run (
    tenant_id,reconciliation_run_id,canonicalization_run_id,document_id,snapshot_id,snapshot_version,
    idempotency_key,status,fund_id,report_period,schema_version,taxonomy_version,
    observation_count,blocking_exception_count,created_at,completed_at
  ) values (
    p_tenant_id,run_id,p_canonicalization_run_id,p_document_id,target_snapshot_id,1,
    p_idempotency_key,'ready',resolved_fund_id,resolved_report_period,resolved_schema_version,
    resolved_taxonomy_version,p_observation_count,0,now(),now()
  ) on conflict (tenant_id,reconciliation_run_id) do nothing;

  select * into existing_run
  from corvis_consolidated.reconciliation_run
  where tenant_id=p_tenant_id and reconciliation_run_id=run_id
  for update;
  if not found then raise exception 'reconciliation run could not be persisted'; end if;
  if existing_run.canonicalization_run_id <> p_canonicalization_run_id
    or existing_run.document_id <> p_document_id
    or existing_run.snapshot_id <> target_snapshot_id
    or existing_run.snapshot_version <> 1
    or existing_run.idempotency_key <> p_idempotency_key
    or existing_run.fund_id <> resolved_fund_id
    or existing_run.report_period <> resolved_report_period
    or existing_run.schema_version <> resolved_schema_version
    or existing_run.taxonomy_version <> resolved_taxonomy_version
    or existing_run.observation_count <> p_observation_count then
    raise exception 'existing reconciliation run conflicts with canonical lineage';
  end if;

  -- On first execution, compare only exact semantic-grain peers. The grain includes
  -- subject identity, metric definition dimensions, period/scenario, currency/unit,
  -- adjustment/valuation and breakdown dimensions. Different grains are retained as
  -- different observations and never collapsed here.
  if not exists (
    select 1 from corvis_consolidated.reconciliation_exception e
    where e.tenant_id=p_tenant_id and e.reconciliation_run_id=run_id
  ) and existing_run.status='ready' then
    for grain in
      with scoped as (
        select o.*,
          md5(concat_ws('|',
            coalesce(o.subject_type,''),coalesce(o.subject_level,''),coalesce(o.fund_id,''),
            coalesce(o.company_id,''),coalesce(o.holding_id,''),coalesce(o.instrument_id,''),
            coalesce(o.metric_code,''),coalesce(o.economic_period,''),coalesce(o.period_type,''),
            coalesce(o.period_start::text,''),coalesce(o.period_end::text,''),coalesce(o.as_of_date::text,''),
            coalesce(o.report_date::text,''),coalesce(o.scenario_type,''),coalesce(o.actuality,''),
            coalesce(o.currency,''),coalesce(o.unit,''),coalesce(o.reported_multiplier,''),
            coalesce(o.is_adjusted::text,''),coalesce(o.adjustment_note,''),coalesce(o.valuation_method,''),
            coalesce(o.breakdown_category,''),coalesce(o.breakdown_value,''),coalesce(o.lookthrough_source,''),
            coalesce(o.is_derived::text,''),coalesce(o.derivation_formula,''),coalesce(o.is_restated::text,'')
          )) as grain_hash,
          jsonb_build_object(
            'number',o.value_number,'string',o.value_string,'raw',o.value_raw,
            'qualifier',o.value_qualifier,'currency',o.currency,'unit',o.unit
          ) as normalized_value
        from corvis_facts.observation o
        where o.tenant_id=p_tenant_id and o.canonicalization_run_id=p_canonicalization_run_id
      ), conflicts as (
        select grain_hash,
          min(subject_type) as subject_type,
          min(case
            when subject_level='fund' then fund_id
            when subject_level='company' then company_id
            when subject_level='holding' then holding_id
            when subject_level='instrument' then instrument_id
            else null end) as subject_id,
          min(metric_code) as metric_code,
          count(*)::integer as observation_count,
          bool_or(risk_tier='critical') as has_critical,
          jsonb_agg(jsonb_build_object(
            'observationId',observation_id::text,
            'value',normalized_value,
            'riskTier',risk_tier
          ) order by observation_id::text) as observations
        from scoped
        group by grain_hash
        having count(*) > 1 and count(distinct normalized_value::text) > 1
      )
      select c.*,
        coalesce((
          select array_agg(distinct osr.source_reference_id order by osr.source_reference_id)
          from scoped s
          join corvis_facts.observation_source_reference osr
            on osr.tenant_id=s.tenant_id and osr.observation_id=s.observation_id
          where s.grain_hash=c.grain_hash
        ),'{}'::uuid[]) as source_reference_ids
      from conflicts c
      order by c.grain_hash
    loop
      insert into corvis_consolidated.reconciliation_exception (
        tenant_id,reconciliation_run_id,snapshot_id,snapshot_version,exception_key,
        fund_id,report_period,exception_type,subject_type,subject_id,metric_code,
        summary,materiality,competing_source_reference_ids,context,status,version,
        created_by,created_at
      ) values (
        p_tenant_id,run_id,target_snapshot_id,1,
        'reconciliation-v1:' || p_canonicalization_run_id::text || ':' || grain.grain_hash,
        resolved_fund_id,resolved_report_period,'reconciliation_conflict',grain.subject_type,
        grain.subject_id,grain.metric_code,'Exact semantic-grain observations disagree',
        case when grain.has_critical then 'material' else 'unknown' end,
        grain.source_reference_ids,
        jsonb_build_object(
          'semanticGrainHash',grain.grain_hash,
          'observationCount',grain.observation_count,
          'observations',grain.observations,
          'policyVersion','reconciliation_v1',
          'sourceAuthoritySelection','explicit_resolution_required'
        ),'open',1,'processing:reconciled',now()
      ) on conflict (tenant_id,snapshot_id,snapshot_version,exception_key) do nothing;
    end loop;

    select count(*)::integer into blocker_count
    from corvis_consolidated.reconciliation_exception e
    where e.tenant_id=p_tenant_id and e.reconciliation_run_id=run_id and e.status='open';

    update corvis_consolidated.reconciliation_run
    set blocking_exception_count=blocker_count,
        status=case when blocker_count=0 then 'ready' else 'blocked' end,
        completed_at=case when blocker_count=0 then now() else null end
    where tenant_id=p_tenant_id and reconciliation_run_id=run_id
    returning * into existing_run;
  else
    select count(*)::integer into blocker_count
    from corvis_consolidated.reconciliation_exception e
    where e.tenant_id=p_tenant_id and e.reconciliation_run_id=run_id and e.status='open';

    if blocker_count=0 and existing_run.status='blocked' then
      update corvis_consolidated.reconciliation_run
      set blocking_exception_count=0,status='ready',completed_at=coalesce(completed_at,now())
      where tenant_id=p_tenant_id and reconciliation_run_id=run_id
      returning * into existing_run;
    elsif blocker_count <> existing_run.blocking_exception_count then
      update corvis_consolidated.reconciliation_run
      set blocking_exception_count=blocker_count
      where tenant_id=p_tenant_id and reconciliation_run_id=run_id
      returning * into existing_run;
    end if;
  end if;

  return query select
    existing_run.reconciliation_run_id,existing_run.canonicalization_run_id,
    existing_run.snapshot_id,existing_run.snapshot_version,existing_run.fund_id,
    existing_run.report_period,existing_run.schema_version,existing_run.taxonomy_version,
    existing_run.observation_count,existing_run.blocking_exception_count,
    (existing_run.status='ready' and existing_run.blocking_exception_count=0);
end;
$$;

-- Called after an authorized reconciliation resolution. It cannot force a resume:
-- Postgres rechecks that every exception belonging to this exact reconciliation run
-- is resolved before changing durable processing state.
create or replace function corvis_control.resume_blocked_reconciled_stage(
  p_tenant_id uuid,
  p_exception_id uuid
)
returns table(resumed boolean,resume_event_id uuid,job_version integer)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_consolidated
as $$
declare
  exception_row corvis_consolidated.reconciliation_exception%rowtype;
  run_row corvis_consolidated.reconciliation_run%rowtype;
  current_job corvis_control.processing_job%rowtype;
  signal_id uuid;
begin
  select * into exception_row
  from corvis_consolidated.reconciliation_exception
  where tenant_id=p_tenant_id and exception_id=p_exception_id
  limit 1;
  if not found or exception_row.reconciliation_run_id is null then
    return query select false,null::uuid,null::integer;
    return;
  end if;

  select * into run_row
  from corvis_consolidated.reconciliation_run
  where tenant_id=p_tenant_id and reconciliation_run_id=exception_row.reconciliation_run_id
  for update;
  if not found then raise exception 'reconciliation resume run is missing'; end if;

  if exists (
    select 1 from corvis_consolidated.reconciliation_exception e
    where e.tenant_id=p_tenant_id
      and e.reconciliation_run_id=run_row.reconciliation_run_id
      and e.status='open'
  ) then
    return query select false,null::uuid,null::integer;
    return;
  end if;

  update corvis_consolidated.reconciliation_run
  set status='ready',blocking_exception_count=0,completed_at=coalesce(completed_at,now())
  where tenant_id=p_tenant_id and reconciliation_run_id=run_row.reconciliation_run_id;

  select * into current_job
  from corvis_control.processing_job
  where tenant_id=p_tenant_id and job_id='reconciled:' || run_row.document_id::text
  for update;
  if not found then raise exception 'reconciliation resume processing job is missing'; end if;
  if current_job.stage <> 'reconciled' or current_job.state <> 'blocked' then
    return query select false,null::uuid,current_job.version;
    return;
  end if;

  update corvis_control.processing_job
  set state='queued',blocked_reason=null,last_error=null,version=version+1,updated_at=now()
  where tenant_id=p_tenant_id and job_id=current_job.job_id
  returning * into current_job;

  signal_id := md5(
    p_tenant_id::text || ':' || current_job.job_id || ':reconciliation-resume:' || current_job.version::text
  )::uuid;
  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,signal_id,'ProcessingStageReady','processing_job',current_job.job_id,
    jsonb_build_object(
      'jobId',current_job.job_id,
      'documentId',current_job.document_id,
      'stage','reconciled',
      'correlationId',current_job.correlation_id,
      'predecessorJobId','canonicalized:' || current_job.document_id::text
    ),now()
  ) on conflict (tenant_id,event_id) do nothing;

  return query select true,signal_id,current_job.version;
end;
$$;

-- Persistence-bound completion guard. A programming error cannot create the
-- consolidated stage unless reconciliation is genuinely ready and the committed
-- effect points to the same run/snapshot lineage.
create or replace function corvis_consolidated.enforce_ready_reconciliation_before_success()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_consolidated
as $$
declare
  effect_result jsonb;
  run_id uuid;
  snapshot_value uuid;
  snapshot_version_value integer;
begin
  if old.stage='reconciled' and old.state='running' and new.state='succeeded' then
    select e.result into effect_result
    from corvis_control.processing_stage_effect e
    where e.tenant_id=old.tenant_id
      and e.job_id=old.job_id
      and e.document_id=old.document_id
      and e.stage='reconciled'
      and e.state='complete'
    order by e.completed_at desc nulls last
    limit 1;
    if effect_result is null then
      raise exception 'reconciliation completion requires committed reconciled-stage effect';
    end if;

    begin
      run_id := (effect_result ->> 'reconciliationRunId')::uuid;
      snapshot_value := (effect_result ->> 'snapshotId')::uuid;
      snapshot_version_value := (effect_result ->> 'snapshotVersion')::integer;
    exception when others then
      raise exception 'reconciliation completion result is invalid';
    end;

    if effect_result ->> 'reconciliationReady' <> 'true' then
      raise exception 'reconciliation completion result is not ready';
    end if;

    if not exists (
      select 1 from corvis_consolidated.reconciliation_run r
      where r.tenant_id=old.tenant_id
        and r.reconciliation_run_id=run_id
        and r.document_id=old.document_id
        and r.snapshot_id=snapshot_value
        and r.snapshot_version=snapshot_version_value
        and r.status='ready'
        and r.blocking_exception_count=0
        and not exists (
          select 1 from corvis_consolidated.reconciliation_exception x
          where x.tenant_id=r.tenant_id
            and x.reconciliation_run_id=r.reconciliation_run_id
            and x.status='open'
        )
    ) then
      raise exception 'reconciliation persistence blocks consolidation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists processing_job_reconciliation_gate_guard
  on corvis_control.processing_job;
create trigger processing_job_reconciliation_gate_guard
before update of state on corvis_control.processing_job
for each row
execute function corvis_consolidated.enforce_ready_reconciliation_before_success();

commit;
