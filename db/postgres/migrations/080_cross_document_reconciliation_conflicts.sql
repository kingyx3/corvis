-- Cross-document reconciliation: conflicting values are blocked, identical values merge lineage.
-- Depends on migrations 001-079 (028/029/030 originals, 031 in-place patches, 065 replacements).
--
-- Documents for the same fund-period deliberately share one draft snapshot (028), but
-- reconciliation, consolidation and the publication gate only compared observations
-- inside ONE reconciliation run. Two defects followed.
--
-- 1. Conflicting values for the same fact from two documents (same semantic grain, e.g.
--    fund + instrument + period + currency + scenario, but different normalized values)
--    were each classified `single_observation`, opened no exception, passed
--    assert_snapshot_publishable and were summed by the published-value queries.
-- 2. An IDENTICAL fact from a second document that arrived before the first document
--    published hit the deterministic consolidated_fact_id (snapshot + grain + value),
--    and the lineage check demanded the same reconciliation run and source observations,
--    so the consolidated stage raised and permanently dead-lettered.
--
-- Decision (conservative, fail closed, never drop lineage):
--
--  * "Peers" of a reconciliation run are the observations of every OTHER reconciliation
--    run of the same snapshot version (including blocked runs); consolidation also
--    compares the facts already in the draft's fact_ids. Every fact in the draft comes
--    from a reconciliation run of that snapshot, so observations cover facts. The
--    snapshot row is locked FOR UPDATE by reconcile, so the later of two documents
--    always sees the earlier one.
--  * Different normalized value for the same semantic grain across documents is an
--    exact-grain `reconciliation_conflict` exception opened on the LATER document's run
--    (context.conflictScope = 'cross_document', context.observations lists every competing
--    observation across documents). That run is blocked, the stage job blocks, and the
--    snapshot cannot publish while the exception is open. The existing resolution flow
--    (`accept_reconciliation`, which resumes the blocked job) is unchanged. The check
--    runs only when the run is first created, so replays and post-resolution resumes are
--    deterministic and cannot re-block on documents that arrived later.
--  * Consolidation counts a grain's distinct values across the run AND its peers: all
--    facts of a conflicted grain are `conflicting_alternative` (the published-value
--    queries already exclude those from totals), including facts of other documents that
--    were consolidated earlier (their label and value copy are updated; no fact is
--    deleted or has its source_observation_ids reduced).
--  * An accepted conflict still publishes only as retained alternatives, never as a
--    selected or summed number. Choosing one document's value requires the governed
--    correction/republication path. assert_snapshot_publishable now (a) rejects any
--    snapshot whose facts disagree on a grain without all of them being classified
--    `conflicting_alternative` (backstop for facts that bypassed reconcile), and (b)
--    accepts a resolved exception for the grain from any run of the snapshot, because the
--    exception of a cross-document conflict lives on the later document's run.
--  * An identical value from a second document merges: the existing fact keeps its
--    reconciliation_run_id and gets the union of source_observation_ids, is labelled
--    `equivalent_grain`, and the second document's consolidation_run.fact_ids records the
--    shared fact. The deterministic-lineage refusal remains for replays inside the same
--    reconciliation run and for any other disagreement. The consolidated-job success guard
--    (enforce_ready_consolidation_before_success) is widened accordingly: a run's facts
--    may be owned by it or merged into it, and it counts the run's own observations.
--
-- Not covered by design: observations whose grain differs (for instance a different
-- report_date or period_start) are different grains and are retained as separate facts.

begin;

