-- Corvis governed reconciliation-to-consolidation stage v1
-- Depends on migrations 001-028.
--
-- Consolidation is deliberately lossless. Exact semantic-grain observations with
-- the same normalized value become one fact with all contributing observation IDs.
-- Different normalized values at the same grain remain separate alternative facts;
-- this stage never invents source authority or overwrites canonical observations.

begin;

create table if not exists corvis_consolidated.consolidation_run (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  consolidation_run_id uuid not null,
  reconciliation_run_id uuid not null,
  document_id uuid not null,
  snapshot_id uuid not null,
  snapshot_version integer not null check (snapshot_version > 0),
  idempotency_key text not null,
  consolidation_rule_version text not null,
  status text not null check (status in ('ready')),
  fact_ids uuid[] not null,
  fact_count integer not null check (fact_count > 0),
  source_observation_count integer not null check (source_observation_count > 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  primary key (tenant_id,consolidation_run_id),
  foreign key (tenant_id,reconciliation_run_id)
    references corvis_consolidated.reconciliation_run(tenant_id,reconciliation_run_id),
  foreign key (tenant_id,document_id)
    references corvis_source.document(tenant_id,document_id),
  foreign key (tenant_id,snapshot_id,snapshot_version)
    references corvis_consolidated.fund_period_snapshot(tenant_id,snapshot_id,version),
  unique (tenant_id,reconciliation_run_id),
  unique (tenant_id,idempotency_key),
  check (btrim(idempotency_key) <> ''),
  check (btrim(consolidation_rule_version) <> ''),
  check (cardinality(fact_ids)=fact_count)
);

alter table corvis_consolidated.consolidation_run enable row level security;
alter table corvis_consolidated.consolidation_run force row level security;
-- Worker-managed state: no direct client policy is intentionally created.

create index if not exists consolidation_run_snapshot_idx
  on corvis_consolidated.consolidation_run
    (tenant_id,snapshot_id,snapshot_version,completed_at desc);
create index if not exists consolidation_run_document_idx
  on corvis_consolidated.consolidation_run
    (tenant_id,document_id,completed_at desc);

-- Historical consolidated facts remain valid. New processing-stage facts add exact
-- reconciliation/snapshot identity and semantic-grain metadata without rewriting
-- older rows.
alter table corvis_consolidated.consolidated_fact
  add column if not exists reconciliation_run_id uuid,
  add column if not exists snapshot_id uuid,
  add column if not exists snapshot_version integer,
  add column if not exists semantic_grain_hash text,
  add column if not exists semantic_grain_relationship text,
  add column if not exists normalized_value_hash text;

alter table corvis_consolidated.consolidated_fact force row level security;

alter table corvis_consolidated.consolidated_fact
  drop constraint if exists consolidated_fact_reconciliation_run_fk;
alter table corvis_consolidated.consolidated_fact
  add constraint consolidated_fact_reconciliation_run_fk
  foreign key (tenant_id,reconciliation_run_id)
  references corvis_consolidated.reconciliation_run(tenant_id,reconciliation_run_id);

alter table corvis_consolidated.consolidated_fact
  drop constraint if exists consolidated_fact_snapshot_fk;
alter table corvis_consolidated.consolidated_fact
  add constraint consolidated_fact_snapshot_fk
  foreign key (tenant_id,snapshot_id,snapshot_version)
  references corvis_consolidated.fund_period_snapshot(tenant_id,snapshot_id,version);

alter table corvis_consolidated.consolidated_fact
  drop constraint if exists consolidated_fact_semantic_relationship_check;
alter table corvis_consolidated.consolidated_fact
  add constraint consolidated_fact_semantic_relationship_check
  check (semantic_grain_relationship is null or semantic_grain_relationship in (
    'single_observation','equivalent_grain','conflicting_alternative'
  ));

alter table corvis_consolidated.consolidated_fact
  drop constraint if exists consolidated_fact_snapshot_version_check;
alter table corvis_consolidated.consolidated_fact
  add constraint consolidated_fact_snapshot_version_check
  check (snapshot_version is null or snapshot_version > 0);

create unique index if not exists consolidated_fact_processing_identity_uniq
  on corvis_consolidated.consolidated_fact
    (tenant_id,reconciliation_run_id,semantic_grain_hash,normalized_value_hash)
  where reconciliation_run_id is not null
    and semantic_grain_hash is not null
    and normalized_value_hash is not null;

create index if not exists consolidated_fact_snapshot_idx
  on corvis_consolidated.consolidated_fact
    (tenant_id,snapshot_id,snapshot_version,metric_code)
  where snapshot_id is not null;

create or replace function corvis_consolidated.consolidate_reconciliation(
  p_tenant_id uuid,
  p_document_id uuid,
  p_reconciliation_run_id uuid,
  p_snapshot_id uuid,
  p_snapshot_version integer,
  p_expected_observation_count integer,
  p_idempotency_key text
)
returns table(
  consolidation_run_id uuid,
  reconciliation_run_id uuid,
  snapshot_id uuid,
  snapshot_version integer,
  fund_id text,
  report_period text,
  fact_count integer,
  source_observation_count integer,
  consolidation_ready boolean
)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_consolidated, corvis_facts, corvis_control
as $$
declare
  reconciliation_row corvis_consolidated.reconciliation_run%rowtype;
  snapshot_row corvis_consolidated.fund_period_snapshot%rowtype;
  existing_run corvis_consolidated.consolidation_run%rowtype;
  run_id uuid;
  run_fact_ids uuid[] := '{}'::uuid[];
  existing_fact_ids uuid[] := '{}'::uuid[];
  resolved_fact_count integer := 0;
  resolved_source_count integer := 0;
  fact record;
  fact_id uuid;
begin
  if p_snapshot_version <= 0 then
    raise exception 'consolidation requires positive snapshot version';
  end if;
  if p_expected_observation_count <= 0 then
    raise exception 'consolidation requires reconciled observations';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key)='' then
    raise exception 'consolidation requires idempotency key';
  end if;

  select * into reconciliation_row
  from corvis_consolidated.reconciliation_run
  where tenant_id=p_tenant_id
    and reconciliation_run_id=p_reconciliation_run_id
    and document_id=p_document_id
    and snapshot_id=p_snapshot_id
    and snapshot_version=p_snapshot_version
    and status='ready'
    and blocking_exception_count=0
  for share;
  if not found then
    raise exception 'consolidation requires exact ready reconciliation run';
  end if;
  if reconciliation_row.observation_count <> p_expected_observation_count then
    raise exception 'consolidation predecessor observation count changed';
  end if;
  if exists (
    select 1
    from corvis_consolidated.reconciliation_exception e
    where e.tenant_id=p_tenant_id
      and e.reconciliation_run_id=p_reconciliation_run_id
      and e.status='open'
  ) then
    raise exception 'consolidation requires zero open reconciliation exceptions';
  end if;

  -- A direct function call cannot bypass the exact successful reconciled stage.
  if not exists (
    select 1
    from corvis_control.processing_job j
    join corvis_control.processing_stage_effect e
      on e.tenant_id=j.tenant_id and e.job_id=j.job_id
    where j.tenant_id=p_tenant_id
      and j.job_id='reconciled:' || p_document_id::text
      and j.document_id=p_document_id
      and j.stage='reconciled'
      and j.state='succeeded'
      and e.stage='reconciled'
      and e.state='complete'
      and e.result ->> 'reconciliationRunId'=p_reconciliation_run_id::text
      and e.result ->> 'snapshotId'=p_snapshot_id::text
      and (e.result ->> 'snapshotVersion')::integer=p_snapshot_version
      and e.result ->> 'reconciliationReady'='true'
      and (e.result ->> 'blockingExceptionCount')::integer=0
  ) then
    raise exception 'consolidation requires committed reconciled-stage predecessor effect';
  end if;

  select * into snapshot_row
  from corvis_consolidated.fund_period_snapshot
  where tenant_id=p_tenant_id
    and snapshot_id=p_snapshot_id
    and version=p_snapshot_version
  for update;
  if not found then raise exception 'consolidation snapshot is missing'; end if;
  if snapshot_row.status not in ('draft','blocked') then
    raise exception 'consolidation cannot mutate publication history';
  end if;
  if snapshot_row.fund_id <> reconciliation_row.fund_id
    or snapshot_row.report_period <> reconciliation_row.report_period
    or snapshot_row.schema_version <> reconciliation_row.schema_version
    or snapshot_row.taxonomy_version <> reconciliation_row.taxonomy_version then
    raise exception 'consolidation snapshot lineage conflicts with reconciliation';
  end if;

  select count(*)::integer into resolved_source_count
  from corvis_facts.observation o
  where o.tenant_id=p_tenant_id
    and o.canonicalization_run_id=reconciliation_row.canonicalization_run_id;
  if resolved_source_count <> p_expected_observation_count then
    raise exception 'consolidation canonical observation set is incomplete';
  end if;

  if exists (
    select 1
    from corvis_facts.observation o
    where o.tenant_id=p_tenant_id
      and o.canonicalization_run_id=reconciliation_row.canonicalization_run_id
      and (
        o.subject_type is null or btrim(o.subject_type)=''
        or o.subject_level is null or btrim(o.subject_level)=''
        or o.metric_code is null or btrim(o.metric_code)=''
        or o.economic_period is null or btrim(o.economic_period)=''
        or not exists (
          select 1 from corvis_facts.observation_source_reference osr
          where osr.tenant_id=o.tenant_id and osr.observation_id=o.observation_id
        )
      )
  ) then
    raise exception 'consolidation requires complete canonical semantic and source lineage';
  end if;

  run_id := md5(p_tenant_id::text || ':' || p_reconciliation_run_id::text || ':consolidation-v1')::uuid;

  select * into existing_run
  from corvis_consolidated.consolidation_run
  where tenant_id=p_tenant_id and consolidation_run_id=run_id
  for update;
  if found then
    if existing_run.reconciliation_run_id <> p_reconciliation_run_id
      or existing_run.document_id <> p_document_id
      or existing_run.snapshot_id <> p_snapshot_id
      or existing_run.snapshot_version <> p_snapshot_version
      or existing_run.idempotency_key <> p_idempotency_key
      or existing_run.source_observation_count <> p_expected_observation_count then
      raise exception 'existing consolidation run conflicts with reconciled lineage';
    end if;
    return query select
      existing_run.consolidation_run_id,existing_run.reconciliation_run_id,
      existing_run.snapshot_id,existing_run.snapshot_version,reconciliation_row.fund_id,
      reconciliation_row.report_period,existing_run.fact_count,
      existing_run.source_observation_count,true;
    return;
  end if;

  -- Build one fact for each exact semantic-grain + normalized-value group. A grain
  -- with multiple distinct values remains multiple alternative facts rather than
  -- silently selecting or averaging a source.
  for fact in
    with scoped as (
      select o.*,
        case
          when o.subject_level='fund' then o.fund_id
          when o.subject_level='company' then o.company_id
          when o.subject_level='holding' then o.holding_id::text
          when o.subject_level='instrument' then o.instrument_id::text
          else null
        end as resolved_subject_id,
        md5(concat_ws('|',
          coalesce(o.subject_type,''),coalesce(o.subject_level,''),coalesce(o.fund_id,''),
          coalesce(o.company_id,''),coalesce(o.holding_id::text,''),coalesce(o.instrument_id::text,''),
          coalesce(o.metric_code,''),coalesce(o.economic_period,''),coalesce(o.period_type,''),
          coalesce(o.period_start::text,''),coalesce(o.period_end::text,''),coalesce(o.as_of_date::text,''),
          coalesce(o.report_date::text,''),coalesce(o.scenario_type,''),coalesce(o.actuality,''),
          coalesce(o.currency,''),coalesce(o.unit,''),coalesce(o.reported_multiplier,''),
          coalesce(o.is_adjusted::text,''),coalesce(o.adjustment_note,''),coalesce(o.valuation_method,''),
          coalesce(o.breakdown_category,''),coalesce(o.breakdown_value,''),coalesce(o.lookthrough_source,''),
          coalesce(o.is_derived::text,''),coalesce(o.derivation_formula,''),coalesce(o.is_restated::text,'')
        )) as grain_hash,
        jsonb_strip_nulls(jsonb_build_object(
          'number',o.value_number,'string',o.value_string,'raw',o.value_raw,
          'qualifier',o.value_qualifier,'currency',o.currency,'unit',o.unit
        )) as normalized_value,
        jsonb_strip_nulls(jsonb_build_object(
          'subjectLevel',o.subject_level,
          'periodType',o.period_type,'periodStart',o.period_start,'periodEnd',o.period_end,
          'asOfDate',o.as_of_date,'reportDate',o.report_date,'actuality',o.actuality,
          'scenarioType',o.scenario_type,'reportedMultiplier',o.reported_multiplier,
          'sourcePrecision',o.source_precision,'isAdjusted',o.is_adjusted,
          'adjustmentNote',o.adjustment_note,'valuationMethod',o.valuation_method,
          'breakdownCategory',o.breakdown_category,'breakdownValue',o.breakdown_value,
          'lookthroughSource',o.lookthrough_source,'isDerived',o.is_derived,
          'derivationFormula',o.derivation_formula,'isRestated',o.is_restated
        )) as semantic_dimensions
      from corvis_facts.observation o
      where o.tenant_id=p_tenant_id
        and o.canonicalization_run_id=reconciliation_row.canonicalization_run_id
    ), grouped as (
      select
        grain_hash,
        md5(normalized_value::text) as normalized_hash,
        min(subject_type) as subject_type,
        min(resolved_subject_id) as subject_id,
        min(metric_code) as metric_code,
        min(economic_period) as economic_period,
        min(normalized_value::text)::jsonb as normalized_value,
        min(semantic_dimensions::text)::jsonb as semantic_dimensions,
        array_agg(observation_id order by observation_id) as source_observation_ids,
        count(*)::integer as observation_count
      from scoped
      group by grain_hash,normalized_value::text
    ), classified as (
      select g.*,
        count(*) over (partition by grain_hash)::integer as grain_variant_count
      from grouped g
    )
    select * from classified
    order by grain_hash,normalized_hash
  loop
    if fact.subject_id is null or btrim(fact.subject_id)='' then
      raise exception 'consolidation cannot resolve canonical subject identity';
    end if;

    fact_id := md5(
      p_tenant_id::text || ':' || p_snapshot_id::text || ':' || p_snapshot_version::text || ':' ||
      fact.grain_hash || ':' || fact.normalized_hash || ':consolidation-v1'
    )::uuid;

    insert into corvis_consolidated.consolidated_fact (
      tenant_id,consolidated_fact_id,fund_id,subject_type,subject_id,metric_code,
      economic_period,value,source_observation_ids,consolidation_rule_version,created_at,
      reconciliation_run_id,snapshot_id,snapshot_version,semantic_grain_hash,
      semantic_grain_relationship,normalized_value_hash
    ) values (
      p_tenant_id,fact_id,reconciliation_row.fund_id,fact.subject_type,fact.subject_id,fact.metric_code,
      fact.economic_period,
      fact.normalized_value || jsonb_build_object(
        'semanticDimensions',fact.semantic_dimensions,
        'semanticGrainHash',fact.grain_hash,
        'semanticGrainRelationship',case
          when fact.grain_variant_count > 1 then 'conflicting_alternative'
          when fact.observation_count > 1 then 'equivalent_grain'
          else 'single_observation'
        end,
        'reconciliationRunId',p_reconciliation_run_id::text
      ),
      fact.source_observation_ids,'consolidation_v1',now(),
      p_reconciliation_run_id,p_snapshot_id,p_snapshot_version,fact.grain_hash,
      case
        when fact.grain_variant_count > 1 then 'conflicting_alternative'
        when fact.observation_count > 1 then 'equivalent_grain'
        else 'single_observation'
      end,
      fact.normalized_hash
    ) on conflict (consolidated_fact_id) do nothing;

    if not exists (
      select 1
      from corvis_consolidated.consolidated_fact cf
      where cf.tenant_id=p_tenant_id
        and cf.consolidated_fact_id=fact_id
        and cf.reconciliation_run_id=p_reconciliation_run_id
        and cf.snapshot_id=p_snapshot_id
        and cf.snapshot_version=p_snapshot_version
        and cf.semantic_grain_hash=fact.grain_hash
        and cf.normalized_value_hash=fact.normalized_hash
        and cf.source_observation_ids=fact.source_observation_ids
        and cf.consolidation_rule_version='consolidation_v1'
    ) then
      raise exception 'existing consolidated fact conflicts with deterministic lineage';
    end if;

    run_fact_ids := array_append(run_fact_ids,fact_id);
  end loop;

  select coalesce(array_agg(distinct id order by id),'{}'::uuid[])
    into run_fact_ids
  from unnest(run_fact_ids) id;
  resolved_fact_count := cardinality(run_fact_ids);
  if resolved_fact_count <= 0 then raise exception 'consolidation produced no facts'; end if;

  insert into corvis_consolidated.consolidation_run (
    tenant_id,consolidation_run_id,reconciliation_run_id,document_id,snapshot_id,snapshot_version,
    idempotency_key,consolidation_rule_version,status,fact_ids,fact_count,
    source_observation_count,created_at,completed_at
  ) values (
    p_tenant_id,run_id,p_reconciliation_run_id,p_document_id,p_snapshot_id,p_snapshot_version,
    p_idempotency_key,'consolidation_v1','ready',run_fact_ids,resolved_fact_count,
    resolved_source_count,now(),now()
  );

  existing_fact_ids := snapshot_row.fact_ids;
  select coalesce(array_agg(distinct id order by id),'{}'::uuid[])
    into existing_fact_ids
  from unnest(existing_fact_ids || run_fact_ids) id;

  update corvis_consolidated.fund_period_snapshot
  set fact_ids=existing_fact_ids
  where tenant_id=p_tenant_id and snapshot_id=p_snapshot_id and version=p_snapshot_version;

  select * into existing_run
  from corvis_consolidated.consolidation_run
  where tenant_id=p_tenant_id and consolidation_run_id=run_id;

  return query select
    existing_run.consolidation_run_id,existing_run.reconciliation_run_id,
    existing_run.snapshot_id,existing_run.snapshot_version,reconciliation_row.fund_id,
    reconciliation_row.report_period,existing_run.fact_count,
    existing_run.source_observation_count,true;
