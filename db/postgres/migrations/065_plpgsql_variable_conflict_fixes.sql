-- Fix PL/pgSQL OUT-parameter/column name collisions (SQLSTATE 42702).
-- Depends on migrations 001-064.
--
-- These functions are declared RETURNS TABLE(...), whose column names become
-- PL/pgSQL variables. Their bodies also reference same-named table columns
-- unqualified (ON CONFLICT targets, WHERE and SELECT lists), so the first
-- execution raised "column reference ... is ambiguous". Migration 042 fixed
-- canonicalization the same way. Earlier migrations stay byte-identical so
-- recorded ledger checksums remain valid; only the function bodies are
-- replaced here, keeping signature, owner, SECURITY attributes and grants.

begin;

CREATE OR REPLACE FUNCTION corvis_consolidated.reconcile_canonicalization(p_tenant_id uuid, p_document_id uuid, p_canonicalization_run_id uuid, p_extraction_run_id uuid, p_candidate_set_sha256 text, p_decision_set_sha256 text, p_observation_count integer, p_source_reference_count integer, p_idempotency_key text)
 RETURNS TABLE(reconciliation_run_id uuid, canonicalization_run_id uuid, snapshot_id uuid, snapshot_version integer, fund_id text, report_period text, schema_version text, taxonomy_version text, observation_count integer, blocking_exception_count integer, reconciliation_ready boolean)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'corvis_consolidated', 'corvis_facts', 'corvis_source', 'corvis_semantic', 'corvis_control'