-- All observations of the other reconciliation runs of the same snapshot version, with the
-- exact semantic-grain / normalized-value hashes consolidate_reconciliation stores on facts.
create or replace function corvis_consolidated.snapshot_grain_peer_observations(
  p_tenant_id uuid,
  p_snapshot_id uuid,
  p_snapshot_version integer,
  p_reconciliation_run_id uuid
)
returns table (
  peer_reconciliation_run_id uuid,
  observation_id uuid,
  semantic_grain_hash text,
  normalized_value_hash text,
  normalized_value jsonb,
  risk_tier text,
  subject_type text,
  subject_id text,
  metric_code text,
  source_reference_ids uuid[]
)
language sql
stable
set search_path = pg_catalog, corvis_consolidated, corvis_facts
as $function$
  select r.reconciliation_run_id,o.observation_id,h.grain_hash,md5(h.normalized_value::text),
         h.normalized_value,o.risk_tier,o.subject_type,
         case
           when o.subject_level='fund' then o.fund_id
           when o.subject_level='company' then o.company_id
           when o.subject_level='holding' then o.holding_id::text
           when o.subject_level='instrument' then o.instrument_id::text
           else null
         end,
         o.metric_code,
         coalesce((
           select array_agg(distinct osr.source_reference_id order by osr.source_reference_id)
           from corvis_facts.observation_source_reference osr
           where osr.tenant_id=o.tenant_id and osr.observation_id=o.observation_id
         ),'{}'::uuid[])
  from corvis_consolidated.reconciliation_run r
  join corvis_facts.observation o
    on o.tenant_id=r.tenant_id and o.canonicalization_run_id=r.canonicalization_run_id
  cross join lateral (
    select
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
      )) as normalized_value
  ) h
  where r.tenant_id=p_tenant_id
    and r.snapshot_id=p_snapshot_id
    and r.snapshot_version=p_snapshot_version
    and r.reconciliation_run_id<>p_reconciliation_run_id;