end;
$$;

-- Persistence-bound completion guard. Application code cannot create publication
-- work unless the exact consolidation run is ready, all facts exist with retained
-- observation lineage, and the draft snapshot contains those exact facts.
create or replace function corvis_consolidated.enforce_ready_consolidation_before_success()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_consolidated, corvis_facts
as $$
declare
  effect_result jsonb;
  run_id uuid;
  snapshot_value uuid;
  snapshot_version_value integer;
  fact_count_value integer;
begin
  if old.stage='consolidated' and old.state='running' and new.state='succeeded' then
    select e.result into effect_result
    from corvis_control.processing_stage_effect e
    where e.tenant_id=old.tenant_id
      and e.job_id=old.job_id
      and e.document_id=old.document_id
      and e.stage='consolidated'
      and e.state='complete'
    order by e.completed_at desc nulls last
    limit 1;
    if effect_result is null then
      raise exception 'consolidation completion requires committed consolidated-stage effect';
    end if;

    begin
      run_id := (effect_result ->> 'consolidationRunId')::uuid;
      snapshot_value := (effect_result ->> 'snapshotId')::uuid;
      snapshot_version_value := (effect_result ->> 'snapshotVersion')::integer;
      fact_count_value := (effect_result ->> 'factCount')::integer;
    exception when others then
      raise exception 'consolidation completion result is invalid';
    end;

    if effect_result ->> 'consolidationReady' <> 'true' or fact_count_value <= 0 then
      raise exception 'consolidation completion result is not ready';
    end if;

    if not exists (
      select 1
      from corvis_consolidated.consolidation_run r
      join corvis_consolidated.fund_period_snapshot s
        on s.tenant_id=r.tenant_id
       and s.snapshot_id=r.snapshot_id
       and s.version=r.snapshot_version
      where r.tenant_id=old.tenant_id
        and r.consolidation_run_id=run_id
        and r.document_id=old.document_id
        and r.snapshot_id=snapshot_value
        and r.snapshot_version=snapshot_version_value
        and r.status='ready'
        and r.fact_count=fact_count_value
        and r.fact_count=cardinality(r.fact_ids)
        and r.fact_ids <@ s.fact_ids
        and s.status in ('draft','blocked')
        and (
          select count(*)::integer
          from corvis_consolidated.consolidated_fact cf
          where cf.tenant_id=r.tenant_id
            and cf.consolidated_fact_id=any(r.fact_ids)
            and cf.reconciliation_run_id=r.reconciliation_run_id
            and cf.snapshot_id=r.snapshot_id
            and cf.snapshot_version=r.snapshot_version
            and cardinality(cf.source_observation_ids) > 0
        )=r.fact_count
        and (
          select count(distinct observation_id)::integer
          from (
            select unnest(cf.source_observation_ids) as observation_id
            from corvis_consolidated.consolidated_fact cf
            where cf.tenant_id=r.tenant_id
              and cf.consolidated_fact_id=any(r.fact_ids)
          ) source_ids
        )=r.source_observation_count
        and not exists (
          select 1
          from corvis_consolidated.consolidated_fact cf
          cross join lateral unnest(cf.source_observation_ids) source_observation_id
          where cf.tenant_id=r.tenant_id
            and cf.consolidated_fact_id=any(r.fact_ids)
            and not exists (
              select 1 from corvis_facts.observation o
              where o.tenant_id=r.tenant_id and o.observation_id=source_observation_id
            )
        )
    ) then
      raise exception 'consolidation persistence blocks publication';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists processing_job_consolidation_gate_guard
  on corvis_control.processing_job;
create trigger processing_job_consolidation_gate_guard
before update of state on corvis_control.processing_job
for each row
execute function corvis_consolidated.enforce_ready_consolidation_before_success();

commit;