AS $function$
#variable_conflict use_column
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
      and j.job_id=corvis_control.processing_predecessor_job_for_effect(p_tenant_id,p_document_id,'reconciled',p_idempotency_key,'canonicalized')
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

  -- The predecessor count covers all reviewed candidate evidence, including entity
  -- and exception candidates that do not become canonical observations. Validate that
  -- complete retained evidence set independently from observation-specific lineage.
  select count(*)::integer into actual_reference_count
  from corvis_source.source_reference sr
  where sr.tenant_id=p_tenant_id
    and sr.extraction_run_id=p_extraction_run_id
    and sr.document_id=p_document_id;
  if actual_reference_count <> p_source_reference_count then
    raise exception 'reconciliation retained source-reference set is incomplete';
  end if;

  -- Every canonical observation must independently retain at least one exact source
  -- reference from this document/extraction run.
  if exists (
    select 1 from corvis_facts.observation o
    where o.tenant_id=p_tenant_id and o.canonicalization_run_id=p_canonicalization_run_id
      and not exists (
        select 1
        from corvis_facts.observation_source_reference osr
        join corvis_source.source_reference sr
          on sr.tenant_id=osr.tenant_id and sr.source_reference_id=osr.source_reference_id
        where osr.tenant_id=o.tenant_id and osr.observation_id=o.observation_id
          and sr.document_id=p_document_id and sr.extraction_run_id=p_extraction_run_id
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

  run_id := md5(p_tenant_id::text || ':' || p_canonicalization_run_id::text || ':reconciliation-v1' || corvis_control.processing_replay_scope_for_effect(p_tenant_id,p_document_id,'reconciled',p_idempotency_key))::uuid;
  target_snapshot_id := md5(p_tenant_id::text || ':' || resolved_fund_id || ':' || resolved_report_period || corvis_control.processing_replay_scope_for_effect(p_tenant_id,p_document_id,'reconciled',p_idempotency_key))::uuid;

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
            coalesce(o.company_id,''),coalesce(o.holding_id::text,''),coalesce(o.instrument_id::text,''),
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
            when subject_level='holding' then holding_id::text
            when subject_level='instrument' then instrument_id::text
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
$function$;

CREATE OR REPLACE FUNCTION corvis_consolidated.consolidate_reconciliation(p_tenant_id uuid, p_document_id uuid, p_reconciliation_run_id uuid, p_snapshot_id uuid, p_snapshot_version integer, p_expected_observation_count integer, p_idempotency_key text)
 RETURNS TABLE(consolidation_run_id uuid, reconciliation_run_id uuid, snapshot_id uuid, snapshot_version integer, fund_id text, report_period text, fact_count integer, source_observation_count integer, consolidation_ready boolean)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'corvis_consolidated', 'corvis_facts', 'corvis_control'
AS $function$
#variable_conflict use_column
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
      and j.job_id=corvis_control.processing_predecessor_job_for_effect(p_tenant_id,p_document_id,'consolidated',p_idempotency_key,'reconciled')
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
$function$;

CREATE OR REPLACE FUNCTION corvis_consolidated.publish_consolidation(p_tenant_id uuid, p_document_id uuid, p_consolidation_run_id uuid, p_snapshot_id uuid, p_source_snapshot_version integer, p_idempotency_key text)
 RETURNS TABLE(publication_run_id uuid, consolidation_run_id uuid, snapshot_id uuid, source_snapshot_version integer, snapshot_version integer, publication_event_id uuid, fact_count integer, publication_ready boolean)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'corvis_consolidated', 'corvis_control'
AS $function$
#variable_conflict use_column
declare
  consolidation_row corvis_consolidated.consolidation_run%rowtype;
  source_snapshot corvis_consolidated.fund_period_snapshot%rowtype;
  target_snapshot corvis_consolidated.fund_period_snapshot%rowtype;
  existing_run corvis_consolidated.publication_run%rowtype;
  existing_event corvis_consolidated.snapshot_publication_event%rowtype;
  run_id uuid;
  event_id uuid;
  target_version integer;
  snapshot_fact_count integer;
begin
  if p_source_snapshot_version <= 0 then raise exception 'publication requires positive source snapshot version'; end if;
  if p_idempotency_key is null or btrim(p_idempotency_key)='' then raise exception 'publication requires idempotency key'; end if;

  select * into consolidation_row
  from corvis_consolidated.consolidation_run
  where tenant_id=p_tenant_id
    and consolidation_run_id=p_consolidation_run_id
    and document_id=p_document_id
    and snapshot_id=p_snapshot_id
    and snapshot_version=p_source_snapshot_version
    and status='ready'
  for share;
  if not found then raise exception 'publication requires exact ready consolidation run'; end if;

  -- A direct database call cannot skip the committed successful consolidated stage.
  if not exists (
    select 1
    from corvis_control.processing_job j
    join corvis_control.processing_stage_effect e
      on e.tenant_id=j.tenant_id and e.job_id=j.job_id
    where j.tenant_id=p_tenant_id
      and j.job_id=corvis_control.processing_predecessor_job_for_effect(p_tenant_id,p_document_id,'published',p_idempotency_key,'consolidated')
      and j.document_id=p_document_id
      and j.stage='consolidated'
      and j.state='succeeded'
      and e.stage='consolidated'
      and e.state='complete'
      and e.result ->> 'consolidationRunId'=p_consolidation_run_id::text
      and e.result ->> 'snapshotId'=p_snapshot_id::text
      and (e.result ->> 'snapshotVersion')::integer=p_source_snapshot_version
      and e.result ->> 'consolidationReady'='true'
  ) then
    raise exception 'publication requires committed consolidated-stage predecessor effect';
  end if;

  run_id := md5(p_tenant_id::text || ':' || p_consolidation_run_id::text || ':publication-v1')::uuid;

  select * into existing_run
  from corvis_consolidated.publication_run
  where tenant_id=p_tenant_id and publication_run_id=run_id
  for share;
  if found then
    if existing_run.consolidation_run_id <> p_consolidation_run_id
      or existing_run.document_id <> p_document_id
      or existing_run.snapshot_id <> p_snapshot_id
      or existing_run.source_snapshot_version <> p_source_snapshot_version
      or existing_run.idempotency_key <> p_idempotency_key then
      raise exception 'existing publication run conflicts with consolidation lineage';
    end if;
    return query select
      existing_run.publication_run_id,existing_run.consolidation_run_id,
      existing_run.snapshot_id,existing_run.source_snapshot_version,
      existing_run.published_snapshot_version,existing_run.publication_event_id,
      existing_run.fact_count,true;
    return;
  end if;

  select * into source_snapshot
  from corvis_consolidated.fund_period_snapshot
  where tenant_id=p_tenant_id and snapshot_id=p_snapshot_id and version=p_source_snapshot_version
  for update;
  if not found then raise exception 'publication source snapshot is missing'; end if;

  perform corvis_consolidated.assert_snapshot_publishable(p_tenant_id,p_snapshot_id,p_source_snapshot_version);

  target_version := p_source_snapshot_version + 1;
  snapshot_fact_count := cardinality(source_snapshot.fact_ids);
  if snapshot_fact_count <= 0 then raise exception 'publication source snapshot has no facts'; end if;

  -- If an authorized manual publish won the race, adopt that identical immutable
  -- version instead of creating a second published version.
  select * into target_snapshot
  from corvis_consolidated.fund_period_snapshot
  where tenant_id=p_tenant_id and snapshot_id=p_snapshot_id and version=target_version
  for share;

  if found then
    if target_snapshot.status <> 'published'
      or target_snapshot.fund_id <> source_snapshot.fund_id
      or target_snapshot.report_period <> source_snapshot.report_period
      or target_snapshot.fact_ids <> source_snapshot.fact_ids
      or target_snapshot.schema_version <> source_snapshot.schema_version
      or target_snapshot.taxonomy_version <> source_snapshot.taxonomy_version then
      raise exception 'existing next snapshot version conflicts with publication';
    end if;

    select * into existing_event
    from corvis_consolidated.snapshot_publication_event pe
    where pe.tenant_id=p_tenant_id
      and pe.snapshot_id=p_snapshot_id
      and pe.from_version=p_source_snapshot_version
      and pe.to_version=target_version
      and pe.action='publish'
    order by pe.created_at
    limit 1;
    if not found then raise exception 'existing published snapshot is missing publication event'; end if;
    event_id := existing_event.publication_event_id;
  else
    event_id := md5(p_tenant_id::text || ':' || p_consolidation_run_id::text || ':publication-event-v1')::uuid;

    insert into corvis_consolidated.fund_period_snapshot (
      tenant_id,snapshot_id,fund_id,report_period,version,status,fact_ids,blocking_exception_count,
      schema_version,taxonomy_version,created_at,published_at
    ) values (
      source_snapshot.tenant_id,source_snapshot.snapshot_id,source_snapshot.fund_id,source_snapshot.report_period,
      target_version,'published',source_snapshot.fact_ids,0,source_snapshot.schema_version,
      source_snapshot.taxonomy_version,now(),now()
    );

    insert into corvis_consolidated.snapshot_publication_event (
      tenant_id,publication_event_id,snapshot_id,from_version,to_version,action,actor_subject,reason,created_at
    ) values (
      p_tenant_id,event_id,p_snapshot_id,p_source_snapshot_version,target_version,'publish',
      'processing:published','automated_processing_gate_v1',now()
    );

    insert into corvis_control.outbox_event (
      tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at
    ) values (
      p_tenant_id,
      md5(p_tenant_id::text || ':' || event_id::text || ':snapshot-publication-changed')::uuid,
      'SnapshotPublicationChanged','fund_period_snapshot',p_snapshot_id::text,
      jsonb_build_object(
        'action','publish','actor','processing:published','reason','automated_processing_gate_v1',
        'version',target_version,'consolidationRunId',p_consolidation_run_id
      ),now()
    ) on conflict (tenant_id,event_id) do nothing;
  end if;

  insert into corvis_consolidated.publication_run (
    tenant_id,publication_run_id,consolidation_run_id,document_id,snapshot_id,
    source_snapshot_version,published_snapshot_version,publication_event_id,idempotency_key,
    status,fact_count,created_at,completed_at
  ) values (
    p_tenant_id,run_id,p_consolidation_run_id,p_document_id,p_snapshot_id,
    p_source_snapshot_version,target_version,event_id,p_idempotency_key,
    'ready',snapshot_fact_count,now(),now()
  );

  select * into existing_run
  from corvis_consolidated.publication_run
  where tenant_id=p_tenant_id and publication_run_id=run_id;

  return query select
    existing_run.publication_run_id,existing_run.consolidation_run_id,
    existing_run.snapshot_id,existing_run.source_snapshot_version,
    existing_run.published_snapshot_version,existing_run.publication_event_id,
    existing_run.fact_count,true;
end;
$function$;

CREATE OR REPLACE FUNCTION corvis_control.accept_tenant_invitation(p_token_sha256 text, p_auth_method text, p_subject text, p_email text, p_email_verified boolean, p_correlation_id text)
 RETURNS TABLE(invitation_id uuid, tenant_id uuid, workspace_id uuid, user_id uuid, role_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'corvis_control', 'public'
AS $function$
#variable_conflict use_column
declare
  v_invitation corvis_control.tenant_invitation%rowtype;
  v_user_id uuid;
begin
  if p_auth_method is null or p_auth_method not in ('oidc','saml') or p_subject is null or length(p_subject) not between 1 and 1024
    or p_email_verified is distinct from true or p_email is null or length(btrim(p_email)) = 0 then
    raise exception using errcode = '22023', message = 'invalid_invitation_identity';
  end if;
  select * into v_invitation
    from corvis_control.tenant_invitation
    where token_sha256 = p_token_sha256
    for update;
  if not found then raise exception using errcode = 'P0002', message = 'invitation_not_found'; end if;
  if v_invitation.status <> 'pending' then raise exception using errcode = 'P0001', message = 'invitation_not_pending'; end if;
  if lower(btrim(p_email)) <> v_invitation.email then
    raise exception using errcode = '42501', message = 'invitation_email_mismatch';
  end if;
  if v_invitation.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'invitation_expired';
  end if;

  select s.user_id into v_user_id
    from corvis_control.identity_subject s
    where s.tenant_id=v_invitation.tenant_id and s.auth_method=p_auth_method and s.subject=p_subject
    for update;
  if found then
    if exists (
      select 1 from corvis_control.identity_subject s
      where s.tenant_id=v_invitation.tenant_id and s.auth_method=p_auth_method and s.subject=p_subject and s.status <> 'active'
    ) then raise exception using errcode = 'P0001', message = 'invitation_identity_disabled'; end if;
  else
    v_user_id := gen_random_uuid();
    insert into corvis_control.identity_subject(tenant_id,user_id,auth_method,subject)
      values(v_invitation.tenant_id,v_user_id,p_auth_method,p_subject);
  end if;

  if exists (
    select 1 from corvis_control.membership m
    where m.tenant_id=v_invitation.tenant_id and m.workspace_id=v_invitation.workspace_id
      and m.user_id=v_user_id and m.role_name=v_invitation.role_name
      and m.status='active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
  ) then raise exception using errcode = 'P0001', message = 'invitation_membership_exists'; end if;

  insert into corvis_control.membership(tenant_id,workspace_id,user_id,role_name)
    values(v_invitation.tenant_id,v_invitation.workspace_id,v_user_id,v_invitation.role_name)
    on conflict (tenant_id,workspace_id,user_id,role_name) do update
      set status='active', valid_from=now(), valid_until=null;

  update corvis_control.tenant_invitation
    set status='accepted', accepted_at=now(), accepted_user_id=v_user_id
    where invitation_id=v_invitation.invitation_id;

  insert into corvis_control.audit_event(
    tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata
  ) values (
    v_invitation.tenant_id,v_invitation.workspace_id,p_subject,'tenant_invitation.accepted',
    'tenant_invitation',v_invitation.invitation_id::text,'success',p_correlation_id,
    jsonb_build_object('roleName',v_invitation.role_name,'invitedEmail',v_invitation.email,'userId',v_user_id)
  );

  return query select v_invitation.invitation_id,v_invitation.tenant_id,v_invitation.workspace_id,v_user_id,v_invitation.role_name;
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
$function$;

commit;