$function$;

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
  run_inserted integer := 0;
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
  get diagnostics run_inserted = row_count;

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

    -- Cross-document: the same semantic grain with a different normalized value in another
    -- reconciliation run of this snapshot. Evaluated once, when this run is first created,
    -- so replays and post-resolution resumes stay deterministic. Every competing
    -- observation (this run's and the other documents') is listed in the exception.
    if run_inserted = 1 then
      for grain in
        with own as (
          select o.observation_id,o.risk_tier,o.subject_type,o.metric_code,
            case
              when o.subject_level='fund' then o.fund_id
              when o.subject_level='company' then o.company_id
              when o.subject_level='holding' then o.holding_id::text
              when o.subject_level='instrument' then o.instrument_id::text
              else null
            end as subject_id,
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
            )) as normalized_value
          from corvis_facts.observation o
          where o.tenant_id=p_tenant_id and o.canonicalization_run_id=p_canonicalization_run_id
        ), peers as (
          select * from corvis_consolidated.snapshot_grain_peer_observations(
            p_tenant_id,target_snapshot_id,1,run_id)
        ), conflicting as (
          select distinct own.grain_hash
          from own
          join peers on peers.semantic_grain_hash=own.grain_hash
           and peers.normalized_value_hash<>md5(own.normalized_value::text)
        ), members as (
          select own.grain_hash,own.observation_id,own.normalized_value,own.risk_tier,
                 own.subject_type,own.subject_id,own.metric_code,
                 null::uuid as peer_run_id,
                 coalesce((
                   select array_agg(distinct osr.source_reference_id)
                   from corvis_facts.observation_source_reference osr
                   where osr.tenant_id=p_tenant_id and osr.observation_id=own.observation_id
                 ),'{}'::uuid[]) as source_reference_ids
          from own
          where own.grain_hash in (select conflicting.grain_hash from conflicting)
          union all
          select peers.semantic_grain_hash,peers.observation_id,peers.normalized_value,peers.risk_tier,
                 peers.subject_type,peers.subject_id,peers.metric_code,
                 peers.peer_reconciliation_run_id,peers.source_reference_ids
          from peers
          where peers.semantic_grain_hash in (select conflicting.grain_hash from conflicting)
        )
        select m.grain_hash,
          min(m.subject_type) as subject_type,
          min(m.subject_id) as subject_id,
          min(m.metric_code) as metric_code,
          count(*)::integer as observation_count,
          bool_or(m.risk_tier='critical') as has_critical,
          jsonb_agg(jsonb_build_object(
            'observationId',m.observation_id::text,
            'value',m.normalized_value,
            'riskTier',m.risk_tier
          ) order by m.observation_id::text) as observations,
          coalesce((
            select array_agg(distinct ref order by ref)
            from members x cross join lateral unnest(x.source_reference_ids) ref
            where x.grain_hash=m.grain_hash
          ),'{}'::uuid[]) as source_reference_ids,
          coalesce((
            select jsonb_agg(distinct x.peer_run_id::text)
            from members x
            where x.grain_hash=m.grain_hash and x.peer_run_id is not null
          ),'[]'::jsonb) as peer_reconciliation_run_ids
        from members m
        group by m.grain_hash
        order by m.grain_hash
      loop
        insert into corvis_consolidated.reconciliation_exception (
          tenant_id,reconciliation_run_id,snapshot_id,snapshot_version,exception_key,
          fund_id,report_period,exception_type,subject_type,subject_id,metric_code,
          summary,materiality,competing_source_reference_ids,context,status,version,
          created_by,created_at
        ) values (
          p_tenant_id,run_id,target_snapshot_id,1,
          'reconciliation-v1:cross-document:' || p_canonicalization_run_id::text || ':' || grain.grain_hash,
          resolved_fund_id,resolved_report_period,'reconciliation_conflict',grain.subject_type,
          grain.subject_id,grain.metric_code,'Exact semantic-grain observations disagree across documents',
          case when grain.has_critical then 'material' else 'unknown' end,
          grain.source_reference_ids,
          jsonb_build_object(
            'semanticGrainHash',grain.grain_hash,
            'observationCount',grain.observation_count,
            'observations',grain.observations,
            'conflictScope','cross_document',
            'peerReconciliationRunIds',grain.peer_reconciliation_run_ids,
            'policyVersion','reconciliation_v1',
            'sourceAuthoritySelection','explicit_resolution_required'
          ),'open',1,'processing:reconciled',now()
        ) on conflict (tenant_id,snapshot_id,snapshot_version,exception_key) do nothing;
      end loop;
    end if;

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
  fact_relationship text;
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
    ), peer_values as (
      -- Values the same grain already carries elsewhere in this snapshot: observations of
      -- other documents' reconciliation runs and facts already attached to the draft.
      select p.semantic_grain_hash as grain_hash,p.normalized_value_hash as value_hash
      from corvis_consolidated.snapshot_grain_peer_observations(
        p_tenant_id,p_snapshot_id,p_snapshot_version,p_reconciliation_run_id) p
      union
      select cf.semantic_grain_hash,cf.normalized_value_hash
      from corvis_consolidated.consolidated_fact cf
      where cf.tenant_id=p_tenant_id
        and cf.consolidated_fact_id=any(snapshot_row.fact_ids)
        and cf.reconciliation_run_id is distinct from p_reconciliation_run_id
        and cf.semantic_grain_hash is not null
        and cf.normalized_value_hash is not null
    ), classified as (
      select g.*,
        (
          select count(distinct v.value_hash)
          from (
            select g2.normalized_hash as value_hash from grouped g2 where g2.grain_hash=g.grain_hash
            union
            select pv.value_hash from peer_values pv where pv.grain_hash=g.grain_hash
          ) v
        )::integer as grain_variant_count,
        exists (
          select 1 from peer_values pv
          where pv.grain_hash=g.grain_hash and pv.value_hash=g.normalized_hash
        ) as peer_equivalent
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

    fact_relationship := case
      when fact.grain_variant_count > 1 then 'conflicting_alternative'
      when fact.observation_count > 1 or fact.peer_equivalent then 'equivalent_grain'
      else 'single_observation'
    end;

    -- An identical value that another document's run already consolidated into this draft
    -- (same snapshot + grain + normalized value => same deterministic fact id) is merged:
    -- the fact keeps its first reconciliation run and gains this run's source observations.
    -- A replay inside the SAME reconciliation run never merges and must match exactly.
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
        'semanticGrainRelationship',fact_relationship,
        'reconciliationRunId',p_reconciliation_run_id::text
      ),
      fact.source_observation_ids,'consolidation_v1',now(),
      p_reconciliation_run_id,p_snapshot_id,p_snapshot_version,fact.grain_hash,
      fact_relationship,
      fact.normalized_hash
    ) on conflict (consolidated_fact_id) do update
    set source_observation_ids=(
          select array_agg(distinct merged.observation_id order by merged.observation_id)
          from unnest(corvis_consolidated.consolidated_fact.source_observation_ids || excluded.source_observation_ids)
            as merged(observation_id)
        ),
        semantic_grain_relationship=case
          when corvis_consolidated.consolidated_fact.semantic_grain_relationship='conflicting_alternative'
            or excluded.semantic_grain_relationship='conflicting_alternative' then 'conflicting_alternative'
          else 'equivalent_grain'
        end,
        value=corvis_consolidated.consolidated_fact.value || jsonb_build_object(
          'semanticGrainRelationship',case
            when corvis_consolidated.consolidated_fact.semantic_grain_relationship='conflicting_alternative'
              or excluded.semantic_grain_relationship='conflicting_alternative' then 'conflicting_alternative'
            else 'equivalent_grain'
          end
        )
    where corvis_consolidated.consolidated_fact.tenant_id=excluded.tenant_id
      and corvis_consolidated.consolidated_fact.reconciliation_run_id is distinct from excluded.reconciliation_run_id
      and corvis_consolidated.consolidated_fact.snapshot_id=excluded.snapshot_id
      and corvis_consolidated.consolidated_fact.snapshot_version=excluded.snapshot_version
      and corvis_consolidated.consolidated_fact.semantic_grain_hash=excluded.semantic_grain_hash
      and corvis_consolidated.consolidated_fact.normalized_value_hash=excluded.normalized_value_hash
      and corvis_consolidated.consolidated_fact.consolidation_rule_version=excluded.consolidation_rule_version;

    if not exists (
      select 1
      from corvis_consolidated.consolidated_fact cf
      where cf.tenant_id=p_tenant_id
        and cf.consolidated_fact_id=fact_id
        and cf.snapshot_id=p_snapshot_id
        and cf.snapshot_version=p_snapshot_version
        and cf.semantic_grain_hash=fact.grain_hash
        and cf.normalized_value_hash=fact.normalized_hash
        and cf.consolidation_rule_version='consolidation_v1'
        and (
          (cf.reconciliation_run_id=p_reconciliation_run_id
            and cf.source_observation_ids=fact.source_observation_ids)
          or (cf.reconciliation_run_id is distinct from p_reconciliation_run_id
            and cf.source_observation_ids @> fact.source_observation_ids)
        )
    ) then
      raise exception 'existing consolidated fact conflicts with deterministic lineage';
    end if;

    -- A grain that now carries more than one value anywhere in the draft makes every
    -- fact of that grain a retained alternative, including facts consolidated earlier
    -- for other documents. Nothing is deleted and no lineage is reduced.
    if fact.grain_variant_count > 1 then
      update corvis_consolidated.consolidated_fact cf
      set semantic_grain_relationship='conflicting_alternative',
          value=cf.value || jsonb_build_object('semanticGrainRelationship','conflicting_alternative')
      where cf.tenant_id=p_tenant_id
        and cf.consolidated_fact_id=any(snapshot_row.fact_ids)
        and cf.semantic_grain_hash=fact.grain_hash
        and cf.semantic_grain_relationship is distinct from 'conflicting_alternative';
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

CREATE OR REPLACE FUNCTION corvis_consolidated.assert_snapshot_publishable(p_tenant_id uuid, p_snapshot_id uuid, p_snapshot_version integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'corvis_consolidated', 'corvis_facts', 'corvis_review', 'corvis_control'
AS $function$
declare
  snapshot_row corvis_consolidated.fund_period_snapshot%rowtype;
  expected_fact_count integer;
  persisted_fact_count integer;
begin
  select * into snapshot_row
  from corvis_consolidated.fund_period_snapshot
  where tenant_id=p_tenant_id
    and snapshot_id=p_snapshot_id
    and version=p_snapshot_version
  for share;
  if not found then raise exception 'publication snapshot is missing'; end if;
  if snapshot_row.status <> 'draft' then
    raise exception 'publication requires a draft snapshot';
  end if;

  expected_fact_count := cardinality(snapshot_row.fact_ids);
  if expected_fact_count <= 0 then raise exception 'publication requires consolidated facts'; end if;

  if exists (
    select 1
    from corvis_consolidated.reconciliation_exception e
    where e.tenant_id=p_tenant_id
      and e.snapshot_id=p_snapshot_id
      and e.snapshot_version=p_snapshot_version
      and e.status='open'
  ) then
    raise exception 'blocking reconciliation exceptions remain';
  end if;

  if exists (
    select 1
    from corvis_control.data_correction_incident c
    where c.tenant_id=p_tenant_id
      and c.fund_id=snapshot_row.fund_id
      and c.report_period=snapshot_row.report_period
      and c.state in ('open','reprocessing')
      and not (c.state='reprocessing' and c.replacement_snapshot_id=p_snapshot_id)
  ) then
    raise exception 'active data correction incident blocks publication';
  end if;

  select count(*)::integer into persisted_fact_count
  from corvis_consolidated.consolidated_fact cf
  where cf.tenant_id=p_tenant_id
    and cf.consolidated_fact_id=any(snapshot_row.fact_ids);
  if persisted_fact_count <> expected_fact_count then
    raise exception 'publication consolidated fact set is incomplete';
  end if;

  -- Every fact must have a ready consolidation owner, retained source observations,
  -- and exact source-reference evidence. This is evaluated over the snapshot fact set,
  -- not merely the most recent document/consolidation run.
  if exists (
    select 1
    from corvis_consolidated.consolidated_fact cf
    where cf.tenant_id=p_tenant_id
      and cf.consolidated_fact_id=any(snapshot_row.fact_ids)
      and (
        cf.reconciliation_run_id is null
        or cf.snapshot_id <> p_snapshot_id
        or cf.snapshot_version <> p_snapshot_version
        or cardinality(cf.source_observation_ids) <= 0
        or not exists (
          select 1
          from corvis_consolidated.consolidation_run cr
          where cr.tenant_id=cf.tenant_id
            and cr.reconciliation_run_id=cf.reconciliation_run_id
            and cr.snapshot_id=p_snapshot_id
            and cr.snapshot_version=p_snapshot_version
            and cr.status='ready'
            and cf.consolidated_fact_id=any(cr.fact_ids)
        )
        or exists (
          select 1
          from unnest(cf.source_observation_ids) source_observation_id
          where not exists (
            select 1
            from corvis_facts.observation o
            where o.tenant_id=cf.tenant_id
              and o.observation_id=source_observation_id
              and o.review_state='approved'
              and exists (
                select 1
                from corvis_facts.observation_source_reference osr
                where osr.tenant_id=o.tenant_id and osr.observation_id=o.observation_id
              )
          )
        )
      )
  ) then
    raise exception 'publication lineage or review coverage is incomplete';
  end if;

  -- Critical canonical observations were reviewed before canonicalization. Recheck
  -- their exact candidate-review requirement and finalized decision-set gate here so
  -- publication does not depend on the older observation-review ledger.
  if exists (
    select 1
    from corvis_consolidated.consolidated_fact cf
    cross join lateral unnest(cf.source_observation_ids) source_observation_id
    join corvis_facts.observation o
      on o.tenant_id=cf.tenant_id and o.observation_id=source_observation_id
    left join corvis_facts.canonicalization_run can
      on can.tenant_id=o.tenant_id and can.canonicalization_run_id=o.canonicalization_run_id
    left join corvis_review.candidate_review_requirement req
      on req.tenant_id=o.tenant_id
     and req.extraction_run_id=can.extraction_run_id
     and req.candidate_id=o.candidate_id
     and req.review_policy_version=can.review_policy_version
    left join corvis_review.extraction_review_gate gate
      on gate.tenant_id=can.tenant_id
     and gate.extraction_run_id=can.extraction_run_id
     and gate.review_policy_version=can.review_policy_version
    where cf.tenant_id=p_tenant_id
      and cf.consolidated_fact_id=any(snapshot_row.fact_ids)
      and o.risk_tier='critical'
      and (
        can.status is distinct from 'ready'
        or req.risk_tier is distinct from 'critical'
        or coalesce(req.required_approvals,0) < 2
        or gate.status is distinct from 'ready'
        or coalesce(gate.blocking_candidate_count,1) <> 0
        or gate.candidate_set_sha256 is distinct from can.candidate_set_sha256
        or gate.decision_set_sha256 is distinct from can.decision_set_sha256
      )
  ) then
    raise exception 'critical observations require finalized independent review';
  end if;

  -- Backstop independent of reconcile/consolidate: facts of ONE snapshot that carry the
  -- same semantic grain with different normalized values are never publishable as ordinary
  -- facts (the published-value queries would sum them). Every such fact must be a retained
  -- conflicting alternative, and the resolution gate below then requires an attributable
  -- resolution. Facts of different documents are compared because fact_ids spans them all.
  if exists (
    select 1
    from corvis_consolidated.consolidated_fact cf
    where cf.tenant_id=p_tenant_id
      and cf.consolidated_fact_id=any(snapshot_row.fact_ids)
      and cf.semantic_grain_hash is not null
    group by cf.semantic_grain_hash
    having count(distinct cf.normalized_value_hash) > 1
       and bool_or(cf.semantic_grain_relationship is distinct from 'conflicting_alternative')
  ) then
    raise exception 'snapshot facts disagree on a semantic grain without conflicting-alternative classification';
  end if;

  -- Conflicting alternatives may be published only when the corresponding exact
  -- semantic-grain conflict was explicitly resolved. Consolidation still retains all
  -- alternatives; this gate proves that retaining them was an attributable decision.
  -- The resolved exception may belong to any reconciliation run of the snapshot: a
  -- cross-document conflict is opened on the later document's run, while the earlier
  -- document's facts are conflicting alternatives of the same exact grain.
  if exists (
    select 1
    from corvis_consolidated.consolidated_fact cf
    where cf.tenant_id=p_tenant_id
      and cf.consolidated_fact_id=any(snapshot_row.fact_ids)
      and cf.semantic_grain_relationship='conflicting_alternative'
      and not exists (
        select 1
        from corvis_consolidated.reconciliation_exception e
        where e.tenant_id=cf.tenant_id
          and e.snapshot_id=p_snapshot_id
          and e.snapshot_version=p_snapshot_version
          and e.status='resolved'
          and e.context ->> 'semanticGrainHash'=cf.semantic_grain_hash
          and exists (
            select 1
            from corvis_consolidated.reconciliation_resolution_event r
            where r.tenant_id=e.tenant_id and r.exception_id=e.exception_id
          )
      )
  ) then
    raise exception 'conflicting alternatives require attributable reconciliation resolution';
  end if;
end;
$function$;


CREATE OR REPLACE FUNCTION corvis_consolidated.enforce_ready_consolidation_before_success()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated', 'corvis_facts'
AS $function$
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
          -- Every fact of the run is either owned by the run or an identical fact first
          -- consolidated for another document of the snapshot (migration 080) that now
          -- also carries this run's source observations.
          select count(*)::integer
          from corvis_consolidated.consolidated_fact cf
          where cf.tenant_id=r.tenant_id
            and cf.consolidated_fact_id=any(r.fact_ids)
            and cf.snapshot_id=r.snapshot_id
            and cf.snapshot_version=r.snapshot_version
            and cardinality(cf.source_observation_ids) > 0
            and (
              cf.reconciliation_run_id=r.reconciliation_run_id
              or exists (
                select 1
                from corvis_consolidated.reconciliation_run rr
                join corvis_facts.observation ro
                  on ro.tenant_id=rr.tenant_id and ro.canonicalization_run_id=rr.canonicalization_run_id
                where rr.tenant_id=r.tenant_id
                  and rr.reconciliation_run_id=r.reconciliation_run_id
                  and ro.observation_id=any(cf.source_observation_ids)
              )
            )
        )=r.fact_count
        and (
          -- This run's own observations, as retained by the facts it produced or merged into.
          select count(distinct source_ids.observation_id)::integer
          from (
            select unnest(cf.source_observation_ids) as observation_id
            from corvis_consolidated.consolidated_fact cf
            where cf.tenant_id=r.tenant_id
              and cf.consolidated_fact_id=any(r.fact_ids)
          ) source_ids
          join corvis_facts.observation so
            on so.tenant_id=r.tenant_id and so.observation_id=source_ids.observation_id
          join corvis_consolidated.reconciliation_run sr
            on sr.tenant_id=r.tenant_id
           and sr.reconciliation_run_id=r.reconciliation_run_id
           and sr.canonicalization_run_id=so.canonicalization_run_id
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
$function$;

commit;
