-- Corvis Postgres baseline schema.
--
-- The complete control plane, source, facts, review, consolidated, semantic, identity and serving schemas, with their
-- row level security, constraints, functions, triggers and reference data (the governed sector taxonomy), as one
-- forward-only baseline for a new database. Nothing was deployed before this baseline, so it replaces the incremental
-- history (the 99 earlier migrations, including their corrective, repair and backfill steps) with the schema they
-- converge on; the history remains in Git. Every later change is a new numbered migration after this one.
--
-- Generated from that converged schema with pg_dump (schema-only, no owners) and reviewed; it assumes a
-- Supabase-style layout where `auth.uid()` exists. The least-privilege runtime role and its grants follow in
-- 002_runtime_database_role.sql.

begin;

set local check_function_bodies = off;

-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)


--
-- Name: corvis_consolidated; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA corvis_consolidated;


--
-- Name: corvis_control; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA corvis_control;


--
-- Name: corvis_facts; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA corvis_facts;


--
-- Name: corvis_identity; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA corvis_identity;


--
-- Name: corvis_review; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA corvis_review;


--
-- Name: corvis_semantic; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA corvis_semantic;


--
-- Name: corvis_serving; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA corvis_serving;


--
-- Name: corvis_source; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA corvis_source;


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto;


--
-- Name: append_snapshot_transition(uuid, uuid, integer, uuid, text, text, text); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.append_snapshot_transition(p_tenant_id uuid, p_snapshot_id uuid, p_expected_version integer, p_publication_event_id uuid, p_action text, p_actor_subject text, p_reason text DEFAULT NULL::text) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_consolidated', 'corvis_control'
    AS $$
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

  if p_action='publish' then
    perform corvis_consolidated.assert_snapshot_publishable(p_tenant_id,p_snapshot_id,p_expected_version);
  end if;

  next_status := case p_action when 'publish' then 'published' when 'withdraw' then 'withdrawn' else 'superseded' end;
  next_version := p_expected_version + 1;

  insert into corvis_consolidated.fund_period_snapshot
    (tenant_id,snapshot_id,fund_id,report_period,version,status,fact_ids,blocking_exception_count,
     schema_version,taxonomy_version,created_at,published_at)
  values (
    current_row.tenant_id,current_row.snapshot_id,current_row.fund_id,current_row.report_period,
    next_version,next_status,current_row.fact_ids,current_row.blocking_exception_count,
    current_row.schema_version,current_row.taxonomy_version,now(),
    case when next_status='published' then now() else current_row.published_at end
  );

  insert into corvis_consolidated.snapshot_publication_event
    (tenant_id,publication_event_id,snapshot_id,from_version,to_version,action,actor_subject,reason)
  values (p_tenant_id,p_publication_event_id,p_snapshot_id,p_expected_version,next_version,p_action,p_actor_subject,p_reason);

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,
    md5(p_tenant_id::text || ':' || p_publication_event_id::text || ':snapshot-publication-changed')::uuid,
    'SnapshotPublicationChanged','fund_period_snapshot',p_snapshot_id::text,
    jsonb_build_object('action',p_action,'actor',p_actor_subject,'reason',p_reason,'version',next_version),now()
  ) on conflict (tenant_id,event_id) do nothing;

  return next_version;
end;
$$;


--
-- Name: assert_snapshot_publishable(uuid, uuid, integer); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.assert_snapshot_publishable(p_tenant_id uuid, p_snapshot_id uuid, p_snapshot_version integer) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_consolidated', 'corvis_facts', 'corvis_review', 'corvis_control'
    AS $$
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
$$;


--
-- Name: consolidate_reconciliation(uuid, uuid, uuid, uuid, integer, integer, text); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.consolidate_reconciliation(p_tenant_id uuid, p_document_id uuid, p_reconciliation_run_id uuid, p_snapshot_id uuid, p_snapshot_version integer, p_expected_observation_count integer, p_idempotency_key text) RETURNS TABLE(consolidation_run_id uuid, reconciliation_run_id uuid, snapshot_id uuid, snapshot_version integer, fund_id text, report_period text, fact_count integer, source_observation_count integer, consolidation_ready boolean)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_consolidated', 'corvis_facts', 'corvis_control'
    AS $$
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
$$;


--
-- Name: enforce_ready_consolidation_before_success(); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.enforce_ready_consolidation_before_success() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated', 'corvis_facts'
    AS $$
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
          -- consolidated for another document of the snapshot that now
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
$$;


--
-- Name: enforce_ready_publication_before_success(); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.enforce_ready_publication_before_success() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated'
    AS $$
declare
  effect_result jsonb;
  run_id uuid;
  snapshot_value uuid;
  snapshot_version_value integer;
  event_id uuid;
  fact_count_value integer;
begin
  if old.stage='published' and old.state='running' and new.state='succeeded' then
    select e.result into effect_result
    from corvis_control.processing_stage_effect e
    where e.tenant_id=old.tenant_id
      and e.job_id=old.job_id
      and e.document_id=old.document_id
      and e.stage='published'
      and e.state='complete'
    order by e.completed_at desc nulls last
    limit 1;
    if effect_result is null then
      raise exception 'publication completion requires committed published-stage effect';
    end if;

    begin
      run_id := (effect_result ->> 'publicationRunId')::uuid;
      snapshot_value := (effect_result ->> 'snapshotId')::uuid;
      snapshot_version_value := (effect_result ->> 'snapshotVersion')::integer;
      event_id := (effect_result ->> 'publicationEventId')::uuid;
      fact_count_value := (effect_result ->> 'factCount')::integer;
    exception when others then
      raise exception 'publication completion result is invalid';
    end;

    if effect_result ->> 'publicationReady' <> 'true' or fact_count_value <= 0 then
      raise exception 'publication completion result is not ready';
    end if;

    if not exists (
      select 1
      from corvis_consolidated.publication_run r
      join corvis_consolidated.fund_period_snapshot s
        on s.tenant_id=r.tenant_id
       and s.snapshot_id=r.snapshot_id
       and s.version=r.published_snapshot_version
      join corvis_consolidated.snapshot_publication_event pe
        on pe.tenant_id=r.tenant_id and pe.publication_event_id=r.publication_event_id
      where r.tenant_id=old.tenant_id
        and r.publication_run_id=run_id
        and r.document_id=old.document_id
        and r.snapshot_id=snapshot_value
        and r.published_snapshot_version=snapshot_version_value
        and r.publication_event_id=event_id
        and r.fact_count=fact_count_value
        and r.status='ready'
        and s.status='published'
        and cardinality(s.fact_ids)=r.fact_count
        and pe.snapshot_id=r.snapshot_id
        and pe.from_version=r.source_snapshot_version
        and pe.to_version=r.published_snapshot_version
        and pe.action='publish'
    ) then
      raise exception 'publication persistence blocks published-stage success';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: enforce_ready_reconciliation_before_success(); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.enforce_ready_reconciliation_before_success() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated'
    AS $$
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


--
-- Name: inherit_snapshot_review_deadline(); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.inherit_snapshot_review_deadline() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.review_deadline_at is null and new.version > 1 then
    select previous.review_deadline_at
      into new.review_deadline_at
    from corvis_consolidated.fund_period_snapshot previous
    where previous.tenant_id=new.tenant_id
      and previous.snapshot_id=new.snapshot_id
      and previous.version < new.version
    order by previous.version desc
    limit 1;
  end if;
  return new;
end;
$$;


--
-- Name: publish_consolidation(uuid, uuid, uuid, uuid, integer, text); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.publish_consolidation(p_tenant_id uuid, p_document_id uuid, p_consolidation_run_id uuid, p_snapshot_id uuid, p_source_snapshot_version integer, p_idempotency_key text) RETURNS TABLE(publication_run_id uuid, consolidation_run_id uuid, snapshot_id uuid, source_snapshot_version integer, snapshot_version integer, publication_event_id uuid, fact_count integer, publication_ready boolean)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_consolidated', 'corvis_control'
    AS $$
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
$$;


--
-- Name: reconcile_canonicalization(uuid, uuid, uuid, uuid, text, text, integer, integer, text); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.reconcile_canonicalization(p_tenant_id uuid, p_document_id uuid, p_canonicalization_run_id uuid, p_extraction_run_id uuid, p_candidate_set_sha256 text, p_decision_set_sha256 text, p_observation_count integer, p_source_reference_count integer, p_idempotency_key text) RETURNS TABLE(reconciliation_run_id uuid, canonicalization_run_id uuid, snapshot_id uuid, snapshot_version integer, fund_id text, report_period text, schema_version text, taxonomy_version text, observation_count integer, blocking_exception_count integer, reconciliation_ready boolean)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_consolidated', 'corvis_facts', 'corvis_source', 'corvis_semantic', 'corvis_control'
    AS $_$
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
$_$;


--
-- Name: resolve_reconciliation_exception(uuid, uuid, integer, uuid, text, text, text, uuid, text); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.resolve_reconciliation_exception(p_tenant_id uuid, p_exception_id uuid, p_expected_version integer, p_resolution_event_id uuid, p_actor_subject text, p_action text, p_reason_code text, p_selected_source_reference_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text) RETURNS TABLE(new_version integer, next_status text)
    LANGUAGE plpgsql
    AS $$
declare
  current_row corvis_consolidated.reconciliation_exception%rowtype;
  before_payload jsonb;
  after_payload jsonb;
begin
  select * into current_row
  from corvis_consolidated.reconciliation_exception
  where tenant_id=p_tenant_id
    and exception_id=p_exception_id
    and version=p_expected_version
    and status='open'
  for update;

  if not found then
    return;
  end if;

  if current_row.exception_type='source_authority' then
    if p_action <> 'select_source' then raise exception 'invalid source-authority resolution'; end if;
    if p_selected_source_reference_id is null or not (p_selected_source_reference_id = any(current_row.competing_source_reference_ids)) then
      raise exception 'selected source is not a competing source';
    end if;
  elsif current_row.exception_type='materiality' then
    if p_action <> 'mark_immaterial' then raise exception 'invalid materiality resolution'; end if;
  elsif current_row.exception_type='reconciliation_conflict' then
    if p_action <> 'accept_reconciliation' then raise exception 'invalid reconciliation resolution'; end if;
  else
    raise exception 'unknown reconciliation exception type';
  end if;

  before_payload := jsonb_build_object(
    'status',current_row.status,
    'version',current_row.version,
    'materiality',current_row.materiality,
    'competingSourceReferenceIds',current_row.competing_source_reference_ids
  );
  after_payload := jsonb_build_object(
    'status','resolved',
    'version',current_row.version + 1,
    'action',p_action,
    'selectedSourceReferenceId',p_selected_source_reference_id,
    'reasonCode',p_reason_code
  );

  insert into corvis_consolidated.reconciliation_resolution_event (
    tenant_id,resolution_event_id,exception_id,exception_version,action,
    selected_source_reference_id,reason_code,note,actor_subject,before_state,after_state,created_at
  ) values (
    p_tenant_id,p_resolution_event_id,p_exception_id,p_expected_version,p_action,
    p_selected_source_reference_id,p_reason_code,p_note,p_actor_subject,before_payload,after_payload,now()
  );

  update corvis_consolidated.reconciliation_exception
  set status='resolved', version=version+1, resolved_by=p_actor_subject, resolved_at=now(),
      materiality=case when p_action='mark_immaterial' then 'immaterial' else materiality end
  where tenant_id=p_tenant_id and exception_id=p_exception_id and version=p_expected_version;

  return query select p_expected_version + 1, 'resolved'::text;
end;
$$;


--
-- Name: resume_reconciliation_after_resolution(); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.resume_reconciliation_after_resolution() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated'
    AS $$
begin
  if old.status='open' and new.status='resolved' and new.reconciliation_run_id is not null then
    perform * from corvis_control.resume_blocked_reconciled_stage(new.tenant_id,new.exception_id);
  end if;
  return new;
end;
$$;


--
-- Name: snapshot_grain_peer_observations(uuid, uuid, integer, uuid); Type: FUNCTION; Schema: corvis_consolidated; Owner: -
--

CREATE FUNCTION corvis_consolidated.snapshot_grain_peer_observations(p_tenant_id uuid, p_snapshot_id uuid, p_snapshot_version integer, p_reconciliation_run_id uuid) RETURNS TABLE(peer_reconciliation_run_id uuid, observation_id uuid, semantic_grain_hash text, normalized_value_hash text, normalized_value jsonb, risk_tier text, subject_type text, subject_id text, metric_code text, source_reference_ids uuid[])
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_consolidated', 'corvis_facts'
    AS $$
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
$$;


--
-- Name: accept_tenant_invitation(text, text, text, text, boolean, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.accept_tenant_invitation(p_token_sha256 text, p_auth_method text, p_subject text, p_email text, p_email_verified boolean, p_correlation_id text) RETURNS TABLE(invitation_id uuid, tenant_id uuid, workspace_id uuid, user_id uuid, role_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'corvis_control', 'public'
    AS $$
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
$$;


--
-- Name: access_policy_resource_belongs_to_tenant(uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.access_policy_resource_belongs_to_tenant(p_tenant_id uuid, p_resource_type text, p_resource_id text) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
begin
  if p_resource_type='workspace' then
    if p_resource_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return false;
    end if;
    return exists (
      select 1
      from corvis_control.workspace w
      where w.tenant_id=p_tenant_id
        and w.workspace_id=p_resource_id::uuid
    );
  end if;

  if p_resource_type='document' then
    if p_resource_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return false;
    end if;
    return exists (
      select 1
      from corvis_source.document d
      where d.tenant_id=p_tenant_id
        and d.document_id=p_resource_id::uuid
    );
  end if;

  if p_resource_type='fund' then
    -- Fund identity is global, but customer authority is not. Accept only a
    -- fund that has tenant-private identity evidence, a portfolio position, or
    -- tenant-owned facts/snapshots. Merely existing in the global fund directory
    -- is deliberately insufficient.
    return exists (
      select 1
      from corvis_identity.tenant_entity_name n
      where n.tenant_id=p_tenant_id and n.fund_id=p_resource_id
    ) or exists (
      select 1
      from corvis_facts.client_portfolio_fund_position p
      where p.tenant_id=p_tenant_id and p.fund_id=p_resource_id
    ) or exists (
      select 1
      from corvis_facts.observation o
      where o.tenant_id=p_tenant_id and o.fund_id=p_resource_id
    ) or exists (
      select 1
      from corvis_consolidated.consolidated_fact f
      where f.tenant_id=p_tenant_id and f.fund_id=p_resource_id
    ) or exists (
      select 1
      from corvis_consolidated.fund_period_snapshot s
      where s.tenant_id=p_tenant_id and s.fund_id=p_resource_id
    );
  end if;

  return false;
end;
$_$;




--
-- Name: review_item_comment; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.review_item_comment (
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_kind text NOT NULL,
    subject_id uuid NOT NULL,
    comment_id uuid DEFAULT gen_random_uuid() NOT NULL,
    comment_seq bigint NOT NULL,
    author_auth_method text NOT NULL,
    author_subject text NOT NULL,
    author_user_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    body text NOT NULL,
    mentioned_user_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_item_comment_author_auth_method_check CHECK ((author_auth_method = ANY (ARRAY['oidc'::text, 'saml'::text]))),
    CONSTRAINT review_item_comment_author_subject_check CHECK (((length(author_subject) >= 1) AND (length(author_subject) <= 1024))),
    CONSTRAINT review_item_comment_body_check CHECK (((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 2000))),
    CONSTRAINT review_item_comment_idempotency_key_check CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 256))),
    CONSTRAINT review_item_comment_mentioned_user_ids_check CHECK ((cardinality(mentioned_user_ids) <= 10)),
    CONSTRAINT review_item_comment_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY corvis_control.review_item_comment FORCE ROW LEVEL SECURITY;


--
-- Name: add_review_item_comment(uuid, uuid, text, uuid, jsonb, jsonb, uuid, text, text, text, text, text, uuid[]); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.add_review_item_comment(p_tenant_id uuid, p_workspace_id uuid, p_subject_kind text, p_subject_id uuid, p_fund_ids jsonb, p_document_ids jsonb, p_comment_id uuid, p_actor_auth_method text, p_actor_subject text, p_idempotency_key text, p_request_hash text, p_body text, p_mentioned_user_ids uuid[]) RETURNS SETOF corvis_control.review_item_comment
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated', 'corvis_source', 'corvis_serving'
    AS $$
declare
  v_fund_id text;
  v_period text;
  v_author uuid;
  v_comment corvis_control.review_item_comment%rowtype;
  v_thread corvis_control.review_item_thread%rowtype;
  v_mention uuid;
begin
  select * into v_comment from corvis_control.review_item_comment c
  where c.tenant_id = p_tenant_id and c.author_auth_method = p_actor_auth_method
    and c.author_subject = p_actor_subject and c.idempotency_key = p_idempotency_key;
  if found then
    if v_comment.request_hash <> p_request_hash
       or (v_comment.workspace_id, v_comment.subject_kind, v_comment.subject_id) is distinct from (p_workspace_id, p_subject_kind, p_subject_id) then
      raise exception 'idempotency key reused with different review comment';
    end if;
    return next v_comment;
    return;
  end if;

  select s.subject_fund_id, s.subject_report_period into v_fund_id, v_period
  from corvis_control.resolve_review_subject(p_tenant_id, p_subject_kind, p_subject_id, p_fund_ids, p_document_ids) s;
  if v_fund_id is null then
    raise exception 'review item not found';
  end if;
  select s.user_id into v_author from corvis_control.identity_subject s
  where s.tenant_id = p_tenant_id and s.auth_method = p_actor_auth_method and s.subject = p_actor_subject
    and s.status = 'active' and s.auth_method in ('oidc','saml');
  if v_author is null then
    raise exception 'review item actor not found';
  end if;
  foreach v_mention in array coalesce(p_mentioned_user_ids, '{}'::uuid[]) loop
    if not corvis_control.review_member_eligible(p_tenant_id, p_workspace_id, v_mention, v_fund_id) then
      raise exception 'review mention not eligible';
    end if;
  end loop;

  insert into corvis_control.review_item_thread
    (tenant_id, workspace_id, subject_kind, subject_id, fund_id, report_period, version)
  values (p_tenant_id, p_workspace_id, p_subject_kind, p_subject_id, v_fund_id, v_period, 0)
  on conflict on constraint review_item_thread_pkey do nothing;
  select * into v_thread from corvis_control.review_item_thread t
  where t.tenant_id = p_tenant_id and t.workspace_id = p_workspace_id and t.subject_kind = p_subject_kind and t.subject_id = p_subject_id
  for update;
  if v_thread.comment_count >= 200 then
    raise exception 'review comment limit reached';
  end if;

  insert into corvis_control.review_item_comment
    (tenant_id, workspace_id, subject_kind, subject_id, comment_id, author_auth_method, author_subject, author_user_id,
     idempotency_key, request_hash, body, mentioned_user_ids)
  values
    (p_tenant_id, p_workspace_id, p_subject_kind, p_subject_id, p_comment_id, p_actor_auth_method, p_actor_subject, v_author,
     p_idempotency_key, p_request_hash, btrim(p_body), coalesce(p_mentioned_user_ids, '{}'::uuid[]))
  returning * into v_comment;

  update corvis_control.review_item_thread t
  set comment_count = t.comment_count + 1, last_comment_at = v_comment.created_at
  where t.tenant_id = p_tenant_id and t.workspace_id = p_workspace_id and t.subject_kind = p_subject_kind and t.subject_id = p_subject_id;

  return next v_comment;
end;
$$;


--
-- Name: apply_backchannel_logout(text, text, text, text, text, boolean, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.apply_backchannel_logout(p_issuer text, p_audience text, p_jti text, p_subject text, p_session_id text, p_global boolean, p_correlation_id text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_inserted integer;
  v_revoked integer := 0;
  v_tenants integer := 0;
begin
  if p_issuer is null or length(p_issuer) not between 1 and 2048
     or p_audience is null or length(p_audience) not between 1 and 1024
     or p_jti is null or length(p_jti) not between 1 and 256
     or p_global is null
     or p_correlation_id is null
     or (p_subject is null and p_session_id is null)
     or (p_subject is not null and length(p_subject) not between 1 and 1024)
     or (p_session_id is not null and length(p_session_id) not between 1 and 1024) then
    raise exception 'backchannel logout request is invalid';
  end if;

  -- Housekeeping: a bounded delete of ledger rows no token could still match.
  delete from corvis_control.oidc_logout_token_use u
   where u.ctid in (select x.ctid from corvis_control.oidc_logout_token_use x where x.used_at < now() - interval '15 minutes' limit 200);

  if (select count(*) from corvis_control.oidc_logout_token_use u where u.issuer = p_issuer and u.used_at > now() - interval '1 minute') >= 600 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  insert into corvis_control.oidc_logout_token_use (issuer, jti) values (p_issuer, p_jti)
  on conflict (issuer, jti) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('status', 'replay');
  end if;

  if p_session_id is not null then
    with scope as (select s as tenant_id from corvis_control.backchannel_logout_tenants(p_issuer, p_audience, p_global) s),
    targets as (
      select i.tenant_id, i.subject
      from corvis_control.identity_subject i join scope on scope.tenant_id = i.tenant_id
      where p_subject is not null and i.auth_method = 'oidc' and i.subject = p_subject
      union
      select a.tenant_id, a.subject
      from corvis_control.tenant_session_activity a join scope on scope.tenant_id = a.tenant_id
      where p_subject is null and a.auth_method = 'oidc' and a.session_id = p_session_id
    ),
    ins as (
      insert into corvis_control.session_revocation (tenant_id, auth_method, subject, session_id, revoked_by_subject, reason)
      select t.tenant_id, 'oidc', t.subject, p_session_id, 'idp:backchannel-logout', 'Signed out by the identity provider (OIDC back-channel logout)'
      from targets t
      on conflict (tenant_id, auth_method, subject, session_id) do nothing
      returning tenant_id
    ),
    aud as (
      insert into corvis_control.audit_event (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
      select i.tenant_id, null, 'idp:backchannel-logout', 'access.session.idp_logout', 'user_sessions', null, 'success', p_correlation_id,
        jsonb_build_object('revokedSessions', count(*), 'scope', 'session', 'issuer', p_issuer)
      from ins i group by i.tenant_id
      returning 1
    )
    select (select count(*) from ins), (select count(*) from aud) into v_revoked, v_tenants;
  else
    with scope as (select s as tenant_id from corvis_control.backchannel_logout_tenants(p_issuer, p_audience, p_global) s),
    ins as (
      insert into corvis_control.session_revocation (tenant_id, auth_method, subject, session_id, revoked_by_subject, reason)
      select a.tenant_id, 'oidc', a.subject, a.session_id, 'idp:backchannel-logout', 'Signed out by the identity provider (OIDC back-channel logout)'
      from corvis_control.tenant_session_activity a join scope on scope.tenant_id = a.tenant_id
      where a.auth_method = 'oidc' and a.subject = p_subject
      on conflict (tenant_id, auth_method, subject, session_id) do nothing
      returning tenant_id
    ),
    aud as (
      insert into corvis_control.audit_event (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
      select i.tenant_id, null, 'idp:backchannel-logout', 'access.session.idp_logout', 'user_sessions', null, 'success', p_correlation_id,
        jsonb_build_object('revokedSessions', count(*), 'scope', 'subject', 'issuer', p_issuer)
      from ins i group by i.tenant_id
      returning 1
    )
    select (select count(*) from ins), (select count(*) from aud) into v_revoked, v_tenants;
  end if;
  return jsonb_build_object('status', 'ok', 'revokedSessions', v_revoked, 'tenants', v_tenants);
end;
$$;


--
-- Name: apply_data_right_admin(uuid, text, uuid, text, text, text, text, boolean, boolean, boolean, boolean, boolean, timestamp with time zone, timestamp with time zone, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.apply_data_right_admin(p_tenant_id uuid, p_actor_subject text, p_actor_workspace_id uuid, p_correlation_id text, p_operation text, p_resource_type text, p_resource_id text, p_client_visible boolean, p_internal_analytics_allowed boolean, p_model_training_allowed boolean, p_redistribution_allowed boolean, p_source_document_access_allowed boolean, p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_contract_reference text, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  raise exception 'contractual data-right mutations require Corvis operations authority';
end;
$$;


--
-- Name: apply_data_right_admin_authorized(uuid, uuid, text, uuid, text, text, text, text, boolean, boolean, boolean, boolean, boolean, timestamp with time zone, timestamp with time zone, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.apply_data_right_admin_authorized(p_target_tenant_id uuid, p_actor_tenant_id uuid, p_actor_subject text, p_actor_workspace_id uuid, p_correlation_id text, p_operation text, p_resource_type text, p_resource_id text, p_client_visible boolean, p_internal_analytics_allowed boolean, p_model_training_allowed boolean, p_redistribution_allowed boolean, p_source_document_access_allowed boolean, p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_contract_reference text, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
declare
  v_now timestamptz := now();
  v_rights_id uuid;
  v_changed integer := 0;
  v_updated integer := 0;
  v_existing boolean := false;
begin
  if p_operation not in ('set','revoke') then raise exception 'invalid data-right operation'; end if;
  if p_resource_type not in ('workspace','fund','document') then raise exception 'invalid resource type'; end if;
  if length(trim(coalesce(p_resource_id,''))) = 0 then raise exception 'resource id required'; end if;
  if length(trim(coalesce(p_reason,''))) = 0 then raise exception 'reason required'; end if;
  if p_operation='set' and length(trim(coalesce(p_contract_reference,''))) = 0 then
    raise exception 'contract reference required';
  end if;
  if p_effective_to is not null and p_effective_to <= p_effective_from then
    raise exception 'invalid data-right effective dates';
  end if;

  if not exists (
    select 1 from corvis_control.tenant t where t.tenant_id=p_target_tenant_id
  ) then raise exception 'target tenant not found'; end if;

  -- Defense in depth for this privileged cross-tenant procedure. The route also
  -- requires the configured operationsTenantId; SQL independently proves the
  -- supplied actor is an active tenant admin in the supplied actor workspace.
  if not exists (
    select 1
    from corvis_control.identity_subject i
    join corvis_control.membership m
      on m.tenant_id=i.tenant_id and m.user_id=i.user_id
    where i.tenant_id=p_actor_tenant_id
      and i.subject=p_actor_subject
      and i.status='active'
      and m.workspace_id=p_actor_workspace_id
      and m.role_name='tenant_admin'
      and m.status='active'
      and m.valid_from<=v_now
      and (m.valid_until is null or m.valid_until>v_now)
  ) then raise exception 'operations actor not authorized'; end if;

  select exists (
    select 1
    from corvis_control.data_rights r
    where r.tenant_id=p_target_tenant_id
      and r.resource_type=p_resource_type
      and r.resource_id=p_resource_id
  ) into v_existing;

  if not corvis_control.access_policy_resource_belongs_to_tenant(p_target_tenant_id,p_resource_type,p_resource_id)
     and not (p_operation='revoke' and v_existing) then
    raise exception 'resource not owned by target tenant';
  end if;

  if p_operation='set' then
    delete from corvis_control.data_rights
      where tenant_id=p_target_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from=p_effective_from and effective_from >= v_now;

    update corvis_control.data_rights
      set effective_to=p_effective_from
      where tenant_id=p_target_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from < p_effective_from
        and (effective_to is null or effective_to > p_effective_from);

    insert into corvis_control.data_rights
      (tenant_id,resource_type,resource_id,client_visible,internal_analytics_allowed,model_training_allowed,
       redistribution_allowed,source_document_access_allowed,effective_from,effective_to,contract_reference)
    values
      (p_target_tenant_id,p_resource_type,p_resource_id,p_client_visible,p_internal_analytics_allowed,p_model_training_allowed,
       p_redistribution_allowed,p_source_document_access_allowed,p_effective_from,p_effective_to,trim(p_contract_reference))
    returning rights_id into v_rights_id;
    v_changed := 1;
  else
    delete from corvis_control.data_rights
      where tenant_id=p_target_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from >= v_now;
    get diagnostics v_changed = row_count;

    update corvis_control.data_rights
      set effective_to=v_now
      where tenant_id=p_target_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from < v_now and (effective_to is null or effective_to > v_now);
    get diagnostics v_updated = row_count;
    v_changed := v_changed + v_updated;
  end if;

  -- The audit event belongs to the customer whose contractual authority changed.
  -- The Corvis operations workspace is carried as metadata rather than written
  -- into the customer's workspace_id column.
  insert into corvis_control.audit_event
    (tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values
    (p_target_tenant_id,null,p_actor_subject,'access.data_right.'||p_operation,
     'data_right',p_resource_type||':'||p_resource_id,'success',p_correlation_id,
     jsonb_build_object('rightsId',v_rights_id,'actorTenantId',p_actor_tenant_id,
       'actorWorkspaceId',p_actor_workspace_id,'resourceType',p_resource_type,'resourceId',p_resource_id,
       'clientVisible',p_client_visible,'internalAnalyticsAllowed',p_internal_analytics_allowed,
       'modelTrainingAllowed',p_model_training_allowed,'redistributionAllowed',p_redistribution_allowed,
       'sourceDocumentAccessAllowed',p_source_document_access_allowed,'effectiveFrom',p_effective_from,
       'effectiveTo',p_effective_to,'contractReference',nullif(trim(p_contract_reference),''),
       'reason',p_reason,'changed',v_changed));

  return jsonb_build_object('operation',p_operation,'changed',v_changed,'rightsId',v_rights_id,
    'tenantId',p_target_tenant_id,'resourceType',p_resource_type,'resourceId',p_resource_id);
end;
$$;


--
-- Name: apply_identity_lifecycle(uuid, text, text, uuid, text, text, text, text, uuid, jsonb, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.apply_identity_lifecycle(p_tenant_id uuid, p_event_key text, p_actor_subject text, p_actor_workspace_id uuid, p_correlation_id text, p_operation text, p_auth_method text, p_subject text, p_user_id uuid, p_memberships jsonb, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'extensions', 'public'
    AS $$
declare
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_existing_user_id uuid;
  v_existing_status text;
  v_revoked_memberships integer := 0;
  v_active_memberships integer := 0;
  v_expired_entitlements integer := 0;
  v_disabled_subjects integer := 0;
  v_disabled_service_grants integer := 0;
  v_result jsonb;
begin
  if p_operation not in ('sync','disable') then
    raise exception 'invalid identity lifecycle operation';
  end if;
  if p_auth_method not in ('oidc','saml') then
    raise exception 'human identity lifecycle only supports oidc or saml';
  end if;
  if length(trim(coalesce(p_event_key,''))) not between 1 and 256
     or length(coalesce(p_subject,'')) not between 1 and 1024
     or length(trim(coalesce(p_actor_subject,''))) not between 1 and 1024
     or length(trim(coalesce(p_reason,''))) not between 1 and 1000
     or length(trim(coalesce(p_correlation_id,''))) not between 1 and 256 then
    raise exception 'invalid identity lifecycle fields';
  end if;
  if p_memberships is null or jsonb_typeof(p_memberships) <> 'array' then
    raise exception 'memberships must be an array';
  end if;
  if p_operation='disable' and jsonb_array_length(p_memberships) <> 0 then
    raise exception 'disable must not include memberships';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_memberships) item
    where jsonb_typeof(item) <> 'object'
       or nullif(trim(item->>'workspaceId'),'') is null
       or nullif(trim(item->>'roleName'),'') is null
       or (item->>'roleName') not in ('tenant_admin','accountadmin','reviewer','analyst','viewer')
  ) then
    raise exception 'invalid membership entry';
  end if;
  if (
    select count(*)
    from jsonb_array_elements(p_memberships)
  ) <> (
    select count(distinct ((item->>'workspaceId') || ':' || (item->>'roleName')))
    from jsonb_array_elements(p_memberships) item
  ) then
    raise exception 'duplicate membership entry';
  end if;

  -- Separation of duties: granting the tenant_admin role (to the actor or to
  -- anyone else) requires the actor to already hold an active tenant_admin
  -- membership in this tenant. Without this, an accountadmin (workspace-scoped
  -- admin) could self-promote, or promote another subject, to tenant_admin.
  if exists (select 1 from jsonb_array_elements(p_memberships) item where item->>'roleName'='tenant_admin')
     and not exists (
       select 1
       from corvis_control.identity_subject a
       join corvis_control.membership m on m.tenant_id=a.tenant_id and m.user_id=a.user_id
       where a.tenant_id=p_tenant_id and a.subject=p_actor_subject and a.status='active'
         and m.role_name='tenant_admin' and m.status='active'
         and m.valid_from<=now() and (m.valid_until is null or m.valid_until>now())
     )
  then
    raise exception 'tenant_admin_role_requires_tenant_admin_actor';
  end if;

  -- Every membership must name a workspace of this tenant. Without this, a well-formed UUID that is not one
  -- of the tenant's workspaces reached the membership foreign key and surfaced as an unclassified 23503 (HTTP
  -- 500). Scoped to p_tenant_id: another tenant's workspace id is indistinguishable from a nonexistent one.
  if exists (
    select 1
    from jsonb_array_elements(p_memberships) item
    where not exists (
      select 1
      from corvis_control.workspace w
      where w.tenant_id=p_tenant_id and w.workspace_id=(item->>'workspaceId')::uuid
    )
  ) then
    raise exception 'workspace not found';
  end if;

  v_request_hash := encode(digest(
    concat_ws(E'\n', p_operation, p_auth_method, p_subject, p_user_id::text, p_memberships::text, p_reason),
    'sha256'
  ), 'hex');

  select request_hash, result
    into v_existing_hash, v_existing_result
  from corvis_control.identity_lifecycle_event
  where tenant_id=p_tenant_id and event_key=p_event_key;

  if found then
    if v_existing_hash <> v_request_hash then
      raise exception 'identity lifecycle event replay conflict';
    end if;
    return v_existing_result;
  end if;

  if p_operation='sync' then
    select user_id,status into v_existing_user_id,v_existing_status
    from corvis_control.identity_subject
    where tenant_id=p_tenant_id and auth_method=p_auth_method and subject=p_subject
    for update;

    if found and v_existing_user_id <> p_user_id then
      raise exception 'identity subject is already mapped to a different user';
    end if;
    if found and v_existing_status='disabled' then
      raise exception 'disabled identity requires explicit reactivation';
    end if;

    insert into corvis_control.identity_subject
      (tenant_id,user_id,auth_method,subject,status,created_at,disabled_at)
    values (p_tenant_id,p_user_id,p_auth_method,p_subject,'active',now(),null)
    on conflict (tenant_id,auth_method,subject) do nothing;

    update corvis_control.membership m
    set status='revoked',
        valid_from=least(m.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where m.tenant_id=p_tenant_id
      and m.user_id=p_user_id
      and m.status='active'
      and not exists (
        select 1
        from jsonb_array_elements(p_memberships) item
        where (item->>'workspaceId')::uuid=m.workspace_id
          and item->>'roleName'=m.role_name
      );
    get diagnostics v_revoked_memberships = row_count;

    insert into corvis_control.membership as m
      (tenant_id,workspace_id,user_id,role_name,status,valid_from,valid_until,created_at)
    select p_tenant_id,(item->>'workspaceId')::uuid,p_user_id,item->>'roleName','active',now(),null,now()
    from jsonb_array_elements(p_memberships) item
    on conflict (tenant_id,workspace_id,user_id,role_name) do update
      set status='active',
          valid_from=case when m.status='active' and m.valid_until is null then m.valid_from else now() end,
          valid_until=null;
    get diagnostics v_active_memberships = row_count;

    update corvis_control.resource_entitlement e
    set valid_from=least(e.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where e.tenant_id=p_tenant_id
      and e.subject_user_id=p_user_id
      and (e.valid_until is null or e.valid_until > now())
      and not exists (
        select 1
        from jsonb_array_elements(p_memberships) item
        where (item->>'workspaceId')::uuid=e.workspace_id
      );
    get diagnostics v_expired_entitlements = row_count;
  else
    select user_id into v_existing_user_id
    from corvis_control.identity_subject
    where tenant_id=p_tenant_id and auth_method=p_auth_method and subject=p_subject
    for update;

    if not found or v_existing_user_id <> p_user_id then
      raise exception 'identity subject does not match the requested user';
    end if;

    update corvis_control.service_identity_grant g
    set status='disabled', disabled_at=coalesce(g.disabled_at,now())
    from corvis_control.identity_subject s
    where s.tenant_id=p_tenant_id
      and s.user_id=p_user_id
      and g.tenant_id=s.tenant_id
      and g.auth_method=s.auth_method
      and g.subject=s.subject
      and g.status='active';
    get diagnostics v_disabled_service_grants = row_count;

    update corvis_control.identity_subject s
    set status='disabled', disabled_at=coalesce(s.disabled_at,now())
    where s.tenant_id=p_tenant_id and s.user_id=p_user_id and s.status='active';
    get diagnostics v_disabled_subjects = row_count;

    update corvis_control.membership m
    set status='revoked',
        valid_from=least(m.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where m.tenant_id=p_tenant_id and m.user_id=p_user_id and m.status='active';
    get diagnostics v_revoked_memberships = row_count;

    update corvis_control.resource_entitlement e
    set valid_from=least(e.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where e.tenant_id=p_tenant_id
      and e.subject_user_id=p_user_id
      and (e.valid_until is null or e.valid_until > now());
    get diagnostics v_expired_entitlements = row_count;
  end if;

  v_result := jsonb_build_object(
    'eventKey',p_event_key,
    'operation',p_operation,
    'subject',p_subject,
    'userId',p_user_id,
    'activeMemberships',v_active_memberships,
    'revokedMemberships',v_revoked_memberships,
    'expiredEntitlements',v_expired_entitlements,
    'disabledSubjects',v_disabled_subjects,
    'disabledServiceGrants',v_disabled_service_grants
  );

  insert into corvis_control.identity_lifecycle_event
    (tenant_id,event_key,request_hash,operation,auth_method,subject,user_id,actor_subject,actor_workspace_id,reason,desired_memberships,result)
  values
    (p_tenant_id,p_event_key,v_request_hash,p_operation,p_auth_method,p_subject,p_user_id,p_actor_subject,p_actor_workspace_id,p_reason,p_memberships,v_result);

  insert into corvis_control.audit_event
    (tenant_id,audit_event_id,occurred_at,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values (
    p_tenant_id,gen_random_uuid(),now(),p_actor_workspace_id,p_actor_subject,
    'identity.lifecycle.' || p_operation,'identity_subject',p_subject,'success',p_correlation_id,
    jsonb_build_object(
      'eventKey',p_event_key,
      'authMethod',p_auth_method,
      'userId',p_user_id,
      'reason',p_reason,
      'result',v_result
    )
  );

  return v_result;
end;
$$;


--
-- Name: apply_resource_entitlement_admin(uuid, text, uuid, text, text, uuid, uuid, text, text, text, timestamp with time zone, timestamp with time zone, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.apply_resource_entitlement_admin(p_tenant_id uuid, p_actor_subject text, p_actor_workspace_id uuid, p_correlation_id text, p_operation text, p_subject_user_id uuid, p_workspace_id uuid, p_resource_type text, p_resource_id text, p_permission text, p_valid_from timestamp with time zone, p_valid_until timestamp with time zone, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
declare
  v_now timestamptz := now();
  v_changed integer := 0;
  v_existing boolean := false;
begin
  if p_operation not in ('grant','revoke') then raise exception 'invalid resource entitlement operation'; end if;
  if p_resource_type not in ('fund','document') then raise exception 'invalid resource type'; end if;
  if p_permission not in ('read','review','publish','admin') then raise exception 'invalid resource permission'; end if;
  if length(trim(coalesce(p_resource_id,''))) = 0 then raise exception 'resource id required'; end if;
  if length(trim(coalesce(p_reason,''))) = 0 then raise exception 'reason required'; end if;
  if p_valid_until is not null and p_valid_until <= p_valid_from then raise exception 'invalid entitlement effective dates'; end if;
  if not exists (
    select 1 from corvis_control.workspace w
    where w.tenant_id=p_tenant_id and w.workspace_id=p_workspace_id
  ) then raise exception 'workspace not found'; end if;
  if not exists (
    select 1 from corvis_control.identity_subject i
    where i.tenant_id=p_tenant_id and i.user_id=p_subject_user_id
  ) then raise exception 'subject user not found'; end if;

  select exists (
    select 1
    from corvis_control.resource_entitlement e
    where e.tenant_id=p_tenant_id
      and e.workspace_id=p_workspace_id
      and e.subject_user_id=p_subject_user_id
      and e.resource_type=p_resource_type
      and e.resource_id=p_resource_id
      and e.permission=p_permission
  ) into v_existing;

  -- A grant must always point at a resource that is provably owned by the
  -- tenant. Revocation also permits a matching historical grant so access can
  -- still be removed after the underlying resource has been deleted/retired.
  if not corvis_control.access_policy_resource_belongs_to_tenant(p_tenant_id,p_resource_type,p_resource_id)
     and not (p_operation='revoke' and v_existing) then
    raise exception 'resource not owned by tenant';
  end if;

  if p_operation='grant' then
    insert into corvis_control.resource_entitlement
      (tenant_id,workspace_id,subject_user_id,resource_type,resource_id,permission,valid_from,valid_until)
    values
      (p_tenant_id,p_workspace_id,p_subject_user_id,p_resource_type,p_resource_id,p_permission,p_valid_from,p_valid_until)
    on conflict (tenant_id,workspace_id,subject_user_id,resource_type,resource_id,permission)
    do update set valid_from=excluded.valid_from, valid_until=excluded.valid_until
    where corvis_control.resource_entitlement.valid_from is distinct from excluded.valid_from
       or corvis_control.resource_entitlement.valid_until is distinct from excluded.valid_until;
    get diagnostics v_changed = row_count;
  else
    delete from corvis_control.resource_entitlement
      where tenant_id=p_tenant_id and workspace_id=p_workspace_id and subject_user_id=p_subject_user_id
        and resource_type=p_resource_type and resource_id=p_resource_id and permission=p_permission
        and valid_from >= v_now;
    get diagnostics v_changed = row_count;
    if v_changed = 0 then
      update corvis_control.resource_entitlement
        set valid_until = case
          when valid_until is null or valid_until > v_now then v_now
          else valid_until end
        where tenant_id=p_tenant_id and workspace_id=p_workspace_id and subject_user_id=p_subject_user_id
          and resource_type=p_resource_type and resource_id=p_resource_id and permission=p_permission
          and valid_from < v_now and (valid_until is null or valid_until > v_now);
      get diagnostics v_changed = row_count;
    end if;
  end if;

  insert into corvis_control.audit_event
    (tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values
    (p_tenant_id,p_actor_workspace_id,p_actor_subject,'access.resource_entitlement.'||p_operation,
     'resource_entitlement',p_subject_user_id::text,'success',p_correlation_id,
     jsonb_build_object('workspaceId',p_workspace_id,'resourceType',p_resource_type,'resourceId',p_resource_id,
       'permission',p_permission,'validFrom',p_valid_from,'validUntil',p_valid_until,'reason',p_reason,'changed',v_changed));

  return jsonb_build_object('operation',p_operation,'changed',v_changed,'subjectUserId',p_subject_user_id,
    'workspaceId',p_workspace_id,'resourceType',p_resource_type,'resourceId',p_resource_id,'permission',p_permission);
end;
$$;


--
-- Name: apply_support_access_admin(uuid, text, uuid, text, text, uuid, text, text, uuid, uuid, text, text, text, timestamp with time zone, timestamp with time zone, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.apply_support_access_admin(p_tenant_id uuid, p_actor_subject text, p_actor_workspace_id uuid, p_correlation_id text, p_operation text, p_support_grant_id uuid, p_auth_method text, p_subject text, p_user_id uuid, p_workspace_id uuid, p_role_name text, p_purpose text, p_approval_reference text, p_valid_from timestamp with time zone, p_valid_until timestamp with time zone, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'corvis_control', 'public'
    AS $$
declare
  v_grant_id uuid;
  v_grant corvis_control.support_access_grant%rowtype;
begin
  if p_operation not in ('grant','revoke') then raise exception 'invalid support access operation'; end if;
  if length(trim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'reason required'; end if;

  if p_operation='grant' then
    if p_auth_method not in ('oidc','saml') then raise exception 'invalid support auth method'; end if;
    -- Separation of duties: the approving administrator can never grant
    -- support access to their own identity or to another subject mapped to
    -- the same user, which would otherwise be a self-service elevation.
    if p_subject=p_actor_subject or exists (
      select 1 from corvis_control.identity_subject a
      where a.tenant_id=p_tenant_id and a.subject=p_actor_subject and a.user_id=p_user_id
    ) then raise exception 'support access cannot be self-approved'; end if;
    if p_role_name not in ('tenant_admin','accountadmin','reviewer','analyst','viewer') then raise exception 'invalid support role'; end if;
    -- A grant of tenant_admin-tier support access requires the actor to
    -- already hold an active tenant_admin membership: an accountadmin must
    -- not be able to hand out (time-bounded) tenant_admin access either.
    if p_role_name='tenant_admin' and not exists (
      select 1
      from corvis_control.identity_subject a
      join corvis_control.membership m on m.tenant_id=a.tenant_id and m.user_id=a.user_id
      where a.tenant_id=p_tenant_id and a.subject=p_actor_subject and a.status='active'
        and m.role_name='tenant_admin' and m.status='active'
        and m.valid_from<=now() and (m.valid_until is null or m.valid_until>now())
    ) then raise exception 'tenant_admin_role_requires_tenant_admin_actor'; end if;
    if length(trim(coalesce(p_purpose,''))) not between 1 and 1000 then raise exception 'support purpose required'; end if;
    if length(trim(coalesce(p_approval_reference,''))) not between 1 and 1000 then raise exception 'approval reference required'; end if;
    if p_valid_from is null or p_valid_until is null or p_valid_until<=p_valid_from or p_valid_until<=now() then
      raise exception 'support access requires a future expiry';
    end if;
    if not exists (
      select 1 from corvis_control.identity_subject s
      where s.tenant_id=p_tenant_id and s.auth_method=p_auth_method and s.subject=p_subject
        and s.user_id=p_user_id and s.status='active'
    ) then raise exception 'active support identity not found'; end if;
    if not exists (
      select 1 from corvis_control.workspace w
      where w.tenant_id=p_tenant_id and w.workspace_id=p_workspace_id and w.status='active'
    ) then raise exception 'active support workspace not found'; end if;
    if exists (
      select 1 from corvis_control.membership m
      where m.tenant_id=p_tenant_id and m.workspace_id=p_workspace_id and m.user_id=p_user_id and m.role_name=p_role_name
        and m.status='active' and m.valid_from<=now() and (m.valid_until is null or m.valid_until>now())
    ) then raise exception 'requested support role is already active outside this grant'; end if;

    v_grant_id := coalesce(p_support_grant_id,gen_random_uuid());
    insert into corvis_control.support_access_grant
      (tenant_id,support_grant_id,auth_method,subject,user_id,workspace_id,role_name,purpose,approval_reference,
       valid_from,valid_until,status,approved_by_subject)
    values
      (p_tenant_id,v_grant_id,p_auth_method,p_subject,p_user_id,p_workspace_id,p_role_name,p_purpose,p_approval_reference,
       p_valid_from,p_valid_until,'active',p_actor_subject);

    insert into corvis_control.membership
      (tenant_id,workspace_id,user_id,role_name,status,valid_from,valid_until,created_at)
    values
      (p_tenant_id,p_workspace_id,p_user_id,p_role_name,'active',p_valid_from,p_valid_until,now())
    on conflict (tenant_id,workspace_id,user_id,role_name) do update
      set status='active',valid_from=excluded.valid_from,valid_until=excluded.valid_until;
  else
    if p_support_grant_id is null then raise exception 'support grant id required'; end if;
    select * into v_grant from corvis_control.support_access_grant
      where tenant_id=p_tenant_id and support_grant_id=p_support_grant_id
      for update;
    if not found then raise exception 'support grant not found'; end if;
    v_grant_id := v_grant.support_grant_id;

    update corvis_control.support_access_grant
      set status='revoked',revoked_at=coalesce(revoked_at,now()),revoked_by_subject=p_actor_subject,revoke_reason=p_reason
      where tenant_id=p_tenant_id and support_grant_id=v_grant_id and status='active';

    if v_grant.valid_from>=now() then
      delete from corvis_control.membership
        where tenant_id=p_tenant_id and workspace_id=v_grant.workspace_id and user_id=v_grant.user_id
          and role_name=v_grant.role_name and valid_from=v_grant.valid_from and valid_until=v_grant.valid_until;
    else
      update corvis_control.membership
        set valid_until=now(),status='revoked'
        where tenant_id=p_tenant_id and workspace_id=v_grant.workspace_id and user_id=v_grant.user_id
          and role_name=v_grant.role_name and status='active'
          and valid_from=v_grant.valid_from and valid_until=v_grant.valid_until;
    end if;
  end if;

  insert into corvis_control.audit_event
    (tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values
    (p_tenant_id,p_actor_workspace_id,p_actor_subject,'access.support.'||p_operation,'support_access_grant',v_grant_id::text,
     'success',p_correlation_id,jsonb_build_object('supportGrantId',v_grant_id,'subject',coalesce(p_subject,v_grant.subject),
       'workspaceId',coalesce(p_workspace_id,v_grant.workspace_id),'roleName',coalesce(p_role_name,v_grant.role_name),
       'purpose',coalesce(p_purpose,v_grant.purpose),'approvalReference',coalesce(p_approval_reference,v_grant.approval_reference),
       'validFrom',coalesce(p_valid_from,v_grant.valid_from),'validUntil',coalesce(p_valid_until,v_grant.valid_until),'reason',p_reason));

  return jsonb_build_object('operation',p_operation,'supportGrantId',v_grant_id);
end;
$$;


--
-- Name: attach_processing_stage_predecessor_result(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.attach_processing_stage_predecessor_result() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
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
$$;


--
-- Name: backchannel_logout_tenants(text, text, boolean); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.backchannel_logout_tenants(p_issuer text, p_audience text, p_global boolean) RETURNS SETOF uuid
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select t.tenant_id
  from corvis_control.tenant t
  where exists (
      select 1 from corvis_control.tenant_identity_provider b
      where b.tenant_id = t.tenant_id and b.protocol = 'oidc' and b.status = 'active'
        and b.issuer = p_issuer and b.audience = p_audience
    )
    or (
      p_global
      and not exists (
        select 1 from corvis_control.tenant_identity_provider b
        where b.tenant_id = t.tenant_id and b.enforce_token_binding
          and not (b.issuer = p_issuer and b.audience = p_audience)
      )
    )
$$;


--
-- Name: begin_processing_stage_effect(uuid, text, text, uuid, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.begin_processing_stage_effect(p_tenant_id uuid, p_job_id text, p_effect_key text, p_document_id uuid, p_stage text) RETURNS TABLE(should_execute boolean, already_complete boolean, effect_attempt integer)
    LANGUAGE plpgsql
    AS $$
declare
  current_effect corvis_control.processing_stage_effect%rowtype;
  current_job corvis_control.processing_job%rowtype;
  inserted_count integer;
begin
  if p_effect_key is null or btrim(p_effect_key)='' then raise exception 'effect key is required'; end if;

  select * into current_job
  from corvis_control.processing_job
  where tenant_id=p_tenant_id and job_id=p_job_id
    and document_id=p_document_id and stage=p_stage
  for update;

  if not found then raise exception 'processing job not found for effect'; end if;
  if current_job.state <> 'running' then raise exception 'processing job is not running'; end if;

  insert into corvis_control.processing_stage_effect (
    tenant_id,job_id,effect_key,document_id,stage,state,attempt_count,first_started_at,last_started_at
  ) values (
    p_tenant_id,p_job_id,p_effect_key,p_document_id,p_stage,'started',1,now(),now()
  ) on conflict (tenant_id,job_id,effect_key) do nothing;
  get diagnostics inserted_count = row_count;

  select * into current_effect
  from corvis_control.processing_stage_effect
  where tenant_id=p_tenant_id and job_id=p_job_id and effect_key=p_effect_key
  for update;

  if current_effect.document_id <> p_document_id or current_effect.stage <> p_stage then
    raise exception 'effect key metadata mismatch';
  end if;

  if current_effect.state='complete' then
    return query select false,true,current_effect.attempt_count;
    return;
  end if;

  if inserted_count=0 then
    update corvis_control.processing_stage_effect
    set attempt_count=attempt_count+1,last_started_at=now()
    where tenant_id=p_tenant_id and job_id=p_job_id and effect_key=p_effect_key
    returning * into current_effect;
  end if;

  return query select true,false,current_effect.attempt_count;
end;
$$;


--
-- Name: block_processing_stage_delivery(uuid, text, uuid, uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.block_processing_stage_delivery(p_tenant_id uuid, p_consumer_name text, p_event_id uuid, p_lease_token uuid, p_job_id text, p_reason text) RETURNS TABLE(blocked boolean, job_version integer)
    LANGUAGE plpgsql
    AS $$
declare
  current_job corvis_control.processing_job%rowtype;
  completion_ok boolean;
  signal_id uuid;
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
  if completion_ok is not true then raise exception 'event lease no longer owns review-block transition'; end if;

  update corvis_control.processing_job
  set state='blocked',
      blocked_reason=left(coalesce(p_reason,'review_required'),500),
      last_error=null,
      version=version+1,
      updated_at=now()
  where tenant_id=p_tenant_id and job_id=p_job_id
  returning * into current_job;

  signal_id := md5(p_tenant_id::text || ':' || p_event_id::text || ':ProcessingStageBlocked')::uuid;
  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,signal_id,'ProcessingStageBlocked','processing_job',p_job_id,
    jsonb_build_object(
      'jobId',p_job_id,
      'documentId',current_job.document_id,
      'stage',current_job.stage,
      'reason',current_job.blocked_reason,
      'correlationId',current_job.correlation_id
    ),now()
  ) on conflict (tenant_id,event_id) do nothing;

  return query select true,current_job.version;
end;
$$;


--
-- Name: claim_event_delivery(uuid, text, uuid, text, text, text, jsonb, text, integer, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.claim_event_delivery(p_tenant_id uuid, p_consumer_name text, p_event_id uuid, p_event_type text, p_aggregate_type text, p_aggregate_id text, p_payload jsonb, p_payload_sha256 text, p_max_attempts integer DEFAULT 5, p_lease_seconds integer DEFAULT 300) RETURNS TABLE(claimed boolean, duplicate_complete boolean, claim_lease_token uuid, claim_attempt integer, claim_state text)
    LANGUAGE plpgsql
    AS $$
declare
  current_row corvis_control.event_inbox%rowtype;
  next_token uuid;
  inserted_count integer;
begin
  if p_consumer_name is null or btrim(p_consumer_name)='' then raise exception 'consumer name is required'; end if;
  if p_payload_sha256 is null or btrim(p_payload_sha256)='' then raise exception 'payload hash is required'; end if;
  if p_max_attempts < 1 then raise exception 'max attempts must be positive'; end if;
  if p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'lease seconds out of range'; end if;

  -- Authenticity guard: this event must be one Corvis itself published to the
  -- outbox (dispatchConfiguredProcessingTransport is the only producer of a
  -- transport message, and it always publishes the outbox row's own
  -- tenant_id/event_id/event_type/payload unmodified). A delivery carrying an
  -- event_id/event_type/payload combination with no such row was never
  -- emitted by Corvis and must be rejected before it is claimed, not merely
  -- deduplicated against whatever a prior delivery of the same event_id wrote.
  if not exists (
    select 1
    from corvis_control.outbox_event o
    where o.tenant_id=p_tenant_id
      and o.event_id=p_event_id
      and o.event_type=p_event_type
      and o.payload=p_payload
  ) then
    raise exception 'event id has no matching outbox record';
  end if;

  insert into corvis_control.event_inbox (
    tenant_id,consumer_name,event_id,event_type,aggregate_type,aggregate_id,payload,payload_sha256,
    state,delivery_count,attempt,max_attempts,first_received_at,last_received_at
  ) values (
    p_tenant_id,p_consumer_name,p_event_id,p_event_type,p_aggregate_type,p_aggregate_id,p_payload,p_payload_sha256,
    'received',1,0,p_max_attempts,now(),now()
  ) on conflict (tenant_id,consumer_name,event_id) do nothing;
  get diagnostics inserted_count = row_count;

  select * into current_row
  from corvis_control.event_inbox
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
  for update;

  if not found then raise exception 'event inbox claim failed'; end if;
  if current_row.payload_sha256 <> p_payload_sha256 then raise exception 'event id payload mismatch'; end if;
  if current_row.event_type <> p_event_type or current_row.aggregate_type <> p_aggregate_type or current_row.aggregate_id <> p_aggregate_id then
    raise exception 'event id metadata mismatch';
  end if;

  if inserted_count = 0 then
    update corvis_control.event_inbox
    set delivery_count=delivery_count+1,last_received_at=now()
    where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
    returning * into current_row;
  end if;

  if current_row.state='complete' then
    return query select false,true,null::uuid,current_row.attempt,current_row.state;
    return;
  end if;
  if current_row.state='failed' or current_row.attempt >= current_row.max_attempts then
    update corvis_control.event_inbox
    set state='failed',lease_token=null,lease_expires_at=null,next_attempt_at=null
    where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
    returning * into current_row;
    return query select false,false,null::uuid,current_row.attempt,current_row.state;
    return;
  end if;
  if current_row.state='processing' and current_row.lease_expires_at is not null and current_row.lease_expires_at > now() then
    return query select false,false,null::uuid,current_row.attempt,current_row.state;
    return;
  end if;
  if current_row.state='retryable' and current_row.next_attempt_at is not null and current_row.next_attempt_at > now() then
    return query select false,false,null::uuid,current_row.attempt,current_row.state;
    return;
  end if;

  next_token := gen_random_uuid();
  update corvis_control.event_inbox
  set state='processing',
      attempt=attempt+1,
      lease_token=next_token,
      lease_expires_at=now()+make_interval(secs => p_lease_seconds),
      next_attempt_at=null,
      last_error=null,
      last_received_at=now()
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
  returning * into current_row;

  return query select true,false,next_token,current_row.attempt,current_row.state;
end;
$$;


--
-- Name: claim_export_schedule_trigger(uuid, uuid, jsonb); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.claim_export_schedule_trigger(p_tenant_id uuid, p_schedule_id uuid, p_entitled_fund_ids jsonb DEFAULT NULL::jsonb) RETURNS TABLE(trigger_key text, snapshot_id uuid, snapshot_version integer)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_schedule corvis_control.export_schedule%rowtype;
  v_publication record;
  v_snapshot_id uuid;
  v_snapshot_version integer;
  v_period timestamp;
  v_key text;
  v_now timestamptz := now();
begin
  select * into v_schedule from corvis_control.export_schedule s
  where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id and s.status = 'active'
  for update;
  if not found then
    return;
  end if;

  if v_schedule.trigger_kind = 'on_publish' then
    select * into v_publication from corvis_control.export_schedule_latest_publication(v_schedule, p_entitled_fund_ids);
    if not found then
      -- An all-funds scorecard narrowed to the owner's funds: a publication of any other fund is not a trigger. It is consumed,
      -- so the schedule is not listed as due for it again, and no run is recorded.
      if p_entitled_fund_ids is not null and v_schedule.scope_snapshot_id is null and v_schedule.scope_fund_id is null then
        select * into v_publication from corvis_control.export_schedule_latest_publication(v_schedule);
        if found then
          update corvis_control.export_schedule s
          set publish_watermark = v_publication.published_at, updated_at = v_now
          where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id;
        end if;
      end if;
      return;
    end if;
    v_snapshot_id := v_publication.snapshot_id;
    v_snapshot_version := v_publication.snapshot_version;
    v_key := 'publish:' || v_snapshot_id::text || ':v' || v_snapshot_version::text;
    update corvis_control.export_schedule s
    set publish_watermark = v_publication.published_at, updated_at = v_now
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id;
  else
    if v_schedule.next_run_at is null or v_schedule.next_run_at > v_now then
      return;
    end if;
    v_period := date_trunc(case v_schedule.trigger_kind when 'monthly' then 'month' else 'quarter' end, v_now at time zone 'UTC');
    v_key := v_schedule.trigger_kind || ':' || case v_schedule.trigger_kind
      when 'monthly' then to_char(v_period, 'YYYY-MM')
      else to_char(v_period, 'YYYY') || '-Q' || to_char(v_period, 'Q') end;
    update corvis_control.export_schedule s
    set next_run_at = corvis_control.export_schedule_next_run_at(s.trigger_kind, v_now), updated_at = v_now
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id;
  end if;

  if exists (select 1 from corvis_control.export_schedule_run r
             where r.tenant_id = p_tenant_id and r.schedule_id = p_schedule_id and r.trigger_key = v_key) then
    return;
  end if;

  trigger_key := v_key;
  snapshot_id := v_snapshot_id;
  snapshot_version := v_snapshot_version;
  return next;
end;
$$;


--
-- Name: tenant_export_request; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant_export_request (
    tenant_id uuid NOT NULL,
    request_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    requested_by_auth_method text NOT NULL,
    requested_by_subject text NOT NULL,
    requested_by_user_id uuid NOT NULL,
    reason text NOT NULL,
    state text DEFAULT 'pending_approval'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    approval_expires_at timestamp with time zone NOT NULL,
    decided_by_subject text,
    decided_by_user_id uuid,
    decided_at timestamp with time zone,
    decision_note text,
    cancelled_at timestamp with time zone,
    state_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    build_attempts integer DEFAULT 0 NOT NULL,
    build_started_at timestamp with time zone,
    build_lease_expires_at timestamp with time zone,
    build_next_attempt_at timestamp with time zone,
    last_error text,
    object_uri text,
    artifact_expires_at timestamp with time zone,
    checksum_sha256 text,
    size_bytes bigint,
    manifest jsonb,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    artifact_deleted_at timestamp with time zone,
    build_progress jsonb,
    CONSTRAINT tenant_export_request_artifact_deleted_check CHECK (((artifact_deleted_at IS NULL) OR (state = 'complete'::text))),
    CONSTRAINT tenant_export_request_build_attempts_check CHECK ((build_attempts >= 0)),
    CONSTRAINT tenant_export_request_build_progress_check CHECK (((build_progress IS NULL) OR (jsonb_typeof(build_progress) = 'object'::text))),
    CONSTRAINT tenant_export_request_check CHECK ((approval_expires_at > requested_at)),
    CONSTRAINT tenant_export_request_check1 CHECK (((decided_by_subject IS NULL) = (decided_by_user_id IS NULL))),
    CONSTRAINT tenant_export_request_check2 CHECK (((decided_by_subject IS NULL) = (decided_at IS NULL))),
    CONSTRAINT tenant_export_request_check3 CHECK (((state <> ALL (ARRAY['approved'::text, 'building'::text, 'complete'::text, 'failed'::text, 'rejected'::text])) OR (decided_by_subject IS NOT NULL))),
    CONSTRAINT tenant_export_request_check4 CHECK (((state <> ALL (ARRAY['pending_approval'::text, 'expired'::text])) OR (decided_by_subject IS NULL))),
    CONSTRAINT tenant_export_request_check5 CHECK (((decided_by_subject IS NULL) OR ((decided_by_subject <> requested_by_subject) AND (decided_by_user_id <> requested_by_user_id)))),
    CONSTRAINT tenant_export_request_check6 CHECK (((state = 'cancelled'::text) = (cancelled_at IS NOT NULL))),
    CONSTRAINT tenant_export_request_check7 CHECK (((state <> 'rejected'::text) OR (decision_note IS NOT NULL))),
    CONSTRAINT tenant_export_request_check8 CHECK (((state = 'complete'::text) = ((object_uri IS NOT NULL) AND (artifact_expires_at IS NOT NULL) AND (checksum_sha256 IS NOT NULL) AND (size_bytes IS NOT NULL) AND (manifest IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT tenant_export_request_checksum_sha256_check CHECK (((checksum_sha256 IS NULL) OR (checksum_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT tenant_export_request_decided_by_subject_check CHECK (((decided_by_subject IS NULL) OR ((length(decided_by_subject) >= 1) AND (length(decided_by_subject) <= 1024)))),
    CONSTRAINT tenant_export_request_decision_note_check CHECK (((decision_note IS NULL) OR (length(decision_note) <= 1000))),
    CONSTRAINT tenant_export_request_last_error_check CHECK (((last_error IS NULL) OR (length(last_error) <= 2000))),
    CONSTRAINT tenant_export_request_reason_check CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 1000))),
    CONSTRAINT tenant_export_request_requested_by_auth_method_check CHECK ((requested_by_auth_method = ANY (ARRAY['oidc'::text, 'saml'::text]))),
    CONSTRAINT tenant_export_request_requested_by_subject_check CHECK (((length(requested_by_subject) >= 1) AND (length(requested_by_subject) <= 1024))),
    CONSTRAINT tenant_export_request_size_bytes_check CHECK (((size_bytes IS NULL) OR (size_bytes >= 0))),
    CONSTRAINT tenant_export_request_state_check CHECK ((state = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'building'::text, 'complete'::text, 'failed'::text, 'rejected'::text, 'cancelled'::text, 'expired'::text])))
);

ALTER TABLE ONLY corvis_control.tenant_export_request FORCE ROW LEVEL SECURITY;


--
-- Name: claim_next_tenant_export_build(integer, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.claim_next_tenant_export_build(p_lease_minutes integer, p_max_attempts integer) RETURNS SETOF corvis_control.tenant_export_request
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_stale corvis_control.tenant_export_request%rowtype;
  v_row corvis_control.tenant_export_request%rowtype;
begin
  for v_stale in
    select * from corvis_control.tenant_export_request r
    where r.state = 'building' and coalesce(r.build_lease_expires_at, '-infinity'::timestamptz) < now()
    order by r.requested_at
    for update skip locked
  loop
    if v_stale.build_attempts >= p_max_attempts then
      update corvis_control.tenant_export_request r
      set state = 'failed', state_changed_at = now(), build_lease_expires_at = null,
          last_error = 'export build lease expired before completion'
      where r.tenant_id = v_stale.tenant_id and r.request_id = v_stale.request_id;
      insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
      values (v_stale.tenant_id, v_stale.request_id, 'build_failed', 'building', 'failed', 'system:tenant-export', 'export build lease expired before completion');
      perform corvis_control.tenant_export_system_audit(v_stale.tenant_id, v_stale.workspace_id, v_stale.request_id, 'data_export.build_failed', 'failure',
        jsonb_build_object('status', 'failed', 'attempt', v_stale.build_attempts));
    else
      update corvis_control.tenant_export_request r
      set state = 'approved', state_changed_at = now(), build_lease_expires_at = null, build_next_attempt_at = now(),
          last_error = 'export build lease expired before completion'
      where r.tenant_id = v_stale.tenant_id and r.request_id = v_stale.request_id;
      insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
      values (v_stale.tenant_id, v_stale.request_id, 'build_retry_scheduled', 'building', 'approved', 'system:tenant-export', 'export build lease expired before completion');
      perform corvis_control.tenant_export_system_audit(v_stale.tenant_id, v_stale.workspace_id, v_stale.request_id, 'data_export.build_retry_scheduled', 'failure',
        jsonb_build_object('status', 'approved', 'attempt', v_stale.build_attempts));
    end if;
  end loop;

  select * into v_row from corvis_control.tenant_export_request r
  where r.state = 'approved' and coalesce(r.build_next_attempt_at, '-infinity'::timestamptz) <= now()
  order by r.decided_at, r.requested_at
  limit 1
  for update skip locked;
  if not found then
    return;
  end if;

  update corvis_control.tenant_export_request r
  set state = 'building', state_changed_at = now(), build_attempts = r.build_attempts + 1,
      build_started_at = now(), build_lease_expires_at = now() + make_interval(mins => p_lease_minutes),
      build_next_attempt_at = null, last_error = null
  where r.tenant_id = v_row.tenant_id and r.request_id = v_row.request_id
  returning * into v_row;
  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (v_row.tenant_id, v_row.request_id, 'build_started', 'approved', 'building', 'system:tenant-export', null);
  perform corvis_control.tenant_export_system_audit(v_row.tenant_id, v_row.workspace_id, v_row.request_id, 'data_export.build_started', 'success',
    jsonb_build_object('status', 'building', 'attempt', v_row.build_attempts));

  return next v_row;
end;
$$;


--
-- Name: claim_processing_stage_delivery(uuid, text, uuid, text, uuid, text, text, jsonb, text, integer, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.claim_processing_stage_delivery(p_tenant_id uuid, p_consumer_name text, p_event_id uuid, p_event_type text, p_document_id uuid, p_job_id text, p_expected_stage text, p_payload jsonb, p_payload_sha256 text, p_max_attempts integer DEFAULT 5, p_lease_seconds integer DEFAULT 300) RETURNS TABLE(claimed boolean, duplicate_complete boolean, claim_lease_token uuid, claim_attempt integer, inbox_state text, job_version integer, job_state text)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  inbox_claim record;
  current_job corvis_control.processing_job%rowtype;
  terminal_error text;
begin
  if p_job_id is null or btrim(p_job_id)='' then raise exception 'job id is required'; end if;
  if p_expected_stage is null or btrim(p_expected_stage)='' then raise exception 'expected stage is required'; end if;

  -- Same authenticity guard as claim_event_delivery, checked directly here
  -- too (rather than relying solely on the delegated call below) so this
  -- stage-specific entry point never claims a fabricated delivery even if a
  -- future caller reaches it through a path that does not route through
  -- claim_event_delivery's own check.
  if not exists (
    select 1
    from corvis_control.outbox_event o
    where o.tenant_id=p_tenant_id
      and o.event_id=p_event_id
      and o.event_type=p_event_type
      and o.payload=p_payload
  ) then
    raise exception 'event id has no matching outbox record';
  end if;

  select * into inbox_claim
  from corvis_control.claim_event_delivery(
    p_tenant_id,
    p_consumer_name,
    p_event_id,
    p_event_type,
    'document',
    p_document_id::text,
    p_payload,
    p_payload_sha256,
    p_max_attempts,
    p_lease_seconds
  );

  if coalesce(inbox_claim.claimed,false)=false then
    select * into current_job
    from corvis_control.processing_job
    where tenant_id=p_tenant_id and job_id=p_job_id;

    return query select
      false,
      coalesce(inbox_claim.duplicate_complete,false),
      inbox_claim.claim_lease_token,
      coalesce(inbox_claim.claim_attempt,0),
      coalesce(inbox_claim.claim_state,'failed')::text,
      coalesce(current_job.version,0),
      coalesce(current_job.state,'missing')::text;
    return;
  end if;

  select * into current_job
  from corvis_control.processing_job
  where tenant_id=p_tenant_id
    and job_id=p_job_id
    and document_id=p_document_id
    and stage=p_expected_stage
  for update;

  if not found then raise exception 'processing job not found for claimed event'; end if;

  if current_job.state='running' then
    -- Another delivery currently owns the job while its inbox lease is live.
    -- Transient: raise so the inbox claim rolls back and the transport
    -- redelivers later.
    if exists (
      select 1
      from corvis_control.event_inbox i
      where i.tenant_id=p_tenant_id
        and i.consumer_name=p_consumer_name
        and i.aggregate_type='document'
        and i.aggregate_id=p_document_id::text
        and i.event_id<>p_event_id
        and i.state='processing'
        and i.lease_expires_at > now()
    ) then
      raise exception 'processing job is not claimable';
    end if;
    -- Otherwise the owning delivery's lease expired without a complete, block
    -- or fail transition: the job is orphaned. Fall through so the orphaned
    -- attempt is charged and the job is re-claimed or dead-lettered.
  elsif current_job.state not in ('queued','retryable') then
    -- Superseded delivery (job already succeeded, blocked, dead-lettered or
    -- failed). Fail this inbox event terminally so the ingress acknowledges it.
    terminal_error := 'processing job is not claimable in state ' || current_job.state;
  end if;

  if terminal_error is null and current_job.attempt >= current_job.max_attempts then
    terminal_error := 'processing job attempts exhausted';
    current_job := corvis_control.dead_letter_exhausted_processing_job(
      p_tenant_id,
      p_job_id,
      md5(p_tenant_id::text || ':' || p_event_id::text || ':' || inbox_claim.claim_attempt::text || ':ProcessingStageDeadLettered')::uuid,
      coalesce(current_job.last_error,terminal_error),
      p_payload
    );
  end if;

  if terminal_error is not null then
    update corvis_control.event_inbox
    set state='failed',lease_token=null,lease_expires_at=null,next_attempt_at=null,
        last_error=left(terminal_error,2000)
    where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
      and lease_token=inbox_claim.claim_lease_token;

    return query select
      false,
      false,
      null::uuid,
      inbox_claim.claim_attempt,
      'failed'::text,
      current_job.version,
      current_job.state;
    return;
  end if;

  update corvis_control.processing_job
  set state='running',
      attempt=attempt+1,
      version=version+1,
      updated_at=now(),
      last_error=null
  where tenant_id=p_tenant_id and job_id=p_job_id
  returning * into current_job;

  return query select
    true,
    false,
    inbox_claim.claim_lease_token,
    inbox_claim.claim_attempt,
    inbox_claim.claim_state::text,
    current_job.version,
    current_job.state;
end;
$$;


--
-- Name: claim_processing_transport_events(integer, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.claim_processing_transport_events(p_limit integer DEFAULT 50, p_lease_seconds integer DEFAULT 60) RETURNS TABLE(tenant_id uuid, event_id uuid, event_type text, aggregate_type text, aggregate_id text, payload jsonb, attempt_count integer, lease_token uuid)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  if p_limit < 1 or p_limit > 500 then raise exception 'transport claim limit out of bounds'; end if;
  if p_lease_seconds < 15 or p_lease_seconds > 600 then raise exception 'transport lease duration out of bounds'; end if;

  return query
  with candidates as (
    select o.tenant_id,o.event_id
    from corvis_control.outbox_event o
    where o.published_at is null
      and o.transport_dead_lettered_at is null
      and coalesce(o.next_attempt_at,o.created_at) <= now()
      and (o.transport_lease_expires_at is null or o.transport_lease_expires_at <= now())
      and o.event_type in ('DocumentRegistered','ProcessingStageReady','ProcessingStageRetryScheduled','ProcessingJobRetryRequested')
    order by coalesce(o.next_attempt_at,o.created_at),o.created_at,o.event_id
    for update skip locked
    limit p_limit
  )
  update corvis_control.outbox_event o
  set transport_lease_token=gen_random_uuid(),
      transport_lease_expires_at=now()+make_interval(secs => p_lease_seconds),
      attempt_count=o.attempt_count+1,
      last_error=null
  from candidates c
  where o.tenant_id=c.tenant_id and o.event_id=c.event_id
  returning o.tenant_id,o.event_id,o.event_type,o.aggregate_type,o.aggregate_id,o.payload,o.attempt_count,o.transport_lease_token;
end;
$$;


--
-- Name: data_issue_case; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.data_issue_case (
    tenant_id uuid NOT NULL,
    case_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    reporter_auth_method text NOT NULL,
    reporter_subject text NOT NULL,
    reporter_user_id uuid,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    figure text NOT NULL,
    fund_id text NOT NULL,
    fund_label text,
    company_id text,
    company_label text,
    metric_code text,
    metric_label text,
    report_period text NOT NULL,
    snapshot_id uuid,
    snapshot_version integer,
    comment text NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    routed_to text DEFAULT 'data_operations'::text NOT NULL,
    correction_incident_id uuid,
    replacement_snapshot_id uuid,
    replacement_snapshot_version integer,
    resolution_note text,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    status_changed_by text NOT NULL,
    reporter_seen_status text DEFAULT 'received'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_issue_case_check CHECK (((snapshot_version IS NULL) OR (snapshot_id IS NOT NULL))),
    CONSTRAINT data_issue_case_check1 CHECK (((status = 'corrected'::text) = ((replacement_snapshot_id IS NOT NULL) AND (replacement_snapshot_version IS NOT NULL)))),
    CONSTRAINT data_issue_case_check2 CHECK (((replacement_snapshot_id IS NULL) = (replacement_snapshot_version IS NULL))),
    CONSTRAINT data_issue_case_check3 CHECK (((status <> 'corrected'::text) OR (correction_incident_id IS NOT NULL))),
    CONSTRAINT data_issue_case_check4 CHECK (((status <> 'no_change'::text) OR (resolution_note IS NOT NULL))),
    CONSTRAINT data_issue_case_comment_check CHECK (((length(btrim(comment)) >= 1) AND (length(btrim(comment)) <= 2000))),
    CONSTRAINT data_issue_case_company_id_check CHECK (((company_id IS NULL) OR ((length(company_id) >= 1) AND (length(company_id) <= 512)))),
    CONSTRAINT data_issue_case_company_label_check CHECK (((company_label IS NULL) OR (length(company_label) <= 200))),
    CONSTRAINT data_issue_case_figure_check CHECK ((figure = ANY (ARRAY['overview'::text, 'position_financials'::text, 'review'::text]))),
    CONSTRAINT data_issue_case_fund_id_check CHECK (((length(fund_id) >= 1) AND (length(fund_id) <= 512))),
    CONSTRAINT data_issue_case_fund_label_check CHECK (((fund_label IS NULL) OR (length(fund_label) <= 200))),
    CONSTRAINT data_issue_case_idempotency_key_check CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 256))),
    CONSTRAINT data_issue_case_metric_code_check CHECK (((metric_code IS NULL) OR ((length(metric_code) >= 1) AND (length(metric_code) <= 256)))),
    CONSTRAINT data_issue_case_metric_label_check CHECK (((metric_label IS NULL) OR (length(metric_label) <= 200))),
    CONSTRAINT data_issue_case_replacement_snapshot_version_check CHECK (((replacement_snapshot_version IS NULL) OR (replacement_snapshot_version > 0))),
    CONSTRAINT data_issue_case_report_period_check CHECK (((length(report_period) >= 1) AND (length(report_period) <= 128))),
    CONSTRAINT data_issue_case_reporter_auth_method_check CHECK ((reporter_auth_method = ANY (ARRAY['oidc'::text, 'saml'::text, 'service_account'::text]))),
    CONSTRAINT data_issue_case_reporter_seen_status_check CHECK ((reporter_seen_status = ANY (ARRAY['received'::text, 'investigating'::text, 'corrected'::text, 'no_change'::text]))),
    CONSTRAINT data_issue_case_reporter_subject_check CHECK (((length(reporter_subject) >= 1) AND (length(reporter_subject) <= 1024))),
    CONSTRAINT data_issue_case_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT data_issue_case_resolution_note_check CHECK (((resolution_note IS NULL) OR (length(resolution_note) <= 2000))),
    CONSTRAINT data_issue_case_routed_to_check CHECK ((routed_to = 'data_operations'::text)),
    CONSTRAINT data_issue_case_snapshot_version_check CHECK (((snapshot_version IS NULL) OR (snapshot_version > 0))),
    CONSTRAINT data_issue_case_status_check CHECK ((status = ANY (ARRAY['received'::text, 'investigating'::text, 'corrected'::text, 'no_change'::text])))
);

ALTER TABLE ONLY corvis_control.data_issue_case FORCE ROW LEVEL SECURITY;


--
-- Name: close_data_issue_cases_for_correction(uuid, uuid, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.close_data_issue_cases_for_correction(p_tenant_id uuid, p_incident_id uuid, p_actor_subject text) RETURNS SETOF corvis_control.data_issue_case
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_incident corvis_control.data_correction_incident%rowtype;
  v_pending corvis_control.data_issue_case%rowtype;
  v_closed corvis_control.data_issue_case%rowtype;
begin
  select * into v_incident from corvis_control.data_correction_incident i
  where i.tenant_id = p_tenant_id and i.incident_id = p_incident_id and i.state = 'resolved';
  if not found then
    return;
  end if;

  for v_pending in
    select * from corvis_control.data_issue_case c
    where c.tenant_id = p_tenant_id and c.correction_incident_id = p_incident_id and c.status = 'investigating'
    order by c.created_at, c.case_id
    for update
  loop
    update corvis_control.data_issue_case c
    set status = 'corrected',
        status_changed_at = now(),
        status_changed_by = p_actor_subject,
        replacement_snapshot_id = v_incident.replacement_snapshot_id,
        replacement_snapshot_version = v_incident.replacement_snapshot_version
    where c.tenant_id = p_tenant_id and c.case_id = v_pending.case_id
    returning * into v_closed;

    insert into corvis_control.data_issue_case_event (tenant_id, case_id, from_status, to_status, actor_subject)
    values (p_tenant_id, v_pending.case_id, 'investigating', 'corrected', p_actor_subject);

    return next v_closed;
  end loop;
end;
$$;


--
-- Name: complete_event_delivery(uuid, text, uuid, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.complete_event_delivery(p_tenant_id uuid, p_consumer_name text, p_event_id uuid, p_lease_token uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
begin
  update corvis_control.event_inbox
  set state='complete',completed_at=now(),lease_token=null,lease_expires_at=null,next_attempt_at=null,last_error=null
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
    and state='processing' and lease_token=p_lease_token;
  return found;
end;
$$;


--
-- Name: complete_processing_stage_delivery(uuid, text, uuid, uuid, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.complete_processing_stage_delivery(p_tenant_id uuid, p_consumer_name text, p_event_id uuid, p_lease_token uuid, p_job_id text) RETURNS TABLE(completed boolean, completed_job_version integer, next_job_id text, next_stage text)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: complete_processing_stage_effect(uuid, text, text, jsonb); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.complete_processing_stage_effect(p_tenant_id uuid, p_job_id text, p_effect_key text, p_result jsonb DEFAULT '{}'::jsonb) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
begin
  update corvis_control.processing_stage_effect
  set state='complete',completed_at=coalesce(completed_at,now()),result=coalesce(p_result,'{}'::jsonb)
  where tenant_id=p_tenant_id and job_id=p_job_id and effect_key=p_effect_key
    and state in ('started','complete');
  return found;
end;
$$;


--
-- Name: complete_processing_transport_event(uuid, uuid, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.complete_processing_transport_event(p_tenant_id uuid, p_event_id uuid, p_lease_token uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  update corvis_control.outbox_event
  set published_at=now(),transport_lease_token=null,transport_lease_expires_at=null,next_attempt_at=null,last_error=null
  where tenant_id=p_tenant_id and event_id=p_event_id and published_at is null
    and transport_lease_token=p_lease_token and transport_lease_expires_at > now();
  return found;
end;
$$;


--
-- Name: complete_tenant_export_build(uuid, uuid, integer, text, timestamp with time zone, text, bigint, jsonb); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.complete_tenant_export_build(p_tenant_id uuid, p_request_id uuid, p_attempt integer, p_object_uri text, p_artifact_expires_at timestamp with time zone, p_checksum_sha256 text, p_size_bytes bigint, p_manifest jsonb) RETURNS SETOF corvis_control.tenant_export_request
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_row corvis_control.tenant_export_request%rowtype;
begin
  update corvis_control.tenant_export_request r
  set state = 'complete', state_changed_at = now(), completed_at = now(), build_lease_expires_at = null, last_error = null,
      object_uri = p_object_uri, artifact_expires_at = p_artifact_expires_at, checksum_sha256 = p_checksum_sha256,
      size_bytes = p_size_bytes, manifest = p_manifest
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id and r.state = 'building' and r.build_attempts = p_attempt
  returning * into v_row;
  if not found then
    return;
  end if;
  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (p_tenant_id, p_request_id, 'build_completed', 'building', 'complete', 'system:tenant-export', null);
  perform corvis_control.tenant_export_system_audit(p_tenant_id, v_row.workspace_id, p_request_id, 'data_export.build_completed', 'success',
    jsonb_build_object('status', 'complete', 'attempt', p_attempt, 'sizeBytes', p_size_bytes, 'checksumSha256', p_checksum_sha256));
  return next v_row;
end;
$$;


--
-- Name: consume_api_rate_limit(uuid, text, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.consume_api_rate_limit(p_tenant_id uuid, p_subject text, p_limit integer) RETURNS TABLE(allowed boolean, retry_after_seconds integer)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_now timestamptz := clock_timestamp();
  v_start timestamptz;
  v_count integer;
begin
  if p_limit is null or p_limit < 1 or p_limit >= 2147483647 then
    raise exception 'invalid request limit';
  end if;
  -- ON CONFLICT serializes callers for the same identity. Saturating at
  -- limit+1 avoids overflow while preserving a stable denied state.
  insert into corvis_control.api_rate_limit as bucket
    (tenant_id, subject, window_start, request_count)
  values (p_tenant_id, p_subject, v_now, 1)
  on conflict (tenant_id, subject) do update set
    window_start = case when bucket.window_start + interval '60 seconds' <= v_now
      then v_now else bucket.window_start end,
    request_count = case when bucket.window_start + interval '60 seconds' <= v_now
      then 1 else least(bucket.request_count::bigint + 1, p_limit::bigint + 1)::integer end
  returning window_start, request_count into v_start, v_count;
  return query select v_count <= p_limit,
    greatest(1, least(60, ceil(extract(epoch from v_start + interval '60 seconds' - v_now))::integer));
end;
$$;


--
-- Name: export_schedule; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.export_schedule (
    tenant_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_auth_method text NOT NULL,
    owner_subject text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    label text NOT NULL,
    scope jsonb NOT NULL,
    scope_label text NOT NULL,
    scope_snapshot_id uuid,
    scope_fund_id text,
    format text NOT NULL,
    trigger_kind text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    stop_reason text,
    next_run_at timestamp with time zone,
    publish_watermark timestamp with time zone,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    status_changed_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    notify_on_completion boolean DEFAULT true NOT NULL,
    CONSTRAINT export_schedule_check1 CHECK (((status = 'stopped'::text) = (stop_reason IS NOT NULL))),
    CONSTRAINT export_schedule_check2 CHECK (((trigger_kind <> 'on_publish'::text) OR (next_run_at IS NULL))),
    CONSTRAINT export_schedule_check3 CHECK (((trigger_kind = 'on_publish'::text) OR (publish_watermark IS NULL))),
    CONSTRAINT export_schedule_check4 CHECK (((status = 'active'::text) =
CASE
    WHEN (trigger_kind = 'on_publish'::text) THEN (publish_watermark IS NOT NULL)
    ELSE (next_run_at IS NOT NULL)
END)),
    CONSTRAINT export_schedule_format_check CHECK ((format = ANY (ARRAY['csv'::text, 'xlsx'::text, 'parquet'::text]))),
    CONSTRAINT export_schedule_idempotency_key_check CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 256))),
    CONSTRAINT export_schedule_label_check CHECK ((((length(label) >= 1) AND (length(label) <= 80)) AND (label = btrim(label)))),
    CONSTRAINT export_schedule_owner_auth_method_check CHECK ((owner_auth_method = ANY (ARRAY['oidc'::text, 'saml'::text, 'service_account'::text]))),
    CONSTRAINT export_schedule_owner_subject_check CHECK (((length(owner_subject) >= 1) AND (length(owner_subject) <= 1024))),
    CONSTRAINT export_schedule_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT export_schedule_scope_check CHECK ((jsonb_typeof(scope) = 'object'::text)),
    CONSTRAINT export_schedule_scope_fund_id_check CHECK (((scope_fund_id IS NULL) OR ((length(scope_fund_id) >= 1) AND (length(scope_fund_id) <= 512)))),
    CONSTRAINT export_schedule_scope_label_check CHECK (((length(scope_label) >= 1) AND (length(scope_label) <= 2000))),
    CONSTRAINT export_schedule_scope_target_check CHECK ((((scope_snapshot_id IS NOT NULL) <> (scope_fund_id IS NOT NULL)) OR ((scope_snapshot_id IS NULL) AND (scope_fund_id IS NULL) AND (scope ? 'performanceScorecard'::text)))),
    CONSTRAINT export_schedule_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'stopped'::text, 'deleted'::text]))),
    CONSTRAINT export_schedule_stop_reason_check CHECK (((stop_reason IS NULL) OR (stop_reason = 'owner_inactive'::text))),
    CONSTRAINT export_schedule_trigger_kind_check CHECK ((trigger_kind = ANY (ARRAY['on_publish'::text, 'monthly'::text, 'quarterly'::text])))
);

ALTER TABLE ONLY corvis_control.export_schedule FORCE ROW LEVEL SECURITY;


--
-- Name: create_export_schedule(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, text, text, boolean); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.create_export_schedule(p_tenant_id uuid, p_schedule_id uuid, p_workspace_id uuid, p_owner_auth_method text, p_owner_subject text, p_idempotency_key text, p_request_hash text, p_label text, p_scope jsonb, p_scope_label text, p_format text, p_trigger_kind text, p_notify_on_completion boolean DEFAULT true) RETURNS SETOF corvis_control.export_schedule
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $_$
declare
  v_schedule corvis_control.export_schedule%rowtype;
  v_snapshot_id uuid;
  v_fund_id text;
  v_now timestamptz := now();
begin
  select * into v_schedule from corvis_control.export_schedule s
  where s.tenant_id = p_tenant_id and s.owner_auth_method = p_owner_auth_method
    and s.owner_subject = p_owner_subject and s.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_schedule.request_hash <> p_request_hash then
      raise exception 'idempotency key reused with different export schedule';
    end if;
    return next v_schedule;
    return;
  end if;

  if p_scope ? 'performanceScorecard' then
    -- The performance scorecard: the marker `true`, and at most the two filters. A fund filter is the fund an on-publish
    -- trigger follows; without one the schedule names no fund (every fund the owner is entitled to at the time of a run).
    if p_scope -> 'performanceScorecard' <> 'true'::jsonb
       or p_scope ?| array['snapshotId', 'positionFinancials']
       or (p_scope - 'performanceScorecard' - 'fundId' - 'period') <> '{}'::jsonb then
      raise exception 'export schedule scope is invalid';
    end if;
    if (p_scope ? 'fundId' and (jsonb_typeof(p_scope -> 'fundId') <> 'string'
          or length(p_scope ->> 'fundId') not between 1 and 512 or (p_scope ->> 'fundId') <> btrim(p_scope ->> 'fundId')))
       or (p_scope ? 'period' and (jsonb_typeof(p_scope -> 'period') <> 'string'
          or length(p_scope ->> 'period') not between 1 and 64 or (p_scope ->> 'period') <> btrim(p_scope ->> 'period'))) then
      raise exception 'export schedule scorecard filter is invalid';
    end if;
    v_fund_id := p_scope ->> 'fundId';
  elsif p_scope ? 'snapshotId' then
    if jsonb_typeof(p_scope -> 'snapshotId') <> 'string'
       or (p_scope ->> 'snapshotId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'export schedule scope is invalid';
    end if;
    v_snapshot_id := (p_scope ->> 'snapshotId')::uuid;
  else
    v_fund_id := p_scope -> 'positionFinancials' ->> 'fundId';
    if jsonb_typeof(p_scope -> 'positionFinancials') <> 'object' or v_fund_id is null or length(v_fund_id) not between 1 and 512 then
      raise exception 'export schedule scope is invalid';
    end if;
  end if;

  if (select count(*) from corvis_control.export_schedule s
      where s.tenant_id = p_tenant_id and s.owner_auth_method = p_owner_auth_method
        and s.owner_subject = p_owner_subject and s.status <> 'deleted') >= 50 then
    raise exception 'export schedule limit reached';
  end if;

  insert into corvis_control.export_schedule
    (tenant_id, schedule_id, workspace_id, owner_auth_method, owner_subject, idempotency_key, request_hash, label, scope,
     scope_label, scope_snapshot_id, scope_fund_id, format, trigger_kind, notify_on_completion, status, next_run_at, publish_watermark,
     status_changed_at, status_changed_by, created_at, updated_at)
  values
    (p_tenant_id, p_schedule_id, p_workspace_id, p_owner_auth_method, p_owner_subject, p_idempotency_key, p_request_hash,
     p_label, p_scope, p_scope_label, v_snapshot_id, v_fund_id, p_format, p_trigger_kind, coalesce(p_notify_on_completion, true), 'active',
     corvis_control.export_schedule_next_run_at(p_trigger_kind, v_now),
     case when p_trigger_kind = 'on_publish' then v_now end,
     v_now, p_owner_subject, v_now, v_now)
  returning * into v_schedule;

  return next v_schedule;
end;
$_$;


--
-- Name: service_account; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.service_account (
    tenant_id uuid NOT NULL,
    service_account_id uuid NOT NULL,
    user_id uuid NOT NULL,
    auth_method text DEFAULT 'service_account'::text NOT NULL,
    subject text NOT NULL,
    display_name text NOT NULL,
    purpose text NOT NULL,
    workspace_id uuid NOT NULL,
    role_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by_subject text NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    disabled_at timestamp with time zone,
    disabled_by_subject text,
    disable_reason text,
    owner_subject text NOT NULL,
    owner_user_id uuid NOT NULL,
    owner_assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_account_auth_method_check CHECK ((auth_method = 'service_account'::text)),
    CONSTRAINT service_account_check CHECK ((expires_at > created_at)),
    CONSTRAINT service_account_check1 CHECK ((((status = 'active'::text) AND (disabled_at IS NULL) AND (disabled_by_subject IS NULL) AND (disable_reason IS NULL)) OR ((status = 'disabled'::text) AND (disabled_at IS NOT NULL) AND (disabled_by_subject IS NOT NULL) AND (disable_reason IS NOT NULL)))),
    CONSTRAINT service_account_created_by_subject_check CHECK (((length(created_by_subject) >= 1) AND (length(created_by_subject) <= 1024))),
    CONSTRAINT service_account_disable_reason_check CHECK (((disable_reason IS NULL) OR ((length(btrim(disable_reason)) >= 3) AND (length(btrim(disable_reason)) <= 1000)))),
    CONSTRAINT service_account_disabled_by_subject_check CHECK (((disabled_by_subject IS NULL) OR ((length(disabled_by_subject) >= 1) AND (length(disabled_by_subject) <= 1024)))),
    CONSTRAINT service_account_display_name_check CHECK (((length(btrim(display_name)) >= 3) AND (length(btrim(display_name)) <= 120))),
    CONSTRAINT service_account_owner_subject_length CHECK (((length(owner_subject) >= 1) AND (length(owner_subject) <= 1024))),
    CONSTRAINT service_account_purpose_check CHECK (((length(btrim(purpose)) >= 3) AND (length(btrim(purpose)) <= 512))),
    CONSTRAINT service_account_role_name_check CHECK ((role_name = ANY (ARRAY['reviewer'::text, 'analyst'::text, 'viewer'::text]))),
    CONSTRAINT service_account_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
    CONSTRAINT service_account_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.service_account FORCE ROW LEVEL SECURITY;


--
-- Name: create_service_account(uuid, uuid, uuid, text, text, text, text, uuid, text, timestamp with time zone, timestamp with time zone, text, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.create_service_account(p_tenant_id uuid, p_service_account_id uuid, p_credential_id uuid, p_actor_auth_method text, p_actor_subject text, p_display_name text, p_purpose text, p_workspace_id uuid, p_role_name text, p_expires_at timestamp with time zone, p_credential_expires_at timestamp with time zone, p_secret_sha256 text, p_max_active integer) RETURNS SETOF corvis_control.service_account
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_admin uuid;
  v_user uuid := gen_random_uuid();
  v_subject text := 'service-account:' || p_service_account_id::text;
  v_row corvis_control.service_account%rowtype;
begin
  v_admin := corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject);
  if v_admin is null then
    raise exception 'service account requires an active organization admin';
  end if;
  if length(btrim(coalesce(p_display_name, ''))) not between 3 and 120 then
    raise exception 'service account name required';
  end if;
  if length(btrim(coalesce(p_purpose, ''))) not between 3 and 512 then
    raise exception 'service account purpose required';
  end if;
  if p_role_name is null or p_role_name not in ('reviewer','analyst','viewer') then
    raise exception 'service account role not allowed';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '366 days'
     or p_credential_expires_at is null or p_credential_expires_at <= now() then
    raise exception 'service account expiry invalid';
  end if;
  if not exists (
    select 1 from corvis_control.workspace w
    where w.tenant_id = p_tenant_id and w.workspace_id = p_workspace_id and w.status = 'active'
  ) then
    raise exception 'workspace not found';
  end if;

  -- Serialise creation within the tenant so the name and the quota checks cannot race.
  perform 1 from corvis_control.tenant t where t.tenant_id = p_tenant_id for update;
  if exists (
    select 1 from corvis_control.service_account a
    where a.tenant_id = p_tenant_id and a.status = 'active' and lower(btrim(a.display_name)) = lower(btrim(p_display_name))
  ) then
    raise exception 'service account name already in use';
  end if;
  if (select count(*) from corvis_control.service_account a where a.tenant_id = p_tenant_id and a.status = 'active') >= p_max_active then
    raise exception 'service account limit reached';
  end if;

  insert into corvis_control.identity_subject (tenant_id, user_id, auth_method, subject, status)
  values (p_tenant_id, v_user, 'service_account', v_subject, 'active');

  insert into corvis_control.membership (tenant_id, workspace_id, user_id, role_name, status, valid_from, valid_until)
  values (p_tenant_id, p_workspace_id, v_user, p_role_name, 'active', now(), p_expires_at);

  insert into corvis_control.service_identity_grant
    (tenant_id, auth_method, subject, purpose, status, valid_from, valid_until, reviewed_at, next_review_at, reviewed_by_subject)
  values
    (p_tenant_id, 'service_account', v_subject, btrim(p_purpose), 'active', now(), p_expires_at, now(), p_expires_at, p_actor_subject);

  insert into corvis_control.service_account
    (tenant_id, service_account_id, user_id, subject, display_name, purpose, workspace_id, role_name,
     created_by_subject, created_by_user_id, expires_at, owner_subject, owner_user_id, owner_assigned_at)
  values
    (p_tenant_id, p_service_account_id, v_user, v_subject, btrim(p_display_name), btrim(p_purpose), p_workspace_id, p_role_name,
     p_actor_subject, v_admin, p_expires_at, p_actor_subject, v_admin, now())
  returning * into v_row;

  insert into corvis_control.service_account_credential
    (tenant_id, credential_id, service_account_id, secret_sha256, created_by_subject, expires_at)
  values
    (p_tenant_id, p_credential_id, p_service_account_id, p_secret_sha256, p_actor_subject, least(p_credential_expires_at, p_expires_at));

  return next v_row;
end;
$$;


--
-- Name: create_webhook_subscription(uuid, uuid, text, text[], text, uuid, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.create_webhook_subscription(p_tenant_id uuid, p_webhook_id uuid, p_endpoint_url text, p_event_types text[], p_created_by text, p_key_id uuid, p_secret text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
begin
  if p_endpoint_url is null or p_endpoint_url !~ '^https://' then
    raise exception 'webhook endpoint url must be https';
  end if;
  if p_event_types is null or array_length(p_event_types, 1) is null then
    raise exception 'at least one event type is required';
  end if;
  if p_secret is null or length(p_secret) < 32 then
    raise exception 'signing secret must be at least 32 characters';
  end if;

  insert into corvis_control.webhook_subscription
    (tenant_id, webhook_id, endpoint_url, event_types, status, created_by, created_at, updated_at)
  values (p_tenant_id, p_webhook_id, p_endpoint_url, p_event_types, 'active', p_created_by, now(), now());

  insert into corvis_control.webhook_signing_key
    (tenant_id, webhook_id, key_id, secret, status, created_at, created_by)
  values (p_tenant_id, p_webhook_id, p_key_id, p_secret, 'active', now(), p_created_by);

  return p_webhook_id;
end;
$$;


--
-- Name: current_user_id(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.current_user_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select auth.uid();
$$;


--
-- Name: customer_deletion_system_audit(uuid, uuid, uuid, text, text, jsonb); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.customer_deletion_system_audit(p_tenant_id uuid, p_workspace_id uuid, p_request_id uuid, p_action text, p_outcome text, p_metadata jsonb) RETURNS void
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  insert into corvis_control.audit_event
    (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
  values
    (p_tenant_id, p_workspace_id, 'system:customer-deletion', p_action, 'deletion_request', p_request_id::text, p_outcome,
     'customer-deletion:' || p_request_id::text, p_metadata)
$$;


--
-- Name: processing_job; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.processing_job (
    tenant_id uuid NOT NULL,
    job_id text NOT NULL,
    document_id uuid NOT NULL,
    stage text NOT NULL,
    state text NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    max_attempts integer NOT NULL,
    correlation_id text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    blocked_reason text,
    recovery_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT processing_job_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT processing_job_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT processing_job_recovery_count_check CHECK ((recovery_count >= 0)),
    CONSTRAINT processing_job_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY corvis_control.processing_job FORCE ROW LEVEL SECURITY;


--
-- Name: dead_letter_exhausted_processing_job(uuid, text, uuid, text, jsonb); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.dead_letter_exhausted_processing_job(p_tenant_id uuid, p_job_id text, p_signal_event_id uuid, p_error text, p_signal_payload jsonb DEFAULT '{}'::jsonb) RETURNS corvis_control.processing_job
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  current_job corvis_control.processing_job%rowtype;
begin
  update corvis_control.processing_job
  set state='dead_letter',
      version=version+1,
      updated_at=now(),
      last_error=left(coalesce(p_error,last_error,'processing job attempts exhausted'),2000)
  where tenant_id=p_tenant_id and job_id=p_job_id
  returning * into current_job;
  if not found then raise exception 'processing job not found for dead-letter transition'; end if;

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,
    p_signal_event_id,
    'ProcessingStageDeadLettered',
    'processing_job',
    p_job_id,
    (coalesce(p_signal_payload,'{}'::jsonb) - 'nextAttemptAt') || jsonb_build_object(
      'jobId',p_job_id,
      'documentId',current_job.document_id,
      'stage',current_job.stage,
      'attempt',current_job.attempt,
      'nextAttemptAt',null,
      'correlationId',current_job.correlation_id
    ),
    now()
  ) on conflict (tenant_id,event_id) do nothing;

  return current_job;
end;
$$;


--
-- Name: deletion_request; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.deletion_request (
    tenant_id uuid NOT NULL,
    deletion_request_id uuid DEFAULT gen_random_uuid() NOT NULL,
    requested_by text NOT NULL,
    scope jsonb NOT NULL,
    reason text NOT NULL,
    state text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_by text,
    approved_at timestamp with time zone,
    completed_at timestamp with time zone,
    completion_evidence jsonb,
    execution_attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    evidence_hash text,
    evidence_recorded_at timestamp with time zone,
    blocked_reason text,
    execution_lease_expires_at timestamp with time zone,
    origin text DEFAULT 'operator'::text NOT NULL,
    workspace_id uuid,
    requested_by_auth_method text,
    requested_by_user_id uuid,
    approval_expires_at timestamp with time zone,
    customer_decided_by_subject text,
    customer_decided_by_user_id uuid,
    customer_decided_at timestamp with time zone,
    customer_decision_note text,
    customer_cancelled_at timestamp with time zone,
    CONSTRAINT deletion_request_customer_cancelled_check CHECK (((state = 'cancelled'::text) = (customer_cancelled_at IS NOT NULL))),
    CONSTRAINT deletion_request_customer_decision_check CHECK ((((customer_decided_by_subject IS NULL) = (customer_decided_by_user_id IS NULL)) AND ((customer_decided_by_subject IS NULL) = (customer_decided_at IS NULL)) AND ((customer_decision_note IS NULL) OR (length(customer_decision_note) <= 1000)))),
    CONSTRAINT deletion_request_customer_fields_check CHECK (((origin <> 'customer'::text) OR ((workspace_id IS NOT NULL) AND (requested_by_auth_method = ANY (ARRAY['oidc'::text, 'saml'::text])) AND (requested_by_user_id IS NOT NULL) AND (approval_expires_at IS NOT NULL) AND (approval_expires_at > requested_at) AND ((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 1000))))),
    CONSTRAINT deletion_request_customer_four_eyes_check CHECK (((customer_decided_by_subject IS NULL) OR ((customer_decided_by_subject <> requested_by) AND (customer_decided_by_user_id <> requested_by_user_id)))),
    CONSTRAINT deletion_request_customer_rejected_note_check CHECK (((state <> 'rejected'::text) OR (customer_decision_note IS NOT NULL))),
    CONSTRAINT deletion_request_customer_state_check CHECK (((origin = 'customer'::text) OR (state <> ALL (ARRAY['pending_customer_approval'::text, 'rejected'::text, 'cancelled'::text, 'expired'::text])))),
    CONSTRAINT deletion_request_customer_state_decision_check CHECK (((origin <> 'customer'::text) OR ((state = ANY (ARRAY['pending_customer_approval'::text, 'expired'::text, 'cancelled'::text])) = (customer_decided_by_subject IS NULL)))),
    CONSTRAINT deletion_request_execution_attempts_check CHECK ((execution_attempts >= 0)),
    CONSTRAINT deletion_request_operator_fields_check CHECK (((origin = 'customer'::text) OR ((requested_by_user_id IS NULL) AND (approval_expires_at IS NULL) AND (customer_decided_by_subject IS NULL) AND (customer_decided_at IS NULL) AND (customer_cancelled_at IS NULL)))),
    CONSTRAINT deletion_request_origin_check CHECK ((origin = ANY (ARRAY['operator'::text, 'customer'::text])))
);

ALTER TABLE ONLY corvis_control.deletion_request FORCE ROW LEVEL SECURITY;


--
-- Name: decide_customer_deletion(uuid, uuid, text, text, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.decide_customer_deletion(p_tenant_id uuid, p_request_id uuid, p_action text, p_auth_method text, p_subject text, p_note text, p_expected_state text) RETURNS SETOF corvis_control.deletion_request
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_row corvis_control.deletion_request%rowtype;
  v_user uuid;
  v_to text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_action not in ('approve','reject','cancel') then
    raise exception 'customer deletion transition not allowed';
  end if;
  select * into v_row from corvis_control.deletion_request r
  where r.tenant_id = p_tenant_id and r.deletion_request_id = p_request_id and r.origin = 'customer'
  for update;
  if not found then
    return;
  end if;
  if p_expected_state is not null and v_row.state <> p_expected_state then
    raise exception 'customer deletion status changed';
  end if;
  v_user := corvis_control.tenant_export_admin_user(p_tenant_id, p_auth_method, p_subject);
  if v_user is null then
    raise exception 'customer deletion requires an active organization admin';
  end if;
  if v_row.state <> 'pending_customer_approval' then
    raise exception 'customer deletion transition not allowed';
  end if;

  if p_action = 'cancel' then
    if v_user <> v_row.requested_by_user_id or p_subject <> v_row.requested_by then
      raise exception 'customer deletion can only be cancelled by its requester';
    end if;
    v_to := 'cancelled';
  else
    if v_user = v_row.requested_by_user_id or p_subject = v_row.requested_by then
      raise exception 'customer deletion requires an independent approver';
    end if;
    if v_row.approval_expires_at <= now() then
      raise exception 'customer deletion approval window has passed';
    end if;
    if p_action = 'reject' and v_note is null then
      raise exception 'customer deletion decision note required';
    end if;
    if p_action = 'approve' and corvis_control.deletion_scope_legal_hold(p_tenant_id, v_row.scope -> 'dataClasses') then
      raise exception 'customer deletion blocked by legal hold';
    end if;
    v_to := case p_action when 'approve' then 'approved' else 'rejected' end;
  end if;

  update corvis_control.deletion_request r
  set state = v_to,
      customer_decided_by_subject = case when p_action = 'cancel' then null else p_subject end,
      customer_decided_by_user_id = case when p_action = 'cancel' then null else v_user end,
      customer_decided_at = case when p_action = 'cancel' then null else now() end,
      customer_decision_note = case when p_action = 'cancel' then null else v_note end,
      customer_cancelled_at = case when p_action = 'cancel' then now() end,
      approved_by = case when p_action = 'approve' then p_subject else r.approved_by end,
      approved_at = case when p_action = 'approve' then now() else r.approved_at end
  where r.tenant_id = p_tenant_id and r.deletion_request_id = p_request_id
  returning * into v_row;

  return next v_row;
end;
$$;


--
-- Name: decide_tenant_export(uuid, uuid, text, text, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.decide_tenant_export(p_tenant_id uuid, p_request_id uuid, p_action text, p_auth_method text, p_subject text, p_note text, p_expected_state text) RETURNS SETOF corvis_control.tenant_export_request
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_row corvis_control.tenant_export_request%rowtype;
  v_user uuid;
  v_to text;
  v_from text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_action not in ('approve','reject','cancel') then
    raise exception 'tenant export transition not allowed';
  end if;
  select * into v_row from corvis_control.tenant_export_request r
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id
  for update;
  if not found then
    return;
  end if;
  if p_expected_state is not null and v_row.state <> p_expected_state then
    raise exception 'tenant export status changed';
  end if;
  v_user := corvis_control.tenant_export_admin_user(p_tenant_id, p_auth_method, p_subject);
  if v_user is null then
    raise exception 'tenant export requires an active organization admin';
  end if;
  v_from := v_row.state;

  if p_action = 'cancel' then
    if v_row.state not in ('pending_approval','approved') then
      raise exception 'tenant export transition not allowed';
    end if;
    if v_user <> v_row.requested_by_user_id or p_subject <> v_row.requested_by_subject then
      raise exception 'tenant export can only be cancelled by its requester';
    end if;
    v_to := 'cancelled';
  else
    if v_row.state <> 'pending_approval' then
      raise exception 'tenant export transition not allowed';
    end if;
    if v_user = v_row.requested_by_user_id or p_subject = v_row.requested_by_subject then
      raise exception 'tenant export requires an independent approver';
    end if;
    if v_row.approval_expires_at <= now() then
      raise exception 'tenant export approval window has passed';
    end if;
    if p_action = 'reject' and v_note is null then
      raise exception 'tenant export decision note required';
    end if;
    v_to := case p_action when 'approve' then 'approved' else 'rejected' end;
  end if;

  update corvis_control.tenant_export_request r
  set state = v_to,
      state_changed_at = now(),
      decided_by_subject = case when p_action = 'cancel' then r.decided_by_subject else p_subject end,
      decided_by_user_id = case when p_action = 'cancel' then r.decided_by_user_id else v_user end,
      decided_at = case when p_action = 'cancel' then r.decided_at else now() end,
      decision_note = case when p_action = 'cancel' then r.decision_note else v_note end,
      cancelled_at = case when p_action = 'cancel' then now() end,
      build_next_attempt_at = case when v_to = 'approved' then now() end
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id
  returning * into v_row;

  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (p_tenant_id, p_request_id, v_to, v_from, v_to, p_subject, v_note);

  return next v_row;
end;
$$;


--
-- Name: deletion_scope_legal_hold(uuid, jsonb); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.deletion_scope_legal_hold(p_tenant_id uuid, p_data_classes jsonb) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select exists (
    select 1
    from jsonb_array_elements_text(case when jsonb_typeof(p_data_classes) = 'array' then p_data_classes else '[]'::jsonb end) as c(data_class)
    where exists (
        select 1 from corvis_control.retention_policy p
        where p.tenant_id = p_tenant_id and p.data_class = c.data_class and p.legal_hold
      )
      or exists (
        select 1 from corvis_control.legal_hold l
        where l.tenant_id = p_tenant_id and l.released_at is null and (l.data_class is null or l.data_class = c.data_class)
      )
  )
$$;


--
-- Name: disable_service_account(uuid, uuid, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.disable_service_account(p_tenant_id uuid, p_service_account_id uuid, p_actor_auth_method text, p_actor_subject text, p_reason text) RETURNS SETOF corvis_control.service_account
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_account corvis_control.service_account%rowtype;
  v_row corvis_control.service_account%rowtype;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  if length(btrim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'service account justification required';
  end if;
  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  if v_account.status = 'disabled' then
    raise exception 'service account is not active';
  end if;

  update corvis_control.service_identity_grant g
  set status = 'disabled', disabled_at = coalesce(g.disabled_at, now())
  where g.tenant_id = p_tenant_id and g.auth_method = 'service_account' and g.subject = v_account.subject and g.status = 'active';

  update corvis_control.identity_subject s
  set status = 'disabled', disabled_at = coalesce(s.disabled_at, now())
  where s.tenant_id = p_tenant_id and s.auth_method = 'service_account' and s.subject = v_account.subject and s.status = 'active';

  update corvis_control.membership m
  set status = 'revoked', valid_from = least(m.valid_from, now() - interval '1 microsecond'), valid_until = now()
  where m.tenant_id = p_tenant_id and m.user_id = v_account.user_id and m.status = 'active';

  update corvis_control.resource_entitlement e
  set valid_from = least(e.valid_from, now() - interval '1 microsecond'), valid_until = now()
  where e.tenant_id = p_tenant_id and e.subject_user_id = v_account.user_id and (e.valid_until is null or e.valid_until > now());

  update corvis_control.service_account_credential c
  set status = 'revoked', revoked_at = now(), revoked_by_subject = p_actor_subject, ends_at = least(now(), coalesce(c.ends_at, now()))
  where c.tenant_id = p_tenant_id and c.service_account_id = p_service_account_id and c.status = 'active';

  update corvis_control.service_account a
  set status = 'disabled', disabled_at = now(), disabled_by_subject = p_actor_subject, disable_reason = btrim(p_reason)
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  returning * into v_row;

  return next v_row;
end;
$$;


--
-- Name: email_domain_allowed(uuid, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.email_domain_allowed(p_tenant_id uuid, p_email text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $_$
  select not exists (select 1 from corvis_control.tenant_verified_domain d where d.tenant_id = p_tenant_id)
    or (
      -- An address needs a local part and an @; anything else cannot match a verified domain.
      position('@' in coalesce(p_email, '')) > 1
      and exists (
        select 1 from corvis_control.tenant_verified_domain d
        where d.tenant_id = p_tenant_id and d.domain = lower(substring(p_email from '[^@]*$'))
      )
    )
$_$;


--
-- Name: emit_export_schedule_run_event(uuid, uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.emit_export_schedule_run_event(p_tenant_id uuid, p_run_id uuid, p_outcome text, p_failure_reason text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_run corvis_control.export_schedule_run%rowtype;
  v_label text;
  v_reason text;
  v_event_id uuid := gen_random_uuid();
  v_payload jsonb;
begin
  if p_outcome not in ('completed','failed') then
    raise exception 'export schedule run event outcome is invalid';
  end if;
  if p_failure_reason is not null and p_failure_reason not in (
    'owner_inactive','export_permission_revoked','redistribution_not_permitted','scope_not_entitled','scope_unavailable','format_unavailable','export_failed'
  ) then
    raise exception 'export schedule run event reason is invalid';
  end if;

  select * into v_run from corvis_control.export_schedule_run r
  where r.tenant_id = p_tenant_id and r.run_id = p_run_id;
  if not found then
    return null;
  end if;
  if p_outcome = 'completed' and v_run.outcome <> 'requested' then
    raise exception 'a refused export schedule run cannot complete';
  end if;
  if exists (
    select 1 from corvis_control.outbox_event e
    where e.tenant_id = p_tenant_id and e.aggregate_type = 'export_schedule_run' and e.aggregate_id = p_run_id::text
      and e.event_type in ('ExportScheduleRunCompleted','ExportScheduleRunFailed')
  ) then
    return null;
  end if;

  select s.label into v_label from corvis_control.export_schedule s
  where s.tenant_id = v_run.tenant_id and s.schedule_id = v_run.schedule_id;

  v_payload := jsonb_build_object('scheduleId', v_run.schedule_id, 'scheduleLabel', v_label, 'runId', v_run.run_id);
  if v_run.export_id is not null then
    v_payload := v_payload || jsonb_build_object('exportId', v_run.export_id);
  end if;
  if p_outcome = 'failed' then
    v_reason := coalesce(p_failure_reason, v_run.failure_reason, 'export_failed');
    v_payload := v_payload || jsonb_build_object('failureReason', v_reason);
  end if;

  insert into corvis_control.outbox_event (tenant_id, event_id, event_type, aggregate_type, aggregate_id, payload, created_at)
  values (p_tenant_id, v_event_id,
          case p_outcome when 'completed' then 'ExportScheduleRunCompleted' else 'ExportScheduleRunFailed' end,
          'export_schedule_run', p_run_id::text, v_payload, now());
  return v_event_id;
end;
$$;


--
-- Name: enforce_session_policy(uuid, text, text, text, boolean); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.enforce_session_policy(p_tenant_id uuid, p_auth_method text, p_subject text, p_session_id text, p_mfa_used boolean DEFAULT NULL::boolean) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_idle integer;
  v_max integer;
  v_first timestamptz;
  v_last timestamptz;
  v_mfa boolean;
begin
  if p_auth_method not in ('oidc','saml') then
    return 'ok';
  end if;

  select p.idle_timeout_minutes, p.max_session_minutes into v_idle, v_max
  from corvis_control.tenant_session_policy p
  where p.tenant_id = p_tenant_id;

  if p_session_id like 'token-%' then
    if v_idle is not null or v_max is not null then
      return 'untracked_session';
    end if;
    return 'ok';
  end if;

  insert into corvis_control.tenant_session_activity (tenant_id, auth_method, subject, session_id, mfa_used)
  values (p_tenant_id, p_auth_method, p_subject, p_session_id, p_mfa_used)
  on conflict (tenant_id, auth_method, subject, session_id) do nothing;

  select a.first_seen_at, a.last_seen_at, a.mfa_used into v_first, v_last, v_mfa
  from corvis_control.tenant_session_activity a
  where a.tenant_id = p_tenant_id and a.auth_method = p_auth_method
    and a.subject = p_subject and a.session_id = p_session_id;

  if v_max is not null and v_first + make_interval(mins => v_max) <= now() then
    return 'max_session';
  end if;
  if v_idle is not null and v_last + make_interval(mins => v_idle) <= now() then
    return 'idle_timeout';
  end if;

  if v_last < now() - interval '30 seconds' or (p_mfa_used is not null and v_mfa is distinct from p_mfa_used) then
    update corvis_control.tenant_session_activity a
       set last_seen_at = case when v_last < now() - interval '30 seconds' then now() else a.last_seen_at end,
           mfa_used = coalesce(p_mfa_used, a.mfa_used)
     where a.tenant_id = p_tenant_id and a.auth_method = p_auth_method
       and a.subject = p_subject and a.session_id = p_session_id;
  end if;
  return 'ok';
end;
$$;


--
-- Name: expired_tenant_export_artifacts(integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.expired_tenant_export_artifacts(p_limit integer) RETURNS TABLE(tenant_id uuid, request_id uuid, object_uri text)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select r.tenant_id, r.request_id, r.object_uri
  from corvis_control.tenant_export_request r
  where r.state = 'complete' and r.artifact_deleted_at is null and r.artifact_expires_at <= now()
  order by r.artifact_expires_at, r.request_id
  limit greatest(1, least(coalesce(p_limit, 100), 500))
$$;


--
-- Name: export_schedule_latest_publication(corvis_control.export_schedule, jsonb); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.export_schedule_latest_publication(p_schedule corvis_control.export_schedule, p_fund_ids jsonb DEFAULT NULL::jsonb) RETURNS TABLE(snapshot_id uuid, snapshot_version integer, published_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated'
    AS $$
  select s.snapshot_id, s.version, s.published_at
  from corvis_consolidated.fund_period_snapshot s
  where p_schedule.trigger_kind = 'on_publish'
    and s.tenant_id = p_schedule.tenant_id
    and s.status = 'published'
    and s.published_at is not null
    and s.published_at > p_schedule.publish_watermark
    and s.published_at <= now() - interval '1 minute'
    and not exists (
      select 1 from corvis_consolidated.fund_period_snapshot newer
      where newer.tenant_id = s.tenant_id and newer.snapshot_id = s.snapshot_id and newer.version > s.version
    )
    and ((p_schedule.scope_snapshot_id is not null and s.snapshot_id = p_schedule.scope_snapshot_id)
      or (p_schedule.scope_fund_id is not null and s.fund_id = p_schedule.scope_fund_id)
      or (p_schedule.scope_snapshot_id is null and p_schedule.scope_fund_id is null
          and (p_fund_ids is null or s.fund_id in (select jsonb_array_elements_text(p_fund_ids)))))
  order by s.published_at desc, s.snapshot_id, s.version desc
  limit 1
$$;


--
-- Name: export_schedule_next_run_at(text, timestamp with time zone); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.export_schedule_next_run_at(p_trigger_kind text, p_after timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
  select case p_trigger_kind
    when 'monthly' then (date_trunc('month', p_after at time zone 'UTC') + interval '1 month') at time zone 'UTC'
    when 'quarterly' then (date_trunc('quarter', p_after at time zone 'UTC') + interval '3 months') at time zone 'UTC'
  end;
$$;


--
-- Name: extend_service_account(uuid, uuid, text, text, timestamp with time zone); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.extend_service_account(p_tenant_id uuid, p_service_account_id uuid, p_actor_auth_method text, p_actor_subject text, p_expires_at timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_account corvis_control.service_account%rowtype;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  if v_account.status <> 'active' then
    raise exception 'service account is not active';
  end if;
  if not corvis_control.service_account_owner_active(p_tenant_id, v_account.owner_user_id) then
    raise exception 'service account needs an owner';
  end if;
  if p_expires_at is null or p_expires_at < v_account.expires_at + interval '1 day' or p_expires_at <= now() or p_expires_at > now() + interval '366 days' then
    raise exception 'service account expiry invalid';
  end if;

  perform set_config('corvis.service_account_renewal', 'on', true);
  update corvis_control.service_account a
  set expires_at = p_expires_at
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id;
  perform set_config('corvis.service_account_renewal', 'off', true);

  update corvis_control.membership m
  set valid_until = p_expires_at
  where m.tenant_id = p_tenant_id and m.user_id = v_account.user_id and m.status = 'active';

  update corvis_control.service_identity_grant g
  set valid_until = p_expires_at, next_review_at = p_expires_at, reviewed_at = now(), reviewed_by_subject = p_actor_subject
  where g.tenant_id = p_tenant_id and g.auth_method = 'service_account' and g.subject = v_account.subject and g.status = 'active';

  return v_account.expires_at;
end;
$$;


--
-- Name: fail_event_delivery(uuid, text, uuid, uuid, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.fail_event_delivery(p_tenant_id uuid, p_consumer_name text, p_event_id uuid, p_lease_token uuid, p_error text) RETURNS text
    LANGUAGE plpgsql
    AS $$
declare
  current_row corvis_control.event_inbox%rowtype;
  next_state text;
  delay_seconds integer;
begin
  select * into current_row
  from corvis_control.event_inbox
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
    and state='processing' and lease_token=p_lease_token
  for update;

  if not found then return null; end if;

  next_state := case when current_row.attempt >= current_row.max_attempts then 'failed' else 'retryable' end;
  delay_seconds := least(900, power(2, greatest(0, current_row.attempt-1))::integer);

  update corvis_control.event_inbox
  set state=next_state,
      lease_token=null,
      lease_expires_at=null,
      next_attempt_at=case when next_state='retryable' then now()+make_interval(secs => delay_seconds) else null end,
      last_error=left(coalesce(p_error,'unknown error'),2000)
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id;

  return next_state;
end;
$$;


--
-- Name: fail_processing_stage_delivery(uuid, text, uuid, uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.fail_processing_stage_delivery(p_tenant_id uuid, p_consumer_name text, p_event_id uuid, p_lease_token uuid, p_job_id text, p_error text) RETURNS TABLE(next_state text, job_version integer, inbox_attempt integer, next_attempt_at timestamp with time zone)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  current_job corvis_control.processing_job%rowtype;
  computed_inbox_state text;
  inbox_row corvis_control.event_inbox%rowtype;
  computed_job_state text;
  retry_at timestamptz;
  signal_type text;
  signal_id uuid;
  signal_payload jsonb;
begin
  select * into current_job
  from corvis_control.processing_job
  where tenant_id=p_tenant_id and job_id=p_job_id
  for update;

  if not found then return; end if;
  if current_job.state <> 'running' then return; end if;

  computed_inbox_state := corvis_control.fail_event_delivery(
    p_tenant_id,p_consumer_name,p_event_id,p_lease_token,p_error
  );
  if computed_inbox_state is null then raise exception 'event lease no longer owns failure transition'; end if;

  computed_job_state := case
    when computed_inbox_state='retryable' and current_job.attempt < current_job.max_attempts then 'retryable'
    else 'dead_letter'
  end;

  if computed_job_state='dead_letter' and computed_inbox_state='retryable' then
    -- Job budget exhausted before the inbox budget: this event is terminal too.
    update corvis_control.event_inbox
    set state='failed',next_attempt_at=null
    where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id;
  elsif computed_job_state='retryable' then
    -- Job-attempt based backoff: 60s doubling, capped at 900s. The inbox
    -- attempt (always 1 for a fresh retry event) must not drive the delay.
    retry_at := now() + make_interval(
      secs => least(900, 60 * power(2, greatest(0, current_job.attempt - 1)))::integer
    );
    update corvis_control.event_inbox
    set next_attempt_at=retry_at
    where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id;
  end if;

  select * into inbox_row
  from corvis_control.event_inbox
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id;

  update corvis_control.processing_job
  set state=computed_job_state,
      version=version+1,
      updated_at=now(),
      last_error=left(coalesce(p_error,'unknown error'),2000)
  where tenant_id=p_tenant_id and job_id=p_job_id
  returning * into current_job;

  signal_type := case computed_job_state when 'retryable' then 'ProcessingStageRetryScheduled' else 'ProcessingStageDeadLettered' end;
  signal_id := md5(
    p_tenant_id::text || ':' || p_event_id::text || ':' || inbox_row.attempt::text || ':' || signal_type
  )::uuid;

  signal_payload := (inbox_row.payload - 'nextAttemptAt') || jsonb_build_object(
    'jobId',p_job_id,
    'documentId',current_job.document_id,
    'stage',current_job.stage,
    'attempt',current_job.attempt,
    'nextAttemptAt',inbox_row.next_attempt_at,
    'correlationId',current_job.correlation_id
  );

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at,next_attempt_at)
  values (
    p_tenant_id,
    signal_id,
    signal_type,
    'processing_job',
    p_job_id,
    signal_payload,
    now(),
    case when computed_job_state='retryable' then inbox_row.next_attempt_at else null end
  ) on conflict (tenant_id,event_id) do nothing;

  return query select computed_job_state,current_job.version,inbox_row.attempt,inbox_row.next_attempt_at;
end;
$$;


--
-- Name: fail_processing_transport_event(uuid, uuid, uuid, text, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.fail_processing_transport_event(p_tenant_id uuid, p_event_id uuid, p_lease_token uuid, p_error text, p_max_attempts integer DEFAULT 8) RETURNS TABLE(next_attempt_at timestamp with time zone, dead_lettered boolean)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  current_attempt integer;
  delay_seconds integer;
begin
  select attempt_count into current_attempt
  from corvis_control.outbox_event
  where tenant_id=p_tenant_id and event_id=p_event_id and published_at is null
    and transport_lease_token=p_lease_token and transport_lease_expires_at > now()
  for update;
  if not found then return; end if;

  if current_attempt >= p_max_attempts then
    update corvis_control.outbox_event
    set transport_lease_token=null,transport_lease_expires_at=null,next_attempt_at=null,
        transport_dead_lettered_at=now(),last_error=left(coalesce(p_error,'unknown transport failure'),2000)
    where tenant_id=p_tenant_id and event_id=p_event_id;
    return query select null::timestamptz,true;
    return;
  end if;

  delay_seconds := least(300,5 * power(2,greatest(current_attempt-1,0))::integer);
  update corvis_control.outbox_event
  set transport_lease_token=null,transport_lease_expires_at=null,
      next_attempt_at=now()+make_interval(secs => delay_seconds),
      last_error=left(coalesce(p_error,'unknown transport failure'),2000)
  where tenant_id=p_tenant_id and event_id=p_event_id
  returning corvis_control.outbox_event.next_attempt_at into next_attempt_at;
  dead_lettered := false;
  return next;
end;
$$;


--
-- Name: fail_tenant_export_build(uuid, uuid, integer, text, boolean, timestamp with time zone, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.fail_tenant_export_build(p_tenant_id uuid, p_request_id uuid, p_attempt integer, p_error text, p_permanent boolean, p_next_attempt_at timestamp with time zone, p_max_attempts integer) RETURNS SETOF corvis_control.tenant_export_request
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_row corvis_control.tenant_export_request%rowtype;
  v_final boolean;
begin
  select * into v_row from corvis_control.tenant_export_request r
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id and r.state = 'building' and r.build_attempts = p_attempt
  for update;
  if not found then
    return;
  end if;
  v_final := p_permanent or v_row.build_attempts >= p_max_attempts;
  update corvis_control.tenant_export_request r
  set state = case when v_final then 'failed' else 'approved' end,
      state_changed_at = now(), build_lease_expires_at = null,
      build_next_attempt_at = case when v_final then null else p_next_attempt_at end,
      last_error = left(p_error, 2000)
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id
  returning * into v_row;
  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (p_tenant_id, p_request_id, case when v_final then 'build_failed' else 'build_retry_scheduled' end, 'building', v_row.state,
          'system:tenant-export', left(p_error, 2000));
  perform corvis_control.tenant_export_system_audit(p_tenant_id, v_row.workspace_id, p_request_id,
    case when v_final then 'data_export.build_failed' else 'data_export.build_retry_scheduled' end, 'failure',
    jsonb_build_object('status', v_row.state, 'attempt', p_attempt));
  return next v_row;
end;
$$;


--
-- Name: grant_service_account_entitlement(uuid, uuid, text, text, text, text, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.grant_service_account_entitlement(p_tenant_id uuid, p_service_account_id uuid, p_actor_auth_method text, p_actor_subject text, p_resource_type text, p_resource_id text, p_max_entitlements integer) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_account corvis_control.service_account%rowtype;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  if p_resource_type is null or p_resource_type not in ('fund','document') then
    raise exception 'service account resource type not allowed';
  end if;
  if length(btrim(coalesce(p_resource_id, ''))) not between 1 and 512 then
    raise exception 'service account resource required';
  end if;
  if p_max_entitlements is null or p_max_entitlements < 1 then
    raise exception 'service account entitlement limit reached';
  end if;

  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  if v_account.status <> 'active' or v_account.expires_at <= now() then
    raise exception 'service account is not active';
  end if;

  -- Nothing the tenant does not own and does not hold a client-visible data right for. One message for both, so the
  -- answer never says whether another tenant holds the resource.
  if not corvis_control.access_policy_resource_belongs_to_tenant(p_tenant_id, p_resource_type, p_resource_id)
     or not corvis_control.service_account_data_right_effective(p_tenant_id, p_resource_type, p_resource_id) then
    raise exception 'service account resource outside organization data rights';
  end if;

  if exists (
    select 1 from corvis_control.resource_entitlement e
    where e.tenant_id = p_tenant_id and e.subject_user_id = v_account.user_id
      and e.resource_type = p_resource_type and e.resource_id = p_resource_id and e.permission = 'read'
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now())
  ) then
    raise exception 'service account entitlement already granted';
  end if;
  if (
    select count(*) from corvis_control.resource_entitlement e
    where e.tenant_id = p_tenant_id and e.subject_user_id = v_account.user_id
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now())
  ) >= p_max_entitlements then
    raise exception 'service account entitlement limit reached';
  end if;

  insert into corvis_control.resource_entitlement
    (tenant_id, workspace_id, subject_user_id, resource_type, resource_id, permission, valid_from, valid_until)
  values
    (p_tenant_id, v_account.workspace_id, v_account.user_id, p_resource_type, p_resource_id, 'read', now(), null)
  on conflict (tenant_id, workspace_id, subject_user_id, resource_type, resource_id, permission)
  do update set valid_from = excluded.valid_from, valid_until = null;
end;
$$;


--
-- Name: guard_data_issue_case_update(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.guard_data_issue_case_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  if (new.tenant_id, new.case_id, new.workspace_id, new.reporter_auth_method, new.reporter_subject, new.reporter_user_id,
      new.idempotency_key, new.request_hash, new.figure, new.fund_id, new.fund_label, new.company_id, new.company_label,
      new.metric_code, new.metric_label, new.report_period, new.snapshot_id, new.snapshot_version, new.comment,
      new.routed_to, new.created_at)
    is distinct from
     (old.tenant_id, old.case_id, old.workspace_id, old.reporter_auth_method, old.reporter_subject, old.reporter_user_id,
      old.idempotency_key, old.request_hash, old.figure, old.fund_id, old.fund_label, old.company_id, old.company_label,
      old.metric_code, old.metric_label, old.report_period, old.snapshot_id, old.snapshot_version, old.comment,
      old.routed_to, old.created_at) then
    raise exception 'data issue report content is immutable';
  end if;
  return new;
end;
$$;


--
-- Name: guard_deletion_request_update(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.guard_deletion_request_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  if new.origin is distinct from old.origin then
    raise exception 'deletion request origin is immutable';
  end if;
  if old.origin <> 'customer' then
    return new;
  end if;
  if (new.tenant_id, new.deletion_request_id, new.requested_by, new.requested_by_auth_method, new.requested_by_user_id,
      new.workspace_id, new.scope, new.reason, new.requested_at, new.approval_expires_at)
    is distinct from
     (old.tenant_id, old.deletion_request_id, old.requested_by, old.requested_by_auth_method, old.requested_by_user_id,
      old.workspace_id, old.scope, old.reason, old.requested_at, old.approval_expires_at) then
    raise exception 'customer deletion request content is immutable';
  end if;
  if old.customer_decided_by_subject is not null
     and (new.customer_decided_by_subject, new.customer_decided_by_user_id, new.customer_decided_at, new.customer_decision_note)
       is distinct from (old.customer_decided_by_subject, old.customer_decided_by_user_id, old.customer_decided_at, old.customer_decision_note) then
    raise exception 'customer deletion decision is immutable';
  end if;
  if new.state is distinct from old.state then
    if old.state = 'pending_customer_approval' then
      if new.state not in ('approved','rejected','cancelled','expired') then
        raise exception 'customer deletion transition not allowed';
      end if;
    elsif old.state in ('rejected','cancelled','expired')
       or new.state in ('pending_customer_approval','rejected','cancelled','expired') then
      raise exception 'customer deletion transition not allowed';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: guard_export_schedule_update(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.guard_export_schedule_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  if (new.tenant_id, new.schedule_id, new.workspace_id, new.owner_auth_method, new.owner_subject, new.idempotency_key,
      new.request_hash, new.label, new.scope, new.scope_label, new.scope_snapshot_id, new.scope_fund_id, new.format,
      new.trigger_kind, new.created_at)
    is distinct from
     (old.tenant_id, old.schedule_id, old.workspace_id, old.owner_auth_method, old.owner_subject, old.idempotency_key,
      old.request_hash, old.label, old.scope, old.scope_label, old.scope_snapshot_id, old.scope_fund_id, old.format,
      old.trigger_kind, old.created_at) then
    raise exception 'export schedule content is immutable';
  end if;
  if old.status = 'deleted' and new.status <> 'deleted' then
    raise exception 'export schedule is deleted';
  end if;
  if old.status = 'stopped' and new.status not in ('stopped','deleted') then
    raise exception 'export schedule is stopped';
  end if;
  return new;
end;
$$;


--
-- Name: guard_review_item_thread_update(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.guard_review_item_thread_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  if (new.tenant_id, new.workspace_id, new.subject_kind, new.subject_id, new.fund_id, new.report_period, new.created_at)
     is distinct from
     (old.tenant_id, old.workspace_id, old.subject_kind, old.subject_id, old.fund_id, old.report_period, old.created_at) then
    raise exception 'review item thread identity is immutable';
  end if;
  if new.version < old.version or new.comment_count < old.comment_count then
    raise exception 'review item thread counters only move forward';
  end if;
  return new;
end;
$$;


--
-- Name: guard_service_account_credential_update(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.guard_service_account_credential_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  if (new.tenant_id, new.credential_id, new.service_account_id, new.secret_sha256, new.created_by_subject, new.created_at, new.expires_at)
    is distinct from
     (old.tenant_id, old.credential_id, old.service_account_id, old.secret_sha256, old.created_by_subject, old.created_at, old.expires_at) then
    raise exception 'service account credential is immutable';
  end if;
  if old.status = 'revoked' and (new.status <> 'revoked' or new.ends_at is distinct from old.ends_at
      or new.revoked_at is distinct from old.revoked_at or new.revoked_by_subject is distinct from old.revoked_by_subject) then
    raise exception 'service account credential is revoked';
  end if;
  if old.ends_at is not null and (new.ends_at is null or new.ends_at > old.ends_at) then
    raise exception 'service account credential end date cannot be extended';
  end if;
  return new;
end;
$$;


--
-- Name: guard_service_account_update(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.guard_service_account_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  if (new.tenant_id, new.service_account_id, new.user_id, new.auth_method, new.subject, new.display_name, new.purpose,
      new.workspace_id, new.role_name, new.created_by_subject, new.created_by_user_id, new.created_at)
    is distinct from
     (old.tenant_id, old.service_account_id, old.user_id, old.auth_method, old.subject, old.display_name, old.purpose,
      old.workspace_id, old.role_name, old.created_by_subject, old.created_by_user_id, old.created_at) then
    raise exception 'service account identity is immutable';
  end if;
  if new.expires_at is distinct from old.expires_at then
    if coalesce(current_setting('corvis.service_account_renewal', true), 'off') <> 'on' then
      raise exception 'service account identity is immutable';
    end if;
    if new.expires_at < old.expires_at then
      raise exception 'service account expiry cannot be shortened';
    end if;
  end if;
  if (new.owner_subject, new.owner_user_id, new.owner_assigned_at) is distinct from (old.owner_subject, old.owner_user_id, old.owner_assigned_at)
     and coalesce(current_setting('corvis.service_account_owner_transfer', true), 'off') <> 'on' then
    raise exception 'service account owner is changed by transfer only';
  end if;
  if old.status = 'disabled' and new.status is distinct from 'disabled' then
    raise exception 'service account is disabled';
  end if;
  return new;
end;
$$;


--
-- Name: guard_tenant_export_request_update(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.guard_tenant_export_request_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  if (new.tenant_id, new.request_id, new.workspace_id, new.requested_by_auth_method, new.requested_by_subject,
      new.requested_by_user_id, new.reason, new.requested_at, new.approval_expires_at, new.created_at)
    is distinct from
     (old.tenant_id, old.request_id, old.workspace_id, old.requested_by_auth_method, old.requested_by_subject,
      old.requested_by_user_id, old.reason, old.requested_at, old.approval_expires_at, old.created_at) then
    raise exception 'tenant export request content is immutable';
  end if;
  if old.decided_by_subject is not null
     and (new.decided_by_subject, new.decided_by_user_id, new.decided_at, new.decision_note)
       is distinct from (old.decided_by_subject, old.decided_by_user_id, old.decided_at, old.decision_note) then
    raise exception 'tenant export decision is immutable';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'pending_approval' and new.state in ('approved','rejected','cancelled','expired'))
    or (old.state = 'approved' and new.state in ('building','cancelled'))
    or (old.state = 'building' and new.state in ('approved','complete','failed'))
  ) then
    raise exception 'tenant export transition not allowed';
  end if;
  return new;
end;
$$;


--
-- Name: has_tenant_access(uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.has_tenant_access(row_tenant_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'corvis_control', 'public'
    AS $$
  select exists (
    select 1
    from corvis_control.membership m
    where m.tenant_id = row_tenant_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.valid_from <= now()
      and (m.valid_until is null or m.valid_until > now())
  );
$$;


--
-- Name: has_workspace_access(uuid, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.has_workspace_access(row_tenant_id uuid, row_workspace_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'corvis_control', 'public'
    AS $$
  select exists (
    select 1
    from corvis_control.membership m
    where m.tenant_id = row_tenant_id
      and m.workspace_id = row_workspace_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.valid_from <= now()
      and (m.valid_until is null or m.valid_until > now())
  );
$$;


--
-- Name: identity_records_operator(uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.identity_records_operator(p_actor_tenant_id uuid, p_actor_auth_method text, p_actor_subject text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select corvis_control.session_policy_admin_user(p_actor_tenant_id, p_actor_auth_method, p_actor_subject) is not null
$$;


--
-- Name: issue_service_account_credential(uuid, uuid, uuid, text, text, text, text, timestamp with time zone, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.issue_service_account_credential(p_tenant_id uuid, p_service_account_id uuid, p_credential_id uuid, p_mode text, p_actor_auth_method text, p_actor_subject text, p_secret_sha256 text, p_credential_expires_at timestamp with time zone, p_overlap_minutes integer) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_account corvis_control.service_account%rowtype;
  v_current corvis_control.service_account_credential%rowtype;
  v_has_current boolean;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  if p_mode not in ('issue','rotate') or p_overlap_minutes is null or p_overlap_minutes < 0 or p_overlap_minutes > 1440 then
    raise exception 'service account credential request invalid';
  end if;

  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  if v_account.status <> 'active' or v_account.expires_at <= now() then
    raise exception 'service account is not active';
  end if;
  if p_credential_expires_at is null or p_credential_expires_at <= now() then
    raise exception 'service account expiry invalid';
  end if;

  -- A current credential whose own expiry has passed no longer counts and makes way for the new one.
  update corvis_control.service_account_credential c
  set ends_at = c.expires_at
  where c.tenant_id = p_tenant_id and c.service_account_id = p_service_account_id
    and c.status = 'active' and c.ends_at is null and c.expires_at <= now();

  select * into v_current from corvis_control.service_account_credential c
  where c.tenant_id = p_tenant_id and c.service_account_id = p_service_account_id
    and c.status = 'active' and c.ends_at is null
  for update;
  v_has_current := found;

  if p_mode = 'issue' and v_has_current then
    raise exception 'service account already has a credential';
  end if;
  if p_mode = 'rotate' and not v_has_current then
    raise exception 'service account has no active credential';
  end if;

  if v_has_current then
    -- Anything already rotating out is ended now, then the current credential starts its overlap.
    update corvis_control.service_account_credential c
    set ends_at = now()
    where c.tenant_id = p_tenant_id and c.service_account_id = p_service_account_id
      and c.status = 'active' and c.ends_at is not null and c.ends_at > now();
    update corvis_control.service_account_credential c
    set ends_at = least(now() + make_interval(mins => p_overlap_minutes), c.expires_at)
    where c.tenant_id = p_tenant_id and c.credential_id = v_current.credential_id;
  end if;

  insert into corvis_control.service_account_credential
    (tenant_id, credential_id, service_account_id, secret_sha256, created_by_subject, expires_at)
  values
    (p_tenant_id, p_credential_id, p_service_account_id, p_secret_sha256, p_actor_subject, least(p_credential_expires_at, v_account.expires_at));

  return p_credential_id;
end;
$$;


--
-- Name: list_due_export_schedules(integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.list_due_export_schedules(p_limit integer) RETURNS TABLE(tenant_id uuid, schedule_id uuid)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select s.tenant_id, s.schedule_id
  from corvis_control.export_schedule s
  where s.status = 'active'
    and ((s.trigger_kind <> 'on_publish' and s.next_run_at <= now())
      or (s.trigger_kind = 'on_publish' and exists (select 1 from corvis_control.export_schedule_latest_publication(s))))
  order by coalesce(s.next_run_at, s.publish_watermark), s.schedule_id
  limit greatest(p_limit, 0)
$$;


--
-- Name: mark_tenant_export_artifact_deleted(uuid, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.mark_tenant_export_artifact_deleted(p_tenant_id uuid, p_request_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_row corvis_control.tenant_export_request%rowtype;
  v_grants integer;
begin
  update corvis_control.tenant_export_request r
  set artifact_deleted_at = now()
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id
    and r.state = 'complete' and r.artifact_deleted_at is null and r.artifact_expires_at <= now()
  returning * into v_row;
  if not found then
    return false;
  end if;
  delete from corvis_control.tenant_export_download_grant g
  where g.tenant_id = p_tenant_id and g.request_id = p_request_id;
  get diagnostics v_grants = row_count;
  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (p_tenant_id, p_request_id, 'artifact_deleted', 'complete', 'complete', 'system:tenant-export', 'artifact lifetime passed');
  perform corvis_control.tenant_export_system_audit(p_tenant_id, v_row.workspace_id, p_request_id, 'data_export.artifact_deleted', 'success',
    jsonb_build_object('status', 'complete', 'grantsDeleted', v_grants));
  return true;
end;
$$;


--
-- Name: notify_tenant_export_event(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.notify_tenant_export_event() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_requester uuid;
begin
  if new.event_type not in ('requested','approved','rejected','build_completed','build_failed') then
    return new;
  end if;
  begin
    select r.requested_by_user_id into v_requester
    from corvis_control.tenant_export_request r
    where r.tenant_id = new.tenant_id and r.request_id = new.request_id;

    if new.event_type = 'requested' then
      -- Every other active Organization Admin with an active human identity: the people who may approve it.
      insert into corvis_control.email_outbox
        (tenant_id, category, recipient_user_id, required_roles, template_params, dedupe_key)
      select distinct m.tenant_id, 'tenant_export_approval', m.user_id, array['tenant_admin']::text[],
        jsonb_build_object('event', 'approval_needed'),
        'tenant_export_approval:' || new.request_id::text || ':' || m.user_id::text
      from corvis_control.membership m
      where m.tenant_id = new.tenant_id
        and m.role_name = 'tenant_admin' and m.status = 'active'
        and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
        and m.user_id <> v_requester
        and exists (
          select 1 from corvis_control.identity_subject s
          where s.tenant_id = m.tenant_id and s.user_id = m.user_id and s.status = 'active' and s.auth_method in ('oidc','saml')
        )
      on conflict (tenant_id, dedupe_key) do nothing;
    else
      insert into corvis_control.email_outbox
        (tenant_id, category, recipient_user_id, required_roles, template_params, dedupe_key)
      values (new.tenant_id, 'tenant_export_outcome', v_requester, array['tenant_admin']::text[],
        jsonb_build_object('event', case new.event_type
          when 'approved' then 'approved'
          when 'rejected' then 'rejected'
          when 'build_completed' then 'ready'
          else 'failed' end),
        'tenant_export_outcome:' || new.request_id::text || ':' || new.event_type)
      on conflict (tenant_id, dedupe_key) do nothing;
    end if;
  exception when others then
    raise warning 'tenant export notification not queued: %', sqlerrm;
  end;
  return new;
end;
$$;


--
-- Name: open_data_correction_incident(uuid, uuid, text, text, text, text, text, uuid, integer, uuid, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.open_data_correction_incident(p_tenant_id uuid, p_incident_id uuid, p_idempotency_key text, p_request_hash text, p_fund_id text, p_report_period text, p_metric_code text, p_snapshot_id uuid, p_snapshot_version integer, p_document_id uuid, p_root_cause text, p_correction_intent text, p_opened_by text) RETURNS TABLE(incident_id uuid, state text)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_source'
    AS $$
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


--
-- Name: processing_job_for_effect_key(uuid, uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.processing_job_for_effect_key(p_tenant_id uuid, p_document_id uuid, p_stage text, p_effect_key text) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
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


--
-- Name: processing_predecessor_job_for_effect(uuid, uuid, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.processing_predecessor_job_for_effect(p_tenant_id uuid, p_document_id uuid, p_current_stage text, p_effect_key text, p_expected_predecessor_stage text) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select corvis_control.processing_predecessor_job_for_job(
    p_tenant_id,
    corvis_control.processing_job_for_effect_key(p_tenant_id,p_document_id,p_current_stage,p_effect_key),
    p_expected_predecessor_stage
  )
$$;


--
-- Name: processing_predecessor_job_for_job(uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.processing_predecessor_job_for_job(p_tenant_id uuid, p_job_id text, p_expected_predecessor_stage text) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
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


--
-- Name: processing_replay_scope_for_effect(uuid, uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.processing_replay_scope_for_effect(p_tenant_id uuid, p_document_id uuid, p_stage text, p_effect_key text) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
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


--
-- Name: promote_control_implementation(uuid, text, text, timestamp with time zone); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.promote_control_implementation(p_tenant_id uuid, p_control_code text, p_promoted_by text, p_evaluated_at timestamp with time zone) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
  v_required integer;
  v_unsatisfied integer;
  v_new_version integer;
begin
  select count(*) into v_required
  from corvis_control.control_evidence_requirement r
  where r.tenant_id = p_tenant_id and r.control_code = p_control_code and r.mandatory;

  if v_required = 0 then return null; end if;

  select count(*) into v_unsatisfied
  from corvis_control.control_evidence_requirement r
  where r.tenant_id = p_tenant_id
    and r.control_code = p_control_code
    and r.mandatory
    and not exists (
      select 1
      from corvis_control.control_evidence_record e
      where e.tenant_id = r.tenant_id
        and e.control_code = r.control_code
        and e.source_key = r.source_key
        and e.result = 'pass'
        and e.collected_at <= p_evaluated_at
        and e.valid_through > p_evaluated_at
    );

  if v_unsatisfied > 0 then return null; end if;

  update corvis_control.control_definition
  set implementation_state = 'implemented',
      promoted_at = p_evaluated_at,
      promoted_by = p_promoted_by,
      version = version + 1,
      updated_at = now()
  where tenant_id = p_tenant_id and control_code = p_control_code
  returning version into v_new_version;

  return v_new_version;
end;
$$;


--
-- Name: purge_tenant_session_activity(integer, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.purge_tenant_session_activity(p_retention_minutes integer, p_limit integer DEFAULT 5000) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_count integer;
begin
  -- 10080 (the longest maximum session the policy allows) + 1440 (a day of margin).
  if p_retention_minutes is null or p_retention_minutes < 11520 then
    raise exception 'session activity retention is shorter than the longest session';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'session activity purge limit is out of range';
  end if;

  delete from corvis_control.tenant_session_activity a
  where (a.tenant_id, a.auth_method, a.subject, a.session_id) in (
    select x.tenant_id, x.auth_method, x.subject, x.session_id
    from corvis_control.tenant_session_activity x
    where x.last_seen_at < now() - make_interval(mins => p_retention_minutes)
    order by x.last_seen_at
    limit p_limit
    for update skip locked
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


--
-- Name: queue_service_account_expiry_notices(integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.queue_service_account_expiry_notices(p_limit integer DEFAULT 500) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_count integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'service account expiry notice limit is out of range';
  end if;

  insert into corvis_control.email_outbox (tenant_id, category, recipient_user_id, required_roles, template_params, dedupe_key)
  select due.tenant_id, 'service_account_expiry', due.user_id, array['tenant_admin']::text[],
    jsonb_build_object('subject', due.item_kind, 'window', due.warning_window),
    due.dedupe_key
  from (
    select c.tenant_id, c.item_kind, c.warning_window, c.expires_at, r.user_id,
      'service_account_expiry:' || c.item_kind || ':' || c.item_id || ':' || c.warning_window || ':'
        || floor(extract(epoch from c.expires_at))::bigint::text || ':' || r.user_id::text as dedupe_key
    from (
      -- An active account inside its warning window.
      select a.tenant_id, 'account'::text as item_kind, a.service_account_id::text as item_id, a.expires_at,
        case when a.expires_at <= now() + interval '3 days' then 'final' else 'warning' end as warning_window
      from corvis_control.service_account a
      where a.status = 'active' and a.expires_at > now() and a.expires_at <= now() + interval '14 days'
      union all
      -- The credential in use (not one already rotating out or revoked) of an active, unexpired account, when it ends
      -- before the account does: a credential clamped to its account's expiry is covered by the account's own notice.
      select k.tenant_id, 'credential'::text, k.credential_id::text, k.expires_at,
        case when k.expires_at <= now() + interval '3 days' then 'final' else 'warning' end
      from corvis_control.service_account_credential k
      join corvis_control.service_account a on a.tenant_id = k.tenant_id and a.service_account_id = k.service_account_id
      where a.status = 'active' and a.expires_at > now()
        and k.status = 'active' and k.ends_at is null
        and k.expires_at > now() and k.expires_at <= now() + interval '14 days'
        and k.expires_at < a.expires_at
    ) c
    join corvis_control.tenant t on t.tenant_id = c.tenant_id and t.status = 'active'
    -- Every active human Organization Admin of the tenant. Eligibility is re-checked when the email is sent.
    join lateral (
      select distinct m.user_id
      from corvis_control.membership m
      where m.tenant_id = c.tenant_id and m.role_name = 'tenant_admin' and m.status = 'active'
        and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
        and exists (
          select 1 from corvis_control.identity_subject s
          where s.tenant_id = m.tenant_id and s.user_id = m.user_id and s.status = 'active' and s.auth_method in ('oidc','saml')
        )
    ) r on true
  ) due
  where not exists (
    select 1 from corvis_control.email_outbox o where o.tenant_id = due.tenant_id and o.dedupe_key = due.dedupe_key
  )
  order by due.expires_at, due.dedupe_key
  limit p_limit
  on conflict (tenant_id, dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


--
-- Name: reactivate_identity_admin(uuid, text, text, uuid, text, text, text, uuid, jsonb, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.reactivate_identity_admin(p_tenant_id uuid, p_event_key text, p_actor_subject text, p_actor_workspace_id uuid, p_correlation_id text, p_auth_method text, p_subject text, p_user_id uuid, p_memberships jsonb, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'corvis_control', 'public'
    AS $$
declare
  v_existing_user_id uuid;
  v_status text;
  v_result jsonb;
begin
  if exists (select 1 from corvis_control.identity_lifecycle_event where tenant_id=p_tenant_id and event_key=p_event_key) then
    return corvis_control.apply_identity_lifecycle(
      p_tenant_id,p_event_key,p_actor_subject,p_actor_workspace_id,p_correlation_id,
      'sync',p_auth_method,p_subject,p_user_id,p_memberships,p_reason
    );
  end if;

  select user_id,status into v_existing_user_id,v_status
  from corvis_control.identity_subject
  where tenant_id=p_tenant_id and auth_method=p_auth_method and subject=p_subject
  for update;

  if not found or v_existing_user_id<>p_user_id then raise exception 'identity subject does not match requested user'; end if;
  if v_status<>'disabled' then raise exception 'identity is not disabled'; end if;

  update corvis_control.identity_subject
    set status='active',disabled_at=null
    where tenant_id=p_tenant_id and auth_method=p_auth_method and subject=p_subject;

  v_result := corvis_control.apply_identity_lifecycle(
    p_tenant_id,p_event_key,p_actor_subject,p_actor_workspace_id,p_correlation_id,
    'sync',p_auth_method,p_subject,p_user_id,p_memberships,p_reason
  );

  insert into corvis_control.audit_event
    (tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values
    (p_tenant_id,p_actor_workspace_id,p_actor_subject,'identity.lifecycle.reactivate','identity_subject',p_subject,
     'success',p_correlation_id,jsonb_build_object('eventKey',p_event_key,'authMethod',p_auth_method,
       'userId',p_user_id,'reason',p_reason,'memberships',p_memberships));
  return v_result;
end;
$$;


--
-- Name: record_tenant_export_build_progress(uuid, uuid, integer, jsonb, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.record_tenant_export_build_progress(p_tenant_id uuid, p_request_id uuid, p_attempt integer, p_progress jsonb, p_lease_minutes integer) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_updated integer;
begin
  update corvis_control.tenant_export_request r
  set build_progress = p_progress,
      build_lease_expires_at = greatest(coalesce(r.build_lease_expires_at, now()), now() + make_interval(mins => greatest(1, p_lease_minutes)))
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id
    and r.state = 'building' and r.build_attempts = p_attempt;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;


--
-- Name: recover_dead_letter_processing_job(uuid, text, integer, uuid, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.recover_dead_letter_processing_job(p_tenant_id uuid, p_job_id text, p_expected_version integer, p_recovery_event_id uuid, p_actor_subject text, p_reason_code text, p_note text DEFAULT NULL::text) RETURNS TABLE(new_version integer, recovery_count integer, recovery_event_id uuid)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  current_job corvis_control.processing_job%rowtype;
  existing_recovery corvis_control.processing_recovery_event%rowtype;
  source_inbox corvis_control.event_inbox%rowtype;
  source_payload jsonb;
  next_version integer;
  next_recovery_count integer;
  before_payload jsonb;
  after_payload jsonb;
begin
  if p_job_id is null or btrim(p_job_id)='' then raise exception 'recovery job id is required'; end if;
  if p_actor_subject is null or btrim(p_actor_subject)='' then raise exception 'recovery actor is required'; end if;
  if p_reason_code is null or btrim(p_reason_code)='' then raise exception 'recovery reason code is required'; end if;

  select * into existing_recovery
  from corvis_control.processing_recovery_event
  where tenant_id=p_tenant_id and processing_recovery_event.recovery_event_id=p_recovery_event_id;

  if found then
    if existing_recovery.job_id <> p_job_id
      or existing_recovery.actor_subject <> p_actor_subject
      or existing_recovery.reason_code <> p_reason_code
      or existing_recovery.note is distinct from p_note then
      raise exception 'processing recovery idempotency key was reused with different command content';
    end if;
    return query select existing_recovery.result_job_version,
      existing_recovery.recovery_count,existing_recovery.recovery_event_id;
    return;
  end if;

  select * into current_job
  from corvis_control.processing_job
  where tenant_id=p_tenant_id and job_id=p_job_id and version=p_expected_version
  for update;

  if not found then return; end if;
  if current_job.state <> 'dead_letter' then raise exception 'only terminal dead-letter jobs can be operator-recovered'; end if;
  if current_job.attempt < current_job.max_attempts then
    raise exception 'dead-letter recovery requires an exhausted job; use normal retry before exhaustion';
  end if;

  -- Reuse the retained payload that originally drove this logical stage. Prefer a
  -- payload carrying predecessorResult for lineage-enforcing stages.
  select i.* into source_inbox
  from corvis_control.event_inbox i
  where i.tenant_id=p_tenant_id
    and i.consumer_name='processing-stage-worker'
    and i.aggregate_id=current_job.document_id::text
    and (
      i.payload ->> 'jobId'=p_job_id
      or (current_job.stage='registered' and i.event_type='DocumentRegistered')
    )
  order by
    case when current_job.stage='registered' or i.payload ? 'predecessorResult' then 0 else 1 end,
    i.last_received_at desc,i.event_id desc
  limit 1;

  if not found then
    raise exception 'dead-letter recovery requires retained durable stage-delivery evidence';
  end if;
  if current_job.stage <> 'registered' and not (source_inbox.payload ? 'predecessorResult') then
    raise exception 'dead-letter recovery requires retained predecessor lineage evidence';
  end if;

  source_payload := (source_inbox.payload - 'nextAttemptAt') || jsonb_build_object(
    'jobId',current_job.job_id,
    'documentId',current_job.document_id,
    'stage',current_job.stage,
    'recoveryEventId',p_recovery_event_id,
    'recovery',true,
    'requestedBy',p_actor_subject
  );

  next_version := current_job.version + 1;
  next_recovery_count := current_job.recovery_count + 1;
  before_payload := jsonb_build_object(
    'state',current_job.state,
    'version',current_job.version,
    'attempt',current_job.attempt,
    'maxAttempts',current_job.max_attempts,
    'lastError',current_job.last_error,
    'blockedReason',current_job.blocked_reason,
    'recoveryCount',current_job.recovery_count
  );
  after_payload := jsonb_build_object(
    'state','queued',
    'version',next_version,
    'attempt',0,
    'maxAttempts',current_job.max_attempts,
    'recoveryCount',next_recovery_count
  );

  update corvis_control.processing_job
  set state='queued',
      attempt=0,
      last_error=null,
      blocked_reason=null,
      recovery_count=next_recovery_count,
      version=next_version,
      updated_at=now()
  where tenant_id=p_tenant_id and job_id=p_job_id and version=p_expected_version;

  if not found then return; end if;

  insert into corvis_control.processing_recovery_event (
    tenant_id,recovery_event_id,job_id,document_id,stage,action,actor_subject,
    reason_code,note,source_event_id,source_job_version,source_attempt,source_max_attempts,
    recovery_count,result_job_version,before_state,after_state,created_at
  ) values (
    p_tenant_id,p_recovery_event_id,current_job.job_id,current_job.document_id,current_job.stage,
    'recover_dead_letter',p_actor_subject,p_reason_code,p_note,source_inbox.event_id,
    current_job.version,current_job.attempt,current_job.max_attempts,next_recovery_count,next_version,
    before_payload,after_payload,now()
  );

  insert into corvis_control.outbox_event (
    tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at
  ) values (
    p_tenant_id,p_recovery_event_id,'ProcessingJobRetryRequested','processing_job',current_job.job_id,
    source_payload,now()
  );

  return query select next_version,next_recovery_count,p_recovery_event_id;
end;
$$;


--
-- Name: reject_audit_event_mutation(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.reject_audit_event_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_control.audit_event is append-only';
end;
$$;


--
-- Name: reject_control_evidence_mutation(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.reject_control_evidence_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_control.control_evidence_record is append-only; record a new revision instead';
end;
$$;


--
-- Name: reject_data_issue_event_mutation(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.reject_data_issue_event_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  raise exception 'data issue case history is append-only';
end;
$$;


--
-- Name: reject_export_schedule_delete(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.reject_export_schedule_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  raise exception 'export schedules are deleted by status, never by row';
end;
$$;


--
-- Name: reject_export_schedule_run_mutation(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.reject_export_schedule_run_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  raise exception 'export schedule run history is append-only';
end;
$$;


--
-- Name: reject_review_item_comment_mutation(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.reject_review_item_comment_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  raise exception 'review item comments are append-only';
end;
$$;


--
-- Name: reject_review_item_thread_removal(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.reject_review_item_thread_removal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  raise exception 'review item threads cannot be deleted';
end;
$$;


--
-- Name: reject_tenant_export_event_mutation(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.reject_tenant_export_event_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  raise exception 'tenant export history is append-only';
end;
$$;


--
-- Name: release_processing_transport_event(uuid, uuid, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.release_processing_transport_event(p_tenant_id uuid, p_event_id uuid, p_lease_token uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
begin
  -- Only the current lease holder may release, and only while the lease is still
  -- live: after expiry another dispatcher may already own the event.
  update corvis_control.outbox_event
  set transport_lease_token=null,
      transport_lease_expires_at=null,
      attempt_count=greatest(attempt_count-1,0)
  where tenant_id=p_tenant_id and event_id=p_event_id and published_at is null
    and transport_dead_lettered_at is null
    and transport_lease_token=p_lease_token and transport_lease_expires_at > now();
  return found;
end;
$$;


--
-- Name: remove_tenant_verified_domain(uuid, uuid, text, text, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.remove_tenant_verified_domain(p_target_tenant_id uuid, p_actor_tenant_id uuid, p_actor_auth_method text, p_actor_subject text, p_domain text, p_reason text, p_correlation_id text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_removed corvis_control.tenant_verified_domain%rowtype;
begin
  if not corvis_control.identity_records_operator(p_actor_tenant_id, p_actor_auth_method, p_actor_subject) then
    raise exception 'identity records require an active operations admin';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 1000 then
    raise exception 'identity record change needs a stated reason';
  end if;
  perform 1 from corvis_control.tenant t where t.tenant_id = p_target_tenant_id for update;
  if not found then
    raise exception 'identity record tenant not found';
  end if;

  delete from corvis_control.tenant_verified_domain d
   where d.tenant_id = p_target_tenant_id and d.domain = p_domain
  returning * into v_removed;
  if not found then
    raise exception 'verified domain not found';
  end if;

  insert into corvis_control.audit_event
    (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
  values
    (p_target_tenant_id, null, p_actor_subject, 'access.verified_domain.removed', 'verified_domain', p_domain, 'success',
     p_correlation_id,
     jsonb_build_object('domain', p_domain, 'verificationMethod', v_removed.verification_method,
       'reason', btrim(p_reason), 'actorTenantId', p_actor_tenant_id));
  return jsonb_build_object('changed', true, 'domain', p_domain);
end;
$$;


--
-- Name: report_data_issue(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, uuid, integer, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.report_data_issue(p_tenant_id uuid, p_case_id uuid, p_workspace_id uuid, p_reporter_auth_method text, p_reporter_subject text, p_idempotency_key text, p_request_hash text, p_figure text, p_fund_id text, p_fund_label text, p_company_id text, p_company_label text, p_metric_code text, p_metric_label text, p_report_period text, p_snapshot_id uuid, p_snapshot_version integer, p_comment text) RETURNS SETOF corvis_control.data_issue_case
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated'
    AS $$
declare
  v_case corvis_control.data_issue_case%rowtype;
  v_user_id uuid;
begin
  select * into v_case from corvis_control.data_issue_case c
  where c.tenant_id = p_tenant_id and c.reporter_auth_method = p_reporter_auth_method
    and c.reporter_subject = p_reporter_subject and c.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_case.request_hash <> p_request_hash then
      raise exception 'idempotency key reused with different data issue report';
    end if;
    return next v_case;
    return;
  end if;

  if p_snapshot_id is not null and not exists (
    select 1 from corvis_consolidated.fund_period_snapshot s
    where s.tenant_id = p_tenant_id and s.snapshot_id = p_snapshot_id and s.fund_id = p_fund_id
      and (p_snapshot_version is null or s.version = p_snapshot_version)
  ) then
    raise exception 'data issue snapshot not found for fund';
  end if;

  select s.user_id into v_user_id from corvis_control.identity_subject s
  where s.tenant_id = p_tenant_id and s.auth_method = p_reporter_auth_method
    and s.subject = p_reporter_subject and s.status = 'active';

  insert into corvis_control.data_issue_case
    (tenant_id, case_id, workspace_id, reporter_auth_method, reporter_subject, reporter_user_id, idempotency_key, request_hash,
     figure, fund_id, fund_label, company_id, company_label, metric_code, metric_label, report_period, snapshot_id,
     snapshot_version, comment, status, status_changed_by, reporter_seen_status)
  values
    (p_tenant_id, p_case_id, p_workspace_id, p_reporter_auth_method, p_reporter_subject, v_user_id, p_idempotency_key, p_request_hash,
     p_figure, p_fund_id, p_fund_label, p_company_id, p_company_label, p_metric_code, p_metric_label, p_report_period, p_snapshot_id,
     p_snapshot_version, btrim(p_comment), 'received', p_reporter_subject, 'received')
  returning * into v_case;

  insert into corvis_control.data_issue_case_event (tenant_id, case_id, from_status, to_status, actor_subject)
  values (p_tenant_id, p_case_id, null, 'received', p_reporter_subject);

  return next v_case;
end;
$$;


--
-- Name: request_customer_deletion(uuid, uuid, uuid, text, text, jsonb, text, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.request_customer_deletion(p_tenant_id uuid, p_request_id uuid, p_workspace_id uuid, p_auth_method text, p_subject text, p_data_classes jsonb, p_reason text, p_approval_window_hours integer) RETURNS SETOF corvis_control.deletion_request
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_user uuid;
  v_classes jsonb;
  v_stale corvis_control.deletion_request%rowtype;
  v_row corvis_control.deletion_request%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 or length(btrim(p_reason)) > 1000 then
    raise exception 'customer deletion purpose required';
  end if;
  v_user := corvis_control.tenant_export_admin_user(p_tenant_id, p_auth_method, p_subject);
  if v_user is null then
    raise exception 'customer deletion requires an active organization admin';
  end if;
  if not exists (select 1 from corvis_control.workspace w where w.tenant_id = p_tenant_id and w.workspace_id = p_workspace_id) then
    raise exception 'workspace not found';
  end if;

  -- The scope: 1 to 20 distinct, non-blank data class names, each with a retention policy in effect. Anything else
  -- (a selector, a class the organization has no policy for) is refused rather than widened or guessed at.
  if p_data_classes is null or jsonb_typeof(p_data_classes) <> 'array' then
    raise exception 'customer deletion scope invalid';
  end if;
  if jsonb_array_length(p_data_classes) not between 1 and 20
     or exists (
       select 1 from jsonb_array_elements(p_data_classes) e
       where jsonb_typeof(e) <> 'string' or length(btrim(e #>> '{}')) not between 1 and 100
     ) then
    raise exception 'customer deletion scope invalid';
  end if;
  select jsonb_agg(c.name order by c.name) into v_classes
  from (select distinct btrim(e #>> '{}') as name from jsonb_array_elements(p_data_classes) e) c;
  if (select count(distinct p.data_class) from corvis_control.retention_policy p
      where p.tenant_id = p_tenant_id and p.effective_from <= now()
        and p.data_class in (select jsonb_array_elements_text(v_classes)))
     <> jsonb_array_length(v_classes) then
    raise exception 'customer deletion scope invalid';
  end if;
  if corvis_control.deletion_scope_legal_hold(p_tenant_id, v_classes) then
    raise exception 'customer deletion blocked by legal hold';
  end if;

  for v_stale in
    select * from corvis_control.deletion_request r
    where r.tenant_id = p_tenant_id and r.state = 'pending_customer_approval' and r.approval_expires_at <= now()
    order by r.requested_at
    for update
  loop
    update corvis_control.deletion_request r set state = 'expired'
    where r.tenant_id = p_tenant_id and r.deletion_request_id = v_stale.deletion_request_id;
    perform corvis_control.customer_deletion_system_audit(p_tenant_id, v_stale.workspace_id, v_stale.deletion_request_id,
      'deletion_request.customer_expired', 'success', jsonb_build_object('status', 'expired'));
  end loop;

  if exists (
    select 1 from corvis_control.deletion_request r
    where r.tenant_id = p_tenant_id and r.state = 'pending_customer_approval'
  ) then
    raise exception 'customer deletion already pending';
  end if;

  insert into corvis_control.deletion_request
    (tenant_id, deletion_request_id, requested_by, scope, reason, state, origin, workspace_id,
     requested_by_auth_method, requested_by_user_id, approval_expires_at)
  values
    (p_tenant_id, p_request_id, p_subject, jsonb_build_object('dataClasses', v_classes), btrim(p_reason),
     'pending_customer_approval', 'customer', p_workspace_id, p_auth_method, v_user,
     now() + make_interval(hours => p_approval_window_hours))
  returning * into v_row;

  -- The mandatory notice to every other active human Organization Admin: the people who may approve it. A failure to
  -- queue it is a warning and never undoes the request (the subtransaction rolls back only the notice).
  begin
    insert into corvis_control.email_outbox
      (tenant_id, category, recipient_user_id, required_roles, template_params, dedupe_key)
    select distinct m.tenant_id, 'deletion_request_approval', m.user_id, array['tenant_admin']::text[],
      jsonb_build_object('event', 'approval_needed'),
      'deletion_request_approval:' || p_request_id::text || ':' || m.user_id::text
    from corvis_control.membership m
    where m.tenant_id = p_tenant_id
      and m.role_name = 'tenant_admin' and m.status = 'active'
      and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
      and m.user_id <> v_user
      and exists (
        select 1 from corvis_control.identity_subject s
        where s.tenant_id = m.tenant_id and s.user_id = m.user_id and s.status = 'active' and s.auth_method in ('oidc','saml')
      )
    on conflict (tenant_id, dedupe_key) do nothing;
  exception when others then
    raise warning 'customer deletion notification not queued: %', sqlerrm;
  end;

  return next v_row;
end;
$$;


--
-- Name: request_data_correction_replay(uuid, uuid, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.request_data_correction_replay(p_tenant_id uuid, p_incident_id uuid, p_requested_by text) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated', 'corvis_facts', 'corvis_source'
    AS $$
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
$$;


--
-- Name: request_tenant_export(uuid, uuid, uuid, text, text, text, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.request_tenant_export(p_tenant_id uuid, p_request_id uuid, p_workspace_id uuid, p_auth_method text, p_subject text, p_reason text, p_approval_window_hours integer) RETURNS SETOF corvis_control.tenant_export_request
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_user uuid;
  v_stale corvis_control.tenant_export_request%rowtype;
  v_row corvis_control.tenant_export_request%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 or length(btrim(p_reason)) > 1000 then
    raise exception 'tenant export purpose required';
  end if;
  v_user := corvis_control.tenant_export_admin_user(p_tenant_id, p_auth_method, p_subject);
  if v_user is null then
    raise exception 'tenant export requires an active organization admin';
  end if;
  if not exists (select 1 from corvis_control.workspace w where w.tenant_id = p_tenant_id and w.workspace_id = p_workspace_id) then
    raise exception 'workspace not found';
  end if;

  for v_stale in
    select * from corvis_control.tenant_export_request r
    where r.tenant_id = p_tenant_id and r.state = 'pending_approval' and r.approval_expires_at <= now()
    order by r.requested_at
    for update
  loop
    update corvis_control.tenant_export_request r set state = 'expired', state_changed_at = now()
    where r.tenant_id = p_tenant_id and r.request_id = v_stale.request_id;
    insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
    values (p_tenant_id, v_stale.request_id, 'expired', 'pending_approval', 'expired', 'system:tenant-export', 'no second organization admin approved in time');
    perform corvis_control.tenant_export_system_audit(p_tenant_id, v_stale.workspace_id, v_stale.request_id, 'data_export.expired', 'success',
      jsonb_build_object('status', 'expired'));
  end loop;

  if exists (
    select 1 from corvis_control.tenant_export_request r
    where r.tenant_id = p_tenant_id and r.state in ('pending_approval','approved','building')
  ) then
    raise exception 'tenant export already in progress';
  end if;

  insert into corvis_control.tenant_export_request
    (tenant_id, request_id, workspace_id, requested_by_auth_method, requested_by_subject, requested_by_user_id,
     reason, state, approval_expires_at)
  values
    (p_tenant_id, p_request_id, p_workspace_id, p_auth_method, p_subject, v_user,
     btrim(p_reason), 'pending_approval', now() + make_interval(hours => p_approval_window_hours))
  returning * into v_row;

  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (p_tenant_id, p_request_id, 'requested', null, 'pending_approval', p_subject, null);

  return next v_row;
end;
$$;


--
-- Name: resolve_data_correction_incident(uuid, uuid, uuid, integer, text, jsonb); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.resolve_data_correction_incident(p_tenant_id uuid, p_incident_id uuid, p_replacement_snapshot_id uuid, p_replacement_snapshot_version integer, p_resolved_by text, p_resolution_evidence jsonb) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated'
    AS $$
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


--
-- Name: resolve_review_subject(uuid, text, uuid, jsonb, jsonb); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.resolve_review_subject(p_tenant_id uuid, p_subject_kind text, p_subject_id uuid, p_fund_ids jsonb, p_document_ids jsonb) RETURNS TABLE(subject_fund_id text, subject_report_period text)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated', 'corvis_source', 'corvis_serving'
    AS $$
begin
  if p_subject_kind = 'observation' then
    return query
      select o.fund_id::text, o.economic_period::text
      from corvis_serving.observations o
      join corvis_source.source_reference r
        on r.tenant_id = o.tenant_id and r.source_reference_id = o.source_reference_id
      where o.tenant_id = p_tenant_id and o.observation_id = p_subject_id
        and o.fund_id in (select jsonb_array_elements_text(p_fund_ids))
        and lower(r.document_id::text) in (select lower(entitled.id) from jsonb_array_elements_text(p_document_ids) as entitled(id))
      limit 1;
  elsif p_subject_kind = 'reconciliation_exception' then
    return query
      select e.fund_id::text, e.report_period::text
      from corvis_consolidated.reconciliation_exception e
      where e.tenant_id = p_tenant_id and e.exception_id = p_subject_id
        and e.fund_id in (select jsonb_array_elements_text(p_fund_ids))
      limit 1;
  end if;
end;
$$;


--
-- Name: resume_blocked_reconciled_stage(uuid, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.resume_blocked_reconciled_stage(p_tenant_id uuid, p_exception_id uuid) RETURNS TABLE(resumed boolean, resume_event_id uuid, job_version integer)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated'
    AS $$
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
  where tenant_id=p_tenant_id and job_id=corvis_control.processing_job_for_effect_key(p_tenant_id,run_row.document_id,'reconciled',run_row.idempotency_key)
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
      'predecessorJobId',corvis_control.processing_predecessor_job_for_job(p_tenant_id,current_job.job_id,'canonicalized')
    ),now()
  ) on conflict (tenant_id,event_id) do nothing;

  return query select true,signal_id,current_job.version;
end;
$$;


--
-- Name: resume_blocked_reviewed_stage(uuid, text, uuid, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.resume_blocked_reviewed_stage(p_tenant_id uuid, p_job_id text, p_extraction_run_id uuid, p_review_policy_version text) RETURNS TABLE(resumed boolean, resume_event_id uuid, job_version integer)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: retry_processing_job(uuid, text, integer, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.retry_processing_job(p_tenant_id uuid, p_job_id text, p_expected_version integer, p_requested_by text) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  current_job corvis_control.processing_job%rowtype;
  source_payload jsonb;
begin
  update corvis_control.processing_job
  set state='queued', last_error=null, version=version+1, updated_at=now()
  where tenant_id=p_tenant_id and job_id=p_job_id and version=p_expected_version
    and state in ('retryable','failed','dead_letter') and attempt < max_attempts
  returning * into current_job;

  if not found then return null; end if;

  -- Prefer evidence addressed to this exact job, then evidence that carries the
  -- stage's inputs (predecessor lineage, or the registration event itself).
  select i.payload into source_payload
  from corvis_control.event_inbox i
  where i.tenant_id=p_tenant_id
    and i.consumer_name='processing-stage-worker'
    and i.aggregate_id=current_job.document_id::text
    and (
      i.payload ->> 'jobId'=p_job_id
      or (current_job.stage='registered' and i.event_type='DocumentRegistered')
    )
  order by
    case when i.payload ->> 'jobId'=p_job_id then 0 else 1 end,
    case when current_job.stage='registered' or i.payload ? 'predecessorResult' then 0 else 1 end,
    i.last_received_at desc,i.event_id desc
  limit 1;

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,gen_random_uuid(),'ProcessingJobRetryRequested','processing_job',p_job_id,
    (coalesce(source_payload,'{}'::jsonb) - 'nextAttemptAt' - 'recovery' - 'recoveryEventId') || jsonb_build_object(
      'jobId',p_job_id,
      'documentId',current_job.document_id,
      'stage',current_job.stage,
      'requestedBy',p_requested_by
    ),
    now()
  );
  return current_job.version;
end;
$$;


--
-- Name: review_eligible_members(uuid, uuid, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.review_eligible_members(p_tenant_id uuid, p_workspace_id uuid, p_fund_id text) RETURNS TABLE(member_user_id uuid, member_label text, member_roles text[])
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select m.user_id,
         corvis_control.review_member_label(p_tenant_id, m.user_id),
         array_agg(distinct m.role_name order by m.role_name)
  from corvis_control.membership m
  where m.tenant_id = p_tenant_id and m.workspace_id = p_workspace_id
    and m.role_name in ('tenant_admin','accountadmin','reviewer')
    and m.status = 'active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    and corvis_control.review_member_eligible(p_tenant_id, p_workspace_id, m.user_id, p_fund_id)
  group by m.user_id;
$$;


--
-- Name: review_member_eligible(uuid, uuid, uuid, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.review_member_eligible(p_tenant_id uuid, p_workspace_id uuid, p_user_id uuid, p_fund_id text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select exists (
    select 1
    from corvis_control.membership m
    join corvis_control.workspace w
      on w.tenant_id = m.tenant_id and w.workspace_id = m.workspace_id and w.status = 'active'
    join corvis_control.tenant t
      on t.tenant_id = m.tenant_id and t.status = 'active'
    where m.tenant_id = p_tenant_id and m.workspace_id = p_workspace_id and m.user_id = p_user_id
      and m.role_name in ('tenant_admin','accountadmin','reviewer')
      and m.status = 'active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
  )
  and exists (
    select 1
    from corvis_control.identity_subject s
    where s.tenant_id = p_tenant_id and s.user_id = p_user_id and s.status = 'active' and s.auth_method in ('oidc','saml')
  )
  and exists (
    select 1
    from corvis_control.resource_entitlement e
    where e.tenant_id = p_tenant_id and e.workspace_id = p_workspace_id and e.subject_user_id = p_user_id
      and e.resource_type = 'fund' and e.resource_id = p_fund_id and e.permission = 'read'
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now())
      and coalesce((
        select bool_and(dr.client_visible)
        from corvis_control.data_rights dr
        where dr.tenant_id = e.tenant_id and dr.resource_type = 'fund' and dr.resource_id = e.resource_id
          and dr.effective_from <= now() and (dr.effective_to is null or dr.effective_to > now())
      ), false)
  );
$$;


--
-- Name: review_member_label(uuid, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.review_member_label(p_tenant_id uuid, p_user_id uuid) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select coalesce(
    (select r.email from corvis_control.notification_recipient r
      where r.tenant_id = p_tenant_id and r.user_id = p_user_id),
    (select i.email from corvis_control.tenant_invitation i
      where i.tenant_id = p_tenant_id and i.accepted_user_id = p_user_id and i.status = 'accepted'
      order by i.accepted_at desc limit 1),
    (select s.subject from corvis_control.identity_subject s
      where s.tenant_id = p_tenant_id and s.user_id = p_user_id and s.status = 'active' and s.auth_method in ('oidc','saml')
      order by s.auth_method, s.subject limit 1)
  );
$$;


--
-- Name: review_member_labels(uuid, uuid[]); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.review_member_labels(p_tenant_id uuid, p_user_ids uuid[]) RETURNS TABLE(member_user_id uuid, member_label text)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select u.id, corvis_control.review_member_label(p_tenant_id, u.id)
  from unnest(p_user_ids) as u(id);
$$;


--
-- Name: revoke_service_account_credentials(uuid, uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.revoke_service_account_credentials(p_tenant_id uuid, p_service_account_id uuid, p_actor_auth_method text, p_actor_subject text) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_status text;
  v_count integer;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  select a.status into v_status from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  update corvis_control.service_account_credential c
  set status = 'revoked', revoked_at = now(), revoked_by_subject = p_actor_subject, ends_at = now()
  where c.tenant_id = p_tenant_id and c.service_account_id = p_service_account_id
    and c.status = 'active' and c.expires_at > now() and (c.ends_at is null or c.ends_at > now());
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'service account has no active credential';
  end if;
  return v_count;
end;
$$;


--
-- Name: revoke_service_account_entitlement(uuid, uuid, text, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.revoke_service_account_entitlement(p_tenant_id uuid, p_service_account_id uuid, p_actor_auth_method text, p_actor_subject text, p_resource_type text, p_resource_id text) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_account corvis_control.service_account%rowtype;
  v_count integer;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  if p_resource_type is null or p_resource_type not in ('fund','document') then
    raise exception 'service account resource type not allowed';
  end if;
  if length(btrim(coalesce(p_resource_id, ''))) not between 1 and 512 then
    raise exception 'service account resource required';
  end if;
  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;

  update corvis_control.resource_entitlement e
  set valid_from = least(e.valid_from, now() - interval '1 microsecond'), valid_until = now()
  where e.tenant_id = p_tenant_id and e.subject_user_id = v_account.user_id
    and e.resource_type = p_resource_type and e.resource_id = p_resource_id
    and (e.valid_until is null or e.valid_until > now());
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'service account entitlement not found';
  end if;
  return v_count;
end;
$$;


--
-- Name: rotate_webhook_signing_key(uuid, uuid, uuid, text, text, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.rotate_webhook_signing_key(p_tenant_id uuid, p_webhook_id uuid, p_new_key_id uuid, p_new_secret text, p_created_by text, p_grace_seconds integer DEFAULT 86400) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
begin
  if p_new_secret is null or length(p_new_secret) < 32 then
    raise exception 'signing secret must be at least 32 characters';
  end if;
  if p_grace_seconds < 0 or p_grace_seconds > 2592000 then
    raise exception 'grace period out of range';
  end if;

  perform 1 from corvis_control.webhook_subscription
  where tenant_id = p_tenant_id and webhook_id = p_webhook_id and status <> 'revoked'
  for update;
  if not found then raise exception 'webhook subscription not found'; end if;

  update corvis_control.webhook_signing_key
  set status = 'retiring', retire_by = now() + make_interval(secs => p_grace_seconds)
  where tenant_id = p_tenant_id and webhook_id = p_webhook_id and status = 'active';

  insert into corvis_control.webhook_signing_key
    (tenant_id, webhook_id, key_id, secret, status, created_at, created_by)
  values (p_tenant_id, p_webhook_id, p_new_key_id, p_new_secret, 'active', now(), p_created_by);

  return p_new_key_id;
end;
$$;


--
-- Name: scoped_processing_job_id(text, text, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.scoped_processing_job_id(p_correlation_id text, p_stage text, p_document_id uuid) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case
    when coalesce(p_correlation_id,'') like 'data-correction:%'
      then 'correction:' || substring(p_correlation_id from length('data-correction:') + 1)
        || ':' || p_stage || ':' || p_document_id::text
    else p_stage || ':' || p_document_id::text
  end
$$;


--
-- Name: service_account_admin_user(uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.service_account_admin_user(p_tenant_id uuid, p_auth_method text, p_subject text) RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select s.user_id
  from corvis_control.identity_subject s
  where s.tenant_id = p_tenant_id
    and s.auth_method = p_auth_method
    and p_auth_method in ('oidc','saml')
    and s.subject = p_subject
    and s.status = 'active'
    and exists (
      select 1 from corvis_control.membership m
      where m.tenant_id = s.tenant_id and m.user_id = s.user_id
        and m.role_name = 'tenant_admin' and m.status = 'active'
        and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    )
  limit 1
$$;


--
-- Name: service_account_data_right_effective(uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.service_account_data_right_effective(p_tenant_id uuid, p_resource_type text, p_resource_id text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select coalesce((
    select bool_and(dr.client_visible)
    from corvis_control.data_rights dr
    where dr.tenant_id = p_tenant_id and dr.resource_type = p_resource_type and dr.resource_id = p_resource_id
      and dr.effective_from <= now() and (dr.effective_to is null or dr.effective_to > now())
  ), false)
$$;


--
-- Name: service_account_owner_active(uuid, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.service_account_owner_active(p_tenant_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select exists (
    select 1
    from corvis_control.identity_subject s
    where s.tenant_id = p_tenant_id
      and s.user_id = p_user_id
      and s.auth_method in ('oidc','saml')
      and s.status = 'active'
      and exists (
        select 1 from corvis_control.membership m
        where m.tenant_id = s.tenant_id and m.user_id = s.user_id
          and m.role_name = 'tenant_admin' and m.status = 'active'
          and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
      )
  )
$$;


--
-- Name: session_policy_admin_user(uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.session_policy_admin_user(p_tenant_id uuid, p_auth_method text, p_subject text) RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select s.user_id
  from corvis_control.identity_subject s
  where s.tenant_id = p_tenant_id
    and s.auth_method = p_auth_method
    and p_auth_method in ('oidc','saml')
    and s.subject = p_subject
    and s.status = 'active'
    and exists (
      select 1 from corvis_control.membership m
      where m.tenant_id = s.tenant_id and m.user_id = s.user_id
        and m.role_name = 'tenant_admin' and m.status = 'active'
        and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    )
  limit 1
$$;


--
-- Name: set_export_schedule_notification(uuid, uuid, text, text, boolean); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.set_export_schedule_notification(p_tenant_id uuid, p_schedule_id uuid, p_owner_auth_method text, p_owner_subject text, p_notify_on_completion boolean) RETURNS SETOF corvis_control.export_schedule
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_schedule corvis_control.export_schedule%rowtype;
begin
  if p_notify_on_completion is null then
    raise exception 'export schedule notification setting is required';
  end if;
  select * into v_schedule from corvis_control.export_schedule s
  where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    and s.owner_auth_method = p_owner_auth_method and s.owner_subject = p_owner_subject
    and s.status <> 'deleted'
  for update;
  if not found then
    return;
  end if;
  if v_schedule.notify_on_completion <> p_notify_on_completion then
    update corvis_control.export_schedule s
    set notify_on_completion = p_notify_on_completion, updated_at = now()
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    returning * into v_schedule;
  end if;
  return next v_schedule;
end;
$$;


--
-- Name: set_export_schedule_status(uuid, uuid, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.set_export_schedule_status(p_tenant_id uuid, p_schedule_id uuid, p_owner_auth_method text, p_owner_subject text, p_action text) RETURNS SETOF corvis_control.export_schedule
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_schedule corvis_control.export_schedule%rowtype;
  v_now timestamptz := now();
begin
  select * into v_schedule from corvis_control.export_schedule s
  where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    and s.owner_auth_method = p_owner_auth_method and s.owner_subject = p_owner_subject
    and s.status <> 'deleted'
  for update;
  if not found then
    return;
  end if;

  if p_action = 'pause' and v_schedule.status = 'active' then
    update corvis_control.export_schedule s
    set status = 'paused', next_run_at = null, publish_watermark = null, status_changed_at = v_now, status_changed_by = p_owner_subject, updated_at = v_now
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    returning * into v_schedule;
  elsif p_action = 'resume' and v_schedule.status = 'paused' then
    update corvis_control.export_schedule s
    set status = 'active',
        next_run_at = corvis_control.export_schedule_next_run_at(s.trigger_kind, v_now),
        publish_watermark = case when s.trigger_kind = 'on_publish' then v_now end,
        status_changed_at = v_now, status_changed_by = p_owner_subject, updated_at = v_now
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    returning * into v_schedule;
  elsif p_action = 'delete' then
    update corvis_control.export_schedule s
    set status = 'deleted', stop_reason = null, next_run_at = null, publish_watermark = null,
        status_changed_at = v_now, status_changed_by = p_owner_subject, updated_at = v_now
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    returning * into v_schedule;
  else
    raise exception 'export schedule transition not allowed';
  end if;

  return next v_schedule;
end;
$$;


--
-- Name: review_item_thread; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.review_item_thread (
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_kind text NOT NULL,
    subject_id uuid NOT NULL,
    fund_id text NOT NULL,
    report_period text,
    assignee_user_id uuid,
    previous_assignee_user_id uuid,
    assignment_changed_by text,
    assignment_changed_at timestamp with time zone,
    version integer DEFAULT 0 NOT NULL,
    comment_count integer DEFAULT 0 NOT NULL,
    last_comment_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_item_thread_check CHECK (((assignee_user_id IS NULL) OR ((assignment_changed_at IS NOT NULL) AND (assignment_changed_by IS NOT NULL)))),
    CONSTRAINT review_item_thread_comment_count_check CHECK (((comment_count >= 0) AND (comment_count <= 200))),
    CONSTRAINT review_item_thread_fund_id_check CHECK (((length(fund_id) >= 1) AND (length(fund_id) <= 512))),
    CONSTRAINT review_item_thread_report_period_check CHECK (((report_period IS NULL) OR (length(report_period) <= 128))),
    CONSTRAINT review_item_thread_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['observation'::text, 'reconciliation_exception'::text]))),
    CONSTRAINT review_item_thread_version_check CHECK ((version >= 0))
);

ALTER TABLE ONLY corvis_control.review_item_thread FORCE ROW LEVEL SECURITY;


--
-- Name: set_review_item_assignee(uuid, uuid, text, uuid, jsonb, jsonb, text, text, uuid, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.set_review_item_assignee(p_tenant_id uuid, p_workspace_id uuid, p_subject_kind text, p_subject_id uuid, p_fund_ids jsonb, p_document_ids jsonb, p_actor_auth_method text, p_actor_subject text, p_assignee_user_id uuid, p_expected_version integer) RETURNS SETOF corvis_control.review_item_thread
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_consolidated', 'corvis_source', 'corvis_serving'
    AS $$
declare
  v_fund_id text;
  v_period text;
  v_thread corvis_control.review_item_thread%rowtype;
begin
  select s.subject_fund_id, s.subject_report_period into v_fund_id, v_period
  from corvis_control.resolve_review_subject(p_tenant_id, p_subject_kind, p_subject_id, p_fund_ids, p_document_ids) s;
  if v_fund_id is null then
    raise exception 'review item not found';
  end if;
  if not exists (
    select 1 from corvis_control.identity_subject s
    where s.tenant_id = p_tenant_id and s.auth_method = p_actor_auth_method and s.subject = p_actor_subject
      and s.status = 'active' and s.auth_method in ('oidc','saml')
  ) then
    raise exception 'review item actor not found';
  end if;
  if p_assignee_user_id is not null
     and not corvis_control.review_member_eligible(p_tenant_id, p_workspace_id, p_assignee_user_id, v_fund_id) then
    raise exception 'review assignee not eligible';
  end if;

  insert into corvis_control.review_item_thread
    (tenant_id, workspace_id, subject_kind, subject_id, fund_id, report_period, version)
  values (p_tenant_id, p_workspace_id, p_subject_kind, p_subject_id, v_fund_id, v_period, 0)
  on conflict on constraint review_item_thread_pkey do nothing;
  select * into v_thread from corvis_control.review_item_thread t
  where t.tenant_id = p_tenant_id and t.workspace_id = p_workspace_id and t.subject_kind = p_subject_kind and t.subject_id = p_subject_id
  for update;

  if p_expected_version <> v_thread.version then
    raise exception 'review item assignment changed';
  end if;

  if v_thread.assignee_user_id is not distinct from p_assignee_user_id then
    return next v_thread;
    return;
  end if;

  update corvis_control.review_item_thread t
  set previous_assignee_user_id = v_thread.assignee_user_id,
      assignee_user_id = p_assignee_user_id,
      assignment_changed_by = p_actor_subject,
      assignment_changed_at = now(),
      version = v_thread.version + 1
  where t.tenant_id = p_tenant_id and t.workspace_id = p_workspace_id and t.subject_kind = p_subject_kind and t.subject_id = p_subject_id
  returning * into v_thread;

  return next v_thread;
end;
$$;


--
-- Name: set_tenant_identity_provider(uuid, uuid, text, text, text, text, text, text, boolean, integer, text, text, boolean, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.set_tenant_identity_provider(p_target_tenant_id uuid, p_actor_tenant_id uuid, p_actor_auth_method text, p_actor_subject text, p_protocol text, p_issuer text, p_audience text, p_status text, p_enforce_token_binding boolean, p_expected_version integer, p_reason text, p_correlation_id text, p_idp_enforces_mfa boolean DEFAULT NULL::boolean, p_end_session_endpoint text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $_$
declare
  v_current corvis_control.tenant_identity_provider%rowtype;
  v_exists boolean;
  v_version integer;
begin
  if not corvis_control.identity_records_operator(p_actor_tenant_id, p_actor_auth_method, p_actor_subject) then
    raise exception 'identity records require an active operations admin';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 1000 then
    raise exception 'identity record change needs a stated reason';
  end if;
  if p_protocol is null or p_protocol not in ('oidc','saml')
     or p_issuer is null or length(p_issuer) not between 1 and 2048 or p_issuer ~ '[[:space:][:cntrl:]]'
     or p_audience is null or length(p_audience) not between 1 and 1024 or p_audience ~ '[[:space:][:cntrl:]]'
     or p_status is null or p_status not in ('pending','active','disabled')
     or p_enforce_token_binding is null
     or p_expected_version is null or p_expected_version < 0
     or (p_protocol = 'oidc' and (p_issuer !~ '^https://[^/?#]+(/[^?#]*)?$' or p_issuer ~ '/$'))
     or (p_end_session_endpoint is not null and (
       length(p_end_session_endpoint) > 2048
       or p_end_session_endpoint !~ '^https://[^/?#@[:space:][:cntrl:]]+(/[^?#[:space:][:cntrl:]]*)?(\?[^#[:space:][:cntrl:]]*)?$')) then
    raise exception 'identity provider record is invalid';
  end if;
  if p_enforce_token_binding and (p_protocol <> 'oidc' or p_status <> 'active') then
    raise exception 'identity provider binding requires an active oidc record';
  end if;

  perform 1 from corvis_control.tenant t where t.tenant_id = p_target_tenant_id for update;
  if not found then
    raise exception 'identity record tenant not found';
  end if;

  if exists (select 1 from corvis_control.tenant_session_policy sp where sp.tenant_id = p_target_tenant_id and sp.require_sso)
     and not (p_protocol = 'oidc' and p_status = 'active' and p_enforce_token_binding) then
    raise exception 'identity provider change would weaken require sso';
  end if;

  select * into v_current from corvis_control.tenant_identity_provider p where p.tenant_id = p_target_tenant_id;
  v_exists := found;
  if not v_exists then
    if p_expected_version <> 0 then
      raise exception 'identity provider version conflict';
    end if;
    v_version := 1;
    insert into corvis_control.tenant_identity_provider
      (tenant_id, protocol, issuer, audience, status, enforce_token_binding, idp_enforces_mfa, end_session_endpoint, version, updated_by_subject)
    values (p_target_tenant_id, p_protocol, p_issuer, p_audience, p_status, p_enforce_token_binding, p_idp_enforces_mfa, p_end_session_endpoint, v_version, p_actor_subject);
    insert into corvis_control.audit_event
      (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
    values
      (p_target_tenant_id, null, p_actor_subject, 'access.identity_provider.configured', 'identity_provider',
       p_target_tenant_id::text, 'success', p_correlation_id,
       jsonb_build_object('protocol', p_protocol, 'issuer', p_issuer, 'audience', p_audience, 'status', p_status,
         'enforceTokenBinding', p_enforce_token_binding, 'idpEnforcesMfa', p_idp_enforces_mfa,
         'endSessionEndpoint', p_end_session_endpoint, 'version', v_version, 'reason', btrim(p_reason),
         'actorTenantId', p_actor_tenant_id));
    return jsonb_build_object('changed', true, 'version', v_version);
  end if;

  if v_current.version <> p_expected_version then
    raise exception 'identity provider version conflict';
  end if;
  if v_current.protocol = p_protocol and v_current.issuer = p_issuer and v_current.audience = p_audience
     and v_current.status = p_status and v_current.enforce_token_binding = p_enforce_token_binding
     and v_current.idp_enforces_mfa is not distinct from p_idp_enforces_mfa
     and v_current.end_session_endpoint is not distinct from p_end_session_endpoint then
    return jsonb_build_object('changed', false, 'version', v_current.version);
  end if;

  v_version := v_current.version + 1;
  update corvis_control.tenant_identity_provider p
     set protocol = p_protocol, issuer = p_issuer, audience = p_audience, status = p_status,
         enforce_token_binding = p_enforce_token_binding, idp_enforces_mfa = p_idp_enforces_mfa,
         end_session_endpoint = p_end_session_endpoint, version = v_version,
         updated_by_subject = p_actor_subject, updated_at = now()
   where p.tenant_id = p_target_tenant_id;
  insert into corvis_control.audit_event
    (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
  values
    (p_target_tenant_id, null, p_actor_subject, 'access.identity_provider.configured', 'identity_provider',
     p_target_tenant_id::text, 'success', p_correlation_id,
     jsonb_build_object('protocol', p_protocol, 'issuer', p_issuer, 'audience', p_audience, 'status', p_status,
       'enforceTokenBinding', p_enforce_token_binding, 'idpEnforcesMfa', p_idp_enforces_mfa,
       'endSessionEndpoint', p_end_session_endpoint, 'version', v_version, 'reason', btrim(p_reason),
       'previousProtocol', v_current.protocol, 'previousIssuer', v_current.issuer, 'previousAudience', v_current.audience,
       'previousStatus', v_current.status, 'previousEnforceTokenBinding', v_current.enforce_token_binding,
       'previousIdpEnforcesMfa', v_current.idp_enforces_mfa, 'previousEndSessionEndpoint', v_current.end_session_endpoint,
       'actorTenantId', p_actor_tenant_id));
  return jsonb_build_object('changed', true, 'version', v_version);
end;
$_$;


--
-- Name: tenant_session_policy; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant_session_policy (
    tenant_id uuid NOT NULL,
    idle_timeout_minutes integer,
    max_session_minutes integer,
    version integer DEFAULT 1 NOT NULL,
    updated_by_auth_method text NOT NULL,
    updated_by_subject text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    require_sso boolean DEFAULT false NOT NULL,
    CONSTRAINT tenant_session_policy_check CHECK (((idle_timeout_minutes IS NULL) OR (max_session_minutes IS NULL) OR (idle_timeout_minutes <= max_session_minutes))),
    CONSTRAINT tenant_session_policy_idle_timeout_minutes_check CHECK (((idle_timeout_minutes >= 15) AND (idle_timeout_minutes <= 480))),
    CONSTRAINT tenant_session_policy_max_session_minutes_check CHECK (((max_session_minutes >= 60) AND (max_session_minutes <= 10080))),
    CONSTRAINT tenant_session_policy_updated_by_auth_method_check CHECK ((updated_by_auth_method = ANY (ARRAY['oidc'::text, 'saml'::text]))),
    CONSTRAINT tenant_session_policy_updated_by_subject_check CHECK (((length(updated_by_subject) >= 1) AND (length(updated_by_subject) <= 1024))),
    CONSTRAINT tenant_session_policy_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY corvis_control.tenant_session_policy FORCE ROW LEVEL SECURITY;


--
-- Name: set_tenant_session_policy(uuid, text, text, integer, integer, integer, boolean, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.set_tenant_session_policy(p_tenant_id uuid, p_auth_method text, p_subject text, p_idle_timeout_minutes integer, p_max_session_minutes integer, p_expected_version integer, p_require_sso boolean DEFAULT NULL::boolean, p_actor_token_issuer text DEFAULT NULL::text, p_actor_token_audience text DEFAULT NULL::text) RETURNS SETOF corvis_control.tenant_session_policy
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_current corvis_control.tenant_session_policy%rowtype;
  v_exists boolean;
  v_require boolean;
begin
  if corvis_control.session_policy_admin_user(p_tenant_id, p_auth_method, p_subject) is null then
    raise exception 'session policy requires an active organization admin';
  end if;
  if (p_idle_timeout_minutes is not null and p_idle_timeout_minutes not between 15 and 480)
     or (p_max_session_minutes is not null and p_max_session_minutes not between 60 and 10080)
     or (p_idle_timeout_minutes is not null and p_max_session_minutes is not null and p_idle_timeout_minutes > p_max_session_minutes) then
    raise exception 'session policy bounds exceeded';
  end if;

  perform 1 from corvis_control.tenant t where t.tenant_id = p_tenant_id for update;

  select * into v_current from corvis_control.tenant_session_policy p where p.tenant_id = p_tenant_id;
  v_exists := found;
  if not v_exists then
    if p_expected_version <> 0 then
      raise exception 'session policy version conflict';
    end if;
    v_require := coalesce(p_require_sso, false);
  else
    if v_current.version <> p_expected_version then
      raise exception 'session policy version conflict';
    end if;
    v_require := coalesce(p_require_sso, v_current.require_sso);
  end if;

  -- Turning Require SSO on: the tenant must have a recorded, active OIDC provider with token binding (otherwise nothing could
  -- satisfy it and everyone would be locked out), and the acting session must itself satisfy it (lock-out safeguard).
  if v_require and not (v_exists and v_current.require_sso) then
    if not exists (
      select 1 from corvis_control.tenant_identity_provider b
      where b.tenant_id = p_tenant_id and b.protocol = 'oidc' and b.status = 'active' and b.enforce_token_binding
    ) then
      raise exception 'session policy sso needs token binding';
    end if;
    if p_auth_method <> 'oidc' or not exists (
      select 1 from corvis_control.tenant_identity_provider b
      where b.tenant_id = p_tenant_id and b.protocol = 'oidc' and b.status = 'active' and b.enforce_token_binding
        and b.issuer = p_actor_token_issuer and b.audience = p_actor_token_audience
    ) then
      raise exception 'session policy sso would lock out current session';
    end if;
  end if;

  if not v_exists then
    if p_idle_timeout_minutes is null and p_max_session_minutes is null and not v_require then
      -- Nothing is set and nothing was asked for: there is no row to create.
      return;
    end if;
    return query
      insert into corvis_control.tenant_session_policy
        (tenant_id, idle_timeout_minutes, max_session_minutes, require_sso, updated_by_auth_method, updated_by_subject)
      values (p_tenant_id, p_idle_timeout_minutes, p_max_session_minutes, v_require, p_auth_method, p_subject)
      returning *;
    return;
  end if;

  if v_current.idle_timeout_minutes is not distinct from p_idle_timeout_minutes
     and v_current.max_session_minutes is not distinct from p_max_session_minutes
     and v_current.require_sso = v_require then
    return next v_current;
    return;
  end if;
  return query
    update corvis_control.tenant_session_policy p
       set idle_timeout_minutes = p_idle_timeout_minutes,
           max_session_minutes = p_max_session_minutes,
           require_sso = v_require,
           version = p.version + 1,
           updated_by_auth_method = p_auth_method,
           updated_by_subject = p_subject,
           updated_at = now()
     where p.tenant_id = p_tenant_id
    returning p.*;
end;
$$;


--
-- Name: set_tenant_verified_domain(uuid, uuid, text, text, text, text, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.set_tenant_verified_domain(p_target_tenant_id uuid, p_actor_tenant_id uuid, p_actor_auth_method text, p_actor_subject text, p_domain text, p_verification_method text, p_evidence text, p_reason text, p_correlation_id text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $_$
declare
  v_existing corvis_control.tenant_verified_domain%rowtype;
begin
  if not corvis_control.identity_records_operator(p_actor_tenant_id, p_actor_auth_method, p_actor_subject) then
    raise exception 'identity records require an active operations admin';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 1000 then
    raise exception 'identity record change needs a stated reason';
  end if;
  if p_domain is null or length(p_domain) not between 4 and 253
     or p_domain !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
     or p_verification_method is null or p_verification_method not in ('dns_txt','operator_attested')
     or p_evidence is null or length(btrim(p_evidence)) not between 3 and 1000 then
    raise exception 'verified domain is invalid';
  end if;
  -- Locks the tenant row so the per-tenant limit cannot be raced past.
  perform 1 from corvis_control.tenant t where t.tenant_id = p_target_tenant_id for update;
  if not found then
    raise exception 'identity record tenant not found';
  end if;

  select * into v_existing from corvis_control.tenant_verified_domain d where d.domain = p_domain;
  if found then
    if v_existing.tenant_id <> p_target_tenant_id then
      raise exception 'verified domain belongs to another tenant';
    end if;
    -- Already verified for this tenant: nothing changes and nothing is audited.
    return jsonb_build_object('changed', false, 'domain', p_domain);
  end if;
  if (select count(*) from corvis_control.tenant_verified_domain d where d.tenant_id = p_target_tenant_id) >= 20 then
    raise exception 'verified domain limit reached';
  end if;

  begin
    insert into corvis_control.tenant_verified_domain (tenant_id, domain, verification_method, evidence, verified_by_subject)
    values (p_target_tenant_id, p_domain, p_verification_method, btrim(p_evidence), p_actor_subject);
  exception when unique_violation then
    -- Another operator verified the same domain for another tenant between the read and the write.
    raise exception 'verified domain belongs to another tenant';
  end;

  insert into corvis_control.audit_event
    (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
  values
    (p_target_tenant_id, null, p_actor_subject, 'access.verified_domain.added', 'verified_domain', p_domain, 'success',
     p_correlation_id,
     jsonb_build_object('domain', p_domain, 'verificationMethod', p_verification_method, 'evidence', btrim(p_evidence),
       'reason', btrim(p_reason), 'actorTenantId', p_actor_tenant_id));
  return jsonb_build_object('changed', true, 'domain', p_domain);
end;
$_$;


--
-- Name: sign_out_user_everywhere(uuid, text, text, uuid, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.sign_out_user_everywhere(p_tenant_id uuid, p_auth_method text, p_subject text, p_user_id uuid, p_reason text) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_actor uuid;
  v_count integer;
begin
  v_actor := corvis_control.session_policy_admin_user(p_tenant_id, p_auth_method, p_subject);
  if v_actor is null then
    raise exception 'session policy requires an active organization admin';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 1000 then
    raise exception 'session sign-out needs a stated reason';
  end if;
  if p_user_id = v_actor then
    raise exception 'session sign-out cannot target current user';
  end if;
  if not exists (
    select 1 from corvis_control.identity_subject s
    where s.tenant_id = p_tenant_id and s.user_id = p_user_id
      and s.status = 'active' and s.auth_method in ('oidc','saml')
  ) then
    raise exception 'session sign-out target not found';
  end if;

  insert into corvis_control.session_revocation
    (tenant_id, auth_method, subject, session_id, revoked_by_subject, reason)
  select a.tenant_id, a.auth_method, a.subject, a.session_id, p_subject, btrim(p_reason)
  from corvis_control.tenant_session_activity a
  join corvis_control.identity_subject s
    on s.tenant_id = a.tenant_id and s.auth_method = a.auth_method and s.subject = a.subject
  where a.tenant_id = p_tenant_id and s.user_id = p_user_id
  on conflict (tenant_id, auth_method, subject, session_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


--
-- Name: sso_session_allowed(uuid, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.sso_session_allowed(p_tenant_id uuid, p_auth_method text, p_token_issuer text, p_token_audience text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select p_auth_method not in ('oidc','saml')
    or not exists (select 1 from corvis_control.tenant_session_policy sp where sp.tenant_id = p_tenant_id and sp.require_sso)
    or (
      p_auth_method = 'oidc'
      and exists (
        select 1 from corvis_control.tenant_identity_provider b
        where b.tenant_id = p_tenant_id
          and b.protocol = 'oidc' and b.status = 'active' and b.enforce_token_binding
          and b.issuer = p_token_issuer and b.audience = p_token_audience
      )
    )
$$;


--
-- Name: stop_export_schedule(uuid, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.stop_export_schedule(p_tenant_id uuid, p_schedule_id uuid) RETURNS SETOF corvis_control.export_schedule
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  update corvis_control.export_schedule s
  set status = 'stopped', stop_reason = 'owner_inactive', next_run_at = null, publish_watermark = null,
      status_changed_at = now(), status_changed_by = 'system:export-scheduler', updated_at = now()
  where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id and s.status in ('active','paused')
  returning s.*
$$;


--
-- Name: stop_export_schedules_for_inactive_owners(); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.stop_export_schedules_for_inactive_owners() RETURNS SETOF corvis_control.export_schedule
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  update corvis_control.export_schedule s
  set status = 'stopped', stop_reason = 'owner_inactive', next_run_at = null, publish_watermark = null,
      status_changed_at = now(), status_changed_by = 'system:export-scheduler', updated_at = now()
  where s.status in ('active','paused')
    and not exists (
      select 1
      from corvis_control.identity_subject i
      join corvis_control.membership m on m.tenant_id = i.tenant_id and m.user_id = i.user_id
      where i.tenant_id = s.tenant_id and i.auth_method = s.owner_auth_method and i.subject = s.owner_subject
        and i.status = 'active'
        and m.workspace_id = s.workspace_id and m.status = 'active'
        and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    )
  returning s.*
$$;


--
-- Name: sweep_tenant_export_grants(integer, integer); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.sweep_tenant_export_grants(p_retention_hours integer, p_limit integer) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_total integer := 0;
  v_item record;
begin
  for v_item in
    with doomed as (
      select g.tenant_id, g.grant_id
      from corvis_control.tenant_export_download_grant g
      where g.expires_at < now() - make_interval(hours => greatest(1, p_retention_hours))
      order by g.expires_at
      limit greatest(1, least(coalesce(p_limit, 1000), 5000))
      for update skip locked
    ), gone as (
      delete from corvis_control.tenant_export_download_grant g
      using doomed d
      where g.tenant_id = d.tenant_id and g.grant_id = d.grant_id
      returning g.tenant_id, g.request_id
    )
    select gone.tenant_id, gone.request_id, count(*)::integer as deleted
    from gone
    group by gone.tenant_id, gone.request_id
  loop
    perform corvis_control.tenant_export_system_audit(v_item.tenant_id,
      (select r.workspace_id from corvis_control.tenant_export_request r where r.tenant_id = v_item.tenant_id and r.request_id = v_item.request_id),
      v_item.request_id, 'data_export.grants_swept', 'success', jsonb_build_object('deleted', v_item.deleted));
    v_total := v_total + v_item.deleted;
  end loop;
  return v_total;
end;
$$;


--
-- Name: tenant_export_admin_user(uuid, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.tenant_export_admin_user(p_tenant_id uuid, p_auth_method text, p_subject text) RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  select s.user_id
  from corvis_control.identity_subject s
  where s.tenant_id = p_tenant_id
    and s.auth_method = p_auth_method
    and p_auth_method in ('oidc','saml')
    and s.subject = p_subject
    and s.status = 'active'
    and exists (
      select 1 from corvis_control.membership m
      where m.tenant_id = s.tenant_id and m.user_id = s.user_id
        and m.role_name = 'tenant_admin' and m.status = 'active'
        and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    )
  limit 1
$$;


--
-- Name: tenant_export_rights(uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.tenant_export_rights(p_tenant_id uuid) RETURNS TABLE(resource_type text, resource_id text, source_document_access_allowed boolean)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  with effective as (
    select dr.resource_type, dr.resource_id,
           bool_and(dr.client_visible) as client_visible,
           bool_and(dr.redistribution_allowed) as redistribution_allowed,
           bool_and(dr.source_document_access_allowed) as source_access
    from corvis_control.data_rights dr
    where dr.tenant_id = p_tenant_id
      and dr.effective_from <= now()
      and (dr.effective_to is null or dr.effective_to > now())
    group by dr.resource_type, dr.resource_id
  )
  select e.resource_type, e.resource_id, e.source_access
  from effective e
  where e.resource_type in ('fund','document')
    and e.client_visible and e.redistribution_allowed
    and exists (select 1 from effective w where w.resource_type = 'workspace' and w.redistribution_allowed)
  order by e.resource_type, e.resource_id
$$;


--
-- Name: tenant_export_scope_changed(uuid, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.tenant_export_scope_changed(p_tenant_id uuid, p_request_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  with scope as (
    select coalesce(r.manifest -> 'artifact', '{}'::jsonb) as artifact
    from corvis_control.tenant_export_request r
    where r.tenant_id = p_tenant_id and r.request_id = p_request_id
  ), held as (
    select h.resource_type, h.resource_id, h.source_document_access_allowed
    from corvis_control.tenant_export_rights(p_tenant_id) h
  ), listed as (
    select 'fund'::text as resource_type, f.id, false as needs_source_access
    from scope s, jsonb_array_elements_text(case when jsonb_typeof(s.artifact -> 'fundIds') = 'array' then s.artifact -> 'fundIds' else '[]'::jsonb end) as f(id)
    union all
    select 'document', d.id, false
    from scope s, jsonb_array_elements_text(case when jsonb_typeof(s.artifact -> 'documentIds') = 'array' then s.artifact -> 'documentIds' else '[]'::jsonb end) as d(id)
    union all
    select 'document', d.id, true
    from scope s, jsonb_array_elements_text(case when jsonb_typeof(s.artifact -> 'sourceDocumentIds') = 'array' then s.artifact -> 'sourceDocumentIds' else '[]'::jsonb end) as d(id)
  )
  select exists (
    select 1 from listed l
    where not exists (
      select 1 from held h
      where h.resource_type = l.resource_type and h.resource_id = l.id
        and (not l.needs_source_access or h.source_document_access_allowed is true)
    )
  )
$$;


--
-- Name: tenant_export_system_audit(uuid, uuid, uuid, text, text, jsonb); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.tenant_export_system_audit(p_tenant_id uuid, p_workspace_id uuid, p_request_id uuid, p_action text, p_outcome text, p_metadata jsonb) RETURNS void
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
  insert into corvis_control.audit_event
    (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
  values
    (p_tenant_id, p_workspace_id, 'system:tenant-export', p_action, 'tenant_export_request', p_request_id::text, p_outcome,
     'tenant-export:' || p_request_id::text, p_metadata)
$$;


--
-- Name: transfer_service_account_owner(uuid, uuid, text, text, text); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.transfer_service_account_owner(p_tenant_id uuid, p_service_account_id uuid, p_actor_auth_method text, p_actor_subject text, p_owner_subject text) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_account corvis_control.service_account%rowtype;
  v_owner_user uuid;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  if v_account.status <> 'active' then
    raise exception 'service account is not active';
  end if;

  select s.user_id into v_owner_user
  from corvis_control.identity_subject s
  where s.tenant_id = p_tenant_id and s.subject = p_owner_subject and s.auth_method in ('oidc','saml')
    and corvis_control.service_account_owner_active(p_tenant_id, s.user_id)
  limit 1;
  if v_owner_user is null then
    raise exception 'service account owner must be an active organization admin';
  end if;
  if v_owner_user = v_account.owner_user_id then
    raise exception 'service account owner unchanged';
  end if;

  perform set_config('corvis.service_account_owner_transfer', 'on', true);
  update corvis_control.service_account a
  set owner_subject = p_owner_subject, owner_user_id = v_owner_user, owner_assigned_at = now()
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id;
  perform set_config('corvis.service_account_owner_transfer', 'off', true);

  return v_account.owner_subject;
end;
$$;


--
-- Name: transition_data_issue_case(uuid, uuid, text, text, text, text, uuid); Type: FUNCTION; Schema: corvis_control; Owner: -
--

CREATE FUNCTION corvis_control.transition_data_issue_case(p_tenant_id uuid, p_case_id uuid, p_action text, p_expected_status text, p_actor_subject text, p_note text, p_correction_incident_id uuid) RETURNS SETOF corvis_control.data_issue_case
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control'
    AS $$
declare
  v_case corvis_control.data_issue_case%rowtype;
  v_incident corvis_control.data_correction_incident%rowtype;
  v_to text;
  v_incident_id uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_case from corvis_control.data_issue_case c
  where c.tenant_id = p_tenant_id and c.case_id = p_case_id
  for update;
  if not found then
    return;
  end if;
  if p_expected_status is not null and v_case.status <> p_expected_status then
    raise exception 'data issue case status changed';
  end if;

  if p_action = 'investigate' and v_case.status = 'received' then
    v_to := 'investigating';
  elsif p_action = 'correct' and v_case.status = 'investigating' then
    v_to := 'corrected';
  elsif p_action = 'no_change' and v_case.status = 'investigating' then
    v_to := 'no_change';
  else
    raise exception 'data issue transition not allowed';
  end if;

  v_incident_id := coalesce(p_correction_incident_id, v_case.correction_incident_id);
  if v_incident_id is not null then
    select * into v_incident from corvis_control.data_correction_incident i
    where i.tenant_id = p_tenant_id and i.incident_id = v_incident_id;
    if not found then
      raise exception 'data issue correction not found';
    end if;
    if v_incident.fund_id <> v_case.fund_id or v_incident.report_period <> v_case.report_period then
      raise exception 'data issue correction scope mismatch';
    end if;
  end if;

  if v_to = 'investigating' then
    if v_incident_id is not null and v_incident.state = 'cancelled' then
      raise exception 'data issue correction was cancelled';
    end if;
  elsif v_to = 'corrected' then
    if v_incident_id is null then
      raise exception 'data issue correction required';
    end if;
    if v_incident.state <> 'resolved' then
      raise exception 'data issue correction is not resolved';
    end if;
  elsif v_note is null then
    raise exception 'data issue resolution note required';
  end if;

  update corvis_control.data_issue_case c
  set status = v_to,
      status_changed_at = now(),
      status_changed_by = p_actor_subject,
      correction_incident_id = v_incident_id,
      replacement_snapshot_id = case when v_to = 'corrected' then v_incident.replacement_snapshot_id end,
      replacement_snapshot_version = case when v_to = 'corrected' then v_incident.replacement_snapshot_version end,
      resolution_note = case when v_to in ('corrected','no_change') then v_note end
  where c.tenant_id = p_tenant_id and c.case_id = p_case_id
  returning * into v_case;

  insert into corvis_control.data_issue_case_event (tenant_id, case_id, from_status, to_status, actor_subject, note)
  values (p_tenant_id, p_case_id,
    case v_to when 'investigating' then 'received' else 'investigating' end,
    v_to, p_actor_subject, v_note);

  return next v_case;
end;
$$;


--
-- Name: apply_review_decision(uuid, uuid, integer, uuid, text, text, text, text); Type: FUNCTION; Schema: corvis_facts; Owner: -
--

CREATE FUNCTION corvis_facts.apply_review_decision(p_tenant_id uuid, p_observation_id uuid, p_expected_version integer, p_review_event_id uuid, p_actor_subject text, p_decision text, p_reason_code text, p_corrected_value text DEFAULT NULL::text) RETURNS TABLE(new_version integer, next_state text)
    LANGUAGE plpgsql
    AS $$
declare
  current_row corvis_facts.observation%rowtype;
  computed_state text;
  reviewer_count integer;
  since_version integer;
begin
  select * into current_row
  from corvis_facts.observation
  where tenant_id=p_tenant_id and observation_id=p_observation_id and version=p_expected_version
  for update;

  if not found then
    return;
  end if;

  if p_decision not in ('approve','reject','correct') then
    raise exception 'invalid review decision';
  end if;
  if p_decision='correct' and p_corrected_value is null then
    raise exception 'corrected value is required';
  end if;

  insert into corvis_facts.review_event
    (tenant_id,review_event_id,observation_id,actor_subject,decision,reason_code,before_value,after_value,observation_version,created_at)
  values (
    p_tenant_id,p_review_event_id,p_observation_id,p_actor_subject,p_decision,p_reason_code,
    jsonb_build_object('valueNumber',current_row.value_number,'valueString',current_row.value_string,'reviewState',current_row.review_state),
    case when p_decision='correct'
      then jsonb_build_object('valueString',p_corrected_value,'reviewState','review_required')
      else jsonb_build_object('valueNumber',current_row.value_number,'valueString',current_row.value_string,'reviewState',case when p_decision='reject' then 'rejected' else 'approved' end)
    end,
    p_expected_version,now()
  );

  if p_decision='correct' then
    insert into corvis_facts.observation_correction
      (tenant_id,observation_id,based_on_observation_version,corrected_value_string,reason_code,actor_subject)
    values (p_tenant_id,p_observation_id,p_expected_version,p_corrected_value,p_reason_code,p_actor_subject);
    computed_state := 'review_required';
  elsif p_decision='reject' then
    computed_state := 'rejected';
  elsif current_row.risk_tier='critical' then
    select coalesce(max(based_on_observation_version) + 1, 0) into since_version
    from corvis_facts.observation_correction
    where tenant_id=p_tenant_id and observation_id=p_observation_id;

    select count(distinct actor_subject) into reviewer_count
    from corvis_facts.review_event
    where tenant_id=p_tenant_id and observation_id=p_observation_id and decision='approve'
      and observation_version >= since_version;
    computed_state := case when reviewer_count >= 2 then 'approved' else 'review_required' end;
  else
    computed_state := 'approved';
  end if;

  update corvis_facts.observation
  set review_state=computed_state, version=version+1, updated_at=now()
  where tenant_id=p_tenant_id and observation_id=p_observation_id and version=p_expected_version;

  return query select p_expected_version + 1, computed_state;
end;
$$;


--
-- Name: assign_company_sector(uuid, text, text, integer, text, text); Type: FUNCTION; Schema: corvis_facts; Owner: -
--

CREATE FUNCTION corvis_facts.assign_company_sector(p_tenant_id uuid, p_company_id text, p_sector_code text, p_expected_version integer, p_actor_subject text, p_reason text) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
  current_row corvis_facts.company_sector_classification%rowtype;
  current_version integer;
  next_version integer;
begin
  if p_reason is null or btrim(p_reason) = '' then raise exception 'sector classification reason is required'; end if;
  if p_actor_subject is null or btrim(p_actor_subject) = '' then raise exception 'sector classification actor is required'; end if;
  if not exists (
    select 1 from corvis_semantic.sector s
    where s.taxonomy_version = 'corvis_sector_v1' and s.sector_code = p_sector_code
  ) then
    raise exception 'unknown sector code';
  end if;

  -- Serialize assignments per company so two first-time classifications
  -- cannot both see version 0.
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':company_sector:' || p_company_id, 0));

  select * into current_row
  from corvis_facts.company_sector_classification c
  where c.tenant_id = p_tenant_id and c.company_id = p_company_id and c.superseded_at is null
  for update;
  current_version := case when found then current_row.version else 0 end;
  if current_version <> p_expected_version then return null; end if;
  next_version := current_version + 1;

  if current_version > 0 then
    update corvis_facts.company_sector_classification
    set superseded_at = now()
    where tenant_id = p_tenant_id and classification_id = current_row.classification_id;
  end if;

  insert into corvis_facts.company_sector_classification
    (tenant_id, company_id, taxonomy_version, sector_code, basis, version, reason, classified_by)
  values
    (p_tenant_id, p_company_id, 'corvis_sector_v1', p_sector_code, 'reviewer_assigned', next_version, btrim(p_reason), p_actor_subject);

  return next_version;
end;
$$;


--
-- Name: canonicalize_reviewed_extraction(uuid, uuid, uuid, text, text, text, text); Type: FUNCTION; Schema: corvis_facts; Owner: -
--

CREATE FUNCTION corvis_facts.canonicalize_reviewed_extraction(p_tenant_id uuid, p_document_id uuid, p_extraction_run_id uuid, p_review_policy_version text, p_candidate_set_sha256 text, p_decision_set_sha256 text, p_idempotency_key text) RETURNS TABLE(canonicalization_run_id uuid, candidate_count integer, canonical_candidate_count integer, observation_count integer, source_reference_count integer)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_facts', 'corvis_source', 'corvis_review', 'corvis_semantic', 'corvis_identity', 'corvis_control'
    AS $_$
declare
  run_row corvis_source.extraction_run%rowtype;
  gate_row corvis_review.extraction_review_gate%rowtype;
  canonical_run_id uuid;
  existing_run corvis_facts.canonicalization_run%rowtype;
  candidate_row record;
  requirement_row corvis_review.candidate_review_requirement%rowtype;
  correction_event_id uuid;
  correction_payload jsonb;
  effective_payload jsonb;
  reference_ids uuid[];
  primary_reference_id uuid;
  expected_reference_count integer;
  actual_reference_count integer;
  actual_candidate_count integer;
  actual_observation_count integer;
  fund_id_value text;
  company_id_value text;
  holding_id_value text;
  instrument_id_value text;
  metric_code_value text;
  subject_type_value text;
  subject_level_value text;
  value_number_text text;
  value_string_value text;
  confidence_value double precision;
  observation_id_value uuid;
  holding_uuid uuid;
  instrument_uuid uuid;
  period_start_value date;
  period_end_value date;
  as_of_date_value date;
  report_date_value date;
begin
  if p_review_policy_version is null or btrim(p_review_policy_version)='' then
    raise exception 'canonicalization requires review policy version';
  end if;
  if p_candidate_set_sha256 !~ '^[0-9a-f]{64}$' or p_decision_set_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'canonicalization requires valid reviewed hashes';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key)='' then
    raise exception 'canonicalization requires idempotency key';
  end if;

  select * into run_row
  from corvis_source.extraction_run
  where tenant_id=p_tenant_id
    and extraction_run_id=p_extraction_run_id
    and document_id=p_document_id
    and status='ready'
  for share;
  if not found then raise exception 'canonicalization requires finalized extraction run'; end if;
  if run_row.candidate_set_sha256 <> p_candidate_set_sha256 then
    raise exception 'canonicalization extraction candidate set no longer matches reviewed result';
  end if;

  select * into gate_row
  from corvis_review.extraction_review_gate
  where tenant_id=p_tenant_id
    and extraction_run_id=p_extraction_run_id
    and review_policy_version=p_review_policy_version
    and status='ready'
    and blocking_candidate_count=0
    and candidate_set_sha256=p_candidate_set_sha256
    and decision_set_sha256=p_decision_set_sha256
  for share;
  if not found then raise exception 'canonicalization requires exact ready review gate'; end if;
  if gate_row.candidate_count <> run_row.candidate_count then
    raise exception 'canonicalization review gate candidate count mismatch';
  end if;

  -- Require the exact predecessor reviewed effect to be durably complete. This
  -- prevents direct invocation from bypassing the reviewed processing boundary.
  if not exists (
    select 1
    from corvis_control.processing_job j
    join corvis_control.processing_stage_effect e
      on e.tenant_id=j.tenant_id and e.job_id=j.job_id
    where j.tenant_id=p_tenant_id
      and j.job_id=corvis_control.processing_predecessor_job_for_effect(p_tenant_id,p_document_id,'canonicalized',p_idempotency_key,'reviewed')
      and j.document_id=p_document_id
      and j.stage='reviewed'
      and j.state='succeeded'
      and e.stage='reviewed'
      and e.state='complete'
      and e.result ->> 'extractionRunId'=p_extraction_run_id::text
      and e.result ->> 'reviewPolicyVersion'=p_review_policy_version
      and e.result ->> 'candidateSetSha256'=p_candidate_set_sha256
      and e.result ->> 'decisionSetSha256'=p_decision_set_sha256
      and e.result ->> 'canonicalizationReady'='true'
  ) then
    raise exception 'canonicalization requires committed reviewed-stage predecessor effect';
  end if;

  canonical_run_id := md5(
    p_tenant_id::text || ':' || p_extraction_run_id::text || ':' || p_review_policy_version || ':' ||
    p_candidate_set_sha256 || ':' || p_decision_set_sha256
  )::uuid;

  insert into corvis_facts.canonicalization_run (
    tenant_id,canonicalization_run_id,extraction_run_id,document_id,review_policy_version,
    candidate_set_sha256,decision_set_sha256,idempotency_key,status,candidate_count
  ) values (
    p_tenant_id,canonical_run_id,p_extraction_run_id,p_document_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256,p_idempotency_key,'writing',run_row.candidate_count
  ) on conflict on constraint canonicalization_run_pkey do nothing;

  select * into existing_run
  from corvis_facts.canonicalization_run cr
  where cr.tenant_id=p_tenant_id and cr.canonicalization_run_id=canonical_run_id
  for update;
  if not found then raise exception 'canonicalization run could not be persisted'; end if;
  if existing_run.extraction_run_id <> p_extraction_run_id
    or existing_run.document_id <> p_document_id
    or existing_run.review_policy_version <> p_review_policy_version
    or existing_run.candidate_set_sha256 <> p_candidate_set_sha256
    or existing_run.decision_set_sha256 <> p_decision_set_sha256
    or existing_run.idempotency_key <> p_idempotency_key
    or existing_run.candidate_count <> run_row.candidate_count then
    raise exception 'existing canonicalization run conflicts with reviewed lineage';
  end if;

  if existing_run.status='ready' then
    return query select existing_run.canonicalization_run_id,existing_run.candidate_count,
      existing_run.canonical_candidate_count,existing_run.observation_count,existing_run.source_reference_count;
    return;
  end if;

  for candidate_row in
    select *
    from corvis_source.extraction_candidate
    where tenant_id=p_tenant_id and extraction_run_id=p_extraction_run_id
    order by candidate_key
  loop
    select * into requirement_row
    from corvis_review.candidate_review_requirement
    where tenant_id=p_tenant_id
      and extraction_run_id=p_extraction_run_id
      and candidate_id=candidate_row.candidate_id
      and review_policy_version=p_review_policy_version
    limit 1;
    if not found then raise exception 'canonicalization candidate is missing immutable review requirement'; end if;

    correction_event_id := null;
    correction_payload := null;
    select cre.review_event_id,cre.correction_payload
      into correction_event_id,correction_payload
    from corvis_review.candidate_review_event cre
    where cre.tenant_id=p_tenant_id
      and cre.extraction_run_id=p_extraction_run_id
      and cre.candidate_id=candidate_row.candidate_id
      and cre.review_policy_version=p_review_policy_version
      and cre.decision='correct'
    order by cre.event_sequence desc
    limit 1;

    -- Corrections are overlays. The extraction candidate payload/evidence/confidence/
    -- provenance remain immutable and are recorded alongside the effective payload.
    effective_payload := candidate_row.payload || coalesce(correction_payload,'{}'::jsonb);

    select coalesce(array_agg(r.source_reference_id order by r.reference_key),'{}'::uuid[]),count(*)::integer
      into reference_ids,expected_reference_count
    from corvis_source.extraction_candidate_source_reference r
    where r.tenant_id=p_tenant_id
      and r.extraction_run_id=p_extraction_run_id
      and r.candidate_id=candidate_row.candidate_id
      and r.document_id=p_document_id
      and r.representation_id=run_row.representation_id;

    if expected_reference_count <> candidate_row.source_reference_count or expected_reference_count <= 0 then
      raise exception 'canonicalization source-reference lineage is incomplete';
    end if;

    insert into corvis_source.source_reference (
      tenant_id,source_reference_id,document_id,document_artifact_version_id,
      page_number,sheet_name,cell_range,bbox,excerpt,created_at,
      extraction_run_id,candidate_id,representation_id,reference_key,
      section_title,table_title,row_label,column_label,footnote_marker,extraction_method
    )
    select
      r.tenant_id,r.source_reference_id,r.document_id,run_row.document_artifact_version_id,
      r.page_number,r.sheet_name,r.cell_or_range,r.bounding_box,r.source_text,now(),
      r.extraction_run_id,r.candidate_id,r.representation_id,r.reference_key,
      r.section_title,r.table_title,r.row_label,r.column_label,r.footnote_marker,r.extraction_method
    from corvis_source.extraction_candidate_source_reference r
    where r.tenant_id=p_tenant_id
      and r.extraction_run_id=p_extraction_run_id
      and r.candidate_id=candidate_row.candidate_id
    on conflict (source_reference_id) do nothing;

    select count(*)::integer into actual_reference_count
    from corvis_source.source_reference r
    where r.tenant_id=p_tenant_id
      and r.extraction_run_id=p_extraction_run_id
      and r.candidate_id=candidate_row.candidate_id
      and r.document_id=p_document_id
      and r.document_artifact_version_id=run_row.document_artifact_version_id
      and r.representation_id=run_row.representation_id
      and r.source_reference_id=any(reference_ids);
    if actual_reference_count <> expected_reference_count then
      raise exception 'canonicalization source-reference conflict or cross-tenant lineage mismatch';
    end if;

    insert into corvis_facts.canonical_candidate (
      tenant_id,canonicalization_run_id,extraction_run_id,candidate_id,candidate_key,candidate_type,
      review_policy_version,candidate_fingerprint_sha256,candidate_set_sha256,decision_set_sha256,
      original_payload,effective_payload,confidence,provenance,exception_codes,
      correction_review_event_id,source_reference_ids
    ) values (
      p_tenant_id,canonical_run_id,p_extraction_run_id,candidate_row.candidate_id,candidate_row.candidate_key,
      candidate_row.candidate_type,p_review_policy_version,requirement_row.candidate_fingerprint_sha256,
      p_candidate_set_sha256,p_decision_set_sha256,candidate_row.payload,effective_payload,
      candidate_row.confidence,candidate_row.provenance,candidate_row.exception_codes,
      correction_event_id,reference_ids
    ) on conflict on constraint canonical_candidate_pkey do nothing;

    if not exists (
      select 1 from corvis_facts.canonical_candidate c
      where c.tenant_id=p_tenant_id
        and c.canonicalization_run_id=canonical_run_id
        and c.candidate_id=candidate_row.candidate_id
        and c.extraction_run_id=p_extraction_run_id
        and c.candidate_key=candidate_row.candidate_key
        and c.candidate_type=candidate_row.candidate_type
        and c.review_policy_version=p_review_policy_version
        and c.candidate_fingerprint_sha256=requirement_row.candidate_fingerprint_sha256
        and c.candidate_set_sha256=p_candidate_set_sha256
        and c.decision_set_sha256=p_decision_set_sha256
        and c.original_payload=candidate_row.payload
        and c.effective_payload=(candidate_row.payload || coalesce(correction_payload,'{}'::jsonb))
        and c.confidence=candidate_row.confidence
        and c.provenance=candidate_row.provenance
        and c.exception_codes=candidate_row.exception_codes
        and c.correction_review_event_id is not distinct from correction_event_id
        and c.source_reference_ids=reference_ids
    ) then
      raise exception 'existing canonical candidate conflicts with immutable reviewed content';
    end if;

    if candidate_row.candidate_type='metric_observation' then
      fund_id_value := nullif(btrim(coalesce(effective_payload ->> 'fund_id','')), '');
      company_id_value := nullif(btrim(coalesce(effective_payload ->> 'company_id','')), '');
      holding_id_value := nullif(btrim(coalesce(effective_payload ->> 'holding_id','')), '');
      instrument_id_value := nullif(btrim(coalesce(effective_payload ->> 'instrument_id','')), '');
      metric_code_value := nullif(btrim(coalesce(effective_payload ->> 'metric_code',effective_payload ->> 'metricCode','')), '');
      subject_type_value := nullif(btrim(coalesce(effective_payload ->> 'subject_type','')), '');
      subject_level_value := nullif(btrim(coalesce(effective_payload ->> 'subject_level','')), '');

      if fund_id_value is null then raise exception 'canonicalization observation requires resolved fund_id'; end if;
      if not exists (select 1 from corvis_identity.fund f where f.global_fund_id=fund_id_value) then
        raise exception 'canonicalization observation fund identity is unresolved';
      end if;
      if metric_code_value is null then raise exception 'canonicalization observation requires metric_code'; end if;
      if not exists (
        select 1 from corvis_semantic.metric_definition m
        where m.metric_code=metric_code_value and m.active=true
      ) then
        raise exception 'canonicalization observation metric taxonomy is unresolved';
      end if;
      if subject_type_value not in ('fund_performance','company_operating','holding_position','instrument_position','fee_expense','lookthrough_exposure') then
        raise exception 'canonicalization observation has unsupported subject_type';
      end if;
      if subject_level_value not in ('fund','company','holding','instrument') then
        raise exception 'canonicalization observation has unsupported subject_level';
      end if;

      if company_id_value is not null and not exists (
        select 1 from corvis_identity.company c where c.global_company_id=company_id_value
      ) then
        raise exception 'canonicalization observation company identity is unresolved';
      end if;
      if subject_level_value='company' and company_id_value is null then
        raise exception 'canonicalization company observation requires company_id';
      end if;

      holding_uuid := null;
      if holding_id_value is not null then
        begin holding_uuid := holding_id_value::uuid;
        exception when others then raise exception 'canonicalization holding_id is not an internal UUID'; end;
        if not exists (
          select 1 from corvis_facts.holding h
          where h.tenant_id=p_tenant_id and h.holding_id=holding_uuid and h.fund_id=fund_id_value
        ) then
          raise exception 'canonicalization observation holding identity is unresolved for tenant/fund';
        end if;
      end if;
      if subject_level_value in ('holding','instrument') and holding_uuid is null then
        raise exception 'canonicalization holding/instrument observation requires holding_id';
      end if;

      instrument_uuid := null;
      if instrument_id_value is not null then
        begin instrument_uuid := instrument_id_value::uuid;
        exception when others then raise exception 'canonicalization instrument_id is not an internal UUID'; end;
        if not exists (
          select 1 from corvis_facts.instrument i
          where i.tenant_id=p_tenant_id and i.instrument_id=instrument_uuid
            and (holding_uuid is null or i.holding_id=holding_uuid)
        ) then
          raise exception 'canonicalization observation instrument identity is unresolved for tenant';
        end if;
      end if;
      if subject_level_value='instrument' and instrument_uuid is null then
        raise exception 'canonicalization instrument observation requires instrument_id';
      end if;

      value_number_text := nullif(btrim(coalesce(effective_payload ->> 'value_numeric',effective_payload ->> 'valueNumeric','')), '');
      value_string_value := coalesce(
        nullif(effective_payload ->> 'value_text',''),
        nullif(effective_payload ->> 'value_qualifier','')
      );
      if value_number_text is not null and value_number_text !~ '^-?[0-9]+([.][0-9]+)?$' then
        raise exception 'canonicalization observation value_numeric is invalid';
      end if;
      if value_number_text is null and value_string_value is null then
        raise exception 'canonicalization observation requires normalized numeric/text/qualifier value';
      end if;

      begin period_start_value := nullif(effective_payload ->> 'period_start','')::date;
      exception when others then raise exception 'canonicalization observation period_start is invalid'; end;
      begin period_end_value := nullif(effective_payload ->> 'period_end','')::date;
      exception when others then raise exception 'canonicalization observation period_end is invalid'; end;
      begin as_of_date_value := nullif(effective_payload ->> 'as_of_date','')::date;
      exception when others then raise exception 'canonicalization observation as_of_date is invalid'; end;
      begin report_date_value := nullif(effective_payload ->> 'report_date','')::date;
      exception when others then raise exception 'canonicalization observation report_date is invalid'; end;

      confidence_value := null;
      if coalesce(effective_payload ->> 'value_confidence',candidate_row.confidence ->> 'value') is not null then
        begin confidence_value := coalesce(effective_payload ->> 'value_confidence',candidate_row.confidence ->> 'value')::double precision;
        exception when others then raise exception 'canonicalization observation value confidence is invalid'; end;
        if confidence_value < 0 or confidence_value > 1 then
          raise exception 'canonicalization observation value confidence must be between 0 and 1';
        end if;
      end if;

      select r.source_reference_id into primary_reference_id
      from corvis_source.extraction_candidate_source_reference r
      where r.tenant_id=p_tenant_id
        and r.extraction_run_id=p_extraction_run_id
        and r.candidate_id=candidate_row.candidate_id
      order by r.reference_key
      limit 1;
      if primary_reference_id is null then raise exception 'canonicalization observation requires source evidence'; end if;

      observation_id_value := md5(
        'canonical-observation:' || p_tenant_id::text || ':' || p_extraction_run_id::text || ':' || candidate_row.candidate_id::text
      )::uuid;

      insert into corvis_facts.observation (
        tenant_id,observation_id,fund_id,company_id,holding_id,instrument_id,metric_code,
        value_number,value_string,currency,economic_period,report_date,actuality,review_state,version,
        source_reference_id,extraction_run_id,schema_version,skill_version,confidence_score,risk_tier,
        canonicalization_run_id,candidate_id,candidate_key,candidate_fingerprint_sha256,
        candidate_set_sha256,decision_set_sha256,review_policy_version,subject_type,subject_level,
        value_raw,value_qualifier,unit,reported_multiplier,source_precision,period_type,period_start,
        period_end,as_of_date,scenario_type,is_adjusted,adjustment_note,valuation_method,
        breakdown_category,breakdown_value,lookthrough_source,is_derived,derivation_formula,is_restated,recorded_at
      ) values (
        p_tenant_id,observation_id_value,fund_id_value,company_id_value,holding_id_value,instrument_id_value,metric_code_value,
        case when value_number_text is null then null else value_number_text::numeric end,value_string_value,
        nullif(effective_payload ->> 'currency',''),
        coalesce(nullif(effective_payload ->> 'period_end',''),nullif(effective_payload ->> 'as_of_date',''),nullif(effective_payload ->> 'period_type','')),
        report_date_value,nullif(effective_payload ->> 'actuality',''),'approved',1,
        primary_reference_id,p_extraction_run_id::text,run_row.schema_version,run_row.skill_version,confidence_value,
        case when requirement_row.risk_tier='critical' then 'critical' else 'normal' end,
        canonical_run_id,candidate_row.candidate_id,candidate_row.candidate_key,requirement_row.candidate_fingerprint_sha256,
        p_candidate_set_sha256,p_decision_set_sha256,p_review_policy_version,subject_type_value,subject_level_value,
        nullif(effective_payload ->> 'value_raw',''),nullif(effective_payload ->> 'value_qualifier',''),
        nullif(effective_payload ->> 'unit',''),nullif(effective_payload ->> 'reported_multiplier',''),
        nullif(effective_payload ->> 'source_precision',''),nullif(effective_payload ->> 'period_type',''),
        period_start_value,period_end_value,as_of_date_value,nullif(effective_payload ->> 'scenario_type',''),
        case when effective_payload ? 'is_adjusted' then (effective_payload ->> 'is_adjusted')::boolean else null end,
        nullif(effective_payload ->> 'adjustment_note',''),nullif(effective_payload ->> 'valuation_method',''),
        nullif(effective_payload ->> 'breakdown_category',''),nullif(effective_payload ->> 'breakdown_value',''),
        nullif(effective_payload ->> 'lookthrough_source',''),
        case when effective_payload ? 'is_derived' then (effective_payload ->> 'is_derived')::boolean else null end,
        nullif(effective_payload ->> 'derivation_formula',''),
        case when effective_payload ? 'is_restated' then (effective_payload ->> 'is_restated')::boolean else null end,
        now()
      ) on conflict (observation_id) do nothing;

      if not exists (
        select 1 from corvis_facts.observation o
        where o.tenant_id=p_tenant_id
          and o.observation_id=observation_id_value
          and o.extraction_run_id=p_extraction_run_id::text
          and o.canonicalization_run_id=canonical_run_id
          and o.candidate_id=candidate_row.candidate_id
          and o.candidate_key=candidate_row.candidate_key
          and o.candidate_fingerprint_sha256=requirement_row.candidate_fingerprint_sha256
          and o.candidate_set_sha256=p_candidate_set_sha256
          and o.decision_set_sha256=p_decision_set_sha256
          and o.review_policy_version=p_review_policy_version
          and o.review_state='approved'
          and o.source_reference_id=primary_reference_id
      ) then
        raise exception 'existing canonical observation conflicts with reviewed lineage';
      end if;

      insert into corvis_facts.observation_source_reference (tenant_id,observation_id,source_reference_id,ordinal)
      select p_tenant_id,observation_id_value,r.source_reference_id,
        row_number() over (order by r.reference_key)::integer
      from corvis_source.extraction_candidate_source_reference r
      where r.tenant_id=p_tenant_id
        and r.extraction_run_id=p_extraction_run_id
        and r.candidate_id=candidate_row.candidate_id
      on conflict (tenant_id,observation_id,source_reference_id) do nothing;
    end if;
  end loop;

  select count(*)::integer into actual_candidate_count
  from corvis_facts.canonical_candidate cc
  where cc.tenant_id=p_tenant_id and cc.canonicalization_run_id=canonical_run_id;
  if actual_candidate_count <> run_row.candidate_count then
    raise exception 'canonicalization candidate persistence is incomplete';
  end if;

  select count(*)::integer into actual_observation_count
  from corvis_facts.canonical_candidate c
  where c.tenant_id=p_tenant_id and c.canonicalization_run_id=canonical_run_id and c.candidate_type='metric_observation';
  if actual_observation_count <> (
    select count(*)::integer from corvis_facts.observation o
    where o.tenant_id=p_tenant_id and o.canonicalization_run_id=canonical_run_id
  ) then
    raise exception 'canonicalization observation persistence is incomplete';
  end if;

  select count(*)::integer into actual_reference_count
  from corvis_source.source_reference r
  where r.tenant_id=p_tenant_id and r.extraction_run_id=p_extraction_run_id;
  if actual_reference_count <> (
    select count(*)::integer
    from corvis_source.extraction_candidate_source_reference r
    where r.tenant_id=p_tenant_id and r.extraction_run_id=p_extraction_run_id
  ) then
    raise exception 'canonicalization source-reference persistence is incomplete';
  end if;

  update corvis_facts.canonicalization_run cr
  set status='ready',canonical_candidate_count=actual_candidate_count,
      observation_count=actual_observation_count,source_reference_count=actual_reference_count,
      completed_at=coalesce(cr.completed_at,now())
  where cr.tenant_id=p_tenant_id and cr.canonicalization_run_id=canonical_run_id and cr.status='writing'
  returning * into existing_run;

  if not found then
    select * into existing_run from corvis_facts.canonicalization_run cr
    where cr.tenant_id=p_tenant_id and cr.canonicalization_run_id=canonical_run_id;
  end if;
  if existing_run.status <> 'ready' then raise exception 'canonicalization run did not finalize'; end if;

  return query select existing_run.canonicalization_run_id,existing_run.candidate_count,
    existing_run.canonical_candidate_count,existing_run.observation_count,existing_run.source_reference_count;
end;
$_$;


--
-- Name: canonicalize_reviewed_extraction_v2(uuid, uuid, uuid, text, text, text, text); Type: FUNCTION; Schema: corvis_facts; Owner: -
--

CREATE FUNCTION corvis_facts.canonicalize_reviewed_extraction_v2(p_tenant_id uuid, p_document_id uuid, p_extraction_run_id uuid, p_review_policy_version text, p_candidate_set_sha256 text, p_decision_set_sha256 text, p_idempotency_key text) RETURNS TABLE(canonicalization_run_id uuid, candidate_count integer, canonical_candidate_count integer, observation_count integer, source_reference_count integer)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_facts', 'corvis_source', 'corvis_review', 'corvis_identity', 'corvis_control'
    AS $$
declare
  candidate_row record;
  v_result record;
  effective_payload jsonb;
  holding_uuid uuid;
  instrument_uuid uuid;
  parent_holding_uuid uuid;
  fund_id_value text;
  target_type_value text;
  target_company_id_value text;
  target_fund_id_value text;
  security_name_value text;
  instrument_type_value text;
  investment_date_value date;
  valid_from_value date;
  valid_to_value date;
  maturity_date_value date;
  coupon_rate_value numeric(18,8);
  seen_holding_ids uuid[] := '{}'::uuid[];
  seen_instrument_ids uuid[] := '{}'::uuid[];
begin
  -- Fail before projection unless this is the exact ready reviewed set. The v1
  -- canonicalizer rechecks this gate again, so the wrapper cannot weaken it.
  if not exists (
    select 1
    from corvis_review.extraction_review_gate g
    join corvis_source.extraction_run r
      on r.tenant_id=g.tenant_id and r.extraction_run_id=g.extraction_run_id
    where g.tenant_id=p_tenant_id
      and g.extraction_run_id=p_extraction_run_id
      and r.document_id=p_document_id
      and r.status='ready'
      and g.review_policy_version=p_review_policy_version
      and g.status='ready'
      and g.blocking_candidate_count=0
      and g.candidate_set_sha256=p_candidate_set_sha256
      and g.decision_set_sha256=p_decision_set_sha256
      and r.candidate_set_sha256=p_candidate_set_sha256
  ) then
    raise exception 'economic materialization requires exact ready reviewed candidate set';
  end if;

  -- Holdings must exist before instruments and before holding/instrument metric
  -- observations are validated by the existing canonicalizer.
  for candidate_row in
    select c.*,
      c.payload || coalesce((
        select e.correction_payload
        from corvis_review.candidate_review_event e
        where e.tenant_id=c.tenant_id
          and e.extraction_run_id=c.extraction_run_id
          and e.candidate_id=c.candidate_id
          and e.review_policy_version=p_review_policy_version
          and e.decision='correct'
        order by e.event_sequence desc limit 1
      ),'{}'::jsonb) as reviewed_payload
    from corvis_source.extraction_candidate c
    where c.tenant_id=p_tenant_id
      and c.extraction_run_id=p_extraction_run_id
      and c.candidate_type='holding'
    order by c.candidate_key
  loop
    effective_payload := candidate_row.reviewed_payload;
    begin
      holding_uuid := nullif(btrim(coalesce(effective_payload->>'holding_id',effective_payload->>'holdingId','')),'')::uuid;
    exception when others then raise exception 'reviewed holding candidate requires UUID holding_id'; end;
    if holding_uuid is null then raise exception 'reviewed holding candidate requires holding_id'; end if;
    if holding_uuid=any(seen_holding_ids) then raise exception 'reviewed candidate set contains duplicate holding_id'; end if;
    seen_holding_ids := array_append(seen_holding_ids,holding_uuid);

    fund_id_value := nullif(btrim(coalesce(effective_payload->>'fund_id',effective_payload->>'fundId','')),'');
    target_type_value := lower(nullif(btrim(coalesce(effective_payload->>'target_type',effective_payload->>'targetType','')),''));
    target_company_id_value := nullif(btrim(coalesce(effective_payload->>'target_company_id',effective_payload->>'targetCompanyId','')),'');
    target_fund_id_value := nullif(btrim(coalesce(effective_payload->>'target_fund_id',effective_payload->>'targetFundId','')),'');
    if fund_id_value is null then raise exception 'reviewed holding candidate requires fund_id'; end if;
    if target_type_value not in ('company','fund') then raise exception 'reviewed holding candidate requires governed target_type'; end if;
    if target_type_value='company' and (target_company_id_value is null or target_fund_id_value is not null) then
      raise exception 'reviewed company holding requires exactly target_company_id';
    end if;
    if target_type_value='fund' and (target_fund_id_value is null or target_company_id_value is not null) then
      raise exception 'reviewed fund holding requires exactly target_fund_id';
    end if;
    if not exists (select 1 from corvis_identity.fund f where f.global_fund_id=fund_id_value) then
      raise exception 'reviewed holding fund identity is unresolved';
    end if;
    if target_company_id_value is not null and not exists (
      select 1 from corvis_identity.company c where c.global_company_id=target_company_id_value
    ) then raise exception 'reviewed holding company target identity is unresolved'; end if;
    if target_fund_id_value is not null and not exists (
      select 1 from corvis_identity.fund f where f.global_fund_id=target_fund_id_value
    ) then raise exception 'reviewed holding fund target identity is unresolved'; end if;

    begin investment_date_value := nullif(effective_payload->>'investment_date','')::date;
    exception when others then raise exception 'reviewed holding investment_date is invalid'; end;
    begin valid_from_value := nullif(effective_payload->>'valid_from','')::date;
    exception when others then raise exception 'reviewed holding valid_from is invalid'; end;
    begin valid_to_value := nullif(effective_payload->>'valid_to','')::date;
    exception when others then raise exception 'reviewed holding valid_to is invalid'; end;

    update corvis_facts.holding h
    set fund_id=fund_id_value,
        target_type=target_type_value,
        target_company_id=target_company_id_value,
        target_fund_id=target_fund_id_value,
        status=nullif(effective_payload->>'status',''),
        investment_date=investment_date_value,
        strategy=nullif(effective_payload->>'strategy',''),
        geography=nullif(effective_payload->>'geography',''),
        valid_from=valid_from_value,
        valid_to=valid_to_value,
        review_state='approved',
        version=h.version+1,
        updated_at=now()
    where h.tenant_id=p_tenant_id and h.holding_id=holding_uuid
      and row(h.fund_id,h.target_type,h.target_company_id,h.target_fund_id,h.status,h.investment_date,
              h.strategy,h.geography,h.valid_from,h.valid_to,h.review_state)
          is distinct from
          row(fund_id_value,target_type_value,target_company_id_value,target_fund_id_value,
              nullif(effective_payload->>'status',''),investment_date_value,
              nullif(effective_payload->>'strategy',''),nullif(effective_payload->>'geography',''),
              valid_from_value,valid_to_value,'approved');

    insert into corvis_facts.holding (
      tenant_id,holding_id,fund_id,target_type,target_company_id,target_fund_id,status,
      investment_date,strategy,geography,source_reference_id,version,valid_from,valid_to,review_state
    )
    select p_tenant_id,holding_uuid,fund_id_value,target_type_value,target_company_id_value,target_fund_id_value,
      nullif(effective_payload->>'status',''),investment_date_value,nullif(effective_payload->>'strategy',''),
      nullif(effective_payload->>'geography',''),null,1,valid_from_value,valid_to_value,'approved'
    where not exists (select 1 from corvis_facts.holding h where h.holding_id=holding_uuid)
    on conflict (holding_id) do nothing;

    if not exists (
      select 1 from corvis_facts.holding h
      where h.tenant_id=p_tenant_id and h.holding_id=holding_uuid
        and h.fund_id=fund_id_value and h.target_type=target_type_value
        and h.target_company_id is not distinct from target_company_id_value
        and h.target_fund_id is not distinct from target_fund_id_value
        and h.review_state='approved'
    ) then raise exception 'reviewed holding conflicts with existing tenant/identity state'; end if;
  end loop;

  for candidate_row in
    select c.*,
      c.payload || coalesce((
        select e.correction_payload
        from corvis_review.candidate_review_event e
        where e.tenant_id=c.tenant_id
          and e.extraction_run_id=c.extraction_run_id
          and e.candidate_id=c.candidate_id
          and e.review_policy_version=p_review_policy_version
          and e.decision='correct'
        order by e.event_sequence desc limit 1
      ),'{}'::jsonb) as reviewed_payload
    from corvis_source.extraction_candidate c
    where c.tenant_id=p_tenant_id
      and c.extraction_run_id=p_extraction_run_id
      and c.candidate_type='instrument'
    order by c.candidate_key
  loop
    effective_payload := candidate_row.reviewed_payload;
    begin
      instrument_uuid := nullif(btrim(coalesce(effective_payload->>'instrument_id',effective_payload->>'instrumentId','')),'')::uuid;
    exception when others then raise exception 'reviewed instrument candidate requires UUID instrument_id'; end;
    begin
      parent_holding_uuid := nullif(btrim(coalesce(effective_payload->>'holding_id',effective_payload->>'holdingId','')),'')::uuid;
    exception when others then raise exception 'reviewed instrument candidate requires UUID holding_id'; end;
    if instrument_uuid is null or parent_holding_uuid is null then raise exception 'reviewed instrument requires instrument_id and holding_id'; end if;
    if instrument_uuid=any(seen_instrument_ids) then raise exception 'reviewed candidate set contains duplicate instrument_id'; end if;
    seen_instrument_ids := array_append(seen_instrument_ids,instrument_uuid);

    security_name_value := nullif(btrim(coalesce(effective_payload->>'security_name',effective_payload->>'security_description',effective_payload->>'securityName','')),'');
    instrument_type_value := nullif(btrim(coalesce(effective_payload->>'instrument_type',effective_payload->>'instrumentType','')),'');
    if security_name_value is null then raise exception 'reviewed instrument requires exact security_name'; end if;
    if instrument_type_value is null then raise exception 'reviewed instrument requires governed instrument_type'; end if;
    if not exists (
      select 1 from corvis_facts.holding h
      where h.tenant_id=p_tenant_id and h.holding_id=parent_holding_uuid
        and h.target_type='company' and h.review_state='approved'
    ) then raise exception 'reviewed instrument parent holding is unresolved or not company-targeted'; end if;

    begin maturity_date_value := nullif(effective_payload->>'maturity_date','')::date;
    exception when others then raise exception 'reviewed instrument maturity_date is invalid'; end;
    begin coupon_rate_value := nullif(effective_payload->>'coupon_rate','')::numeric(18,8);
    exception when others then raise exception 'reviewed instrument coupon_rate is invalid'; end;

    update corvis_facts.instrument i
    set holding_id=parent_holding_uuid,
        instrument_type=instrument_type_value,
        security_name=security_name_value,
        currency=nullif(effective_payload->>'currency',''),
        seniority=nullif(effective_payload->>'seniority',''),
        maturity_date=maturity_date_value,
        coupon_rate=coupon_rate_value,
        review_state='approved',
        version=i.version+1,
        updated_at=now()
    where i.tenant_id=p_tenant_id and i.instrument_id=instrument_uuid
      and row(i.holding_id,i.instrument_type,i.security_name,i.currency,i.seniority,i.maturity_date,i.coupon_rate,i.review_state)
          is distinct from
          row(parent_holding_uuid,instrument_type_value,security_name_value,
              nullif(effective_payload->>'currency',''),nullif(effective_payload->>'seniority',''),
              maturity_date_value,coupon_rate_value,'approved');

    insert into corvis_facts.instrument (
      tenant_id,instrument_id,holding_id,instrument_type,security_name,currency,seniority,
      maturity_date,coupon_rate,source_reference_id,version,review_state
    )
    select p_tenant_id,instrument_uuid,parent_holding_uuid,instrument_type_value,security_name_value,
      nullif(effective_payload->>'currency',''),nullif(effective_payload->>'seniority',''),
      maturity_date_value,coupon_rate_value,null,1,'approved'
    where not exists (select 1 from corvis_facts.instrument i where i.instrument_id=instrument_uuid)
    on conflict (instrument_id) do nothing;

    if not exists (
      select 1 from corvis_facts.instrument i
      where i.tenant_id=p_tenant_id and i.instrument_id=instrument_uuid
        and i.holding_id=parent_holding_uuid and i.instrument_type=instrument_type_value
        and i.security_name=security_name_value and i.review_state='approved'
    ) then raise exception 'reviewed instrument conflicts with existing tenant/identity state'; end if;
  end loop;

  select * into v_result
  from corvis_facts.canonicalize_reviewed_extraction(
    p_tenant_id,p_document_id,p_extraction_run_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256,p_idempotency_key
  );
  if v_result.canonicalization_run_id is null then raise exception 'canonicalization did not finalize reviewed economic candidates'; end if;

  -- Canonical source references exist now. Attach the deterministic primary
  -- reference to the current projection without creating a new economic version.
  update corvis_facts.holding h
  set source_reference_id=c.source_reference_ids[1]
  from corvis_facts.canonical_candidate c
  where c.tenant_id=p_tenant_id
    and c.canonicalization_run_id=v_result.canonicalization_run_id
    and c.candidate_type='holding'
    and h.tenant_id=c.tenant_id
    and h.holding_id=(coalesce(c.effective_payload->>'holding_id',c.effective_payload->>'holdingId'))::uuid
    and h.source_reference_id is distinct from c.source_reference_ids[1];

  update corvis_facts.instrument i
  set source_reference_id=c.source_reference_ids[1]
  from corvis_facts.canonical_candidate c
  where c.tenant_id=p_tenant_id
    and c.canonicalization_run_id=v_result.canonicalization_run_id
    and c.candidate_type='instrument'
    and i.tenant_id=c.tenant_id
    and i.instrument_id=(coalesce(c.effective_payload->>'instrument_id',c.effective_payload->>'instrumentId'))::uuid
    and i.source_reference_id is distinct from c.source_reference_ids[1];

  insert into corvis_facts.holding_revision (
    tenant_id,holding_id,canonicalization_run_id,candidate_id,candidate_fingerprint_sha256,
    effective_payload,source_reference_ids
  )
  select c.tenant_id,(coalesce(c.effective_payload->>'holding_id',c.effective_payload->>'holdingId'))::uuid,
    c.canonicalization_run_id,c.candidate_id,c.candidate_fingerprint_sha256,c.effective_payload,c.source_reference_ids
  from corvis_facts.canonical_candidate c
  where c.tenant_id=p_tenant_id and c.canonicalization_run_id=v_result.canonicalization_run_id
    and c.candidate_type='holding'
  on conflict do nothing;

  insert into corvis_facts.instrument_revision (
    tenant_id,instrument_id,canonicalization_run_id,candidate_id,candidate_fingerprint_sha256,
    effective_payload,source_reference_ids
  )
  select c.tenant_id,(coalesce(c.effective_payload->>'instrument_id',c.effective_payload->>'instrumentId'))::uuid,
    c.canonicalization_run_id,c.candidate_id,c.candidate_fingerprint_sha256,c.effective_payload,c.source_reference_ids
  from corvis_facts.canonical_candidate c
  where c.tenant_id=p_tenant_id and c.canonicalization_run_id=v_result.canonicalization_run_id
    and c.candidate_type='instrument'
  on conflict do nothing;

  return query select
    v_result.canonicalization_run_id,
    v_result.candidate_count,
    v_result.canonical_candidate_count,
    v_result.observation_count,
    v_result.source_reference_count;
end;
$$;


--
-- Name: canonicalize_reviewed_extraction_v3(uuid, uuid, uuid, text, text, text, text); Type: FUNCTION; Schema: corvis_facts; Owner: -
--

CREATE FUNCTION corvis_facts.canonicalize_reviewed_extraction_v3(p_tenant_id uuid, p_document_id uuid, p_extraction_run_id uuid, p_review_policy_version text, p_candidate_set_sha256 text, p_decision_set_sha256 text, p_idempotency_key text) RETURNS TABLE(canonicalization_run_id uuid, candidate_count integer, canonical_candidate_count integer, observation_count integer, source_reference_count integer)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_facts', 'corvis_identity', 'corvis_source', 'corvis_review', 'corvis_control'
    AS $$
declare
  v_result record;
  candidate_row record;
  participant jsonb;
  event_uuid uuid;
  event_type_value text;
  event_status_value text;
  announced_date_value date;
  effective_date_value date;
  closed_date_value date;
  entity_type_value text;
  entity_id_value text;
  role_value text;
  identity_continues_value boolean;
  ownership_before_value numeric(9,6);
  ownership_after_value numeric(9,6);
  supplied_participant_count integer;
  persisted_participant_count integer;
  ref_id uuid;
begin
  -- v2 already verifies the exact ready review gate, materializes economic
  -- holdings/instruments and persists immutable canonical candidates/evidence.
  -- Calling it first gives lifecycle materialization a single authoritative
  -- effective payload and source-reference set. Any failure below rolls v2 back.
  select * into v_result
  from corvis_facts.canonicalize_reviewed_extraction_v2(
    p_tenant_id,p_document_id,p_extraction_run_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256,p_idempotency_key
  );
  if v_result.canonicalization_run_id is null then
    raise exception 'lifecycle materialization requires finalized canonicalization';
  end if;

  for candidate_row in
    select c.*
    from corvis_facts.canonical_candidate c
    where c.tenant_id=p_tenant_id
      and c.canonicalization_run_id=v_result.canonicalization_run_id
      and c.candidate_type='lifecycle_event'
    order by c.candidate_key
  loop
    begin
      event_uuid := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'lifecycle_event_id',
        candidate_row.effective_payload->>'lifecycleEventId',
        candidate_row.effective_payload->>'event_id',
        candidate_row.effective_payload->>'eventId','')),'')::uuid;
    exception when others then
      raise exception 'reviewed lifecycle candidate requires UUID lifecycle_event_id';
    end;
    if event_uuid is null then
      raise exception 'reviewed lifecycle candidate requires lifecycle_event_id';
    end if;

    event_type_value := lower(nullif(btrim(coalesce(
      candidate_row.effective_payload->>'event_type',
      candidate_row.effective_payload->>'eventType','')),''));
    if event_type_value not in (
      'rename','acquisition','merger','demerger','split','spin_off','carve_out',
      'partial_divestiture','reorganization','legal_form_change','domicile_change',
      'formation','dissolution','liquidation','fund_restructure','manager_change',
      'listing','delisting','take_private','successor_transition','other'
    ) then
      raise exception 'reviewed lifecycle candidate requires governed event_type';
    end if;

    event_status_value := lower(coalesce(nullif(btrim(coalesce(
      candidate_row.effective_payload->>'event_status',
      candidate_row.effective_payload->>'eventStatus','')),''),'completed'));
    if event_status_value not in ('announced','pending','completed','cancelled','unknown') then
      raise exception 'reviewed lifecycle candidate requires governed event_status';
    end if;

    begin announced_date_value := nullif(coalesce(candidate_row.effective_payload->>'announced_date',candidate_row.effective_payload->>'announcedDate'),'')::date;
    exception when others then raise exception 'reviewed lifecycle announced_date is invalid'; end;
    begin effective_date_value := nullif(coalesce(candidate_row.effective_payload->>'effective_date',candidate_row.effective_payload->>'effectiveDate'),'')::date;
    exception when others then raise exception 'reviewed lifecycle effective_date is invalid'; end;
    begin closed_date_value := nullif(coalesce(candidate_row.effective_payload->>'closed_date',candidate_row.effective_payload->>'closedDate'),'')::date;
    exception when others then raise exception 'reviewed lifecycle closed_date is invalid'; end;
    if closed_date_value is not null and effective_date_value is not null and closed_date_value < effective_date_value then
      raise exception 'reviewed lifecycle closed_date precedes effective_date';
    end if;

    if jsonb_typeof(candidate_row.effective_payload->'participants') <> 'array'
      or jsonb_array_length(candidate_row.effective_payload->'participants')=0 then
      raise exception 'reviewed lifecycle candidate requires participant array';
    end if;
    supplied_participant_count := jsonb_array_length(candidate_row.effective_payload->'participants');

    insert into corvis_identity.entity_lifecycle_event (
      lifecycle_event_id,event_type,event_status,announced_date,effective_date,closed_date,
      event_subtype_raw,description,source_kind
    ) values (
      event_uuid,event_type_value,event_status_value,announced_date_value,effective_date_value,closed_date_value,
      nullif(coalesce(candidate_row.effective_payload->>'event_subtype_raw',candidate_row.effective_payload->>'eventSubtypeRaw'),''),
      nullif(candidate_row.effective_payload->>'description',''),'tenant_evidence'
    ) on conflict (lifecycle_event_id) do nothing;

    if not exists (
      select 1 from corvis_identity.entity_lifecycle_event e
      where e.lifecycle_event_id=event_uuid
        and e.event_type=event_type_value
        and e.event_status=event_status_value
        and e.announced_date is not distinct from announced_date_value
        and e.effective_date is not distinct from effective_date_value
        and e.closed_date is not distinct from closed_date_value
        and e.event_subtype_raw is not distinct from nullif(coalesce(candidate_row.effective_payload->>'event_subtype_raw',candidate_row.effective_payload->>'eventSubtypeRaw'),'')
        and e.description is not distinct from nullif(candidate_row.effective_payload->>'description','')
    ) then
      raise exception 'reviewed lifecycle candidate conflicts with existing governed event';
    end if;

    for participant in
      select value from jsonb_array_elements(candidate_row.effective_payload->'participants')
    loop
      if jsonb_typeof(participant) <> 'object' then
        raise exception 'reviewed lifecycle participant must be an object';
      end if;
      entity_type_value := lower(nullif(btrim(coalesce(participant->>'entity_type',participant->>'entityType','')),''));
      entity_id_value := nullif(btrim(coalesce(participant->>'entity_id',participant->>'entityId','')),'');
      role_value := lower(nullif(btrim(coalesce(participant->>'participant_role',participant->>'participantRole',participant->>'role','')),''));
      if entity_type_value not in ('fund','company') or entity_id_value is null then
        raise exception 'reviewed lifecycle participant requires fund/company entity identity';
      end if;
      if role_value not in (
        'subject','predecessor','successor','acquirer','acquired','surviving_entity',
        'merged_constituent','source_entity','resulting_entity','parent','child',
        'seller','buyer','transferred_entity','other'
      ) then
        raise exception 'reviewed lifecycle participant requires governed participant_role';
      end if;
      if entity_type_value='fund' and not exists (
        select 1 from corvis_identity.fund f where f.global_fund_id=entity_id_value
      ) then raise exception 'reviewed lifecycle fund participant identity is unresolved'; end if;
      if entity_type_value='company' and not exists (
        select 1 from corvis_identity.company c where c.global_company_id=entity_id_value
      ) then raise exception 'reviewed lifecycle company participant identity is unresolved'; end if;

      if participant ? 'economic_identity_continues' then
        begin identity_continues_value := (participant->>'economic_identity_continues')::boolean;
        exception when others then raise exception 'reviewed lifecycle participant economic_identity_continues is invalid'; end;
      elsif participant ? 'economicIdentityContinues' then
        begin identity_continues_value := (participant->>'economicIdentityContinues')::boolean;
        exception when others then raise exception 'reviewed lifecycle participant economicIdentityContinues is invalid'; end;
      else identity_continues_value := null;
      end if;
      begin ownership_before_value := nullif(coalesce(participant->>'ownership_before',participant->>'ownershipBefore'),'')::numeric(9,6);
      exception when others then raise exception 'reviewed lifecycle ownership_before is invalid'; end;
      begin ownership_after_value := nullif(coalesce(participant->>'ownership_after',participant->>'ownershipAfter'),'')::numeric(9,6);
      exception when others then raise exception 'reviewed lifecycle ownership_after is invalid'; end;
      if ownership_before_value is not null and (ownership_before_value < 0 or ownership_before_value > 1) then raise exception 'reviewed lifecycle ownership_before is outside 0..1'; end if;
      if ownership_after_value is not null and (ownership_after_value < 0 or ownership_after_value > 1) then raise exception 'reviewed lifecycle ownership_after is outside 0..1'; end if;

      insert into corvis_identity.entity_lifecycle_participant (
        lifecycle_event_id,fund_id,company_id,participant_role,economic_identity_continues,
        ownership_before,ownership_after,notes
      ) values (
        event_uuid,
        case when entity_type_value='fund' then entity_id_value else null end,
        case when entity_type_value='company' then entity_id_value else null end,
        role_value,identity_continues_value,ownership_before_value,ownership_after_value,
        nullif(participant->>'notes','')
      ) on conflict do nothing;

      if not exists (
        select 1 from corvis_identity.entity_lifecycle_participant p
        where p.lifecycle_event_id=event_uuid
          and p.participant_role=role_value
          and ((entity_type_value='fund' and p.fund_id=entity_id_value and p.company_id is null)
            or (entity_type_value='company' and p.company_id=entity_id_value and p.fund_id is null))
          and p.economic_identity_continues is not distinct from identity_continues_value
          and p.ownership_before is not distinct from ownership_before_value
          and p.ownership_after is not distinct from ownership_after_value
          and p.notes is not distinct from nullif(participant->>'notes','')
      ) then
        raise exception 'reviewed lifecycle participant conflicts with existing governed participant';
      end if;
    end loop;

    select count(*)::integer into persisted_participant_count
    from corvis_identity.entity_lifecycle_participant p
    where p.lifecycle_event_id=event_uuid;
    if persisted_participant_count < supplied_participant_count then
      raise exception 'reviewed lifecycle participant persistence is incomplete';
    end if;

    foreach ref_id in array candidate_row.source_reference_ids
    loop
      insert into corvis_identity.tenant_entity_lifecycle_evidence (
        tenant_id,lifecycle_event_id,source_reference_id,evidence_role,confidence,review_status
      ) values (p_tenant_id,event_uuid,ref_id,'supporting',null,'approved')
      on conflict (tenant_id,lifecycle_event_id,source_reference_id)
      do update set review_status='approved';
    end loop;

    insert into corvis_identity.tenant_lifecycle_revision (
      tenant_id,lifecycle_event_id,canonicalization_run_id,candidate_id,
      candidate_fingerprint_sha256,effective_payload,source_reference_ids
    ) values (
      p_tenant_id,event_uuid,v_result.canonicalization_run_id,candidate_row.candidate_id,
      candidate_row.candidate_fingerprint_sha256,candidate_row.effective_payload,candidate_row.source_reference_ids
    ) on conflict do nothing;
  end loop;

  return query select
    v_result.canonicalization_run_id,
    v_result.candidate_count,
    v_result.canonical_candidate_count,
    v_result.observation_count,
    v_result.source_reference_count;
end;
$$;


--
-- Name: canonicalize_reviewed_extraction_v4(uuid, uuid, uuid, text, text, text, text); Type: FUNCTION; Schema: corvis_facts; Owner: -
--

CREATE FUNCTION corvis_facts.canonicalize_reviewed_extraction_v4(p_tenant_id uuid, p_document_id uuid, p_extraction_run_id uuid, p_review_policy_version text, p_candidate_set_sha256 text, p_decision_set_sha256 text, p_idempotency_key text) RETURNS TABLE(canonicalization_run_id uuid, candidate_count integer, canonical_candidate_count integer, observation_count integer, source_reference_count integer)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_facts', 'corvis_identity', 'corvis_source', 'corvis_review', 'corvis_control'
    AS $$
declare
  v_result record;
begin
  -- Dependency order for a new graph in one report:
  -- identity -> v2 holding/instrument preprojection -> v1 observations -> lifecycle.
  perform corvis_identity.pre_materialize_reviewed_entity_candidates(
    p_tenant_id,p_document_id,p_extraction_run_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256
  );

  select * into v_result
  from corvis_facts.canonicalize_reviewed_extraction_v3(
    p_tenant_id,p_document_id,p_extraction_run_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256,p_idempotency_key
  );
  if v_result.canonicalization_run_id is null then
    raise exception 'entity materialization requires finalized canonicalization';
  end if;

  perform corvis_identity.record_reviewed_entity_candidate_lineage(
    p_tenant_id,v_result.canonicalization_run_id
  );

  return query select
    v_result.canonicalization_run_id,
    v_result.candidate_count,
    v_result.canonical_candidate_count,
    v_result.observation_count,
    v_result.source_reference_count;
end;
$$;


--
-- Name: enforce_instrument_company_holding(); Type: FUNCTION; Schema: corvis_facts; Owner: -
--

CREATE FUNCTION corvis_facts.enforce_instrument_company_holding() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_facts'
    AS $$
begin
  if not exists (
    select 1 from corvis_facts.holding h
    where h.tenant_id=new.tenant_id
      and h.holding_id=new.holding_id
      and h.target_type='company'
      and h.target_company_id is not null
  ) then
    raise exception 'instrument must belong to a company-targeted holding';
  end if;
  return new;
end;
$$;


--
-- Name: enforce_ready_canonicalization_before_success(); Type: FUNCTION; Schema: corvis_facts; Owner: -
--

CREATE FUNCTION corvis_facts.enforce_ready_canonicalization_before_success() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_facts'
    AS $$
declare
  canonical_result jsonb;
  canonical_run_id uuid;
  extraction_run_id_value uuid;
  candidate_hash text;
  decision_hash text;
  policy_version text;
begin
  if old.stage='canonicalized' and old.state='running' and new.state='succeeded' then
    select e.result into canonical_result
    from corvis_control.processing_stage_effect e
    where e.tenant_id=old.tenant_id
      and e.job_id=old.job_id
      and e.document_id=old.document_id
      and e.stage='canonicalized'
      and e.state='complete'
    order by e.completed_at desc nulls last
    limit 1;

    if canonical_result is null then
      raise exception 'canonicalized completion requires committed canonicalization effect';
    end if;
    begin
      canonical_run_id := (canonical_result ->> 'canonicalizationRunId')::uuid;
      extraction_run_id_value := (canonical_result ->> 'extractionRunId')::uuid;
    exception when others then
      raise exception 'canonicalized completion identifiers are invalid';
    end;
    candidate_hash := canonical_result ->> 'candidateSetSha256';
    decision_hash := canonical_result ->> 'decisionSetSha256';
    policy_version := canonical_result ->> 'reviewPolicyVersion';

    if not exists (
      select 1
      from corvis_facts.canonicalization_run c
      where c.tenant_id=old.tenant_id
        and c.canonicalization_run_id=canonical_run_id
        and c.extraction_run_id=extraction_run_id_value
        and c.document_id=old.document_id
        and c.review_policy_version=policy_version
        and c.candidate_set_sha256=candidate_hash
        and c.decision_set_sha256=decision_hash
        and c.status='ready'
        and c.canonical_candidate_count=c.candidate_count
    ) then
      raise exception 'canonicalization persistence blocks reconciliation';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: guard_company_sector_classification(); Type: FUNCTION; Schema: corvis_facts; Owner: -
--

CREATE FUNCTION corvis_facts.guard_company_sector_classification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.superseded_at is not null
     or new.superseded_at is null
     or (to_jsonb(new) - 'superseded_at') is distinct from (to_jsonb(old) - 'superseded_at') then
    raise exception 'company sector classifications are append-only; only superseding the current row is allowed';
  end if;
  return new;
end;
$$;


--
-- Name: materialize_position_financial_statement_candidate(); Type: FUNCTION; Schema: corvis_facts; Owner: -
--

CREATE FUNCTION corvis_facts.materialize_position_financial_statement_candidate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_facts', 'corvis_source'
    AS $_$
declare
  p jsonb := new.effective_payload;
  v_statement_type text;
  v_statement_key text;
  v_line_key text;
  v_semantic_line_key text;
  v_source_label text;
  v_metric_code text;
  v_line_role text;
  v_report_period text;
  v_document_id uuid;
  v_statement_id uuid;
  v_line_id uuid;
  v_value_id uuid;
  v_display_order integer;
  v_depth integer;
  v_value_number numeric(38,10);
  v_value_number_text text;
  v_value_raw text;
  v_value_string text;
  v_source_document_period_end date;
begin
  if new.candidate_type not in ('metric_observation','financial_statement_line') then
    return new;
  end if;

  v_statement_type := nullif(btrim(coalesce(p ->> 'statement_type', p ->> 'statementType', '')), '');
  if v_statement_type is null then return new; end if;
  if v_statement_type not in ('income_statement','balance_sheet','cash_flow_statement','statement_of_equity','other') then
    raise exception 'unsupported financial statement type: %', v_statement_type;
  end if;

  v_statement_key := nullif(btrim(coalesce(p ->> 'statement_key', p ->> 'statementKey', '')), '');
  v_line_key := nullif(btrim(coalesce(p ->> 'statement_line_key', p ->> 'line_key', p ->> 'statementLineKey', '')), '');
  v_source_label := nullif(btrim(coalesce(p ->> 'statement_line_label', p ->> 'metric_label_original', p ->> 'line_label', '')), '');
  if v_statement_key is null or v_line_key is null or v_source_label is null then
    raise exception 'financial statement candidate requires statement_key, statement_line_key and statement_line_label';
  end if;

  v_metric_code := nullif(btrim(coalesce(p ->> 'metric_code', p ->> 'metricCode', '')), '');
  v_semantic_line_key := nullif(btrim(coalesce(p ->> 'semantic_line_key', p ->> 'semanticLineKey', v_metric_code, '')), '');
  if v_semantic_line_key is null then
    v_semantic_line_key := lower(regexp_replace(v_source_label, '[^[:alnum:]]+', '_', 'g'));
  end if;
  v_line_role := coalesce(nullif(btrim(coalesce(p ->> 'statement_line_role', p ->> 'line_role', '')), ''), 'line_item');
  if v_line_role not in ('line_item','subtotal','total','header','memorandum','other') then
    raise exception 'unsupported financial statement line role: %', v_line_role;
  end if;

  begin v_display_order := coalesce((p ->> 'display_order')::integer, (p ->> 'statement_line_order')::integer, 0);
  exception when invalid_text_representation then raise exception 'financial statement display_order must be an integer'; end;
  begin v_depth := coalesce((p ->> 'depth')::integer, (p ->> 'statement_line_depth')::integer, 0);
  exception when invalid_text_representation then raise exception 'financial statement depth must be an integer'; end;

  select r.document_id,d.report_period into v_document_id,v_report_period
  from corvis_source.extraction_run r
  join corvis_source.document d on d.tenant_id=r.tenant_id and d.document_id=r.document_id
  where r.tenant_id=new.tenant_id and r.extraction_run_id=new.extraction_run_id;
  v_report_period := coalesce(nullif(btrim(coalesce(p ->> 'report_period','')), ''), v_report_period);
  if v_document_id is null or v_report_period is null or btrim(v_report_period)='' then
    raise exception 'financial statement candidate requires a resolved source document report period';
  end if;
  if nullif(btrim(coalesce(p ->> 'fund_id','')), '') is null
     or nullif(btrim(coalesce(p ->> 'holding_id','')), '') is null
     or nullif(btrim(coalesce(p ->> 'company_id','')), '') is null then
    raise exception 'financial statement candidate requires resolved fund_id, holding_id and company_id';
  end if;

  begin v_source_document_period_end := nullif(p ->> 'source_document_period_end','')::date;
  exception when invalid_datetime_format then raise exception 'invalid source_document_period_end on financial statement candidate'; end;

  v_statement_id := md5(new.tenant_id::text || ':' || new.extraction_run_id::text || ':' || v_statement_key)::uuid;
  v_line_id := md5(v_statement_id::text || ':' || v_line_key)::uuid;
  v_value_id := md5(v_statement_id::text || ':' || v_line_key || ':' || new.candidate_id::text)::uuid;

  insert into corvis_facts.position_financial_statement (
    tenant_id,statement_id,canonicalization_run_id,extraction_run_id,document_id,
    fund_id,holding_id,company_id,statement_type,statement_key,source_title,report_period,
    source_document_period_end,source_version_status,review_policy_version
  ) values (
    new.tenant_id,v_statement_id,new.canonicalization_run_id,new.extraction_run_id,v_document_id,
    p ->> 'fund_id',p ->> 'holding_id',p ->> 'company_id',v_statement_type,v_statement_key,
    nullif(btrim(coalesce(p ->> 'statement_title','')), ''),v_report_period,
    v_source_document_period_end,nullif(btrim(coalesce(p ->> 'source_version_status','')), ''),new.review_policy_version
  ) on conflict (tenant_id,statement_id) do nothing;

  if not exists (
    select 1 from corvis_facts.position_financial_statement s
    where s.tenant_id=new.tenant_id and s.statement_id=v_statement_id
      and s.extraction_run_id=new.extraction_run_id and s.document_id=v_document_id
      and s.fund_id=p ->> 'fund_id' and s.holding_id=p ->> 'holding_id'
      and s.company_id=p ->> 'company_id' and s.statement_type=v_statement_type
      and s.statement_key=v_statement_key and s.report_period=v_report_period
  ) then
    raise exception 'financial statement identity conflicts within one extraction run';
  end if;

  insert into corvis_facts.position_financial_statement_line (
    tenant_id,statement_id,line_id,line_key,semantic_line_key,source_label,metric_code,line_role,
    parent_line_key,display_order,depth,source_reference_ids
  ) values (
    new.tenant_id,v_statement_id,v_line_id,v_line_key,v_semantic_line_key,v_source_label,v_metric_code,v_line_role,
    nullif(btrim(coalesce(p ->> 'parent_line_key','')), ''),v_display_order,v_depth,new.source_reference_ids
  ) on conflict (tenant_id,statement_id,line_key) do nothing;

  if not exists (
    select 1 from corvis_facts.position_financial_statement_line l
    where l.tenant_id=new.tenant_id and l.statement_id=v_statement_id and l.line_id=v_line_id
      and l.line_key=v_line_key and l.semantic_line_key=v_semantic_line_key and l.source_label=v_source_label
      and l.metric_code is not distinct from v_metric_code and l.line_role=v_line_role
      and l.parent_line_key is not distinct from nullif(btrim(coalesce(p ->> 'parent_line_key','')), '')
      and l.display_order=v_display_order and l.depth=v_depth
  ) then
    raise exception 'financial statement line presentation conflicts within one statement';
  end if;

  v_value_raw := nullif(p ->> 'value_raw','');
  v_value_string := nullif(coalesce(p ->> 'value_string',p ->> 'value_text'),'');
  v_value_number_text := nullif(btrim(coalesce(p ->> 'value_numeric',p ->> 'value_number','')), '');
  if v_value_number_text is not null then
    if v_value_number_text !~ '^[-+]?[0-9]+([.][0-9]+)?$' then
      raise exception 'financial statement value_numeric must be normalized decimal text';
    end if;
    v_value_number := v_value_number_text::numeric;
  end if;

  if v_value_raw is not null or v_value_string is not null or v_value_number is not null then
    insert into corvis_facts.position_financial_statement_value (
      tenant_id,statement_id,line_id,value_id,candidate_id,candidate_type,value_raw,value_number,value_string,
      value_qualifier,currency,unit,reported_multiplier,source_precision,value_nature,period_type,
      period_start,period_end,as_of_date,fiscal_year,fiscal_quarter,source_document_period_end,source_column_label,
      actuality,scenario_type,source_version_status,preliminary,is_restatement,is_re_reported_prior_period,
      is_derived,derivation_formula,source_reference_ids
    ) values (
      new.tenant_id,v_statement_id,v_line_id,v_value_id,new.candidate_id,new.candidate_type,v_value_raw,v_value_number,v_value_string,
      nullif(p ->> 'value_qualifier',''),nullif(p ->> 'currency',''),nullif(p ->> 'unit',''),
      nullif(p ->> 'reported_multiplier',''),nullif(p ->> 'source_precision',''),nullif(p ->> 'value_nature',''),
      nullif(p ->> 'period_type',''),nullif(p ->> 'period_start','')::date,nullif(p ->> 'period_end','')::date,
      nullif(p ->> 'as_of_date','')::date,nullif(p ->> 'fiscal_year','')::integer,nullif(p ->> 'fiscal_quarter','')::integer,
      v_source_document_period_end,nullif(coalesce(p ->> 'source_column_label',p ->> 'column_label'),''),
      nullif(p ->> 'actuality',''),nullif(p ->> 'scenario_type',''),nullif(p ->> 'source_version_status',''),
      coalesce((p ->> 'preliminary')::boolean,false),coalesce((p ->> 'is_restatement')::boolean,false),
      coalesce((p ->> 'is_re_reported_prior_period')::boolean,false),coalesce((p ->> 'is_derived')::boolean,false),
      nullif(p ->> 'derivation_formula',''),new.source_reference_ids
    ) on conflict (tenant_id,statement_id,line_id,candidate_id) do nothing;
  end if;

  return new;
end;
$_$;


--
-- Name: capture_company_canonical_name_history(); Type: FUNCTION; Schema: corvis_identity; Owner: -
--

CREATE FUNCTION corvis_identity.capture_company_canonical_name_history() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_identity'
    AS $$
begin
  if new.canonical_name is not distinct from old.canonical_name then
    return new;
  end if;

  update corvis_identity.entity_name
  set is_current=false
  where company_id=old.global_company_id and name_kind='canonical' and is_current;

  insert into corvis_identity.entity_name
    (company_id,name,name_kind,is_current,source_kind,recorded_by)
  values
    (new.global_company_id,new.canonical_name,'canonical',true,'governed','canonical-name-trigger');

  return new;
end;
$$;


--
-- Name: capture_fund_canonical_name_history(); Type: FUNCTION; Schema: corvis_identity; Owner: -
--

CREATE FUNCTION corvis_identity.capture_fund_canonical_name_history() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_identity'
    AS $$
begin
  if new.canonical_name is not distinct from old.canonical_name then
    return new;
  end if;

  update corvis_identity.entity_name
  set is_current=false
  where fund_id=old.global_fund_id and name_kind='canonical' and is_current;

  insert into corvis_identity.entity_name
    (fund_id,name,name_kind,is_current,source_kind,recorded_by)
  values
    (new.global_fund_id,new.canonical_name,'canonical',true,'governed','canonical-name-trigger');

  return new;
end;
$$;


--
-- Name: normalize_entity_name(text); Type: FUNCTION; Schema: corvis_identity; Owner: -
--

CREATE FUNCTION corvis_identity.normalize_entity_name(p_name text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  select btrim(regexp_replace(lower(p_name), '[^[:alnum:]]+', ' ', 'g'));
$$;


--
-- Name: pre_materialize_reviewed_entity_candidates(uuid, uuid, uuid, text, text, text); Type: FUNCTION; Schema: corvis_identity; Owner: -
--

CREATE FUNCTION corvis_identity.pre_materialize_reviewed_entity_candidates(p_tenant_id uuid, p_document_id uuid, p_extraction_run_id uuid, p_review_policy_version text, p_candidate_set_sha256 text, p_decision_set_sha256 text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_identity', 'corvis_source', 'corvis_review', 'corvis_control'
    AS $$
declare
  candidate_row record;
  effective_payload jsonb;
  entity_id_value text;
  canonical_name_value text;
  source_name_value text;
  manager_name_value text;
  seen_fund_ids text[] := '{}'::text[];
  seen_company_ids text[] := '{}'::text[];
begin
  -- Mirror v2's proven fail-before-projection gate. v1 later rechecks this exact
  -- gate plus the committed reviewed-stage predecessor and all evidence/identity
  -- invariants; a failure there rolls these writes back atomically.
  if not exists (
    select 1
    from corvis_review.extraction_review_gate g
    join corvis_source.extraction_run r
      on r.tenant_id=g.tenant_id and r.extraction_run_id=g.extraction_run_id
    where g.tenant_id=p_tenant_id
      and g.extraction_run_id=p_extraction_run_id
      and r.document_id=p_document_id
      and r.status='ready'
      and g.review_policy_version=p_review_policy_version
      and g.status='ready'
      and g.blocking_candidate_count=0
      and g.candidate_set_sha256=p_candidate_set_sha256
      and g.decision_set_sha256=p_decision_set_sha256
      and r.candidate_set_sha256=p_candidate_set_sha256
  ) then
    raise exception 'entity materialization requires exact ready reviewed candidate set';
  end if;

  for candidate_row in
    select c.*,
      c.payload || coalesce((
        select e.correction_payload
        from corvis_review.candidate_review_event e
        where e.tenant_id=c.tenant_id
          and e.extraction_run_id=c.extraction_run_id
          and e.candidate_id=c.candidate_id
          and e.review_policy_version=p_review_policy_version
          and e.decision='correct'
        order by e.event_sequence desc limit 1
      ),'{}'::jsonb) as reviewed_payload
    from corvis_source.extraction_candidate c
    where c.tenant_id=p_tenant_id
      and c.extraction_run_id=p_extraction_run_id
      and c.candidate_type in ('fund','company')
    order by c.candidate_type,c.candidate_key
  loop
    effective_payload := candidate_row.reviewed_payload;

    if candidate_row.candidate_type='fund' then
      entity_id_value := nullif(btrim(coalesce(
        effective_payload->>'global_fund_id',effective_payload->>'globalFundId',
        effective_payload->>'fund_id',effective_payload->>'fundId','')),'');
      canonical_name_value := nullif(btrim(coalesce(
        effective_payload->>'canonical_name',effective_payload->>'canonicalName','')),'');
      source_name_value := nullif(btrim(coalesce(
        effective_payload->>'source_name',effective_payload->>'sourceName',
        effective_payload->>'fund_name',effective_payload->>'fundName',effective_payload->>'name',
        canonical_name_value,'')),'');
      manager_name_value := nullif(btrim(coalesce(
        effective_payload->>'manager_name',effective_payload->>'managerName',
        effective_payload->>'gp_name',effective_payload->>'gpName','')),'');

      if entity_id_value is null then raise exception 'reviewed fund candidate requires resolved global_fund_id'; end if;
      if source_name_value is null then raise exception 'reviewed fund candidate requires source or canonical name'; end if;
      if entity_id_value=any(seen_fund_ids) then raise exception 'reviewed candidate set contains duplicate global_fund_id'; end if;
      seen_fund_ids := array_append(seen_fund_ids,entity_id_value);

      if not exists (select 1 from corvis_identity.fund f where f.global_fund_id=entity_id_value) then
        if canonical_name_value is null then raise exception 'new reviewed fund identity requires explicit canonical_name'; end if;
        insert into corvis_identity.fund (global_fund_id,canonical_name,manager_name)
        values (entity_id_value,canonical_name_value,manager_name_value)
        on conflict (global_fund_id) do nothing;
      end if;
      if not exists (select 1 from corvis_identity.fund f where f.global_fund_id=entity_id_value) then
        raise exception 'reviewed fund identity could not be materialized';
      end if;
    else
      entity_id_value := nullif(btrim(coalesce(
        effective_payload->>'global_company_id',effective_payload->>'globalCompanyId',
        effective_payload->>'company_id',effective_payload->>'companyId','')),'');
      canonical_name_value := nullif(btrim(coalesce(
        effective_payload->>'canonical_name',effective_payload->>'canonicalName','')),'');
      source_name_value := nullif(btrim(coalesce(
        effective_payload->>'source_name',effective_payload->>'sourceName',
        effective_payload->>'company_name',effective_payload->>'companyName',effective_payload->>'name',
        canonical_name_value,'')),'');

      if entity_id_value is null then raise exception 'reviewed company candidate requires resolved global_company_id'; end if;
      if source_name_value is null then raise exception 'reviewed company candidate requires source or canonical name'; end if;
      if entity_id_value=any(seen_company_ids) then raise exception 'reviewed candidate set contains duplicate global_company_id'; end if;
      seen_company_ids := array_append(seen_company_ids,entity_id_value);

      if not exists (select 1 from corvis_identity.company c where c.global_company_id=entity_id_value) then
        if canonical_name_value is null then raise exception 'new reviewed company identity requires explicit canonical_name'; end if;
        insert into corvis_identity.company (global_company_id,canonical_name)
        values (entity_id_value,canonical_name_value)
        on conflict (global_company_id) do nothing;
      end if;
      if not exists (select 1 from corvis_identity.company c where c.global_company_id=entity_id_value) then
        raise exception 'reviewed company identity could not be materialized';
      end if;
    end if;
  end loop;
end;
$$;


--
-- Name: record_reviewed_entity_candidate_lineage(uuid, uuid); Type: FUNCTION; Schema: corvis_identity; Owner: -
--

CREATE FUNCTION corvis_identity.record_reviewed_entity_candidate_lineage(p_tenant_id uuid, p_canonicalization_run_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_identity', 'corvis_facts', 'corvis_source', 'corvis_control'
    AS $$
declare
  candidate_row record;
  entity_id_value text;
  source_name_value text;
  entity_confidence numeric(5,4);
begin
  if not exists (
    select 1 from corvis_facts.canonicalization_run r
    where r.tenant_id=p_tenant_id
      and r.canonicalization_run_id=p_canonicalization_run_id
      and r.status='ready'
  ) then
    raise exception 'entity lineage requires finalized reviewed canonicalization';
  end if;

  for candidate_row in
    select c.*
    from corvis_facts.canonical_candidate c
    where c.tenant_id=p_tenant_id
      and c.canonicalization_run_id=p_canonicalization_run_id
      and c.candidate_type in ('fund','company')
    order by c.candidate_type,c.candidate_key
  loop
    if candidate_row.candidate_type='fund' then
      entity_id_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'global_fund_id',candidate_row.effective_payload->>'globalFundId',
        candidate_row.effective_payload->>'fund_id',candidate_row.effective_payload->>'fundId','')),'');
      source_name_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'source_name',candidate_row.effective_payload->>'sourceName',
        candidate_row.effective_payload->>'fund_name',candidate_row.effective_payload->>'fundName',
        candidate_row.effective_payload->>'name',candidate_row.effective_payload->>'canonical_name',
        candidate_row.effective_payload->>'canonicalName','')),'');
      if entity_id_value is null or source_name_value is null then
        raise exception 'canonical fund candidate lost reviewed identity/name lineage';
      end if;
      if not exists (select 1 from corvis_identity.fund f where f.global_fund_id=entity_id_value) then
        raise exception 'canonical fund identity is unresolved after materialization';
      end if;
    else
      entity_id_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'global_company_id',candidate_row.effective_payload->>'globalCompanyId',
        candidate_row.effective_payload->>'company_id',candidate_row.effective_payload->>'companyId','')),'');
      source_name_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'source_name',candidate_row.effective_payload->>'sourceName',
        candidate_row.effective_payload->>'company_name',candidate_row.effective_payload->>'companyName',
        candidate_row.effective_payload->>'name',candidate_row.effective_payload->>'canonical_name',
        candidate_row.effective_payload->>'canonicalName','')),'');
      if entity_id_value is null or source_name_value is null then
        raise exception 'canonical company candidate lost reviewed identity/name lineage';
      end if;
      if not exists (select 1 from corvis_identity.company c where c.global_company_id=entity_id_value) then
        raise exception 'canonical company identity is unresolved after materialization';
      end if;
    end if;

    begin
      entity_confidence := nullif(candidate_row.confidence->>'entity','')::numeric(5,4);
    exception when others then
      entity_confidence := null;
    end;

    -- Canonical source references exist only after v1 has finalized the reviewed set.
    insert into corvis_identity.tenant_entity_name (
      tenant_id,tenant_entity_name_id,fund_id,company_id,name,name_kind,
      source_reference_id,confidence,review_status
    ) values (
      p_tenant_id,candidate_row.candidate_id,
      case when candidate_row.candidate_type='fund' then entity_id_value else null end,
      case when candidate_row.candidate_type='company' then entity_id_value else null end,
      source_name_value,'source_label',candidate_row.source_reference_ids[1],entity_confidence,'approved'
    ) on conflict (tenant_id,tenant_entity_name_id) do nothing;

    if not exists (
      select 1 from corvis_identity.tenant_entity_name n
      where n.tenant_id=p_tenant_id
        and n.tenant_entity_name_id=candidate_row.candidate_id
        and n.name=source_name_value
        and n.name_kind='source_label'
        and n.review_status='approved'
        and n.source_reference_id=candidate_row.source_reference_ids[1]
        and ((candidate_row.candidate_type='fund' and n.fund_id=entity_id_value and n.company_id is null)
          or (candidate_row.candidate_type='company' and n.company_id=entity_id_value and n.fund_id is null))
    ) then
      raise exception 'reviewed entity candidate conflicts with existing tenant identity evidence';
    end if;

    insert into corvis_identity.tenant_entity_revision (
      tenant_id,canonicalization_run_id,candidate_id,entity_type,global_entity_id,
      candidate_fingerprint_sha256,effective_payload,source_reference_ids
    ) values (
      p_tenant_id,p_canonicalization_run_id,candidate_row.candidate_id,candidate_row.candidate_type,
      entity_id_value,candidate_row.candidate_fingerprint_sha256,
      candidate_row.effective_payload,candidate_row.source_reference_ids
    ) on conflict do nothing;
  end loop;
end;
$$;


--
-- Name: seed_company_canonical_name_history(); Type: FUNCTION; Schema: corvis_identity; Owner: -
--

CREATE FUNCTION corvis_identity.seed_company_canonical_name_history() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_identity'
    AS $$
begin
  insert into corvis_identity.entity_name
    (company_id,name,name_kind,is_current,source_kind,recorded_by)
  values
    (new.global_company_id,new.canonical_name,'canonical',true,'governed','canonical-name-insert-trigger')
  on conflict do nothing;
  return new;
end;
$$;


--
-- Name: seed_fund_canonical_name_history(); Type: FUNCTION; Schema: corvis_identity; Owner: -
--

CREATE FUNCTION corvis_identity.seed_fund_canonical_name_history() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_identity'
    AS $$
begin
  insert into corvis_identity.entity_name
    (fund_id,name,name_kind,is_current,source_kind,recorded_by)
  values
    (new.global_fund_id,new.canonical_name,'canonical',true,'governed','canonical-name-insert-trigger')
  on conflict do nothing;
  return new;
end;
$$;


--
-- Name: enforce_ready_gate_before_review_success(); Type: FUNCTION; Schema: corvis_review; Owner: -
--

CREATE FUNCTION corvis_review.enforce_ready_gate_before_review_success() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_control', 'corvis_review', 'corvis_source'
    AS $$
declare
  reviewed_result jsonb;
  run_id uuid;
  candidate_hash text;
  decision_hash text;
  policy_version text;
begin
  if old.stage='reviewed' and old.state='running' and new.state='succeeded' then
    select e.result into reviewed_result
    from corvis_control.processing_stage_effect e
    where e.tenant_id=old.tenant_id
      and e.job_id=old.job_id
      and e.document_id=old.document_id
      and e.stage='reviewed'
      and e.state='complete'
    order by e.completed_at desc nulls last
    limit 1;

    if reviewed_result is null then
      raise exception 'review completion requires committed reviewed-stage effect';
    end if;

    begin
      run_id := (reviewed_result ->> 'extractionRunId')::uuid;
    exception when others then
      raise exception 'review completion extraction run is invalid';
    end;
    candidate_hash := reviewed_result ->> 'candidateSetSha256';
    decision_hash := reviewed_result ->> 'decisionSetSha256';
    policy_version := reviewed_result ->> 'reviewPolicyVersion';

    if policy_version <> 'candidate_review_v1'
      or candidate_hash is null
      or decision_hash is null then
      raise exception 'review completion result is incomplete';
    end if;

    if not exists (
      select 1
      from corvis_review.extraction_review_gate g
      join corvis_source.extraction_run r
        on r.tenant_id=g.tenant_id and r.extraction_run_id=g.extraction_run_id
      where g.tenant_id=old.tenant_id
        and g.extraction_run_id=run_id
        and g.review_policy_version=policy_version
        and g.status='ready'
        and g.blocking_candidate_count=0
        and g.candidate_set_sha256=candidate_hash
        and g.decision_set_sha256=decision_hash
        and r.document_id=old.document_id
        and r.status='ready'
        and r.candidate_set_sha256=candidate_hash
    ) then
      raise exception 'review gate blocks canonicalization';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: guard_review_event_lifecycle(); Type: FUNCTION; Schema: corvis_review; Owner: -
--

CREATE FUNCTION corvis_review.guard_review_event_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'corvis_review', 'corvis_source', 'corvis_control'
    AS $$
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


--
-- Name: normalize_sector_label(text); Type: FUNCTION; Schema: corvis_semantic; Owner: -
--

CREATE FUNCTION corvis_semantic.normalize_sector_label(p_label text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select nullif(btrim(regexp_replace(
    regexp_replace(regexp_replace(lower(coalesce(p_label,'')), '[&+]', ' and ', 'g'), '[^a-z0-9 ]+', ' ', 'g'),
    '\s+', ' ', 'g')), '')
$$;


--
-- Name: release_clean_artifact(uuid, uuid, uuid, text, text); Type: FUNCTION; Schema: corvis_source; Owner: -
--

CREATE FUNCTION corvis_source.release_clean_artifact(p_tenant_id uuid, p_document_id uuid, p_artifact_version_id uuid, p_storage_generation text, p_ingestion_id text) RETURNS text
    LANGUAGE plpgsql
    AS $$
declare
  v_job_id text := 'registered:' || p_document_id::text;
  v_previous text;
  v_scan text;
begin
  select a.quarantine_status, a.malware_scan_status into v_previous, v_scan
  from corvis_source.document_artifact_version a
  where a.tenant_id=p_tenant_id and a.document_artifact_version_id=p_artifact_version_id
  for update;

  if not found then raise exception 'artifact not found'; end if;
  if v_previous not in ('pending','quarantined','released') then
    raise exception 'artifact was purged and cannot be released';
  end if;
  -- A threat, integrity or content-validation verdict is terminal: never overwrite it with 'clean'.
  if v_scan not in ('pending','clean') then
    raise exception 'artifact scan verdict % blocks release', v_scan;
  end if;
  -- Idempotent: an artifact that is already released keeps its job and its document status.
  if v_previous = 'released' then return v_job_id; end if;

  update corvis_source.document_artifact_version
  set storage_generation=p_storage_generation,
      malware_scan_status='clean',
      quarantine_status='released'
  where tenant_id=p_tenant_id and document_artifact_version_id=p_artifact_version_id;

  update corvis_source.document set status='queued'
  where tenant_id=p_tenant_id and document_id=p_document_id;

  insert into corvis_control.processing_job
    (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version,created_at,updated_at)
  values (p_tenant_id,v_job_id,p_document_id,'registered','queued',0,5,p_ingestion_id,1,now(),now())
  on conflict (tenant_id, job_id) do nothing;

  if not exists (
    select 1 from corvis_control.outbox_event
    where tenant_id=p_tenant_id and event_type='DocumentRegistered'
      and aggregate_type='document' and aggregate_id=p_document_id::text
  ) then
    insert into corvis_control.outbox_event
      (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
    values (
      p_tenant_id,gen_random_uuid(),'DocumentRegistered','document',p_document_id::text,
      jsonb_build_object('documentId',p_document_id,'artifactVersionId',p_artifact_version_id,'ingestionId',p_ingestion_id),now()
    );
  end if;

  return v_job_id;
end;
$$;


--
-- Name: consolidated_fact; Type: TABLE; Schema: corvis_consolidated; Owner: -
--

CREATE TABLE corvis_consolidated.consolidated_fact (
    tenant_id uuid NOT NULL,
    consolidated_fact_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_id text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    metric_code text NOT NULL,
    economic_period text,
    value jsonb NOT NULL,
    source_observation_ids uuid[] NOT NULL,
    consolidation_rule_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reconciliation_run_id uuid,
    snapshot_id uuid,
    snapshot_version integer,
    semantic_grain_hash text,
    semantic_grain_relationship text,
    normalized_value_hash text,
    CONSTRAINT consolidated_fact_semantic_relationship_check CHECK (((semantic_grain_relationship IS NULL) OR (semantic_grain_relationship = ANY (ARRAY['single_observation'::text, 'equivalent_grain'::text, 'conflicting_alternative'::text])))),
    CONSTRAINT consolidated_fact_snapshot_version_check CHECK (((snapshot_version IS NULL) OR (snapshot_version > 0))),
    CONSTRAINT consolidated_fact_subject_level_present CHECK ((NULLIF(btrim(((value -> 'semanticDimensions'::text) ->> 'subjectLevel'::text)), ''::text) IS NOT NULL)),
    CONSTRAINT consolidated_fact_subject_type_nonempty CHECK ((NULLIF(btrim(subject_type), ''::text) IS NOT NULL))
);

ALTER TABLE ONLY corvis_consolidated.consolidated_fact FORCE ROW LEVEL SECURITY;


--
-- Name: consolidation_run; Type: TABLE; Schema: corvis_consolidated; Owner: -
--

CREATE TABLE corvis_consolidated.consolidation_run (
    tenant_id uuid NOT NULL,
    consolidation_run_id uuid NOT NULL,
    reconciliation_run_id uuid NOT NULL,
    document_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    snapshot_version integer NOT NULL,
    idempotency_key text NOT NULL,
    consolidation_rule_version text NOT NULL,
    status text NOT NULL,
    fact_ids uuid[] NOT NULL,
    fact_count integer NOT NULL,
    source_observation_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT consolidation_run_check CHECK ((cardinality(fact_ids) = fact_count)),
    CONSTRAINT consolidation_run_consolidation_rule_version_check CHECK ((btrim(consolidation_rule_version) <> ''::text)),
    CONSTRAINT consolidation_run_fact_count_check CHECK ((fact_count > 0)),
    CONSTRAINT consolidation_run_idempotency_key_check CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT consolidation_run_snapshot_version_check CHECK ((snapshot_version > 0)),
    CONSTRAINT consolidation_run_source_observation_count_check CHECK ((source_observation_count > 0)),
    CONSTRAINT consolidation_run_status_check CHECK ((status = 'ready'::text))
);

ALTER TABLE ONLY corvis_consolidated.consolidation_run FORCE ROW LEVEL SECURITY;


--
-- Name: fund_period_snapshot; Type: TABLE; Schema: corvis_consolidated; Owner: -
--

CREATE TABLE corvis_consolidated.fund_period_snapshot (
    tenant_id uuid NOT NULL,
    snapshot_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_id text NOT NULL,
    report_period text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    fact_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    blocking_exception_count integer DEFAULT 0 NOT NULL,
    schema_version text NOT NULL,
    taxonomy_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    review_deadline_at timestamp with time zone,
    CONSTRAINT fund_period_snapshot_blocking_exception_count_check CHECK ((blocking_exception_count >= 0)),
    CONSTRAINT fund_period_snapshot_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'blocked'::text, 'published'::text, 'withdrawn'::text, 'superseded'::text]))),
    CONSTRAINT fund_period_snapshot_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY corvis_consolidated.fund_period_snapshot FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN fund_period_snapshot.review_deadline_at; Type: COMMENT; Schema: corvis_consolidated; Owner: -
--

COMMENT ON COLUMN corvis_consolidated.fund_period_snapshot.review_deadline_at IS 'Optional tenant/workflow supplied review deadline. Null means no configured deadline; Corvis does not fabricate one.';


--
-- Name: publication_run; Type: TABLE; Schema: corvis_consolidated; Owner: -
--

CREATE TABLE corvis_consolidated.publication_run (
    tenant_id uuid NOT NULL,
    publication_run_id uuid NOT NULL,
    consolidation_run_id uuid NOT NULL,
    document_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    source_snapshot_version integer NOT NULL,
    published_snapshot_version integer NOT NULL,
    publication_event_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL,
    fact_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_run_check CHECK ((published_snapshot_version > source_snapshot_version)),
    CONSTRAINT publication_run_fact_count_check CHECK ((fact_count > 0)),
    CONSTRAINT publication_run_idempotency_key_check CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT publication_run_source_snapshot_version_check CHECK ((source_snapshot_version > 0)),
    CONSTRAINT publication_run_status_check CHECK ((status = 'ready'::text))
);

ALTER TABLE ONLY corvis_consolidated.publication_run FORCE ROW LEVEL SECURITY;


--
-- Name: reconciliation; Type: TABLE; Schema: corvis_consolidated; Owner: -
--

CREATE TABLE corvis_consolidated.reconciliation (
    tenant_id uuid NOT NULL,
    reconciliation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_id text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    metric_code text NOT NULL,
    economic_period text,
    source_observation_ids uuid[] NOT NULL,
    status text NOT NULL,
    resolution_rule text,
    resolved_observation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY corvis_consolidated.reconciliation FORCE ROW LEVEL SECURITY;


--
-- Name: reconciliation_exception; Type: TABLE; Schema: corvis_consolidated; Owner: -
--

CREATE TABLE corvis_consolidated.reconciliation_exception (
    tenant_id uuid NOT NULL,
    exception_id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_id uuid NOT NULL,
    snapshot_version integer NOT NULL,
    exception_key text NOT NULL,
    fund_id text NOT NULL,
    report_period text NOT NULL,
    exception_type text NOT NULL,
    subject_type text,
    subject_id text,
    metric_code text,
    summary text NOT NULL,
    materiality text DEFAULT 'unknown'::text NOT NULL,
    competing_source_reference_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_by text,
    resolved_at timestamp with time zone,
    reconciliation_run_id uuid,
    CONSTRAINT reconciliation_exception_exception_type_check CHECK ((exception_type = ANY (ARRAY['source_authority'::text, 'materiality'::text, 'reconciliation_conflict'::text]))),
    CONSTRAINT reconciliation_exception_materiality_check CHECK ((materiality = ANY (ARRAY['unknown'::text, 'immaterial'::text, 'material'::text]))),
    CONSTRAINT reconciliation_exception_snapshot_version_check CHECK ((snapshot_version > 0)),
    CONSTRAINT reconciliation_exception_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text]))),
    CONSTRAINT reconciliation_exception_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY corvis_consolidated.reconciliation_exception FORCE ROW LEVEL SECURITY;


--
-- Name: reconciliation_resolution_event; Type: TABLE; Schema: corvis_consolidated; Owner: -
--

CREATE TABLE corvis_consolidated.reconciliation_resolution_event (
    tenant_id uuid NOT NULL,
    resolution_event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    exception_id uuid NOT NULL,
    exception_version integer NOT NULL,
    action text NOT NULL,
    selected_source_reference_id uuid,
    reason_code text NOT NULL,
    note text,
    actor_subject text NOT NULL,
    before_state jsonb NOT NULL,
    after_state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reconciliation_resolution_event_action_check CHECK ((action = ANY (ARRAY['select_source'::text, 'mark_immaterial'::text, 'accept_reconciliation'::text]))),
    CONSTRAINT reconciliation_resolution_event_exception_version_check CHECK ((exception_version > 0))
);

ALTER TABLE ONLY corvis_consolidated.reconciliation_resolution_event FORCE ROW LEVEL SECURITY;


--
-- Name: reconciliation_run; Type: TABLE; Schema: corvis_consolidated; Owner: -
--

CREATE TABLE corvis_consolidated.reconciliation_run (
    tenant_id uuid NOT NULL,
    reconciliation_run_id uuid NOT NULL,
    canonicalization_run_id uuid NOT NULL,
    document_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    snapshot_version integer NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL,
    fund_id text NOT NULL,
    report_period text NOT NULL,
    schema_version text NOT NULL,
    taxonomy_version text NOT NULL,
    observation_count integer NOT NULL,
    blocking_exception_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT reconciliation_run_blocking_exception_count_check CHECK ((blocking_exception_count >= 0)),
    CONSTRAINT reconciliation_run_check CHECK ((((status = 'blocked'::text) AND (blocking_exception_count > 0) AND (completed_at IS NULL)) OR ((status = 'ready'::text) AND (blocking_exception_count = 0) AND (completed_at IS NOT NULL)))),
    CONSTRAINT reconciliation_run_fund_id_check CHECK ((btrim(fund_id) <> ''::text)),
    CONSTRAINT reconciliation_run_idempotency_key_check CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT reconciliation_run_observation_count_check CHECK ((observation_count > 0)),
    CONSTRAINT reconciliation_run_report_period_check CHECK ((btrim(report_period) <> ''::text)),
    CONSTRAINT reconciliation_run_snapshot_version_check CHECK ((snapshot_version > 0)),
    CONSTRAINT reconciliation_run_status_check CHECK ((status = ANY (ARRAY['blocked'::text, 'ready'::text])))
);

ALTER TABLE ONLY corvis_consolidated.reconciliation_run FORCE ROW LEVEL SECURITY;


--
-- Name: snapshot_publication_event; Type: TABLE; Schema: corvis_consolidated; Owner: -
--

CREATE TABLE corvis_consolidated.snapshot_publication_event (
    tenant_id uuid NOT NULL,
    publication_event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_id uuid NOT NULL,
    from_version integer NOT NULL,
    to_version integer NOT NULL,
    action text NOT NULL,
    actor_subject text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT snapshot_publication_event_action_check CHECK ((action = ANY (ARRAY['publish'::text, 'withdraw'::text, 'supersede'::text]))),
    CONSTRAINT snapshot_publication_event_check CHECK ((to_version > from_version)),
    CONSTRAINT snapshot_publication_event_from_version_check CHECK ((from_version > 0))
);

ALTER TABLE ONLY corvis_consolidated.snapshot_publication_event FORCE ROW LEVEL SECURITY;


--
-- Name: api_rate_limit; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.api_rate_limit (
    tenant_id uuid NOT NULL,
    subject text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    request_count integer NOT NULL,
    CONSTRAINT api_rate_limit_request_count_check CHECK ((request_count > 0)),
    CONSTRAINT api_rate_limit_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.api_rate_limit FORCE ROW LEVEL SECURITY;


--
-- Name: audit_event; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.audit_event (
    audit_event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_subject text NOT NULL,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    outcome text NOT NULL,
    correlation_id text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY corvis_control.audit_event FORCE ROW LEVEL SECURITY;


--
-- Name: control_definition; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.control_definition (
    tenant_id uuid NOT NULL,
    control_code text NOT NULL,
    title text NOT NULL,
    domain text NOT NULL,
    owner text NOT NULL,
    implementation_state text DEFAULT 'planned'::text NOT NULL,
    promoted_at timestamp with time zone,
    promoted_by text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT control_definition_check CHECK (((implementation_state = 'implemented'::text) = ((promoted_at IS NOT NULL) AND (promoted_by IS NOT NULL)))),
    CONSTRAINT control_definition_control_code_check CHECK (((length(control_code) >= 1) AND (length(control_code) <= 128))),
    CONSTRAINT control_definition_implementation_state_check CHECK ((implementation_state = ANY (ARRAY['planned'::text, 'in_progress'::text, 'implemented'::text, 'not_applicable'::text]))),
    CONSTRAINT control_definition_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY corvis_control.control_definition FORCE ROW LEVEL SECURITY;


--
-- Name: control_evidence; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.control_evidence (
    tenant_id uuid NOT NULL,
    evidence_id uuid DEFAULT gen_random_uuid() NOT NULL,
    control_code text NOT NULL,
    evidence_type text NOT NULL,
    evidence_uri text,
    evidence_payload jsonb,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    result text NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    generated_by text NOT NULL,
    valid_through timestamp with time zone
);

ALTER TABLE ONLY corvis_control.control_evidence FORCE ROW LEVEL SECURITY;


--
-- Name: control_evidence_escalation; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.control_evidence_escalation (
    tenant_id uuid NOT NULL,
    escalation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    control_code text NOT NULL,
    source_key text NOT NULL,
    lifecycle_state text NOT NULL,
    escalation_level text NOT NULL,
    detail text NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    detected_by text NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    CONSTRAINT control_evidence_escalation_escalation_level_check CHECK ((escalation_level = ANY (ARRAY['notice'::text, 'warning'::text, 'breach'::text]))),
    CONSTRAINT control_evidence_escalation_lifecycle_state_check CHECK ((lifecycle_state = ANY (ARRAY['due_soon'::text, 'stale'::text, 'expired'::text, 'failing'::text, 'missing'::text, 'not_collectable'::text])))
);

ALTER TABLE ONLY corvis_control.control_evidence_escalation FORCE ROW LEVEL SECURITY;


--
-- Name: control_evidence_record; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.control_evidence_record (
    tenant_id uuid NOT NULL,
    evidence_record_id uuid DEFAULT gen_random_uuid() NOT NULL,
    control_code text NOT NULL,
    source_key text NOT NULL,
    revision integer NOT NULL,
    result text NOT NULL,
    collection_method text NOT NULL,
    collected_at timestamp with time zone NOT NULL,
    valid_through timestamp with time zone NOT NULL,
    collected_by text NOT NULL,
    source_run_uri text,
    payload_digest text NOT NULL,
    payload_location text,
    previous_digest text,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT control_evidence_record_check CHECK ((valid_through > collected_at)),
    CONSTRAINT control_evidence_record_collected_by_check CHECK (((length(collected_by) >= 1) AND (length(collected_by) <= 512))),
    CONSTRAINT control_evidence_record_collection_method_check CHECK ((collection_method = ANY (ARRAY['automated'::text, 'attested_manual'::text]))),
    CONSTRAINT control_evidence_record_payload_digest_check CHECK ((payload_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT control_evidence_record_previous_digest_check CHECK ((previous_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT control_evidence_record_result_check CHECK ((result = ANY (ARRAY['pass'::text, 'fail'::text]))),
    CONSTRAINT control_evidence_record_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY corvis_control.control_evidence_record FORCE ROW LEVEL SECURITY;


--
-- Name: control_evidence_requirement; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.control_evidence_requirement (
    tenant_id uuid NOT NULL,
    control_code text NOT NULL,
    source_key text NOT NULL,
    title text NOT NULL,
    producer text NOT NULL,
    owner text NOT NULL,
    cadence_days integer NOT NULL,
    grace_days integer DEFAULT 0 NOT NULL,
    collection text NOT NULL,
    collectable boolean DEFAULT false NOT NULL,
    mandatory boolean DEFAULT false NOT NULL,
    confidentiality text DEFAULT 'restricted'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT control_evidence_requirement_cadence_days_check CHECK (((cadence_days >= 1) AND (cadence_days <= 1095))),
    CONSTRAINT control_evidence_requirement_check CHECK (((collection = 'automated'::text) = collectable)),
    CONSTRAINT control_evidence_requirement_collection_check CHECK ((collection = ANY (ARRAY['automated'::text, 'provider_gated'::text]))),
    CONSTRAINT control_evidence_requirement_confidentiality_check CHECK ((confidentiality = ANY (ARRAY['internal'::text, 'restricted'::text]))),
    CONSTRAINT control_evidence_requirement_grace_days_check CHECK ((grace_days >= 0)),
    CONSTRAINT control_evidence_requirement_source_key_check CHECK (((length(source_key) >= 1) AND (length(source_key) <= 128)))
);

ALTER TABLE ONLY corvis_control.control_evidence_requirement FORCE ROW LEVEL SECURITY;


--
-- Name: data_correction_incident; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.data_correction_incident (
    tenant_id uuid NOT NULL,
    incident_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    fund_id text NOT NULL,
    report_period text NOT NULL,
    metric_code text,
    snapshot_id uuid,
    snapshot_version integer,
    document_id uuid,
    state text NOT NULL,
    root_cause text NOT NULL,
    correction_intent text NOT NULL,
    opened_by text NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    replay_job_id text,
    replacement_snapshot_id uuid,
    replacement_snapshot_version integer,
    resolved_by text,
    resolved_at timestamp with time zone,
    resolution_evidence jsonb,
    CONSTRAINT data_correction_incident_idempotency_key_check CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 256))),
    CONSTRAINT data_correction_incident_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT data_correction_incident_snapshot_version_check CHECK (((snapshot_version IS NULL) OR (snapshot_version > 0))),
    CONSTRAINT data_correction_incident_state_check CHECK ((state = ANY (ARRAY['open'::text, 'reprocessing'::text, 'resolved'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY corvis_control.data_correction_incident FORCE ROW LEVEL SECURITY;


--
-- Name: data_issue_case_event; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.data_issue_case_event (
    tenant_id uuid NOT NULL,
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_seq bigint NOT NULL,
    case_id uuid NOT NULL,
    from_status text,
    to_status text NOT NULL,
    actor_subject text NOT NULL,
    note text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_issue_case_event_from_status_check CHECK (((from_status IS NULL) OR (from_status = ANY (ARRAY['received'::text, 'investigating'::text, 'corrected'::text, 'no_change'::text])))),
    CONSTRAINT data_issue_case_event_note_check CHECK (((note IS NULL) OR (length(note) <= 2000))),
    CONSTRAINT data_issue_case_event_to_status_check CHECK ((to_status = ANY (ARRAY['received'::text, 'investigating'::text, 'corrected'::text, 'no_change'::text])))
);

ALTER TABLE ONLY corvis_control.data_issue_case_event FORCE ROW LEVEL SECURITY;


--
-- Name: data_issue_case_event_event_seq_seq; Type: SEQUENCE; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.data_issue_case_event ALTER COLUMN event_seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME corvis_control.data_issue_case_event_event_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: data_rights; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.data_rights (
    rights_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    client_visible boolean DEFAULT true NOT NULL,
    internal_analytics_allowed boolean DEFAULT false NOT NULL,
    model_training_allowed boolean DEFAULT false NOT NULL,
    redistribution_allowed boolean DEFAULT false NOT NULL,
    source_document_access_allowed boolean DEFAULT false NOT NULL,
    effective_from timestamp with time zone DEFAULT now() NOT NULL,
    effective_to timestamp with time zone,
    contract_reference text,
    CONSTRAINT data_rights_check CHECK (((effective_to IS NULL) OR (effective_to > effective_from)))
);

ALTER TABLE ONLY corvis_control.data_rights FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE data_rights; Type: COMMENT; Schema: corvis_control; Owner: -
--

COMMENT ON TABLE corvis_control.data_rights IS 'Server-managed authoritative contractual data rights. Missing current rights fail closed; overlapping current rights are evaluated deny-wins by application authorization.';


--
-- Name: COLUMN data_rights.redistribution_allowed; Type: COMMENT; Schema: corvis_control; Owner: -
--

COMMENT ON COLUMN corvis_control.data_rights.redistribution_allowed IS 'Controls outbound redistribution/export independently from application RBAC.';


--
-- Name: COLUMN data_rights.source_document_access_allowed; Type: COMMENT; Schema: corvis_control; Owner: -
--

COMMENT ON COLUMN corvis_control.data_rights.source_document_access_allowed IS 'Controls access to underlying source evidence independently from client-visible derived data.';


--
-- Name: deletion_execution_evidence; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.deletion_execution_evidence (
    tenant_id uuid NOT NULL,
    deletion_request_id uuid NOT NULL,
    attempt integer NOT NULL,
    outcome text NOT NULL,
    evidence jsonb NOT NULL,
    evidence_hash text NOT NULL,
    recorded_by text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deletion_execution_evidence_attempt_check CHECK ((attempt >= 1)),
    CONSTRAINT deletion_execution_evidence_outcome_check CHECK ((outcome = ANY (ARRAY['completed'::text, 'blocked'::text, 'failed'::text])))
);

ALTER TABLE ONLY corvis_control.deletion_execution_evidence FORCE ROW LEVEL SECURITY;


--
-- Name: email_outbox; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.email_outbox (
    email_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    category text NOT NULL,
    recipient_user_id uuid,
    recipient_email text,
    workspace_id uuid,
    fund_id text,
    required_roles text[],
    template_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    dedupe_key text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    suppression_reason text,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone,
    digest_email_id uuid,
    provider_message_id text,
    last_error_class text,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT email_outbox_category_check CHECK ((category = ANY (ARRAY['invitation'::text, 'export_ready'::text, 'pinned_fund_published'::text, 'source_attention'::text, 'support_access'::text, 'role_changed'::text, 'digest'::text, 'data_issue_update'::text, 'review_discussion'::text, 'security_policy'::text, 'tenant_export_approval'::text, 'tenant_export_outcome'::text, 'export_schedule_failed'::text, 'service_account_expiry'::text, 'deletion_request_approval'::text]))),
    CONSTRAINT email_outbox_check CHECK (((recipient_user_id IS NULL) <> (recipient_email IS NULL))),
    CONSTRAINT email_outbox_check1 CHECK (((recipient_email IS NULL) OR (category = 'invitation'::text))),
    CONSTRAINT email_outbox_check2 CHECK (((status = 'suppressed'::text) = (suppression_reason IS NOT NULL))),
    CONSTRAINT email_outbox_check3 CHECK (((status = 'digested'::text) = (digest_email_id IS NOT NULL))),
    CONSTRAINT email_outbox_check4 CHECK (((status = 'sent'::text) = (sent_at IS NOT NULL))),
    CONSTRAINT email_outbox_dedupe_key_check CHECK (((length(dedupe_key) >= 1) AND (length(dedupe_key) <= 300))),
    CONSTRAINT email_outbox_recipient_email_check CHECK (((recipient_email IS NULL) OR ((recipient_email = lower(btrim(recipient_email))) AND ((length(recipient_email) >= 3) AND (length(recipient_email) <= 320))))),
    CONSTRAINT email_outbox_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sending'::text, 'retry'::text, 'digest_pending'::text, 'digested'::text, 'sent'::text, 'suppressed'::text, 'dead_letter'::text]))),
    CONSTRAINT email_outbox_suppression_reason_check CHECK (((suppression_reason IS NULL) OR (suppression_reason = ANY (ARRAY['opted_out'::text, 'no_verified_address'::text, 'not_eligible'::text, 'provider_not_configured'::text, 'app_url_not_configured'::text])))),
    CONSTRAINT email_outbox_template_params_check CHECK ((jsonb_typeof(template_params) = 'object'::text))
);

ALTER TABLE ONLY corvis_control.email_outbox FORCE ROW LEVEL SECURITY;


--
-- Name: event_inbox; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.event_inbox (
    tenant_id uuid NOT NULL,
    consumer_name text NOT NULL,
    event_id uuid NOT NULL,
    event_type text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    payload jsonb NOT NULL,
    payload_sha256 text NOT NULL,
    state text NOT NULL,
    delivery_count integer DEFAULT 1 NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    first_received_at timestamp with time zone DEFAULT now() NOT NULL,
    last_received_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    last_error text,
    CONSTRAINT event_inbox_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT event_inbox_delivery_count_check CHECK ((delivery_count > 0)),
    CONSTRAINT event_inbox_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT event_inbox_state_check CHECK ((state = ANY (ARRAY['received'::text, 'processing'::text, 'retryable'::text, 'complete'::text, 'failed'::text])))
);

ALTER TABLE ONLY corvis_control.event_inbox FORCE ROW LEVEL SECURITY;


--
-- Name: exception; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.exception (
    tenant_id uuid NOT NULL,
    exception_id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_id uuid,
    document_id uuid,
    observation_id uuid,
    code text NOT NULL,
    severity text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text
);

ALTER TABLE ONLY corvis_control.exception FORCE ROW LEVEL SECURITY;


--
-- Name: export_schedule_run; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.export_schedule_run (
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    trigger_key text NOT NULL,
    outcome text NOT NULL,
    export_id uuid,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT export_schedule_run_check CHECK (((outcome = 'requested'::text) = (export_id IS NOT NULL))),
    CONSTRAINT export_schedule_run_check1 CHECK (((outcome = 'failed'::text) = (failure_reason IS NOT NULL))),
    CONSTRAINT export_schedule_run_failure_reason_check CHECK (((failure_reason IS NULL) OR (failure_reason = ANY (ARRAY['owner_inactive'::text, 'export_permission_revoked'::text, 'redistribution_not_permitted'::text, 'scope_not_entitled'::text, 'scope_unavailable'::text, 'format_unavailable'::text])))),
    CONSTRAINT export_schedule_run_outcome_check CHECK ((outcome = ANY (ARRAY['requested'::text, 'failed'::text]))),
    CONSTRAINT export_schedule_run_trigger_key_check CHECK (((length(trigger_key) >= 1) AND (length(trigger_key) <= 200)))
);

ALTER TABLE ONLY corvis_control.export_schedule_run FORCE ROW LEVEL SECURITY;


--
-- Name: feature_flag; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.feature_flag (
    tenant_id uuid NOT NULL,
    flag_key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    kill_switch boolean DEFAULT false NOT NULL,
    configuration jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    owner text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retire_by timestamp with time zone,
    retired_at timestamp with time zone,
    retired_by text,
    kill_switch_reason text,
    kill_switch_at timestamp with time zone,
    kill_switch_by text
);

ALTER TABLE ONLY corvis_control.feature_flag FORCE ROW LEVEL SECURITY;


--
-- Name: feature_flag_emergency_stop; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.feature_flag_emergency_stop (
    tenant_id uuid NOT NULL,
    engaged boolean DEFAULT false NOT NULL,
    reason text,
    engaged_by text,
    engaged_at timestamp with time zone,
    released_by text,
    released_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY corvis_control.feature_flag_emergency_stop FORCE ROW LEVEL SECURITY;


--
-- Name: idempotency_key; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.idempotency_key (
    tenant_id uuid NOT NULL,
    scope text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    response_status integer,
    response_body jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT idempotency_key_check CHECK ((expires_at > created_at))
);

ALTER TABLE ONLY corvis_control.idempotency_key FORCE ROW LEVEL SECURITY;


--
-- Name: identity_lifecycle_event; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.identity_lifecycle_event (
    tenant_id uuid NOT NULL,
    lifecycle_event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_key text NOT NULL,
    request_hash text NOT NULL,
    operation text NOT NULL,
    auth_method text NOT NULL,
    subject text NOT NULL,
    user_id uuid NOT NULL,
    actor_subject text NOT NULL,
    actor_workspace_id uuid,
    reason text NOT NULL,
    desired_memberships jsonb DEFAULT '[]'::jsonb NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_lifecycle_event_actor_subject_check CHECK (((length(actor_subject) >= 1) AND (length(actor_subject) <= 1024))),
    CONSTRAINT identity_lifecycle_event_auth_method_check CHECK ((auth_method = ANY (ARRAY['oidc'::text, 'saml'::text]))),
    CONSTRAINT identity_lifecycle_event_desired_memberships_check CHECK ((jsonb_typeof(desired_memberships) = 'array'::text)),
    CONSTRAINT identity_lifecycle_event_event_key_check CHECK (((length(TRIM(BOTH FROM event_key)) >= 1) AND (length(TRIM(BOTH FROM event_key)) <= 256))),
    CONSTRAINT identity_lifecycle_event_operation_check CHECK ((operation = ANY (ARRAY['sync'::text, 'disable'::text]))),
    CONSTRAINT identity_lifecycle_event_reason_check CHECK (((length(TRIM(BOTH FROM reason)) >= 1) AND (length(TRIM(BOTH FROM reason)) <= 1000))),
    CONSTRAINT identity_lifecycle_event_request_hash_check CHECK ((length(request_hash) = 64)),
    CONSTRAINT identity_lifecycle_event_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.identity_lifecycle_event FORCE ROW LEVEL SECURITY;


--
-- Name: identity_subject; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.identity_subject (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    auth_method text NOT NULL,
    subject text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    CONSTRAINT identity_subject_auth_method_check CHECK ((auth_method = ANY (ARRAY['oidc'::text, 'saml'::text, 'service_account'::text]))),
    CONSTRAINT identity_subject_check CHECK ((((status = 'active'::text) AND (disabled_at IS NULL)) OR (status = 'disabled'::text))),
    CONSTRAINT identity_subject_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
    CONSTRAINT identity_subject_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.identity_subject FORCE ROW LEVEL SECURITY;


--
-- Name: legal_hold; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.legal_hold (
    legal_hold_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    data_class text,
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    matter_reference text NOT NULL,
    placed_by text NOT NULL,
    placed_at timestamp with time zone DEFAULT now() NOT NULL,
    released_by text,
    released_at timestamp with time zone,
    CONSTRAINT legal_hold_check CHECK (((released_at IS NULL) OR (released_at >= placed_at)))
);

ALTER TABLE ONLY corvis_control.legal_hold FORCE ROW LEVEL SECURITY;


--
-- Name: membership; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.membership (
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT membership_check CHECK (((valid_until IS NULL) OR (valid_until > valid_from))),
    CONSTRAINT membership_role_name_check CHECK ((role_name = ANY (ARRAY['tenant_admin'::text, 'accountadmin'::text, 'reviewer'::text, 'analyst'::text, 'viewer'::text]))),
    CONSTRAINT membership_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'revoked'::text])))
);

ALTER TABLE ONLY corvis_control.membership FORCE ROW LEVEL SECURITY;


--
-- Name: notification_preference; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.notification_preference (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    category text NOT NULL,
    enabled boolean NOT NULL,
    delivery text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_preference_category_check CHECK ((category = ANY (ARRAY['export_ready'::text, 'pinned_fund_published'::text, 'source_attention'::text, 'data_issue_update'::text, 'review_discussion'::text, 'tenant_export_outcome'::text, 'export_schedule_failed'::text]))),
    CONSTRAINT notification_preference_delivery_check CHECK ((delivery = ANY (ARRAY['immediate'::text, 'daily_digest'::text])))
);

ALTER TABLE ONLY corvis_control.notification_preference FORCE ROW LEVEL SECURITY;


--
-- Name: notification_recipient; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.notification_recipient (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    email text NOT NULL,
    source text NOT NULL,
    verified_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_recipient_email_check CHECK (((email = lower(btrim(email))) AND ((length(email) >= 3) AND (length(email) <= 320)))),
    CONSTRAINT notification_recipient_source_check CHECK ((source = ANY (ARRAY['verified_identity_claim'::text, 'accepted_invitation'::text])))
);

ALTER TABLE ONLY corvis_control.notification_recipient FORCE ROW LEVEL SECURITY;


--
-- Name: oidc_logout_token_use; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.oidc_logout_token_use (
    issuer text NOT NULL,
    jti text NOT NULL,
    used_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oidc_logout_token_use_issuer_check CHECK (((length(issuer) >= 1) AND (length(issuer) <= 2048))),
    CONSTRAINT oidc_logout_token_use_jti_check CHECK (((length(jti) >= 1) AND (length(jti) <= 256)))
);

ALTER TABLE ONLY corvis_control.oidc_logout_token_use FORCE ROW LEVEL SECURITY;


--
-- Name: outbox_event; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.outbox_event (
    tenant_id uuid NOT NULL,
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    transport_lease_token uuid,
    transport_lease_expires_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    transport_dead_lettered_at timestamp with time zone,
    webhook_fanout_completed_at timestamp with time zone,
    CONSTRAINT outbox_event_attempt_count_check CHECK ((attempt_count >= 0))
);

ALTER TABLE ONLY corvis_control.outbox_event FORCE ROW LEVEL SECURITY;


--
-- Name: processing_recovery_event; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.processing_recovery_event (
    tenant_id uuid NOT NULL,
    recovery_event_id uuid NOT NULL,
    job_id text NOT NULL,
    document_id uuid NOT NULL,
    stage text NOT NULL,
    action text NOT NULL,
    actor_subject text NOT NULL,
    reason_code text NOT NULL,
    note text,
    source_event_id uuid NOT NULL,
    source_job_version integer NOT NULL,
    source_attempt integer NOT NULL,
    source_max_attempts integer NOT NULL,
    recovery_count integer NOT NULL,
    result_job_version integer NOT NULL,
    before_state jsonb NOT NULL,
    after_state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT processing_recovery_event_action_check CHECK ((action = 'recover_dead_letter'::text)),
    CONSTRAINT processing_recovery_event_actor_subject_check CHECK ((btrim(actor_subject) <> ''::text)),
    CONSTRAINT processing_recovery_event_after_state_check CHECK ((jsonb_typeof(after_state) = 'object'::text)),
    CONSTRAINT processing_recovery_event_before_state_check CHECK ((jsonb_typeof(before_state) = 'object'::text)),
    CONSTRAINT processing_recovery_event_reason_code_check CHECK ((btrim(reason_code) <> ''::text)),
    CONSTRAINT processing_recovery_event_recovery_count_check CHECK ((recovery_count > 0)),
    CONSTRAINT processing_recovery_event_result_job_version_check CHECK ((result_job_version > 0)),
    CONSTRAINT processing_recovery_event_source_attempt_check CHECK ((source_attempt >= 0)),
    CONSTRAINT processing_recovery_event_source_job_version_check CHECK ((source_job_version > 0)),
    CONSTRAINT processing_recovery_event_source_max_attempts_check CHECK ((source_max_attempts > 0))
);

ALTER TABLE ONLY corvis_control.processing_recovery_event FORCE ROW LEVEL SECURITY;


--
-- Name: processing_stage_effect; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.processing_stage_effect (
    tenant_id uuid NOT NULL,
    job_id text NOT NULL,
    effect_key text NOT NULL,
    document_id uuid NOT NULL,
    stage text NOT NULL,
    state text NOT NULL,
    attempt_count integer DEFAULT 1 NOT NULL,
    first_started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    result jsonb,
    CONSTRAINT processing_stage_effect_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT processing_stage_effect_state_check CHECK ((state = ANY (ARRAY['started'::text, 'complete'::text])))
);

ALTER TABLE ONLY corvis_control.processing_stage_effect FORCE ROW LEVEL SECURITY;


--
-- Name: research_answer_pin; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.research_answer_pin (
    pin_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    auth_method text NOT NULL,
    subject text NOT NULL,
    question text NOT NULL,
    answer jsonb NOT NULL,
    asked_at timestamp with time zone NOT NULL,
    pinned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_answer_pin_auth_method_check CHECK ((auth_method = ANY (ARRAY['oidc'::text, 'saml'::text, 'service_account'::text]))),
    CONSTRAINT research_answer_pin_question_check CHECK (((length(question) >= 1) AND (length(question) <= 2000))),
    CONSTRAINT research_answer_pin_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.research_answer_pin FORCE ROW LEVEL SECURITY;


--
-- Name: resource_entitlement; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.resource_entitlement (
    entitlement_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_user_id uuid NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    permission text NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resource_entitlement_check CHECK (((valid_until IS NULL) OR (valid_until > valid_from))),
    CONSTRAINT resource_entitlement_permission_check CHECK ((permission = ANY (ARRAY['read'::text, 'review'::text, 'publish'::text, 'admin'::text])))
);

ALTER TABLE ONLY corvis_control.resource_entitlement FORCE ROW LEVEL SECURITY;


--
-- Name: retention_policy; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.retention_policy (
    tenant_id uuid NOT NULL,
    data_class text NOT NULL,
    retention_days integer,
    legal_hold boolean DEFAULT false NOT NULL,
    delete_on_termination boolean DEFAULT false NOT NULL,
    policy_version text NOT NULL,
    effective_from timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retention_policy_retention_days_check CHECK (((retention_days IS NULL) OR (retention_days >= 0)))
);

ALTER TABLE ONLY corvis_control.retention_policy FORCE ROW LEVEL SECURITY;


--
-- Name: review_item_comment_comment_seq_seq; Type: SEQUENCE; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.review_item_comment ALTER COLUMN comment_seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME corvis_control.review_item_comment_comment_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: semantic_query_log; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.semantic_query_log (
    tenant_id uuid NOT NULL,
    semantic_query_id text NOT NULL,
    actor_subject text NOT NULL,
    question_hash text NOT NULL,
    result_fact_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    result_row_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    query_shape jsonb DEFAULT '{}'::jsonb NOT NULL,
    completed_at timestamp with time zone,
    result_rows_sha256 text,
    CONSTRAINT semantic_query_log_result_row_count_check CHECK ((result_row_count >= 0)),
    CONSTRAINT semantic_query_log_result_rows_sha256_check CHECK (((result_rows_sha256 IS NULL) OR (result_rows_sha256 ~ '^[0-9a-f]{64}$'::text)))
);

ALTER TABLE ONLY corvis_control.semantic_query_log FORCE ROW LEVEL SECURITY;


--
-- Name: service_account_credential; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.service_account_credential (
    tenant_id uuid NOT NULL,
    credential_id uuid NOT NULL,
    service_account_id uuid NOT NULL,
    secret_sha256 text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by_subject text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_by_subject text,
    last_used_at timestamp with time zone,
    CONSTRAINT service_account_credential_check CHECK ((expires_at > created_at)),
    CONSTRAINT service_account_credential_check1 CHECK (((status = 'revoked'::text) = (revoked_at IS NOT NULL))),
    CONSTRAINT service_account_credential_check2 CHECK (((status = 'revoked'::text) = (revoked_by_subject IS NOT NULL))),
    CONSTRAINT service_account_credential_check3 CHECK (((status <> 'revoked'::text) OR (ends_at IS NOT NULL))),
    CONSTRAINT service_account_credential_created_by_subject_check CHECK (((length(created_by_subject) >= 1) AND (length(created_by_subject) <= 1024))),
    CONSTRAINT service_account_credential_revoked_by_subject_check CHECK (((revoked_by_subject IS NULL) OR ((length(revoked_by_subject) >= 1) AND (length(revoked_by_subject) <= 1024)))),
    CONSTRAINT service_account_credential_secret_sha256_check CHECK ((secret_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT service_account_credential_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);

ALTER TABLE ONLY corvis_control.service_account_credential FORCE ROW LEVEL SECURITY;


--
-- Name: service_identity_grant; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.service_identity_grant (
    tenant_id uuid NOT NULL,
    auth_method text DEFAULT 'service_account'::text NOT NULL,
    subject text NOT NULL,
    purpose text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_until timestamp with time zone NOT NULL,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL,
    next_review_at timestamp with time zone NOT NULL,
    reviewed_by_subject text NOT NULL,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_identity_grant_auth_method_check CHECK ((auth_method = 'service_account'::text)),
    CONSTRAINT service_identity_grant_check CHECK ((valid_until > valid_from)),
    CONSTRAINT service_identity_grant_check1 CHECK ((next_review_at > reviewed_at)),
    CONSTRAINT service_identity_grant_check2 CHECK ((next_review_at <= valid_until)),
    CONSTRAINT service_identity_grant_check3 CHECK ((((status = 'active'::text) AND (disabled_at IS NULL)) OR (status = 'disabled'::text))),
    CONSTRAINT service_identity_grant_purpose_check CHECK (((length(TRIM(BOTH FROM purpose)) >= 1) AND (length(TRIM(BOTH FROM purpose)) <= 512))),
    CONSTRAINT service_identity_grant_reviewed_by_subject_check CHECK (((length(reviewed_by_subject) >= 1) AND (length(reviewed_by_subject) <= 1024))),
    CONSTRAINT service_identity_grant_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
    CONSTRAINT service_identity_grant_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.service_identity_grant FORCE ROW LEVEL SECURITY;


--
-- Name: session_revocation; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.session_revocation (
    tenant_id uuid NOT NULL,
    auth_method text NOT NULL,
    subject text NOT NULL,
    session_id text NOT NULL,
    revoked_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_by_subject text NOT NULL,
    reason text NOT NULL,
    CONSTRAINT session_revocation_auth_method_check CHECK ((auth_method = ANY (ARRAY['oidc'::text, 'saml'::text, 'service_account'::text]))),
    CONSTRAINT session_revocation_reason_check CHECK (((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 1000))),
    CONSTRAINT session_revocation_revoked_by_subject_check CHECK (((length(revoked_by_subject) >= 1) AND (length(revoked_by_subject) <= 1024))),
    CONSTRAINT session_revocation_session_id_check CHECK (((length(session_id) >= 1) AND (length(session_id) <= 1024))),
    CONSTRAINT session_revocation_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.session_revocation FORCE ROW LEVEL SECURITY;


--
-- Name: support_access_grant; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.support_access_grant (
    tenant_id uuid NOT NULL,
    support_grant_id uuid DEFAULT gen_random_uuid() NOT NULL,
    auth_method text NOT NULL,
    subject text NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    role_name text NOT NULL,
    purpose text NOT NULL,
    approval_reference text NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_until timestamp with time zone NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    approved_by_subject text NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by_subject text,
    revoke_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    requires_tenant_ack boolean DEFAULT false NOT NULL,
    acknowledged_at timestamp with time zone,
    acknowledged_by_subject text,
    CONSTRAINT support_access_grant_approval_reference_check CHECK (((length(TRIM(BOTH FROM approval_reference)) >= 1) AND (length(TRIM(BOTH FROM approval_reference)) <= 1000))),
    CONSTRAINT support_access_grant_approved_by_subject_check CHECK (((length(approved_by_subject) >= 1) AND (length(approved_by_subject) <= 1024))),
    CONSTRAINT support_access_grant_auth_method_check CHECK ((auth_method = ANY (ARRAY['oidc'::text, 'saml'::text]))),
    CONSTRAINT support_access_grant_check CHECK ((valid_until > valid_from)),
    CONSTRAINT support_access_grant_purpose_check CHECK (((length(TRIM(BOTH FROM purpose)) >= 1) AND (length(TRIM(BOTH FROM purpose)) <= 1000))),
    CONSTRAINT support_access_grant_revocation_state_check CHECK ((((status = ANY (ARRAY['pending_ack'::text, 'active'::text])) AND (revoked_at IS NULL)) OR (status = 'revoked'::text))),
    CONSTRAINT support_access_grant_role_name_check CHECK ((role_name = ANY (ARRAY['tenant_admin'::text, 'accountadmin'::text, 'reviewer'::text, 'analyst'::text, 'viewer'::text]))),
    CONSTRAINT support_access_grant_status_check CHECK ((status = ANY (ARRAY['pending_ack'::text, 'active'::text, 'revoked'::text]))),
    CONSTRAINT support_access_grant_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.support_access_grant FORCE ROW LEVEL SECURITY;


--
-- Name: tenant; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant (
    tenant_id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'closed'::text])))
);

ALTER TABLE ONLY corvis_control.tenant FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_access_notification; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant_access_notification (
    tenant_id uuid NOT NULL,
    notification_id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    support_grant_id uuid NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    CONSTRAINT tenant_access_notification_kind_check CHECK ((kind = ANY (ARRAY['support_access_active'::text, 'support_access_pending_ack'::text]))),
    CONSTRAINT tenant_access_notification_message_check CHECK (((length(TRIM(BOTH FROM message)) >= 1) AND (length(TRIM(BOTH FROM message)) <= 2000))),
    CONSTRAINT tenant_access_notification_title_check CHECK (((length(TRIM(BOTH FROM title)) >= 1) AND (length(TRIM(BOTH FROM title)) <= 200)))
);

ALTER TABLE ONLY corvis_control.tenant_access_notification FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_export_download_grant; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant_export_download_grant (
    tenant_id uuid NOT NULL,
    grant_id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    subject text NOT NULL,
    token_sha256 text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_export_download_grant_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024))),
    CONSTRAINT tenant_export_download_grant_token_sha256_check CHECK ((token_sha256 ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY corvis_control.tenant_export_download_grant FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_export_request_event; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant_export_request_event (
    tenant_id uuid NOT NULL,
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_seq bigint NOT NULL,
    request_id uuid NOT NULL,
    event_type text NOT NULL,
    from_state text,
    to_state text NOT NULL,
    actor_subject text NOT NULL,
    note text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_export_request_event_event_type_check CHECK ((event_type = ANY (ARRAY['requested'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text, 'expired'::text, 'build_started'::text, 'build_retry_scheduled'::text, 'build_completed'::text, 'build_failed'::text, 'artifact_deleted'::text]))),
    CONSTRAINT tenant_export_request_event_from_state_check CHECK (((from_state IS NULL) OR (from_state = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'building'::text, 'complete'::text, 'failed'::text, 'rejected'::text, 'cancelled'::text, 'expired'::text])))),
    CONSTRAINT tenant_export_request_event_note_check CHECK (((note IS NULL) OR (length(note) <= 2000))),
    CONSTRAINT tenant_export_request_event_to_state_check CHECK ((to_state = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'building'::text, 'complete'::text, 'failed'::text, 'rejected'::text, 'cancelled'::text, 'expired'::text])))
);

ALTER TABLE ONLY corvis_control.tenant_export_request_event FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_export_request_event_event_seq_seq; Type: SEQUENCE; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_export_request_event ALTER COLUMN event_seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME corvis_control.tenant_export_request_event_event_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tenant_identity_provider; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant_identity_provider (
    tenant_id uuid NOT NULL,
    protocol text NOT NULL,
    issuer text NOT NULL,
    audience text NOT NULL,
    status text NOT NULL,
    enforce_token_binding boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by_subject text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    idp_enforces_mfa boolean,
    end_session_endpoint text,
    CONSTRAINT tenant_identity_provider_audience_check CHECK ((((length(audience) >= 1) AND (length(audience) <= 1024)) AND (audience !~ '[[:space:][:cntrl:]]'::text))),
    CONSTRAINT tenant_identity_provider_check CHECK (((protocol <> 'oidc'::text) OR ((issuer ~ '^https://[^/?#]+(/[^?#]*)?$'::text) AND (issuer !~ '/$'::text)))),
    CONSTRAINT tenant_identity_provider_check1 CHECK (((NOT enforce_token_binding) OR ((protocol = 'oidc'::text) AND (status = 'active'::text)))),
    CONSTRAINT tenant_identity_provider_end_session_endpoint_check CHECK (((end_session_endpoint IS NULL) OR (((length(end_session_endpoint) >= 1) AND (length(end_session_endpoint) <= 2048)) AND (end_session_endpoint ~ '^https://[^/?#@[:space:][:cntrl:]]+(/[^?#[:space:][:cntrl:]]*)?(\?[^#[:space:][:cntrl:]]*)?$'::text)))),
    CONSTRAINT tenant_identity_provider_issuer_check CHECK ((((length(issuer) >= 1) AND (length(issuer) <= 2048)) AND (issuer !~ '[[:space:][:cntrl:]]'::text))),
    CONSTRAINT tenant_identity_provider_protocol_check CHECK ((protocol = ANY (ARRAY['oidc'::text, 'saml'::text]))),
    CONSTRAINT tenant_identity_provider_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'disabled'::text]))),
    CONSTRAINT tenant_identity_provider_updated_by_subject_check CHECK (((length(updated_by_subject) >= 1) AND (length(updated_by_subject) <= 1024))),
    CONSTRAINT tenant_identity_provider_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY corvis_control.tenant_identity_provider FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_invitation; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant_invitation (
    invitation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    email text NOT NULL,
    role_name text NOT NULL,
    token_sha256 text NOT NULL,
    invited_by_subject text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_user_id uuid,
    revoked_at timestamp with time zone,
    CONSTRAINT tenant_invitation_check CHECK ((expires_at > created_at)),
    CONSTRAINT tenant_invitation_check1 CHECK (((status = 'accepted'::text) = (accepted_at IS NOT NULL))),
    CONSTRAINT tenant_invitation_check2 CHECK (((status = 'accepted'::text) = (accepted_user_id IS NOT NULL))),
    CONSTRAINT tenant_invitation_check3 CHECK (((status = 'revoked'::text) = (revoked_at IS NOT NULL))),
    CONSTRAINT tenant_invitation_email_check CHECK (((email = lower(btrim(email))) AND ((length(email) >= 3) AND (length(email) <= 320)))),
    CONSTRAINT tenant_invitation_role_name_check CHECK ((role_name = ANY (ARRAY['tenant_admin'::text, 'accountadmin'::text, 'reviewer'::text, 'analyst'::text, 'viewer'::text]))),
    CONSTRAINT tenant_invitation_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text, 'expired'::text]))),
    CONSTRAINT tenant_invitation_token_sha256_check CHECK ((token_sha256 ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY corvis_control.tenant_invitation FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_scim_configuration; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant_scim_configuration (
    tenant_id uuid NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    token_sha256 text NOT NULL,
    auth_method text NOT NULL,
    default_workspace_id uuid NOT NULL,
    default_role_name text NOT NULL,
    updated_by_subject text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_scim_configuration_auth_method_check CHECK ((auth_method = ANY (ARRAY['oidc'::text, 'saml'::text]))),
    CONSTRAINT tenant_scim_configuration_default_role_name_check CHECK ((default_role_name = ANY (ARRAY['accountadmin'::text, 'reviewer'::text, 'analyst'::text, 'viewer'::text]))),
    CONSTRAINT tenant_scim_configuration_token_sha256_check CHECK ((token_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tenant_scim_configuration_updated_by_subject_check CHECK (((length(updated_by_subject) >= 1) AND (length(updated_by_subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.tenant_scim_configuration FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_scim_identity; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant_scim_identity (
    tenant_id uuid NOT NULL,
    scim_user_id uuid DEFAULT gen_random_uuid() NOT NULL,
    external_id text NOT NULL,
    user_id uuid NOT NULL,
    auth_method text NOT NULL,
    subject text NOT NULL,
    user_name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_scim_identity_auth_method_check CHECK ((auth_method = ANY (ARRAY['oidc'::text, 'saml'::text]))),
    CONSTRAINT tenant_scim_identity_external_id_check CHECK (((length(TRIM(BOTH FROM external_id)) >= 1) AND (length(TRIM(BOTH FROM external_id)) <= 1024))),
    CONSTRAINT tenant_scim_identity_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024))),
    CONSTRAINT tenant_scim_identity_user_name_check CHECK (((length(TRIM(BOTH FROM user_name)) >= 1) AND (length(TRIM(BOTH FROM user_name)) <= 320)))
);

ALTER TABLE ONLY corvis_control.tenant_scim_identity FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_session_activity; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant_session_activity (
    tenant_id uuid NOT NULL,
    auth_method text NOT NULL,
    subject text NOT NULL,
    session_id text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    mfa_used boolean,
    CONSTRAINT tenant_session_activity_auth_method_check CHECK ((auth_method = ANY (ARRAY['oidc'::text, 'saml'::text]))),
    CONSTRAINT tenant_session_activity_check CHECK ((last_seen_at >= first_seen_at)),
    CONSTRAINT tenant_session_activity_session_id_check CHECK (((length(session_id) >= 1) AND (length(session_id) <= 1024))),
    CONSTRAINT tenant_session_activity_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.tenant_session_activity FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_verified_domain; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.tenant_verified_domain (
    tenant_id uuid NOT NULL,
    domain text NOT NULL,
    verification_method text NOT NULL,
    evidence text NOT NULL,
    verified_by_subject text NOT NULL,
    verified_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_verified_domain_domain_check CHECK ((((length(domain) >= 4) AND (length(domain) <= 253)) AND (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'::text))),
    CONSTRAINT tenant_verified_domain_evidence_check CHECK (((length(btrim(evidence)) >= 3) AND (length(btrim(evidence)) <= 1000))),
    CONSTRAINT tenant_verified_domain_verification_method_check CHECK ((verification_method = ANY (ARRAY['dns_txt'::text, 'operator_attested'::text]))),
    CONSTRAINT tenant_verified_domain_verified_by_subject_check CHECK (((length(verified_by_subject) >= 1) AND (length(verified_by_subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.tenant_verified_domain FORCE ROW LEVEL SECURITY;


--
-- Name: webhook_delivery; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.webhook_delivery (
    tenant_id uuid NOT NULL,
    delivery_id uuid DEFAULT gen_random_uuid() NOT NULL,
    webhook_id uuid NOT NULL,
    event_id uuid NOT NULL,
    attempt integer NOT NULL,
    status_code integer,
    state text NOT NULL,
    next_attempt_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    last_error text,
    CONSTRAINT webhook_delivery_attempt_check CHECK ((attempt > 0)),
    CONSTRAINT webhook_delivery_state_check CHECK ((state = ANY (ARRAY['delivering'::text, 'complete'::text, 'retryable'::text, 'failed'::text])))
);

ALTER TABLE ONLY corvis_control.webhook_delivery FORCE ROW LEVEL SECURITY;


--
-- Name: webhook_signing_key; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.webhook_signing_key (
    tenant_id uuid NOT NULL,
    webhook_id uuid NOT NULL,
    key_id uuid DEFAULT gen_random_uuid() NOT NULL,
    secret text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    retire_by timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT webhook_signing_key_secret_check CHECK ((length(secret) >= 32)),
    CONSTRAINT webhook_signing_key_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retiring'::text, 'revoked'::text])))
);

ALTER TABLE ONLY corvis_control.webhook_signing_key FORCE ROW LEVEL SECURITY;


--
-- Name: webhook_subscription; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.webhook_subscription (
    tenant_id uuid NOT NULL,
    webhook_id uuid DEFAULT gen_random_uuid() NOT NULL,
    endpoint_url text NOT NULL,
    event_types text[] NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    paused_at timestamp with time zone,
    paused_by text,
    revoked_at timestamp with time zone,
    revoked_by text,
    CONSTRAINT webhook_subscription_customer_event_types CHECK (((event_types <@ ARRAY['SnapshotPublicationChanged'::text, 'DataCorrectionOpened'::text, 'DataCorrectionResolved'::text, 'CorrectionReplacementDeliveryRequested'::text, 'ExportRequested'::text, 'ExportScheduleRunCompleted'::text, 'ExportScheduleRunFailed'::text]) AND ((status <> 'active'::text) OR (cardinality(event_types) > 0)))),
    CONSTRAINT webhook_subscription_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'revoked'::text])))
);

ALTER TABLE ONLY corvis_control.webhook_subscription FORCE ROW LEVEL SECURITY;


--
-- Name: workspace; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.workspace (
    workspace_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'closed'::text])))
);

ALTER TABLE ONLY corvis_control.workspace FORCE ROW LEVEL SECURITY;


--
-- Name: workspace_user_preference; Type: TABLE; Schema: corvis_control; Owner: -
--

CREATE TABLE corvis_control.workspace_user_preference (
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    auth_method text NOT NULL,
    subject text NOT NULL,
    pinned_fund_ids text[] DEFAULT '{}'::text[] NOT NULL,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    display_preferences jsonb,
    saved_views jsonb DEFAULT '[]'::jsonb NOT NULL,
    view_defaults jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT display_preferences_object CHECK (((display_preferences IS NULL) OR (jsonb_typeof(display_preferences) = 'object'::text))),
    CONSTRAINT saved_views_array CHECK (((jsonb_typeof(saved_views) = 'array'::text) AND (jsonb_array_length(saved_views) <= 100))),
    CONSTRAINT view_defaults_object CHECK ((jsonb_typeof(view_defaults) = 'object'::text)),
    CONSTRAINT workspace_user_preference_auth_method_check CHECK ((auth_method = ANY (ARRAY['oidc'::text, 'saml'::text, 'service_account'::text]))),
    CONSTRAINT workspace_user_preference_pinned_fund_ids_check CHECK ((cardinality(pinned_fund_ids) <= 100)),
    CONSTRAINT workspace_user_preference_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 1024)))
);

ALTER TABLE ONLY corvis_control.workspace_user_preference FORCE ROW LEVEL SECURITY;


--
-- Name: canonical_candidate; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.canonical_candidate (
    tenant_id uuid NOT NULL,
    canonicalization_run_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    candidate_key text NOT NULL,
    candidate_type text NOT NULL,
    review_policy_version text NOT NULL,
    candidate_fingerprint_sha256 text NOT NULL,
    candidate_set_sha256 text NOT NULL,
    decision_set_sha256 text NOT NULL,
    original_payload jsonb NOT NULL,
    effective_payload jsonb NOT NULL,
    confidence jsonb NOT NULL,
    provenance jsonb NOT NULL,
    exception_codes jsonb NOT NULL,
    correction_review_event_id uuid,
    source_reference_ids uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT canonical_candidate_candidate_fingerprint_sha256_check CHECK ((candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT canonical_candidate_candidate_set_sha256_check CHECK ((candidate_set_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT canonical_candidate_confidence_check CHECK ((jsonb_typeof(confidence) = 'object'::text)),
    CONSTRAINT canonical_candidate_decision_set_sha256_check CHECK ((decision_set_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT canonical_candidate_effective_payload_check CHECK ((jsonb_typeof(effective_payload) = 'object'::text)),
    CONSTRAINT canonical_candidate_exception_codes_check CHECK ((jsonb_typeof(exception_codes) = 'array'::text)),
    CONSTRAINT canonical_candidate_original_payload_check CHECK ((jsonb_typeof(original_payload) = 'object'::text)),
    CONSTRAINT canonical_candidate_provenance_check CHECK ((jsonb_typeof(provenance) = 'object'::text)),
    CONSTRAINT canonical_candidate_source_reference_ids_check CHECK ((cardinality(source_reference_ids) > 0))
);

ALTER TABLE ONLY corvis_facts.canonical_candidate FORCE ROW LEVEL SECURITY;


--
-- Name: canonicalization_run; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.canonicalization_run (
    tenant_id uuid NOT NULL,
    canonicalization_run_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    document_id uuid NOT NULL,
    review_policy_version text NOT NULL,
    candidate_set_sha256 text NOT NULL,
    decision_set_sha256 text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL,
    candidate_count integer NOT NULL,
    canonical_candidate_count integer,
    observation_count integer,
    source_reference_count integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT canonicalization_run_candidate_count_check CHECK ((candidate_count >= 0)),
    CONSTRAINT canonicalization_run_candidate_set_sha256_check CHECK ((candidate_set_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT canonicalization_run_canonical_candidate_count_check CHECK (((canonical_candidate_count IS NULL) OR (canonical_candidate_count >= 0))),
    CONSTRAINT canonicalization_run_check CHECK ((((status = 'writing'::text) AND (completed_at IS NULL)) OR ((status = 'ready'::text) AND (completed_at IS NOT NULL) AND (canonical_candidate_count IS NOT NULL) AND (observation_count IS NOT NULL) AND (source_reference_count IS NOT NULL)))),
    CONSTRAINT canonicalization_run_decision_set_sha256_check CHECK ((decision_set_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT canonicalization_run_idempotency_key_check CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT canonicalization_run_observation_count_check CHECK (((observation_count IS NULL) OR (observation_count >= 0))),
    CONSTRAINT canonicalization_run_source_reference_count_check CHECK (((source_reference_count IS NULL) OR (source_reference_count >= 0))),
    CONSTRAINT canonicalization_run_status_check CHECK ((status = ANY (ARRAY['writing'::text, 'ready'::text])))
);

ALTER TABLE ONLY corvis_facts.canonicalization_run FORCE ROW LEVEL SECURITY;


--
-- Name: client_portfolio; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.client_portfolio (
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    portfolio_id uuid DEFAULT gen_random_uuid() NOT NULL,
    portfolio_key text NOT NULL,
    display_name text NOT NULL,
    base_currency text,
    external_portfolio_id text,
    status text DEFAULT 'active'::text NOT NULL,
    valid_from date,
    valid_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT client_portfolio_check CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT client_portfolio_display_name_check CHECK ((btrim(display_name) <> ''::text)),
    CONSTRAINT client_portfolio_portfolio_key_check CHECK ((btrim(portfolio_key) <> ''::text)),
    CONSTRAINT client_portfolio_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'archived'::text])))
);

ALTER TABLE ONLY corvis_facts.client_portfolio FORCE ROW LEVEL SECURITY;


--
-- Name: client_portfolio_fund_position; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.client_portfolio_fund_position (
    tenant_id uuid NOT NULL,
    portfolio_fund_position_id uuid DEFAULT gen_random_uuid() NOT NULL,
    portfolio_id uuid NOT NULL,
    position_key text NOT NULL,
    fund_id text NOT NULL,
    position_label text,
    external_position_id text,
    valid_from date,
    valid_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT client_portfolio_fund_position_check CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT client_portfolio_fund_position_position_key_check CHECK ((btrim(position_key) <> ''::text))
);

ALTER TABLE ONLY corvis_facts.client_portfolio_fund_position FORCE ROW LEVEL SECURITY;


--
-- Name: company_sector_classification; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.company_sector_classification (
    tenant_id uuid NOT NULL,
    classification_id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id text NOT NULL,
    taxonomy_version text NOT NULL,
    sector_code text NOT NULL,
    basis text NOT NULL,
    version integer NOT NULL,
    reason text NOT NULL,
    classified_by text NOT NULL,
    classified_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT company_sector_classification_basis_check CHECK ((basis = 'reviewer_assigned'::text)),
    CONSTRAINT company_sector_classification_check CHECK (((superseded_at IS NULL) OR (superseded_at >= classified_at))),
    CONSTRAINT company_sector_classification_classified_by_check CHECK ((btrim(classified_by) <> ''::text)),
    CONSTRAINT company_sector_classification_reason_check CHECK ((btrim(reason) <> ''::text)),
    CONSTRAINT company_sector_classification_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY corvis_facts.company_sector_classification FORCE ROW LEVEL SECURITY;


--
-- Name: holding; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.holding (
    tenant_id uuid NOT NULL,
    holding_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_id text NOT NULL,
    target_type text NOT NULL,
    target_company_id text,
    target_fund_id text,
    status text,
    investment_date date,
    strategy text,
    geography text,
    source_reference_id uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    review_state text DEFAULT 'review_required'::text NOT NULL,
    valid_from date,
    valid_to date,
    CONSTRAINT holding_check CHECK ((((target_type = 'company'::text) AND (target_company_id IS NOT NULL)) OR ((target_type = 'fund'::text) AND (target_fund_id IS NOT NULL)) OR (target_type = 'other'::text))),
    CONSTRAINT holding_exact_target_check CHECK ((((target_type = 'company'::text) AND (target_company_id IS NOT NULL) AND (target_fund_id IS NULL)) OR ((target_type = 'fund'::text) AND (target_fund_id IS NOT NULL) AND (target_company_id IS NULL)))),
    CONSTRAINT holding_review_state_check CHECK ((review_state = ANY (ARRAY['review_required'::text, 'approved'::text, 'rejected'::text, 'superseded'::text]))),
    CONSTRAINT holding_target_type_check CHECK ((target_type = ANY (ARRAY['company'::text, 'fund'::text, 'other'::text]))),
    CONSTRAINT holding_target_type_governed_check CHECK ((target_type = ANY (ARRAY['company'::text, 'fund'::text]))),
    CONSTRAINT holding_valid_range_check CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT holding_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY corvis_facts.holding FORCE ROW LEVEL SECURITY;


--
-- Name: holding_revision; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.holding_revision (
    tenant_id uuid NOT NULL,
    holding_id uuid NOT NULL,
    canonicalization_run_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    candidate_fingerprint_sha256 text NOT NULL,
    effective_payload jsonb NOT NULL,
    source_reference_ids uuid[] NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT holding_revision_candidate_fingerprint_sha256_check CHECK ((candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT holding_revision_effective_payload_check CHECK ((jsonb_typeof(effective_payload) = 'object'::text)),
    CONSTRAINT holding_revision_source_reference_ids_check CHECK ((cardinality(source_reference_ids) > 0))
);

ALTER TABLE ONLY corvis_facts.holding_revision FORCE ROW LEVEL SECURITY;


--
-- Name: instrument; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.instrument (
    tenant_id uuid NOT NULL,
    instrument_id uuid DEFAULT gen_random_uuid() NOT NULL,
    holding_id uuid NOT NULL,
    instrument_type text NOT NULL,
    security_name text,
    currency text,
    seniority text,
    maturity_date date,
    coupon_rate numeric(18,8),
    source_reference_id uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    review_state text DEFAULT 'review_required'::text NOT NULL,
    CONSTRAINT instrument_review_state_check CHECK ((review_state = ANY (ARRAY['review_required'::text, 'approved'::text, 'rejected'::text, 'superseded'::text]))),
    CONSTRAINT instrument_security_name_required_check CHECK (((security_name IS NOT NULL) AND (btrim(security_name) <> ''::text))),
    CONSTRAINT instrument_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY corvis_facts.instrument FORCE ROW LEVEL SECURITY;


--
-- Name: instrument_revision; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.instrument_revision (
    tenant_id uuid NOT NULL,
    instrument_id uuid NOT NULL,
    canonicalization_run_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    candidate_fingerprint_sha256 text NOT NULL,
    effective_payload jsonb NOT NULL,
    source_reference_ids uuid[] NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT instrument_revision_candidate_fingerprint_sha256_check CHECK ((candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT instrument_revision_effective_payload_check CHECK ((jsonb_typeof(effective_payload) = 'object'::text)),
    CONSTRAINT instrument_revision_source_reference_ids_check CHECK ((cardinality(source_reference_ids) > 0))
);

ALTER TABLE ONLY corvis_facts.instrument_revision FORCE ROW LEVEL SECURITY;


--
-- Name: observation; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.observation (
    tenant_id uuid NOT NULL,
    observation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_id text NOT NULL,
    company_id text,
    holding_id text,
    instrument_id text,
    metric_code text NOT NULL,
    value_number numeric(38,10),
    value_string text,
    currency text,
    economic_period text,
    report_date date,
    actuality text,
    review_state text DEFAULT 'review_required'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    source_reference_id uuid NOT NULL,
    extraction_run_id text,
    schema_version text NOT NULL,
    skill_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    confidence_score double precision,
    delta_display text,
    risk_tier text DEFAULT 'normal'::text NOT NULL,
    canonicalization_run_id uuid,
    candidate_id uuid,
    candidate_key text,
    candidate_fingerprint_sha256 text,
    candidate_set_sha256 text,
    decision_set_sha256 text,
    review_policy_version text,
    subject_type text,
    subject_level text,
    value_raw text,
    value_qualifier text,
    unit text,
    reported_multiplier text,
    source_precision text,
    period_type text,
    period_start date,
    period_end date,
    as_of_date date,
    scenario_type text,
    is_adjusted boolean,
    adjustment_note text,
    valuation_method text,
    breakdown_category text,
    breakdown_value text,
    lookthrough_source text,
    is_derived boolean,
    derivation_formula text,
    is_restated boolean,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT observation_check CHECK (((value_number IS NOT NULL) OR (value_string IS NOT NULL))),
    CONSTRAINT observation_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY corvis_facts.observation FORCE ROW LEVEL SECURITY;


--
-- Name: observation_correction; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.observation_correction (
    tenant_id uuid NOT NULL,
    correction_id uuid DEFAULT gen_random_uuid() NOT NULL,
    observation_id uuid NOT NULL,
    based_on_observation_version integer NOT NULL,
    corrected_value_string text,
    corrected_value_number numeric(38,10),
    reason_code text NOT NULL,
    actor_subject text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT observation_correction_based_on_observation_version_check CHECK ((based_on_observation_version > 0)),
    CONSTRAINT observation_correction_check CHECK (((corrected_value_string IS NOT NULL) OR (corrected_value_number IS NOT NULL)))
);

ALTER TABLE ONLY corvis_facts.observation_correction FORCE ROW LEVEL SECURITY;


--
-- Name: observation_source_reference; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.observation_source_reference (
    tenant_id uuid NOT NULL,
    observation_id uuid NOT NULL,
    source_reference_id uuid NOT NULL,
    ordinal integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT observation_source_reference_ordinal_check CHECK ((ordinal > 0))
);

ALTER TABLE ONLY corvis_facts.observation_source_reference FORCE ROW LEVEL SECURITY;


--
-- Name: position_financial_statement; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.position_financial_statement (
    tenant_id uuid NOT NULL,
    statement_id uuid NOT NULL,
    canonicalization_run_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    document_id uuid NOT NULL,
    fund_id text NOT NULL,
    holding_id text NOT NULL,
    company_id text NOT NULL,
    statement_type text NOT NULL,
    statement_key text NOT NULL,
    source_title text,
    report_period text NOT NULL,
    source_document_period_end date,
    source_version_status text,
    review_policy_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT position_financial_statement_report_period_check CHECK ((btrim(report_period) <> ''::text)),
    CONSTRAINT position_financial_statement_statement_key_check CHECK ((btrim(statement_key) <> ''::text)),
    CONSTRAINT position_financial_statement_statement_type_check CHECK ((statement_type = ANY (ARRAY['income_statement'::text, 'balance_sheet'::text, 'cash_flow_statement'::text, 'statement_of_equity'::text, 'other'::text])))
);

ALTER TABLE ONLY corvis_facts.position_financial_statement FORCE ROW LEVEL SECURITY;


--
-- Name: position_financial_statement_line; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.position_financial_statement_line (
    tenant_id uuid NOT NULL,
    statement_id uuid NOT NULL,
    line_id uuid NOT NULL,
    line_key text NOT NULL,
    semantic_line_key text NOT NULL,
    source_label text NOT NULL,
    metric_code text,
    line_role text DEFAULT 'line_item'::text NOT NULL,
    parent_line_key text,
    display_order integer NOT NULL,
    depth integer DEFAULT 0 NOT NULL,
    source_reference_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT position_financial_statement_line_depth_check CHECK ((depth >= 0)),
    CONSTRAINT position_financial_statement_line_display_order_check CHECK ((display_order >= 0)),
    CONSTRAINT position_financial_statement_line_line_key_check CHECK ((btrim(line_key) <> ''::text)),
    CONSTRAINT position_financial_statement_line_line_role_check CHECK ((line_role = ANY (ARRAY['line_item'::text, 'subtotal'::text, 'total'::text, 'header'::text, 'memorandum'::text, 'other'::text]))),
    CONSTRAINT position_financial_statement_line_semantic_line_key_check CHECK ((btrim(semantic_line_key) <> ''::text)),
    CONSTRAINT position_financial_statement_line_source_label_check CHECK ((btrim(source_label) <> ''::text))
);

ALTER TABLE ONLY corvis_facts.position_financial_statement_line FORCE ROW LEVEL SECURITY;


--
-- Name: position_financial_statement_value; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.position_financial_statement_value (
    tenant_id uuid NOT NULL,
    statement_id uuid NOT NULL,
    line_id uuid NOT NULL,
    value_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    candidate_type text NOT NULL,
    value_raw text,
    value_number numeric(38,10),
    value_string text,
    value_qualifier text,
    currency text,
    unit text,
    reported_multiplier text,
    source_precision text,
    value_nature text,
    period_type text,
    period_start date,
    period_end date,
    as_of_date date,
    fiscal_year integer,
    fiscal_quarter integer,
    source_document_period_end date,
    source_column_label text,
    actuality text,
    scenario_type text,
    source_version_status text,
    preliminary boolean DEFAULT false NOT NULL,
    is_restatement boolean DEFAULT false NOT NULL,
    is_re_reported_prior_period boolean DEFAULT false NOT NULL,
    is_derived boolean DEFAULT false NOT NULL,
    derivation_formula text,
    source_reference_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT position_financial_statement_value_check CHECK (((value_number IS NOT NULL) OR (value_string IS NOT NULL) OR (value_raw IS NOT NULL))),
    CONSTRAINT position_financial_statement_value_fiscal_quarter_check CHECK (((fiscal_quarter IS NULL) OR ((fiscal_quarter >= 1) AND (fiscal_quarter <= 4))))
);

ALTER TABLE ONLY corvis_facts.position_financial_statement_value FORCE ROW LEVEL SECURITY;


--
-- Name: review_event; Type: TABLE; Schema: corvis_facts; Owner: -
--

CREATE TABLE corvis_facts.review_event (
    tenant_id uuid NOT NULL,
    review_event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    observation_id uuid NOT NULL,
    actor_subject text NOT NULL,
    decision text NOT NULL,
    reason_code text NOT NULL,
    before_value jsonb,
    after_value jsonb,
    observation_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY corvis_facts.review_event FORCE ROW LEVEL SECURITY;


--
-- Name: company; Type: TABLE; Schema: corvis_identity; Owner: -
--

CREATE TABLE corvis_identity.company (
    global_company_id text NOT NULL,
    canonical_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: entity_external_identifier; Type: TABLE; Schema: corvis_identity; Owner: -
--

CREATE TABLE corvis_identity.entity_external_identifier (
    entity_external_identifier_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_id text,
    company_id text,
    identifier_type text NOT NULL,
    identifier_value text NOT NULL,
    issuer text,
    jurisdiction text,
    is_current boolean DEFAULT true NOT NULL,
    valid_from date,
    valid_to date,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_external_identifier_check CHECK (((
CASE
    WHEN (fund_id IS NULL) THEN 0
    ELSE 1
END +
CASE
    WHEN (company_id IS NULL) THEN 0
    ELSE 1
END) = 1)),
    CONSTRAINT entity_external_identifier_check1 CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT entity_external_identifier_identifier_type_check CHECK ((identifier_type = ANY (ARRAY['lei'::text, 'cik'::text, 'company_registry'::text, 'ticker'::text, 'isin'::text, 'sedol'::text, 'cusip'::text, 'vendor_id'::text, 'gp_or_admin_id'::text, 'other'::text]))),
    CONSTRAINT entity_external_identifier_identifier_value_check CHECK ((btrim(identifier_value) <> ''::text))
);


--
-- Name: entity_lifecycle_event; Type: TABLE; Schema: corvis_identity; Owner: -
--

CREATE TABLE corvis_identity.entity_lifecycle_event (
    lifecycle_event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    event_status text DEFAULT 'completed'::text NOT NULL,
    announced_date date,
    effective_date date,
    closed_date date,
    event_subtype_raw text,
    description text,
    source_kind text DEFAULT 'governed'::text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_lifecycle_event_check CHECK (((closed_date IS NULL) OR (effective_date IS NULL) OR (closed_date >= effective_date))),
    CONSTRAINT entity_lifecycle_event_event_status_check CHECK ((event_status = ANY (ARRAY['announced'::text, 'pending'::text, 'completed'::text, 'cancelled'::text, 'unknown'::text]))),
    CONSTRAINT entity_lifecycle_event_event_type_check CHECK ((event_type = ANY (ARRAY['rename'::text, 'acquisition'::text, 'merger'::text, 'demerger'::text, 'split'::text, 'spin_off'::text, 'carve_out'::text, 'partial_divestiture'::text, 'reorganization'::text, 'legal_form_change'::text, 'domicile_change'::text, 'formation'::text, 'dissolution'::text, 'liquidation'::text, 'fund_restructure'::text, 'manager_change'::text, 'listing'::text, 'delisting'::text, 'take_private'::text, 'successor_transition'::text, 'other'::text]))),
    CONSTRAINT entity_lifecycle_event_source_kind_check CHECK ((source_kind = ANY (ARRAY['governed'::text, 'public_registry'::text, 'tenant_evidence'::text, 'manual'::text, 'other'::text])))
);


--
-- Name: entity_lifecycle_participant; Type: TABLE; Schema: corvis_identity; Owner: -
--

CREATE TABLE corvis_identity.entity_lifecycle_participant (
    lifecycle_event_id uuid NOT NULL,
    fund_id text,
    company_id text,
    participant_role text NOT NULL,
    economic_identity_continues boolean,
    ownership_before numeric(9,6),
    ownership_after numeric(9,6),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    participant_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT entity_lifecycle_participant_check CHECK (((
CASE
    WHEN (fund_id IS NULL) THEN 0
    ELSE 1
END +
CASE
    WHEN (company_id IS NULL) THEN 0
    ELSE 1
END) = 1)),
    CONSTRAINT entity_lifecycle_participant_ownership_after_check CHECK (((ownership_after IS NULL) OR ((ownership_after >= (0)::numeric) AND (ownership_after <= (1)::numeric)))),
    CONSTRAINT entity_lifecycle_participant_ownership_before_check CHECK (((ownership_before IS NULL) OR ((ownership_before >= (0)::numeric) AND (ownership_before <= (1)::numeric)))),
    CONSTRAINT entity_lifecycle_participant_participant_role_check CHECK ((participant_role = ANY (ARRAY['subject'::text, 'predecessor'::text, 'successor'::text, 'acquirer'::text, 'acquired'::text, 'surviving_entity'::text, 'merged_constituent'::text, 'source_entity'::text, 'resulting_entity'::text, 'parent'::text, 'child'::text, 'seller'::text, 'buyer'::text, 'transferred_entity'::text, 'other'::text])))
);


--
-- Name: entity_name; Type: TABLE; Schema: corvis_identity; Owner: -
--

CREATE TABLE corvis_identity.entity_name (
    entity_name_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_id text,
    company_id text,
    name text NOT NULL,
    normalized_name text GENERATED ALWAYS AS (corvis_identity.normalize_entity_name(name)) STORED,
    name_kind text NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    valid_from date,
    valid_to date,
    source_kind text DEFAULT 'governed'::text NOT NULL,
    source_note text,
    recorded_by text DEFAULT 'system'::text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_name_check CHECK (((
CASE
    WHEN (fund_id IS NULL) THEN 0
    ELSE 1
END +
CASE
    WHEN (company_id IS NULL) THEN 0
    ELSE 1
END) = 1)),
    CONSTRAINT entity_name_check1 CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT entity_name_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT entity_name_name_kind_check CHECK ((name_kind = ANY (ARRAY['canonical'::text, 'legal'::text, 'trading'::text, 'marketed'::text, 'abbreviation'::text, 'program_code'::text, 'codename'::text, 'other'::text]))),
    CONSTRAINT entity_name_source_kind_check CHECK ((source_kind = ANY (ARRAY['governed'::text, 'public_registry'::text, 'manual_migration'::text, 'other'::text])))
);


--
-- Name: entity_relationship; Type: TABLE; Schema: corvis_identity; Owner: -
--

CREATE TABLE corvis_identity.entity_relationship (
    entity_relationship_id uuid DEFAULT gen_random_uuid() NOT NULL,
    relationship_type text NOT NULL,
    source_fund_id text,
    source_company_id text,
    target_fund_id text,
    target_company_id text,
    lifecycle_event_id uuid,
    relationship_status text DEFAULT 'active'::text NOT NULL,
    valid_from date,
    valid_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_relationship_check CHECK (((
CASE
    WHEN (source_fund_id IS NULL) THEN 0
    ELSE 1
END +
CASE
    WHEN (source_company_id IS NULL) THEN 0
    ELSE 1
END) = 1)),
    CONSTRAINT entity_relationship_check1 CHECK (((
CASE
    WHEN (target_fund_id IS NULL) THEN 0
    ELSE 1
END +
CASE
    WHEN (target_company_id IS NULL) THEN 0
    ELSE 1
END) = 1)),
    CONSTRAINT entity_relationship_check2 CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT entity_relationship_check3 CHECK ((NOT ((source_fund_id IS NOT NULL) AND (source_fund_id = target_fund_id)))),
    CONSTRAINT entity_relationship_check4 CHECK ((NOT ((source_company_id IS NOT NULL) AND (source_company_id = target_company_id)))),
    CONSTRAINT entity_relationship_relationship_status_check CHECK ((relationship_status = ANY (ARRAY['planned'::text, 'active'::text, 'historical'::text, 'cancelled'::text, 'unknown'::text]))),
    CONSTRAINT entity_relationship_relationship_type_check CHECK ((relationship_type = ANY (ARRAY['successor_of'::text, 'merged_into'::text, 'acquired_by'::text, 'parent_of'::text, 'subsidiary_of'::text, 'spun_off_from'::text, 'carved_out_from'::text, 'reorganized_from'::text, 'related_vehicle'::text, 'other'::text])))
);


--
-- Name: fund; Type: TABLE; Schema: corvis_identity; Owner: -
--

CREATE TABLE corvis_identity.fund (
    global_fund_id text NOT NULL,
    canonical_name text NOT NULL,
    manager_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenant_entity_lifecycle_evidence; Type: TABLE; Schema: corvis_identity; Owner: -
--

CREATE TABLE corvis_identity.tenant_entity_lifecycle_evidence (
    tenant_id uuid NOT NULL,
    lifecycle_event_id uuid NOT NULL,
    source_reference_id uuid NOT NULL,
    evidence_role text DEFAULT 'supporting'::text NOT NULL,
    confidence numeric(5,4),
    review_status text DEFAULT 'candidate'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_entity_lifecycle_evidence_confidence_check CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT tenant_entity_lifecycle_evidence_evidence_role_check CHECK ((evidence_role = ANY (ARRAY['primary'::text, 'supporting'::text, 'contradicting'::text, 'announcement'::text, 'completion'::text, 'other'::text]))),
    CONSTRAINT tenant_entity_lifecycle_evidence_review_status_check CHECK ((review_status = ANY (ARRAY['candidate'::text, 'approved'::text, 'rejected'::text, 'superseded'::text])))
);

ALTER TABLE ONLY corvis_identity.tenant_entity_lifecycle_evidence FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_entity_name; Type: TABLE; Schema: corvis_identity; Owner: -
--

CREATE TABLE corvis_identity.tenant_entity_name (
    tenant_id uuid NOT NULL,
    tenant_entity_name_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fund_id text,
    company_id text,
    name text NOT NULL,
    normalized_name text GENERATED ALWAYS AS (corvis_identity.normalize_entity_name(name)) STORED,
    name_kind text NOT NULL,
    first_seen_date date,
    last_seen_date date,
    source_reference_id uuid,
    confidence numeric(5,4),
    review_status text DEFAULT 'candidate'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_entity_name_check CHECK (((
CASE
    WHEN (fund_id IS NULL) THEN 0
    ELSE 1
END +
CASE
    WHEN (company_id IS NULL) THEN 0
    ELSE 1
END) = 1)),
    CONSTRAINT tenant_entity_name_check1 CHECK (((last_seen_date IS NULL) OR (first_seen_date IS NULL) OR (last_seen_date >= first_seen_date))),
    CONSTRAINT tenant_entity_name_confidence_check CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT tenant_entity_name_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT tenant_entity_name_name_kind_check CHECK ((name_kind = ANY (ARRAY['source_label'::text, 'legal'::text, 'trading'::text, 'marketed'::text, 'abbreviation'::text, 'program_code'::text, 'codename'::text, 'former_name'::text, 'other'::text]))),
    CONSTRAINT tenant_entity_name_review_status_check CHECK ((review_status = ANY (ARRAY['candidate'::text, 'approved'::text, 'rejected'::text, 'superseded'::text])))
);

ALTER TABLE ONLY corvis_identity.tenant_entity_name FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_entity_revision; Type: TABLE; Schema: corvis_identity; Owner: -
--

CREATE TABLE corvis_identity.tenant_entity_revision (
    tenant_id uuid NOT NULL,
    canonicalization_run_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    entity_type text NOT NULL,
    global_entity_id text NOT NULL,
    candidate_fingerprint_sha256 text NOT NULL,
    effective_payload jsonb NOT NULL,
    source_reference_ids uuid[] NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_entity_revision_candidate_fingerprint_sha256_check CHECK ((candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tenant_entity_revision_effective_payload_check CHECK ((jsonb_typeof(effective_payload) = 'object'::text)),
    CONSTRAINT tenant_entity_revision_entity_type_check CHECK ((entity_type = ANY (ARRAY['fund'::text, 'company'::text]))),
    CONSTRAINT tenant_entity_revision_global_entity_id_check CHECK ((btrim(global_entity_id) <> ''::text)),
    CONSTRAINT tenant_entity_revision_source_reference_ids_check CHECK ((cardinality(source_reference_ids) > 0))
);

ALTER TABLE ONLY corvis_identity.tenant_entity_revision FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_lifecycle_revision; Type: TABLE; Schema: corvis_identity; Owner: -
--

CREATE TABLE corvis_identity.tenant_lifecycle_revision (
    tenant_id uuid NOT NULL,
    lifecycle_event_id uuid NOT NULL,
    canonicalization_run_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    candidate_fingerprint_sha256 text NOT NULL,
    effective_payload jsonb NOT NULL,
    source_reference_ids uuid[] NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_lifecycle_revision_candidate_fingerprint_sha256_check CHECK ((candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tenant_lifecycle_revision_effective_payload_check CHECK ((jsonb_typeof(effective_payload) = 'object'::text)),
    CONSTRAINT tenant_lifecycle_revision_source_reference_ids_check CHECK ((cardinality(source_reference_ids) > 0))
);

ALTER TABLE ONLY corvis_identity.tenant_lifecycle_revision FORCE ROW LEVEL SECURITY;


--
-- Name: candidate_review_event; Type: TABLE; Schema: corvis_review; Owner: -
--

CREATE TABLE corvis_review.candidate_review_event (
    tenant_id uuid NOT NULL,
    review_event_id uuid NOT NULL,
    event_sequence bigint NOT NULL,
    extraction_run_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    review_policy_version text NOT NULL,
    actor_subject text NOT NULL,
    decision text NOT NULL,
    reason_code text NOT NULL,
    correction_payload jsonb,
    resolved_exception_codes jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT candidate_review_event_actor_subject_check CHECK ((btrim(actor_subject) <> ''::text)),
    CONSTRAINT candidate_review_event_check CHECK ((((decision = 'correct'::text) AND (correction_payload IS NOT NULL)) OR ((decision <> 'correct'::text) AND (correction_payload IS NULL)))),
    CONSTRAINT candidate_review_event_check1 CHECK ((((decision = 'resolve_exception'::text) AND (jsonb_array_length(resolved_exception_codes) > 0)) OR ((decision <> 'resolve_exception'::text) AND (jsonb_array_length(resolved_exception_codes) = 0)))),
    CONSTRAINT candidate_review_event_correction_payload_check CHECK (((correction_payload IS NULL) OR (jsonb_typeof(correction_payload) = 'object'::text))),
    CONSTRAINT candidate_review_event_decision_check CHECK ((decision = ANY (ARRAY['approve'::text, 'reject'::text, 'correct'::text, 'resolve_exception'::text]))),
    CONSTRAINT candidate_review_event_reason_code_check CHECK ((btrim(reason_code) <> ''::text)),
    CONSTRAINT candidate_review_event_resolved_exception_codes_check CHECK ((jsonb_typeof(resolved_exception_codes) = 'array'::text))
);

ALTER TABLE ONLY corvis_review.candidate_review_event FORCE ROW LEVEL SECURITY;


--
-- Name: candidate_review_event_event_sequence_seq; Type: SEQUENCE; Schema: corvis_review; Owner: -
--

ALTER TABLE corvis_review.candidate_review_event ALTER COLUMN event_sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME corvis_review.candidate_review_event_event_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: candidate_review_requirement; Type: TABLE; Schema: corvis_review; Owner: -
--

CREATE TABLE corvis_review.candidate_review_requirement (
    tenant_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    review_policy_version text NOT NULL,
    candidate_fingerprint_sha256 text NOT NULL,
    risk_tier text NOT NULL,
    required_approvals integer NOT NULL,
    requires_exception_resolution boolean DEFAULT false NOT NULL,
    blocking_reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT candidate_review_requirement_blocking_reasons_check CHECK ((jsonb_typeof(blocking_reasons) = 'array'::text)),
    CONSTRAINT candidate_review_requirement_candidate_fingerprint_sha256_check CHECK ((candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT candidate_review_requirement_required_approvals_check CHECK ((required_approvals > 0)),
    CONSTRAINT candidate_review_requirement_risk_tier_check CHECK ((risk_tier = ANY (ARRAY['standard'::text, 'critical'::text])))
);

ALTER TABLE ONLY corvis_review.candidate_review_requirement FORCE ROW LEVEL SECURITY;


--
-- Name: extraction_review_gate; Type: TABLE; Schema: corvis_review; Owner: -
--

CREATE TABLE corvis_review.extraction_review_gate (
    tenant_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    review_policy_version text NOT NULL,
    candidate_set_sha256 text NOT NULL,
    decision_set_sha256 text NOT NULL,
    status text NOT NULL,
    candidate_count integer NOT NULL,
    blocking_candidate_count integer NOT NULL,
    critical_candidate_count integer NOT NULL,
    exception_candidate_count integer NOT NULL,
    evaluated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT extraction_review_gate_blocking_candidate_count_check CHECK ((blocking_candidate_count >= 0)),
    CONSTRAINT extraction_review_gate_candidate_count_check CHECK ((candidate_count >= 0)),
    CONSTRAINT extraction_review_gate_candidate_set_sha256_check CHECK ((candidate_set_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT extraction_review_gate_check CHECK ((((status = 'ready'::text) AND (blocking_candidate_count = 0)) OR (status = 'pending'::text))),
    CONSTRAINT extraction_review_gate_critical_candidate_count_check CHECK ((critical_candidate_count >= 0)),
    CONSTRAINT extraction_review_gate_decision_set_sha256_check CHECK ((decision_set_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT extraction_review_gate_exception_candidate_count_check CHECK ((exception_candidate_count >= 0)),
    CONSTRAINT extraction_review_gate_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text])))
);

ALTER TABLE ONLY corvis_review.extraction_review_gate FORCE ROW LEVEL SECURITY;


--
-- Name: metric_definition; Type: TABLE; Schema: corvis_semantic; Owner: -
--

CREATE TABLE corvis_semantic.metric_definition (
    metric_code text NOT NULL,
    definition_version text NOT NULL,
    display_name text NOT NULL,
    data_type text NOT NULL,
    aggregation_behavior text NOT NULL,
    unit_type text,
    fx_behavior text,
    compatibility_rule jsonb DEFAULT '{}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL
);


--
-- Name: sector; Type: TABLE; Schema: corvis_semantic; Owner: -
--

CREATE TABLE corvis_semantic.sector (
    taxonomy_version text NOT NULL,
    sector_code text NOT NULL,
    display_name text NOT NULL,
    description text NOT NULL,
    display_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sector_display_name_check CHECK ((btrim(display_name) <> ''::text)),
    CONSTRAINT sector_display_order_check CHECK ((display_order > 0)),
    CONSTRAINT sector_sector_code_check CHECK ((sector_code ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT sector_taxonomy_version_check CHECK ((btrim(taxonomy_version) <> ''::text))
);


--
-- Name: sector_alias; Type: TABLE; Schema: corvis_semantic; Owner: -
--

CREATE TABLE corvis_semantic.sector_alias (
    taxonomy_version text NOT NULL,
    alias_normalized text NOT NULL,
    sector_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sector_alias_alias_normalized_check CHECK ((alias_normalized = corvis_semantic.normalize_sector_label(alias_normalized)))
);


--
-- Name: client_portfolios; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.client_portfolios WITH (security_invoker='true') AS
 SELECT tenant_id,
    workspace_id,
    portfolio_id,
    portfolio_key,
    display_name,
    base_currency,
    external_portfolio_id,
    status,
    valid_from,
    valid_to,
    created_at,
    updated_at
   FROM corvis_facts.client_portfolio
  WHERE ((status = 'active'::text) AND ((valid_from IS NULL) OR (valid_from <= CURRENT_DATE)) AND ((valid_to IS NULL) OR (valid_to >= CURRENT_DATE)));


--
-- Name: client_portfolio_fund_positions; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.client_portfolio_fund_positions WITH (security_invoker='true') AS
 SELECT pf.tenant_id,
    p.workspace_id,
    pf.portfolio_fund_position_id,
    pf.portfolio_id,
    pf.position_key,
    pf.fund_id,
    pf.position_label,
    pf.external_position_id,
    pf.valid_from,
    pf.valid_to,
    pf.created_at,
    pf.updated_at
   FROM (corvis_facts.client_portfolio_fund_position pf
     JOIN corvis_serving.client_portfolios p ON (((p.tenant_id = pf.tenant_id) AND (p.portfolio_id = pf.portfolio_id))))
  WHERE (((pf.valid_from IS NULL) OR (pf.valid_from <= CURRENT_DATE)) AND ((pf.valid_to IS NULL) OR (pf.valid_to >= CURRENT_DATE)));


--
-- Name: holdings; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.holdings AS
 SELECT tenant_id,
    holding_id,
    fund_id,
    target_type,
    target_company_id,
    target_fund_id,
    status,
    investment_date,
    strategy,
    geography,
    source_reference_id,
    valid_from,
    valid_to,
    version,
    updated_at
   FROM corvis_facts.holding
  WHERE (review_state = 'approved'::text);


--
-- Name: client_portfolio_holding_attribution; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.client_portfolio_holding_attribution WITH (security_invoker='true') AS
 WITH RECURSIVE fund_path AS (
         SELECT pf.tenant_id,
            pf.workspace_id,
            pf.portfolio_id,
            pf.portfolio_fund_position_id,
            pf.fund_id AS root_fund_id,
            pf.fund_id AS owning_fund_id,
            ARRAY[pf.fund_id] AS fund_path,
            ARRAY[]::uuid[] AS parent_holding_path,
            0 AS lookthrough_depth
           FROM corvis_serving.client_portfolio_fund_positions pf
        UNION ALL
         SELECT fp_1.tenant_id,
            fp_1.workspace_id,
            fp_1.portfolio_id,
            fp_1.portfolio_fund_position_id,
            fp_1.root_fund_id,
            h_1.target_fund_id AS owning_fund_id,
            (fp_1.fund_path || h_1.target_fund_id),
            (fp_1.parent_holding_path || h_1.holding_id),
            (fp_1.lookthrough_depth + 1)
           FROM (fund_path fp_1
             JOIN corvis_serving.holdings h_1 ON (((h_1.tenant_id = fp_1.tenant_id) AND (h_1.fund_id = fp_1.owning_fund_id) AND (h_1.target_type = 'fund'::text) AND (h_1.target_fund_id IS NOT NULL))))
          WHERE ((fp_1.lookthrough_depth < 15) AND (NOT (h_1.target_fund_id = ANY (fp_1.fund_path))))
        )
 SELECT md5((((((((((fp.tenant_id)::text || ':'::text) || (fp.portfolio_id)::text) || ':'::text) || (fp.portfolio_fund_position_id)::text) || ':'::text) || (h.holding_id)::text) || ':'::text) || array_to_string(fp.fund_path, '>'::text))) AS attribution_key,
    fp.tenant_id,
    fp.workspace_id,
    fp.portfolio_id,
    fp.portfolio_fund_position_id,
    fp.root_fund_id,
    fp.owning_fund_id,
    h.holding_id,
    h.target_type,
    h.target_company_id,
    h.target_fund_id,
    h.status AS holding_status,
    h.investment_date,
    h.strategy,
    h.geography,
    h.source_reference_id,
    h.valid_from AS holding_valid_from,
    h.valid_to AS holding_valid_to,
    fp.fund_path,
    (fp.parent_holding_path || h.holding_id) AS holding_path,
    fp.lookthrough_depth
   FROM (fund_path fp
     JOIN corvis_serving.holdings h ON (((h.tenant_id = fp.tenant_id) AND (h.fund_id = fp.owning_fund_id))));


--
-- Name: company_sectors; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.company_sectors WITH (security_invoker='true') AS
 SELECT c.tenant_id,
    c.company_id,
    c.taxonomy_version,
    c.sector_code,
    s.display_name AS sector_name,
    c.basis,
    c.version,
    c.classified_by,
    c.classified_at
   FROM (corvis_facts.company_sector_classification c
     JOIN corvis_semantic.sector s ON (((s.taxonomy_version = c.taxonomy_version) AND (s.sector_code = c.sector_code))))
  WHERE (c.superseded_at IS NULL);


--
-- Name: document; Type: TABLE; Schema: corvis_source; Owner: -
--

CREATE TABLE corvis_source.document (
    tenant_id uuid NOT NULL,
    document_id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_family_id uuid,
    display_name text NOT NULL,
    media_type text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    fund_name text,
    report_period text,
    document_type text,
    page_count integer,
    quality text
);

ALTER TABLE ONLY corvis_source.document FORCE ROW LEVEL SECURITY;


--
-- Name: document_artifact_version; Type: TABLE; Schema: corvis_source; Owner: -
--

CREATE TABLE corvis_source.document_artifact_version (
    tenant_id uuid NOT NULL,
    document_artifact_version_id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    ingestion_id text NOT NULL,
    object_uri text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text,
    storage_generation text,
    malware_scan_status text DEFAULT 'pending'::text NOT NULL,
    quarantine_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_release_attempt_at timestamp with time zone,
    CONSTRAINT document_artifact_version_size_bytes_check CHECK ((size_bytes >= 0))
);

ALTER TABLE ONLY corvis_source.document_artifact_version FORCE ROW LEVEL SECURITY;


--
-- Name: source_reference; Type: TABLE; Schema: corvis_source; Owner: -
--

CREATE TABLE corvis_source.source_reference (
    tenant_id uuid NOT NULL,
    source_reference_id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    document_artifact_version_id uuid NOT NULL,
    page_number integer,
    sheet_name text,
    cell_range text,
    bbox jsonb,
    excerpt text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    extraction_run_id uuid,
    candidate_id uuid,
    representation_id uuid,
    reference_key text,
    section_title text,
    table_title text,
    row_label text,
    column_label text,
    footnote_marker text,
    extraction_method text
);

ALTER TABLE ONLY corvis_source.source_reference FORCE ROW LEVEL SECURITY;


--
-- Name: documents; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.documents AS
 WITH latest_artifact AS (
         SELECT DISTINCT ON (document_artifact_version.tenant_id, document_artifact_version.document_id) document_artifact_version.tenant_id,
            document_artifact_version.document_id,
            document_artifact_version.size_bytes,
            document_artifact_version.malware_scan_status,
            document_artifact_version.quarantine_status
           FROM corvis_source.document_artifact_version
          ORDER BY document_artifact_version.tenant_id, document_artifact_version.document_id, document_artifact_version.created_at DESC
        ), latest_job AS (
         SELECT DISTINCT ON (processing_job.tenant_id, processing_job.document_id) processing_job.tenant_id,
            processing_job.document_id,
            processing_job.stage,
            processing_job.state,
            processing_job.updated_at
           FROM corvis_control.processing_job
          ORDER BY processing_job.tenant_id, processing_job.document_id, processing_job.updated_at DESC
        ), document_observations AS (
         SELECT o.tenant_id,
            r.document_id,
            (count(*))::integer AS observation_count
           FROM (corvis_facts.observation o
             JOIN corvis_source.source_reference r ON (((r.tenant_id = o.tenant_id) AND (r.source_reference_id = o.source_reference_id))))
          GROUP BY o.tenant_id, r.document_id
        )
 SELECT d.tenant_id,
    d.document_id,
    d.display_name,
    d.fund_name,
    d.report_period,
    COALESCE(d.document_type, d.media_type) AS document_type,
    d.page_count,
    a.size_bytes,
    d.status,
    d.quality,
    COALESCE(obs.observation_count, 0) AS observation_count,
    j.stage AS processing_stage,
    j.state AS processing_state,
    j.updated_at AS processing_updated_at,
    a.malware_scan_status,
    a.quarantine_status,
    d.created_at
   FROM (((corvis_source.document d
     LEFT JOIN latest_artifact a ON (((a.tenant_id = d.tenant_id) AND (a.document_id = d.document_id))))
     LEFT JOIN latest_job j ON (((j.tenant_id = d.tenant_id) AND (j.document_id = d.document_id))))
     LEFT JOIN document_observations obs ON (((obs.tenant_id = d.tenant_id) AND (obs.document_id = d.document_id))));


--
-- Name: entity_directory; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.entity_directory AS
 SELECT 'fund'::text AS entity_type,
    f.global_fund_id AS entity_id,
    f.canonical_name,
    f.manager_name,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('name', n.name, 'nameKind', n.name_kind, 'isCurrent', n.is_current, 'validFrom', n.valid_from, 'validTo', n.valid_to) ORDER BY n.is_current DESC, n.recorded_at DESC) AS jsonb_agg
           FROM corvis_identity.entity_name n
          WHERE (n.fund_id = f.global_fund_id)), '[]'::jsonb) AS names,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('type', i.identifier_type, 'value', i.identifier_value, 'issuer', i.issuer, 'jurisdiction', i.jurisdiction, 'isCurrent', i.is_current) ORDER BY i.is_current DESC, i.recorded_at DESC) AS jsonb_agg
           FROM corvis_identity.entity_external_identifier i
          WHERE (i.fund_id = f.global_fund_id)), '[]'::jsonb) AS external_identifiers
   FROM corvis_identity.fund f
UNION ALL
 SELECT 'company'::text AS entity_type,
    c.global_company_id AS entity_id,
    c.canonical_name,
    NULL::text AS manager_name,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('name', n.name, 'nameKind', n.name_kind, 'isCurrent', n.is_current, 'validFrom', n.valid_from, 'validTo', n.valid_to) ORDER BY n.is_current DESC, n.recorded_at DESC) AS jsonb_agg
           FROM corvis_identity.entity_name n
          WHERE (n.company_id = c.global_company_id)), '[]'::jsonb) AS names,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('type', i.identifier_type, 'value', i.identifier_value, 'issuer', i.issuer, 'jurisdiction', i.jurisdiction, 'isCurrent', i.is_current) ORDER BY i.is_current DESC, i.recorded_at DESC) AS jsonb_agg
           FROM corvis_identity.entity_external_identifier i
          WHERE (i.company_id = c.global_company_id)), '[]'::jsonb) AS external_identifiers
   FROM corvis_identity.company c;


--
-- Name: entity_relationships; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.entity_relationships AS
 SELECT entity_relationship_id,
    relationship_type,
        CASE
            WHEN (source_fund_id IS NOT NULL) THEN 'fund'::text
            ELSE 'company'::text
        END AS source_entity_type,
    COALESCE(source_fund_id, source_company_id) AS source_entity_id,
        CASE
            WHEN (target_fund_id IS NOT NULL) THEN 'fund'::text
            ELSE 'company'::text
        END AS target_entity_type,
    COALESCE(target_fund_id, target_company_id) AS target_entity_id,
    lifecycle_event_id,
    relationship_status,
    valid_from,
    valid_to,
    created_at
   FROM corvis_identity.entity_relationship r;


--
-- Name: export_download_grant; Type: TABLE; Schema: corvis_serving; Owner: -
--

CREATE TABLE corvis_serving.export_download_grant (
    tenant_id uuid NOT NULL,
    grant_id uuid DEFAULT gen_random_uuid() NOT NULL,
    export_id uuid NOT NULL,
    subject text NOT NULL,
    token_sha256 text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT export_download_grant_check CHECK ((expires_at > created_at))
);

ALTER TABLE ONLY corvis_serving.export_download_grant FORCE ROW LEVEL SECURITY;


--
-- Name: export_job; Type: TABLE; Schema: corvis_serving; Owner: -
--

CREATE TABLE corvis_serving.export_job (
    tenant_id uuid NOT NULL,
    export_id uuid DEFAULT gen_random_uuid() NOT NULL,
    requested_by text NOT NULL,
    format text NOT NULL,
    snapshot_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    object_uri text,
    expires_at timestamp with time zone,
    checksum_sha256 text,
    manifest jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    delivery_attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    workspace_id uuid,
    auth_method text,
    session_id text,
    delivery_started_at timestamp with time zone,
    delivery_next_attempt_at timestamp with time zone,
    CONSTRAINT export_job_delivery_attempts_check CHECK ((delivery_attempts >= 0)),
    CONSTRAINT export_job_format_check CHECK ((format = ANY (ARRAY['csv'::text, 'xlsx'::text, 'parquet'::text]))),
    CONSTRAINT export_job_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'delivering'::text, 'retryable'::text, 'complete'::text, 'failed'::text])))
);

ALTER TABLE ONLY corvis_serving.export_job FORCE ROW LEVEL SECURITY;


--
-- Name: fund_period_snapshots; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.fund_period_snapshots AS
 SELECT s.tenant_id,
    s.snapshot_id,
    s.fund_id,
    s.report_period,
    s.version,
    s.status,
    s.fact_ids,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM corvis_consolidated.reconciliation_exception e
              WHERE ((e.tenant_id = s.tenant_id) AND (e.snapshot_id = s.snapshot_id) AND (e.snapshot_version = s.version)))) THEN ( SELECT (count(*))::integer AS count
               FROM corvis_consolidated.reconciliation_exception e
              WHERE ((e.tenant_id = s.tenant_id) AND (e.snapshot_id = s.snapshot_id) AND (e.snapshot_version = s.version) AND (e.status = 'open'::text)))
            ELSE s.blocking_exception_count
        END AS blocking_exception_count,
    s.schema_version,
    s.taxonomy_version,
    s.created_at,
    s.published_at,
    f.canonical_name AS fund_name,
    cardinality(s.fact_ids) AS fact_count,
    s.review_deadline_at
   FROM (corvis_consolidated.fund_period_snapshot s
     LEFT JOIN corvis_identity.fund f ON ((f.global_fund_id = s.fund_id)));


--
-- Name: instruments; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.instruments AS
 SELECT i.tenant_id,
    i.instrument_id,
    i.holding_id,
    h.fund_id,
    h.target_company_id AS company_id,
    i.security_name AS security_description,
    i.instrument_type,
    i.currency,
    i.seniority,
    i.maturity_date,
    i.coupon_rate,
    i.source_reference_id,
    i.version,
    i.updated_at
   FROM (corvis_facts.instrument i
     JOIN corvis_facts.holding h ON (((h.tenant_id = i.tenant_id) AND (h.holding_id = i.holding_id))))
  WHERE ((i.review_state = 'approved'::text) AND (h.review_state = 'approved'::text) AND (h.target_type = 'company'::text));


--
-- Name: observations; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.observations AS
 WITH latest_correction AS (
         SELECT DISTINCT ON (observation_correction.tenant_id, observation_correction.observation_id) observation_correction.tenant_id,
            observation_correction.observation_id,
            observation_correction.corrected_value_string,
            observation_correction.corrected_value_number,
            observation_correction.based_on_observation_version,
            observation_correction.created_at
           FROM corvis_facts.observation_correction
          ORDER BY observation_correction.tenant_id, observation_correction.observation_id, observation_correction.created_at DESC
        )
 SELECT o.tenant_id,
    o.observation_id,
    o.fund_id,
    o.company_id,
    o.holding_id,
    o.instrument_id,
    o.metric_code,
    COALESCE(lc.corrected_value_number, o.value_number) AS value_number,
    COALESCE(lc.corrected_value_string, o.value_string) AS value_string,
    o.currency,
    o.economic_period,
    o.report_date,
    o.review_state,
    o.source_reference_id,
    o.version,
    o.updated_at,
    c.canonical_name AS company_name,
    r.document_id,
    r.page_number,
    r.sheet_name,
    r.cell_range,
    o.confidence_score,
    o.delta_display,
    o.risk_tier,
    ( SELECT (count(DISTINCT e.actor_subject))::integer AS count
           FROM corvis_facts.review_event e
          WHERE ((e.tenant_id = o.tenant_id) AND (e.observation_id = o.observation_id) AND (e.decision = 'approve'::text) AND (e.observation_version >= COALESCE((lc.based_on_observation_version + 1), 0)))) AS approved_reviewer_count
   FROM (((corvis_facts.observation o
     LEFT JOIN corvis_identity.company c ON ((c.global_company_id = o.company_id)))
     LEFT JOIN corvis_source.source_reference r ON (((r.tenant_id = o.tenant_id) AND (r.source_reference_id = o.source_reference_id))))
     LEFT JOIN latest_correction lc ON (((lc.tenant_id = o.tenant_id) AND (lc.observation_id = o.observation_id))))
  WHERE (o.review_state = ANY (ARRAY['approved'::text, 'review_required'::text]));


--
-- Name: position_financial_statement_values; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.position_financial_statement_values AS
 SELECT s.tenant_id,
    s.statement_id,
    s.canonicalization_run_id,
    s.extraction_run_id,
    s.document_id,
    s.fund_id,
    s.holding_id,
    s.company_id,
    s.statement_type,
    s.statement_key,
    s.source_title,
    s.report_period,
    s.source_document_period_end AS statement_source_document_period_end,
    s.source_version_status AS statement_source_version_status,
    l.line_id,
    l.line_key,
    l.semantic_line_key,
    l.source_label,
    l.metric_code,
    l.line_role,
    l.parent_line_key,
    l.display_order,
    l.depth,
    v.value_id,
    v.candidate_id,
    v.candidate_type,
    v.value_raw,
    v.value_number,
    v.value_string,
    v.value_qualifier,
    v.currency,
    v.unit,
    v.reported_multiplier,
    v.source_precision,
    v.value_nature,
    v.period_type,
    v.period_start,
    v.period_end,
    v.as_of_date,
    v.fiscal_year,
    v.fiscal_quarter,
    v.source_document_period_end,
    v.source_column_label,
    v.actuality,
    v.scenario_type,
    v.source_version_status,
    v.preliminary,
    v.is_restatement,
    v.is_re_reported_prior_period,
    v.is_derived,
    v.derivation_formula,
    COALESCE(v.source_reference_ids, l.source_reference_ids) AS source_reference_ids,
    sr.page_number,
    sr.sheet_name,
    sr.cell_range,
    sr.section_title,
    sr.table_title,
    sr.row_label,
    sr.column_label,
    sr.footnote_marker
   FROM (((corvis_facts.position_financial_statement s
     JOIN corvis_facts.position_financial_statement_line l ON (((l.tenant_id = s.tenant_id) AND (l.statement_id = s.statement_id))))
     LEFT JOIN corvis_facts.position_financial_statement_value v ON (((v.tenant_id = l.tenant_id) AND (v.statement_id = l.statement_id) AND (v.line_id = l.line_id))))
     LEFT JOIN corvis_source.source_reference sr ON (((sr.tenant_id = l.tenant_id) AND (sr.source_reference_id = COALESCE(v.source_reference_ids[1], l.source_reference_ids[1])))));


--
-- Name: reconciliation_exceptions; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.reconciliation_exceptions AS
 SELECT e.tenant_id,
    e.exception_id,
    e.snapshot_id,
    e.snapshot_version,
    e.exception_key,
    e.fund_id,
    e.report_period,
    e.exception_type,
    e.subject_type,
    e.subject_id,
    e.metric_code,
    e.summary,
    e.materiality,
    e.competing_source_reference_ids,
    (COALESCE(e.context, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('triggerRule',
        CASE e.exception_type
            WHEN 'reconciliation_conflict'::text THEN 'exact_semantic_grain_value_disagreement'::text
            WHEN 'source_authority'::text THEN 'source_authority_selection_required'::text
            WHEN 'materiality'::text THEN 'materiality_review_required'::text
            ELSE 'reconciliation_review_required'::text
        END, 'triggerRuleVersion', COALESCE(NULLIF((e.context ->> 'policyVersion'::text), ''::text), 'reconciliation_v1'::text), 'reviewDeadlineAt', current_snapshot.review_deadline_at, 'priorPublished', ( SELECT jsonb_build_object('snapshotId', (prior.snapshot_id)::text, 'reportPeriod', prior.report_period, 'publishedAt', prior.published_at, 'value', fact.value) AS jsonb_build_object
           FROM ((corvis_consolidated.fund_period_snapshot prior
             CROSS JOIN LATERAL unnest(prior.fact_ids) published_fact(fact_id))
             JOIN corvis_consolidated.consolidated_fact fact ON (((fact.tenant_id = prior.tenant_id) AND (fact.consolidated_fact_id = published_fact.fact_id))))
          WHERE ((prior.tenant_id = e.tenant_id) AND (prior.fund_id = e.fund_id) AND (prior.status = 'published'::text) AND (prior.snapshot_id <> e.snapshot_id) AND (prior.report_period <> e.report_period) AND (prior.created_at < current_snapshot.created_at) AND (e.subject_type IS NOT NULL) AND (e.subject_id IS NOT NULL) AND (e.metric_code IS NOT NULL) AND (fact.subject_type = e.subject_type) AND (fact.subject_id = e.subject_id) AND (fact.metric_code = e.metric_code) AND (COALESCE((fact.value ->> 'semanticGrainRelationship'::text), ''::text) <> 'conflicting_alternative'::text) AND (NOT (EXISTS ( SELECT 1
                   FROM corvis_consolidated.fund_period_snapshot newer
                  WHERE ((newer.tenant_id = prior.tenant_id) AND (newer.snapshot_id = prior.snapshot_id) AND (newer.version > prior.version))))))
          ORDER BY prior.published_at DESC NULLS LAST, prior.created_at DESC, fact.created_at DESC
         LIMIT 1), 'competingValues', ( SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('observationId', (candidate.item ->> 'observationId'::text), 'value', (candidate.item -> 'value'::text), 'riskTier', (candidate.item ->> 'riskTier'::text), 'sourceReferenceId', (observation.source_reference_id)::text)) ORDER BY candidate.ordinality), '[]'::jsonb) AS "coalesce"
           FROM (jsonb_array_elements(COALESCE((e.context -> 'observations'::text), '[]'::jsonb)) WITH ORDINALITY candidate(item, ordinality)
             LEFT JOIN corvis_facts.observation observation ON (((observation.tenant_id = e.tenant_id) AND ((observation.observation_id)::text = (candidate.item ->> 'observationId'::text))))))))) AS context,
    e.status,
    e.version,
    e.created_by,
    e.created_at,
    e.resolved_by,
    e.resolved_at
   FROM (corvis_consolidated.reconciliation_exception e
     JOIN corvis_consolidated.fund_period_snapshot current_snapshot ON (((current_snapshot.tenant_id = e.tenant_id) AND (current_snapshot.snapshot_id = e.snapshot_id) AND (current_snapshot.version = e.snapshot_version))));


--
-- Name: source_references; Type: VIEW; Schema: corvis_serving; Owner: -
--

CREATE VIEW corvis_serving.source_references AS
 SELECT r.tenant_id,
    r.source_reference_id,
    r.document_id,
    r.document_artifact_version_id,
    r.page_number,
    r.sheet_name,
    r.cell_range,
    r.bbox,
    r.excerpt,
    a.object_uri,
    a.storage_generation,
    a.quarantine_status
   FROM (corvis_source.source_reference r
     JOIN corvis_source.document_artifact_version a ON (((a.tenant_id = r.tenant_id) AND (a.document_artifact_version_id = r.document_artifact_version_id))))
  WHERE (a.quarantine_status = 'released'::text);


--
-- Name: acquired_document; Type: TABLE; Schema: corvis_source; Owner: -
--

CREATE TABLE corvis_source.acquired_document (
    tenant_id uuid NOT NULL,
    acquisition_id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_connection_id uuid NOT NULL,
    run_id uuid NOT NULL,
    provider_key text NOT NULL,
    remote_document_id text NOT NULL,
    remote_version text NOT NULL,
    remote_path text NOT NULL,
    remote_modified_at timestamp with time zone,
    content_sha256 text NOT NULL,
    acquisition_key text NOT NULL,
    connector_version text NOT NULL,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    disposition text NOT NULL,
    rejection_reason text,
    document_id uuid,
    document_artifact_version_id uuid,
    CONSTRAINT acquired_document_acquisition_key_check CHECK ((acquisition_key ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT acquired_document_content_sha256_check CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT acquired_document_disposition_check CHECK ((disposition = ANY (ARRAY['accepted'::text, 'duplicate'::text, 'rejected'::text, 'quarantined'::text]))),
    CONSTRAINT acquired_document_remote_document_id_check CHECK (((length(remote_document_id) >= 1) AND (length(remote_document_id) <= 512)))
);

ALTER TABLE ONLY corvis_source.acquired_document FORCE ROW LEVEL SECURITY;


--
-- Name: document_representation; Type: TABLE; Schema: corvis_source; Owner: -
--

CREATE TABLE corvis_source.document_representation (
    tenant_id uuid NOT NULL,
    representation_id uuid NOT NULL,
    document_id uuid NOT NULL,
    document_artifact_version_id uuid NOT NULL,
    representation_type text NOT NULL,
    object_uri text NOT NULL,
    storage_generation text NOT NULL,
    content_sha256 text NOT NULL,
    size_bytes bigint NOT NULL,
    producer text NOT NULL,
    producer_version text NOT NULL,
    method text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_representation_content_sha256_check CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT document_representation_method_check CHECK ((method = ANY (ARRAY['native'::text, 'ocr'::text, 'vision'::text, 'hybrid'::text]))),
    CONSTRAINT document_representation_object_uri_check CHECK ((object_uri ~~ 'gs://%'::text)),
    CONSTRAINT document_representation_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT document_representation_status_check CHECK ((status = 'ready'::text)),
    CONSTRAINT document_representation_storage_generation_check CHECK ((storage_generation <> ''::text))
);

ALTER TABLE ONLY corvis_source.document_representation FORCE ROW LEVEL SECURITY;


--
-- Name: extraction_candidate; Type: TABLE; Schema: corvis_source; Owner: -
--

CREATE TABLE corvis_source.extraction_candidate (
    tenant_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    candidate_key text NOT NULL,
    document_id uuid NOT NULL,
    representation_id uuid NOT NULL,
    candidate_type text NOT NULL,
    payload jsonb NOT NULL,
    confidence jsonb NOT NULL,
    provenance jsonb NOT NULL,
    exception_codes jsonb DEFAULT '[]'::jsonb NOT NULL,
    review_status text DEFAULT 'candidate'::text NOT NULL,
    source_reference_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT extraction_candidate_candidate_key_check CHECK ((btrim(candidate_key) <> ''::text)),
    CONSTRAINT extraction_candidate_candidate_type_check CHECK ((candidate_type = ANY (ARRAY['fund'::text, 'company'::text, 'holding'::text, 'instrument'::text, 'lifecycle_event'::text, 'metric_observation'::text, 'financial_statement_line'::text, 'exception'::text]))),
    CONSTRAINT extraction_candidate_confidence_check CHECK ((jsonb_typeof(confidence) = 'object'::text)),
    CONSTRAINT extraction_candidate_exception_codes_check CHECK ((jsonb_typeof(exception_codes) = 'array'::text)),
    CONSTRAINT extraction_candidate_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT extraction_candidate_provenance_check CHECK ((jsonb_typeof(provenance) = 'object'::text)),
    CONSTRAINT extraction_candidate_review_status_check CHECK ((review_status = 'candidate'::text)),
    CONSTRAINT extraction_candidate_source_reference_count_check CHECK ((source_reference_count > 0))
);

ALTER TABLE ONLY corvis_source.extraction_candidate FORCE ROW LEVEL SECURITY;


--
-- Name: extraction_candidate_source_reference; Type: TABLE; Schema: corvis_source; Owner: -
--

CREATE TABLE corvis_source.extraction_candidate_source_reference (
    tenant_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    source_reference_id uuid NOT NULL,
    reference_key text NOT NULL,
    document_id uuid NOT NULL,
    representation_id uuid NOT NULL,
    page_number integer,
    sheet_name text,
    section_title text,
    table_title text,
    row_label text,
    column_label text,
    cell_or_range text,
    footnote_marker text,
    source_text text,
    extraction_method text NOT NULL,
    bounding_box jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    document_segment_id text,
    work_unit_id text,
    fund_context_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    page_coverage_state text,
    CONSTRAINT extraction_candidate_source_reference_bounding_box_check CHECK (((bounding_box IS NULL) OR (jsonb_typeof(bounding_box) = 'object'::text))),
    CONSTRAINT extraction_candidate_source_reference_check CHECK (((page_number IS NOT NULL) OR (NULLIF(btrim(COALESCE(sheet_name, ''::text)), ''::text) IS NOT NULL))),
    CONSTRAINT extraction_candidate_source_reference_extraction_method_check CHECK ((extraction_method = ANY (ARRAY['native_text'::text, 'table_parser'::text, 'ocr'::text, 'vision'::text, 'spreadsheet_parser'::text]))),
    CONSTRAINT extraction_candidate_source_reference_fund_context_ids_check CHECK ((jsonb_typeof(fund_context_ids) = 'array'::text)),
    CONSTRAINT extraction_candidate_source_reference_page_coverage_state_check CHECK (((page_coverage_state IS NULL) OR (page_coverage_state = ANY (ARRAY['primary'::text, 'overlap_shared'::text, 'excluded'::text, 'exception'::text])))),
    CONSTRAINT extraction_candidate_source_reference_page_number_check CHECK (((page_number IS NULL) OR (page_number > 0))),
    CONSTRAINT extraction_candidate_source_reference_reference_key_check CHECK ((btrim(reference_key) <> ''::text)),
    CONSTRAINT extraction_candidate_source_reference_segment_id_check CHECK (((document_segment_id IS NULL) OR (NULLIF(btrim(document_segment_id), ''::text) IS NOT NULL))),
    CONSTRAINT extraction_candidate_source_reference_work_unit_id_check CHECK (((work_unit_id IS NULL) OR (NULLIF(btrim(work_unit_id), ''::text) IS NOT NULL)))
);

ALTER TABLE ONLY corvis_source.extraction_candidate_source_reference FORCE ROW LEVEL SECURITY;


--
-- Name: extraction_run; Type: TABLE; Schema: corvis_source; Owner: -
--

CREATE TABLE corvis_source.extraction_run (
    tenant_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    document_id uuid NOT NULL,
    document_artifact_version_id uuid NOT NULL,
    representation_id uuid NOT NULL,
    extraction_contract_version text NOT NULL,
    schema_version text NOT NULL,
    skill_id text NOT NULL,
    skill_version text NOT NULL,
    bundle_object_uri text NOT NULL,
    bundle_storage_generation text NOT NULL,
    bundle_content_sha256 text NOT NULL,
    bundle_size_bytes bigint NOT NULL,
    producer text NOT NULL,
    producer_version text NOT NULL,
    model_provider text NOT NULL,
    model_name text NOT NULL,
    model_version text NOT NULL,
    status text NOT NULL,
    candidate_count integer,
    candidate_set_sha256 text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    orchestration_policy_version text,
    orchestration_manifest_object_uri text,
    orchestration_manifest_storage_generation text,
    orchestration_manifest_content_sha256 text,
    orchestration_manifest_size_bytes bigint,
    page_count integer,
    covered_page_count integer,
    document_segment_count integer,
    work_unit_count integer,
    unexplained_page_gap_count integer,
    unresolved_material_attribution_count integer,
    CONSTRAINT extraction_run_bundle_content_sha256_check CHECK ((bundle_content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT extraction_run_bundle_object_uri_check CHECK ((bundle_object_uri ~~ 'gs://%'::text)),
    CONSTRAINT extraction_run_bundle_size_bytes_check CHECK ((bundle_size_bytes >= 0)),
    CONSTRAINT extraction_run_bundle_storage_generation_check CHECK ((bundle_storage_generation <> ''::text)),
    CONSTRAINT extraction_run_candidate_count_check CHECK (((candidate_count IS NULL) OR (candidate_count >= 0))),
    CONSTRAINT extraction_run_candidate_set_sha256_check CHECK (((candidate_set_sha256 IS NULL) OR (candidate_set_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT extraction_run_check CHECK ((((status = 'writing'::text) AND (completed_at IS NULL)) OR ((status = 'ready'::text) AND (completed_at IS NOT NULL) AND (candidate_count IS NOT NULL) AND (candidate_set_sha256 IS NOT NULL)))),
    CONSTRAINT extraction_run_covered_page_count_check CHECK (((covered_page_count IS NULL) OR (covered_page_count >= 0))),
    CONSTRAINT extraction_run_document_segment_count_check CHECK (((document_segment_count IS NULL) OR (document_segment_count > 0))),
    CONSTRAINT extraction_run_orchestration_manifest_sha256_check CHECK (((orchestration_manifest_content_sha256 IS NULL) OR (orchestration_manifest_content_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT extraction_run_orchestration_manifest_size_check CHECK (((orchestration_manifest_size_bytes IS NULL) OR (orchestration_manifest_size_bytes >= 0))),
    CONSTRAINT extraction_run_orchestration_manifest_uri_check CHECK (((orchestration_manifest_object_uri IS NULL) OR (orchestration_manifest_object_uri ~~ 'gs://%'::text))),
    CONSTRAINT extraction_run_page_count_check CHECK (((page_count IS NULL) OR (page_count >= 0))),
    CONSTRAINT extraction_run_skill_2_1_orchestration_check CHECK (((NOT ((skill_id = 'quarterly_fund_report_extraction'::text) AND (skill_version = '2.1'::text) AND (schema_version = '1.6'::text))) OR ((orchestration_policy_version IS NOT NULL) AND (orchestration_policy_version = '1'::text) AND (orchestration_manifest_object_uri IS NOT NULL) AND (orchestration_manifest_object_uri ~~ 'gs://%'::text) AND (orchestration_manifest_storage_generation IS NOT NULL) AND (NULLIF(btrim(orchestration_manifest_storage_generation), ''::text) IS NOT NULL) AND (orchestration_manifest_content_sha256 IS NOT NULL) AND (orchestration_manifest_content_sha256 ~ '^[0-9a-f]{64}$'::text) AND (orchestration_manifest_size_bytes IS NOT NULL) AND (orchestration_manifest_size_bytes >= 0) AND (page_count IS NOT NULL) AND (page_count >= 0) AND (covered_page_count IS NOT NULL) AND (covered_page_count = page_count) AND (document_segment_count IS NOT NULL) AND (document_segment_count > 0) AND (work_unit_count IS NOT NULL) AND (work_unit_count >= 0) AND (unexplained_page_gap_count IS NOT NULL) AND (unexplained_page_gap_count = 0) AND (unresolved_material_attribution_count IS NOT NULL) AND (unresolved_material_attribution_count = 0)))),
    CONSTRAINT extraction_run_status_check CHECK ((status = ANY (ARRAY['writing'::text, 'ready'::text]))),
    CONSTRAINT extraction_run_unexplained_page_gap_count_check CHECK (((unexplained_page_gap_count IS NULL) OR (unexplained_page_gap_count >= 0))),
    CONSTRAINT extraction_run_unresolved_material_attribution_count_check CHECK (((unresolved_material_attribution_count IS NULL) OR (unresolved_material_attribution_count >= 0))),
    CONSTRAINT extraction_run_work_unit_count_check CHECK (((work_unit_count IS NULL) OR (work_unit_count >= 0)))
);

ALTER TABLE ONLY corvis_source.extraction_run FORCE ROW LEVEL SECURITY;


--
-- Name: source_connection; Type: TABLE; Schema: corvis_source; Owner: -
--

CREATE TABLE corvis_source.source_connection (
    tenant_id uuid NOT NULL,
    source_connection_id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider_key text NOT NULL,
    connection_label text NOT NULL,
    credential_type text NOT NULL,
    source_scope jsonb DEFAULT '[]'::jsonb NOT NULL,
    scope_confirmed_by text NOT NULL,
    scope_confirmed_at timestamp with time zone NOT NULL,
    secret_reference text NOT NULL,
    connector_version text NOT NULL,
    status text DEFAULT 'pending_authorization'::text NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_authorized_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    last_error_class text,
    next_scheduled_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT source_connection_connection_label_check CHECK (((length(connection_label) >= 1) AND (length(connection_label) <= 200))),
    CONSTRAINT source_connection_consecutive_failures_check CHECK ((consecutive_failures >= 0)),
    CONSTRAINT source_connection_credential_type_check CHECK ((credential_type = ANY (ARRAY['oauth_authorization_code'::text, 'oauth_client_credentials'::text, 'scoped_api_token'::text, 'service_account'::text, 'browser_session'::text]))),
    CONSTRAINT source_connection_last_error_class_check CHECK ((last_error_class = ANY (ARRAY['auth'::text, 'reauthorization'::text, 'permission'::text, 'provider_change'::text, 'network'::text, 'download'::text, 'validation'::text, 'rate_limit'::text]))),
    CONSTRAINT source_connection_provider_key_check CHECK ((provider_key ~ '^[a-z0-9][a-z0-9_-]{2,63}$'::text)),
    CONSTRAINT source_connection_revoked_is_terminal CHECK (((status = 'revoked'::text) = (revoked_at IS NOT NULL))),
    CONSTRAINT source_connection_secret_reference_tenant_scoped CHECK ((secret_reference ~ (('^projects/[a-z0-9][a-z0-9-]{4,28}[a-z0-9]/secrets/corvis-src-'::text || (tenant_id)::text) || '-[a-z0-9][a-z0-9-]{0,63}(/versions/(latest|[0-9]+))?$'::text))),
    CONSTRAINT source_connection_status_check CHECK ((status = ANY (ARRAY['pending_authorization'::text, 'active'::text, 'paused'::text, 'reauthorization_required'::text, 'suspended'::text, 'revoked'::text])))
);

ALTER TABLE ONLY corvis_source.source_connection FORCE ROW LEVEL SECURITY;


--
-- Name: source_connection_run; Type: TABLE; Schema: corvis_source; Owner: -
--

CREATE TABLE corvis_source.source_connection_run (
    tenant_id uuid NOT NULL,
    run_id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_connection_id uuid NOT NULL,
    trigger text NOT NULL,
    state text NOT NULL,
    attempt integer NOT NULL,
    max_attempts integer NOT NULL,
    connector_version text NOT NULL,
    discovered_count integer DEFAULT 0 NOT NULL,
    accepted_count integer DEFAULT 0 NOT NULL,
    duplicate_count integer DEFAULT 0 NOT NULL,
    rejected_count integer DEFAULT 0 NOT NULL,
    error_class text,
    error_summary text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    CONSTRAINT source_connection_run_accepted_count_check CHECK ((accepted_count >= 0)),
    CONSTRAINT source_connection_run_attempt_check CHECK ((attempt > 0)),
    CONSTRAINT source_connection_run_discovered_count_check CHECK ((discovered_count >= 0)),
    CONSTRAINT source_connection_run_duplicate_count_check CHECK ((duplicate_count >= 0)),
    CONSTRAINT source_connection_run_error_class_check CHECK ((error_class = ANY (ARRAY['auth'::text, 'reauthorization'::text, 'permission'::text, 'provider_change'::text, 'network'::text, 'download'::text, 'validation'::text, 'rate_limit'::text]))),
    CONSTRAINT source_connection_run_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT source_connection_run_rejected_count_check CHECK ((rejected_count >= 0)),
    CONSTRAINT source_connection_run_state_check CHECK ((state = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'retryable'::text, 'dead_letter'::text, 'refused'::text]))),
    CONSTRAINT source_connection_run_trigger_check CHECK ((trigger = ANY (ARRAY['scheduled'::text, 'on_demand'::text, 'webhook'::text, 'backfill'::text])))
);

ALTER TABLE ONLY corvis_source.source_connection_run FORCE ROW LEVEL SECURITY;


--
-- Name: consolidated_fact consolidated_fact_pkey; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidated_fact
    ADD CONSTRAINT consolidated_fact_pkey PRIMARY KEY (consolidated_fact_id);


--
-- Name: consolidated_fact consolidated_fact_tenant_id_consolidated_fact_id_key; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidated_fact
    ADD CONSTRAINT consolidated_fact_tenant_id_consolidated_fact_id_key UNIQUE (tenant_id, consolidated_fact_id);


--
-- Name: consolidation_run consolidation_run_pkey; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidation_run
    ADD CONSTRAINT consolidation_run_pkey PRIMARY KEY (tenant_id, consolidation_run_id);


--
-- Name: consolidation_run consolidation_run_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidation_run
    ADD CONSTRAINT consolidation_run_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: consolidation_run consolidation_run_tenant_id_reconciliation_run_id_key; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidation_run
    ADD CONSTRAINT consolidation_run_tenant_id_reconciliation_run_id_key UNIQUE (tenant_id, reconciliation_run_id);


--
-- Name: fund_period_snapshot fund_period_snapshot_pkey; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.fund_period_snapshot
    ADD CONSTRAINT fund_period_snapshot_pkey PRIMARY KEY (tenant_id, snapshot_id, version);


--
-- Name: publication_run publication_run_pkey; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.publication_run
    ADD CONSTRAINT publication_run_pkey PRIMARY KEY (tenant_id, publication_run_id);


--
-- Name: publication_run publication_run_tenant_id_consolidation_run_id_key; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.publication_run
    ADD CONSTRAINT publication_run_tenant_id_consolidation_run_id_key UNIQUE (tenant_id, consolidation_run_id);


--
-- Name: publication_run publication_run_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.publication_run
    ADD CONSTRAINT publication_run_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: reconciliation_exception reconciliation_exception_pkey; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_exception
    ADD CONSTRAINT reconciliation_exception_pkey PRIMARY KEY (exception_id);


--
-- Name: reconciliation_exception reconciliation_exception_tenant_id_exception_id_key; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_exception
    ADD CONSTRAINT reconciliation_exception_tenant_id_exception_id_key UNIQUE (tenant_id, exception_id);


--
-- Name: reconciliation_exception reconciliation_exception_tenant_id_snapshot_id_snapshot_ver_key; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_exception
    ADD CONSTRAINT reconciliation_exception_tenant_id_snapshot_id_snapshot_ver_key UNIQUE (tenant_id, snapshot_id, snapshot_version, exception_key);


--
-- Name: reconciliation reconciliation_pkey; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation
    ADD CONSTRAINT reconciliation_pkey PRIMARY KEY (reconciliation_id);


--
-- Name: reconciliation_resolution_event reconciliation_resolution_eve_tenant_id_resolution_event_id_key; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_resolution_event
    ADD CONSTRAINT reconciliation_resolution_eve_tenant_id_resolution_event_id_key UNIQUE (tenant_id, resolution_event_id);


--
-- Name: reconciliation_resolution_event reconciliation_resolution_event_pkey; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_resolution_event
    ADD CONSTRAINT reconciliation_resolution_event_pkey PRIMARY KEY (resolution_event_id);


--
-- Name: reconciliation_run reconciliation_run_pkey; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_run
    ADD CONSTRAINT reconciliation_run_pkey PRIMARY KEY (tenant_id, reconciliation_run_id);


--
-- Name: reconciliation_run reconciliation_run_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_run
    ADD CONSTRAINT reconciliation_run_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: reconciliation reconciliation_tenant_id_reconciliation_id_key; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation
    ADD CONSTRAINT reconciliation_tenant_id_reconciliation_id_key UNIQUE (tenant_id, reconciliation_id);


--
-- Name: snapshot_publication_event snapshot_publication_event_pkey; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.snapshot_publication_event
    ADD CONSTRAINT snapshot_publication_event_pkey PRIMARY KEY (publication_event_id);


--
-- Name: snapshot_publication_event snapshot_publication_event_tenant_id_publication_event_id_key; Type: CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.snapshot_publication_event
    ADD CONSTRAINT snapshot_publication_event_tenant_id_publication_event_id_key UNIQUE (tenant_id, publication_event_id);


--
-- Name: api_rate_limit api_rate_limit_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.api_rate_limit
    ADD CONSTRAINT api_rate_limit_pkey PRIMARY KEY (tenant_id, subject);


--
-- Name: audit_event audit_event_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.audit_event
    ADD CONSTRAINT audit_event_pkey PRIMARY KEY (audit_event_id);


--
-- Name: control_definition control_definition_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_definition
    ADD CONSTRAINT control_definition_pkey PRIMARY KEY (tenant_id, control_code);


--
-- Name: control_evidence_escalation control_evidence_escalation_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_escalation
    ADD CONSTRAINT control_evidence_escalation_pkey PRIMARY KEY (escalation_id);


--
-- Name: control_evidence_escalation control_evidence_escalation_tenant_id_escalation_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_escalation
    ADD CONSTRAINT control_evidence_escalation_tenant_id_escalation_id_key UNIQUE (tenant_id, escalation_id);


--
-- Name: control_evidence control_evidence_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence
    ADD CONSTRAINT control_evidence_pkey PRIMARY KEY (evidence_id);


--
-- Name: control_evidence_record control_evidence_record_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_record
    ADD CONSTRAINT control_evidence_record_pkey PRIMARY KEY (evidence_record_id);


--
-- Name: control_evidence_record control_evidence_record_tenant_id_control_code_source_key_r_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_record
    ADD CONSTRAINT control_evidence_record_tenant_id_control_code_source_key_r_key UNIQUE (tenant_id, control_code, source_key, revision);


--
-- Name: control_evidence_record control_evidence_record_tenant_id_evidence_record_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_record
    ADD CONSTRAINT control_evidence_record_tenant_id_evidence_record_id_key UNIQUE (tenant_id, evidence_record_id);


--
-- Name: control_evidence_requirement control_evidence_requirement_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_requirement
    ADD CONSTRAINT control_evidence_requirement_pkey PRIMARY KEY (tenant_id, control_code, source_key);


--
-- Name: control_evidence control_evidence_tenant_id_evidence_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence
    ADD CONSTRAINT control_evidence_tenant_id_evidence_id_key UNIQUE (tenant_id, evidence_id);


--
-- Name: data_correction_incident data_correction_incident_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_correction_incident
    ADD CONSTRAINT data_correction_incident_pkey PRIMARY KEY (incident_id);


--
-- Name: data_correction_incident data_correction_incident_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_correction_incident
    ADD CONSTRAINT data_correction_incident_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: data_correction_incident data_correction_incident_tenant_id_incident_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_correction_incident
    ADD CONSTRAINT data_correction_incident_tenant_id_incident_id_key UNIQUE (tenant_id, incident_id);


--
-- Name: data_issue_case_event data_issue_case_event_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_issue_case_event
    ADD CONSTRAINT data_issue_case_event_pkey PRIMARY KEY (tenant_id, event_id);


--
-- Name: data_issue_case data_issue_case_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_issue_case
    ADD CONSTRAINT data_issue_case_pkey PRIMARY KEY (tenant_id, case_id);


--
-- Name: data_issue_case data_issue_case_tenant_id_reporter_auth_method_reporter_sub_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_issue_case
    ADD CONSTRAINT data_issue_case_tenant_id_reporter_auth_method_reporter_sub_key UNIQUE (tenant_id, reporter_auth_method, reporter_subject, idempotency_key);


--
-- Name: data_rights data_rights_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_rights
    ADD CONSTRAINT data_rights_pkey PRIMARY KEY (rights_id);


--
-- Name: data_rights data_rights_tenant_id_rights_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_rights
    ADD CONSTRAINT data_rights_tenant_id_rights_id_key UNIQUE (tenant_id, rights_id);


--
-- Name: deletion_execution_evidence deletion_execution_evidence_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.deletion_execution_evidence
    ADD CONSTRAINT deletion_execution_evidence_pkey PRIMARY KEY (tenant_id, deletion_request_id, attempt);


--
-- Name: deletion_request deletion_request_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.deletion_request
    ADD CONSTRAINT deletion_request_pkey PRIMARY KEY (deletion_request_id);


--
-- Name: deletion_request deletion_request_tenant_id_deletion_request_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.deletion_request
    ADD CONSTRAINT deletion_request_tenant_id_deletion_request_id_key UNIQUE (tenant_id, deletion_request_id);


--
-- Name: email_outbox email_outbox_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.email_outbox
    ADD CONSTRAINT email_outbox_pkey PRIMARY KEY (email_id);


--
-- Name: email_outbox email_outbox_tenant_id_dedupe_key_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.email_outbox
    ADD CONSTRAINT email_outbox_tenant_id_dedupe_key_key UNIQUE (tenant_id, dedupe_key);


--
-- Name: event_inbox event_inbox_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.event_inbox
    ADD CONSTRAINT event_inbox_pkey PRIMARY KEY (tenant_id, consumer_name, event_id);


--
-- Name: exception exception_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.exception
    ADD CONSTRAINT exception_pkey PRIMARY KEY (exception_id);


--
-- Name: exception exception_tenant_id_exception_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.exception
    ADD CONSTRAINT exception_tenant_id_exception_id_key UNIQUE (tenant_id, exception_id);


--
-- Name: export_schedule export_schedule_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.export_schedule
    ADD CONSTRAINT export_schedule_pkey PRIMARY KEY (tenant_id, schedule_id);


--
-- Name: export_schedule_run export_schedule_run_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.export_schedule_run
    ADD CONSTRAINT export_schedule_run_pkey PRIMARY KEY (tenant_id, run_id);


--
-- Name: export_schedule_run export_schedule_run_tenant_id_schedule_id_trigger_key_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.export_schedule_run
    ADD CONSTRAINT export_schedule_run_tenant_id_schedule_id_trigger_key_key UNIQUE (tenant_id, schedule_id, trigger_key);


--
-- Name: export_schedule export_schedule_tenant_id_owner_auth_method_owner_subject_i_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.export_schedule
    ADD CONSTRAINT export_schedule_tenant_id_owner_auth_method_owner_subject_i_key UNIQUE (tenant_id, owner_auth_method, owner_subject, idempotency_key);


--
-- Name: feature_flag_emergency_stop feature_flag_emergency_stop_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.feature_flag_emergency_stop
    ADD CONSTRAINT feature_flag_emergency_stop_pkey PRIMARY KEY (tenant_id);


--
-- Name: feature_flag feature_flag_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.feature_flag
    ADD CONSTRAINT feature_flag_pkey PRIMARY KEY (tenant_id, flag_key);


--
-- Name: idempotency_key idempotency_key_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.idempotency_key
    ADD CONSTRAINT idempotency_key_pkey PRIMARY KEY (tenant_id, scope, idempotency_key);


--
-- Name: identity_lifecycle_event identity_lifecycle_event_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.identity_lifecycle_event
    ADD CONSTRAINT identity_lifecycle_event_pkey PRIMARY KEY (lifecycle_event_id);


--
-- Name: identity_lifecycle_event identity_lifecycle_event_tenant_id_event_key_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.identity_lifecycle_event
    ADD CONSTRAINT identity_lifecycle_event_tenant_id_event_key_key UNIQUE (tenant_id, event_key);


--
-- Name: identity_subject identity_subject_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.identity_subject
    ADD CONSTRAINT identity_subject_pkey PRIMARY KEY (tenant_id, auth_method, subject);


--
-- Name: identity_subject identity_subject_tenant_id_user_id_auth_method_subject_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.identity_subject
    ADD CONSTRAINT identity_subject_tenant_id_user_id_auth_method_subject_key UNIQUE (tenant_id, user_id, auth_method, subject);


--
-- Name: legal_hold legal_hold_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.legal_hold
    ADD CONSTRAINT legal_hold_pkey PRIMARY KEY (legal_hold_id);


--
-- Name: legal_hold legal_hold_tenant_id_legal_hold_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.legal_hold
    ADD CONSTRAINT legal_hold_tenant_id_legal_hold_id_key UNIQUE (tenant_id, legal_hold_id);


--
-- Name: membership membership_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.membership
    ADD CONSTRAINT membership_pkey PRIMARY KEY (tenant_id, workspace_id, user_id, role_name);


--
-- Name: notification_preference notification_preference_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.notification_preference
    ADD CONSTRAINT notification_preference_pkey PRIMARY KEY (tenant_id, user_id, category);


--
-- Name: notification_recipient notification_recipient_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.notification_recipient
    ADD CONSTRAINT notification_recipient_pkey PRIMARY KEY (tenant_id, user_id);


--
-- Name: oidc_logout_token_use oidc_logout_token_use_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.oidc_logout_token_use
    ADD CONSTRAINT oidc_logout_token_use_pkey PRIMARY KEY (issuer, jti);


--
-- Name: outbox_event outbox_event_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.outbox_event
    ADD CONSTRAINT outbox_event_pkey PRIMARY KEY (event_id);


--
-- Name: outbox_event outbox_event_tenant_id_event_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.outbox_event
    ADD CONSTRAINT outbox_event_tenant_id_event_id_key UNIQUE (tenant_id, event_id);


--
-- Name: processing_job processing_job_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_job
    ADD CONSTRAINT processing_job_pkey PRIMARY KEY (job_id);


--
-- Name: processing_job processing_job_tenant_id_job_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_job
    ADD CONSTRAINT processing_job_tenant_id_job_id_key UNIQUE (tenant_id, job_id);


--
-- Name: processing_recovery_event processing_recovery_event_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_recovery_event
    ADD CONSTRAINT processing_recovery_event_pkey PRIMARY KEY (tenant_id, recovery_event_id);


--
-- Name: processing_stage_effect processing_stage_effect_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_stage_effect
    ADD CONSTRAINT processing_stage_effect_pkey PRIMARY KEY (tenant_id, job_id, effect_key);


--
-- Name: research_answer_pin research_answer_pin_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.research_answer_pin
    ADD CONSTRAINT research_answer_pin_pkey PRIMARY KEY (pin_id);


--
-- Name: resource_entitlement resource_entitlement_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.resource_entitlement
    ADD CONSTRAINT resource_entitlement_pkey PRIMARY KEY (entitlement_id);


--
-- Name: resource_entitlement resource_entitlement_tenant_id_workspace_id_subject_user_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.resource_entitlement
    ADD CONSTRAINT resource_entitlement_tenant_id_workspace_id_subject_user_id_key UNIQUE (tenant_id, workspace_id, subject_user_id, resource_type, resource_id, permission);


--
-- Name: retention_policy retention_policy_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.retention_policy
    ADD CONSTRAINT retention_policy_pkey PRIMARY KEY (tenant_id, data_class, policy_version);


--
-- Name: review_item_comment review_item_comment_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.review_item_comment
    ADD CONSTRAINT review_item_comment_pkey PRIMARY KEY (tenant_id, comment_id);


--
-- Name: review_item_comment review_item_comment_tenant_id_author_auth_method_author_sub_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.review_item_comment
    ADD CONSTRAINT review_item_comment_tenant_id_author_auth_method_author_sub_key UNIQUE (tenant_id, author_auth_method, author_subject, idempotency_key);


--
-- Name: review_item_thread review_item_thread_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.review_item_thread
    ADD CONSTRAINT review_item_thread_pkey PRIMARY KEY (tenant_id, workspace_id, subject_kind, subject_id);


--
-- Name: semantic_query_log semantic_query_log_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.semantic_query_log
    ADD CONSTRAINT semantic_query_log_pkey PRIMARY KEY (tenant_id, semantic_query_id);


--
-- Name: service_account_credential service_account_credential_credential_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_account_credential
    ADD CONSTRAINT service_account_credential_credential_id_key UNIQUE (credential_id);


--
-- Name: service_account_credential service_account_credential_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_account_credential
    ADD CONSTRAINT service_account_credential_pkey PRIMARY KEY (tenant_id, credential_id);


--
-- Name: service_account_credential service_account_credential_secret_sha256_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_account_credential
    ADD CONSTRAINT service_account_credential_secret_sha256_key UNIQUE (secret_sha256);


--
-- Name: service_account service_account_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_account
    ADD CONSTRAINT service_account_pkey PRIMARY KEY (tenant_id, service_account_id);


--
-- Name: service_account service_account_tenant_id_subject_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_account
    ADD CONSTRAINT service_account_tenant_id_subject_key UNIQUE (tenant_id, subject);


--
-- Name: service_account service_account_tenant_id_user_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_account
    ADD CONSTRAINT service_account_tenant_id_user_id_key UNIQUE (tenant_id, user_id);


--
-- Name: service_identity_grant service_identity_grant_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_identity_grant
    ADD CONSTRAINT service_identity_grant_pkey PRIMARY KEY (tenant_id, auth_method, subject);


--
-- Name: session_revocation session_revocation_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.session_revocation
    ADD CONSTRAINT session_revocation_pkey PRIMARY KEY (tenant_id, auth_method, subject, session_id);


--
-- Name: support_access_grant support_access_grant_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.support_access_grant
    ADD CONSTRAINT support_access_grant_pkey PRIMARY KEY (support_grant_id);


--
-- Name: tenant_access_notification tenant_access_notification_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_access_notification
    ADD CONSTRAINT tenant_access_notification_pkey PRIMARY KEY (notification_id);


--
-- Name: tenant_access_notification tenant_access_notification_tenant_id_support_grant_id_kind_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_access_notification
    ADD CONSTRAINT tenant_access_notification_tenant_id_support_grant_id_kind_key UNIQUE (tenant_id, support_grant_id, kind);


--
-- Name: tenant_export_download_grant tenant_export_download_grant_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_export_download_grant
    ADD CONSTRAINT tenant_export_download_grant_pkey PRIMARY KEY (tenant_id, grant_id);


--
-- Name: tenant_export_download_grant tenant_export_download_grant_tenant_id_token_sha256_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_export_download_grant
    ADD CONSTRAINT tenant_export_download_grant_tenant_id_token_sha256_key UNIQUE (tenant_id, token_sha256);


--
-- Name: tenant_export_request_event tenant_export_request_event_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_export_request_event
    ADD CONSTRAINT tenant_export_request_event_pkey PRIMARY KEY (tenant_id, event_id);


--
-- Name: tenant_export_request tenant_export_request_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_export_request
    ADD CONSTRAINT tenant_export_request_pkey PRIMARY KEY (tenant_id, request_id);


--
-- Name: tenant_identity_provider tenant_identity_provider_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_identity_provider
    ADD CONSTRAINT tenant_identity_provider_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_invitation tenant_invitation_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_invitation
    ADD CONSTRAINT tenant_invitation_pkey PRIMARY KEY (invitation_id);


--
-- Name: tenant_invitation tenant_invitation_token_sha256_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_invitation
    ADD CONSTRAINT tenant_invitation_token_sha256_key UNIQUE (token_sha256);


--
-- Name: tenant tenant_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant
    ADD CONSTRAINT tenant_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_scim_configuration tenant_scim_configuration_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_scim_configuration
    ADD CONSTRAINT tenant_scim_configuration_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_scim_identity tenant_scim_identity_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_scim_identity
    ADD CONSTRAINT tenant_scim_identity_pkey PRIMARY KEY (tenant_id, scim_user_id);


--
-- Name: tenant_scim_identity tenant_scim_identity_tenant_id_external_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_scim_identity
    ADD CONSTRAINT tenant_scim_identity_tenant_id_external_id_key UNIQUE (tenant_id, external_id);


--
-- Name: tenant_scim_identity tenant_scim_identity_tenant_id_user_name_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_scim_identity
    ADD CONSTRAINT tenant_scim_identity_tenant_id_user_name_key UNIQUE (tenant_id, user_name);


--
-- Name: tenant_session_activity tenant_session_activity_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_session_activity
    ADD CONSTRAINT tenant_session_activity_pkey PRIMARY KEY (tenant_id, auth_method, subject, session_id);


--
-- Name: tenant_session_policy tenant_session_policy_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_session_policy
    ADD CONSTRAINT tenant_session_policy_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant tenant_slug_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant
    ADD CONSTRAINT tenant_slug_key UNIQUE (slug);


--
-- Name: tenant_verified_domain tenant_verified_domain_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_verified_domain
    ADD CONSTRAINT tenant_verified_domain_pkey PRIMARY KEY (tenant_id, domain);


--
-- Name: webhook_delivery webhook_delivery_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_delivery
    ADD CONSTRAINT webhook_delivery_pkey PRIMARY KEY (delivery_id);


--
-- Name: webhook_delivery webhook_delivery_tenant_id_delivery_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_delivery
    ADD CONSTRAINT webhook_delivery_tenant_id_delivery_id_key UNIQUE (tenant_id, delivery_id);


--
-- Name: webhook_delivery webhook_delivery_tenant_id_webhook_id_event_id_attempt_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_delivery
    ADD CONSTRAINT webhook_delivery_tenant_id_webhook_id_event_id_attempt_key UNIQUE (tenant_id, webhook_id, event_id, attempt);


--
-- Name: webhook_signing_key webhook_signing_key_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_signing_key
    ADD CONSTRAINT webhook_signing_key_pkey PRIMARY KEY (key_id);


--
-- Name: webhook_signing_key webhook_signing_key_tenant_id_key_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_signing_key
    ADD CONSTRAINT webhook_signing_key_tenant_id_key_id_key UNIQUE (tenant_id, key_id);


--
-- Name: webhook_subscription webhook_subscription_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_subscription
    ADD CONSTRAINT webhook_subscription_pkey PRIMARY KEY (webhook_id);


--
-- Name: webhook_subscription webhook_subscription_tenant_id_webhook_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_subscription
    ADD CONSTRAINT webhook_subscription_tenant_id_webhook_id_key UNIQUE (tenant_id, webhook_id);


--
-- Name: workspace workspace_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.workspace
    ADD CONSTRAINT workspace_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace workspace_tenant_id_slug_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.workspace
    ADD CONSTRAINT workspace_tenant_id_slug_key UNIQUE (tenant_id, slug);


--
-- Name: workspace workspace_tenant_id_workspace_id_key; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.workspace
    ADD CONSTRAINT workspace_tenant_id_workspace_id_key UNIQUE (tenant_id, workspace_id);


--
-- Name: workspace_user_preference workspace_user_preference_pkey; Type: CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.workspace_user_preference
    ADD CONSTRAINT workspace_user_preference_pkey PRIMARY KEY (tenant_id, workspace_id, auth_method, subject);


--
-- Name: canonical_candidate canonical_candidate_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.canonical_candidate
    ADD CONSTRAINT canonical_candidate_pkey PRIMARY KEY (tenant_id, canonicalization_run_id, candidate_id);


--
-- Name: canonicalization_run canonicalization_run_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.canonicalization_run
    ADD CONSTRAINT canonicalization_run_pkey PRIMARY KEY (tenant_id, canonicalization_run_id);


--
-- Name: canonicalization_run canonicalization_run_tenant_id_extraction_run_id_review_pol_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.canonicalization_run
    ADD CONSTRAINT canonicalization_run_tenant_id_extraction_run_id_review_pol_key UNIQUE (tenant_id, extraction_run_id, review_policy_version, candidate_set_sha256, decision_set_sha256);


--
-- Name: client_portfolio_fund_position client_portfolio_fund_positio_tenant_id_portfolio_id_positi_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.client_portfolio_fund_position
    ADD CONSTRAINT client_portfolio_fund_positio_tenant_id_portfolio_id_positi_key UNIQUE (tenant_id, portfolio_id, position_key);


--
-- Name: client_portfolio_fund_position client_portfolio_fund_position_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.client_portfolio_fund_position
    ADD CONSTRAINT client_portfolio_fund_position_pkey PRIMARY KEY (tenant_id, portfolio_fund_position_id);


--
-- Name: client_portfolio client_portfolio_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.client_portfolio
    ADD CONSTRAINT client_portfolio_pkey PRIMARY KEY (tenant_id, portfolio_id);


--
-- Name: client_portfolio client_portfolio_tenant_id_workspace_id_portfolio_key_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.client_portfolio
    ADD CONSTRAINT client_portfolio_tenant_id_workspace_id_portfolio_key_key UNIQUE (tenant_id, workspace_id, portfolio_key);


--
-- Name: company_sector_classification company_sector_classification_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.company_sector_classification
    ADD CONSTRAINT company_sector_classification_pkey PRIMARY KEY (tenant_id, classification_id);


--
-- Name: company_sector_classification company_sector_classification_tenant_id_company_id_version_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.company_sector_classification
    ADD CONSTRAINT company_sector_classification_tenant_id_company_id_version_key UNIQUE (tenant_id, company_id, version);


--
-- Name: holding holding_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.holding
    ADD CONSTRAINT holding_pkey PRIMARY KEY (holding_id);


--
-- Name: holding_revision holding_revision_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.holding_revision
    ADD CONSTRAINT holding_revision_pkey PRIMARY KEY (tenant_id, holding_id, canonicalization_run_id, candidate_id);


--
-- Name: holding holding_tenant_id_holding_id_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.holding
    ADD CONSTRAINT holding_tenant_id_holding_id_key UNIQUE (tenant_id, holding_id);


--
-- Name: instrument instrument_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.instrument
    ADD CONSTRAINT instrument_pkey PRIMARY KEY (instrument_id);


--
-- Name: instrument_revision instrument_revision_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.instrument_revision
    ADD CONSTRAINT instrument_revision_pkey PRIMARY KEY (tenant_id, instrument_id, canonicalization_run_id, candidate_id);


--
-- Name: instrument instrument_tenant_id_instrument_id_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.instrument
    ADD CONSTRAINT instrument_tenant_id_instrument_id_key UNIQUE (tenant_id, instrument_id);


--
-- Name: observation_correction observation_correction_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.observation_correction
    ADD CONSTRAINT observation_correction_pkey PRIMARY KEY (correction_id);


--
-- Name: observation_correction observation_correction_tenant_id_correction_id_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.observation_correction
    ADD CONSTRAINT observation_correction_tenant_id_correction_id_key UNIQUE (tenant_id, correction_id);


--
-- Name: observation observation_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.observation
    ADD CONSTRAINT observation_pkey PRIMARY KEY (observation_id);


--
-- Name: observation_source_reference observation_source_reference_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.observation_source_reference
    ADD CONSTRAINT observation_source_reference_pkey PRIMARY KEY (tenant_id, observation_id, source_reference_id);


--
-- Name: observation observation_tenant_id_observation_id_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.observation
    ADD CONSTRAINT observation_tenant_id_observation_id_key UNIQUE (tenant_id, observation_id);


--
-- Name: position_financial_statement_value position_financial_statement__tenant_id_statement_id_line_i_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement_value
    ADD CONSTRAINT position_financial_statement__tenant_id_statement_id_line_i_key UNIQUE (tenant_id, statement_id, line_id, candidate_id);


--
-- Name: position_financial_statement_line position_financial_statement__tenant_id_statement_id_line_k_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement_line
    ADD CONSTRAINT position_financial_statement__tenant_id_statement_id_line_k_key UNIQUE (tenant_id, statement_id, line_key);


--
-- Name: position_financial_statement_line position_financial_statement_line_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement_line
    ADD CONSTRAINT position_financial_statement_line_pkey PRIMARY KEY (tenant_id, line_id);


--
-- Name: position_financial_statement position_financial_statement_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement
    ADD CONSTRAINT position_financial_statement_pkey PRIMARY KEY (tenant_id, statement_id);


--
-- Name: position_financial_statement position_financial_statement_tenant_id_extraction_run_id_st_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement
    ADD CONSTRAINT position_financial_statement_tenant_id_extraction_run_id_st_key UNIQUE (tenant_id, extraction_run_id, statement_key);


--
-- Name: position_financial_statement_value position_financial_statement_value_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement_value
    ADD CONSTRAINT position_financial_statement_value_pkey PRIMARY KEY (tenant_id, value_id);


--
-- Name: review_event review_event_pkey; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.review_event
    ADD CONSTRAINT review_event_pkey PRIMARY KEY (review_event_id);


--
-- Name: review_event review_event_tenant_id_review_event_id_key; Type: CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.review_event
    ADD CONSTRAINT review_event_tenant_id_review_event_id_key UNIQUE (tenant_id, review_event_id);


--
-- Name: company company_pkey; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.company
    ADD CONSTRAINT company_pkey PRIMARY KEY (global_company_id);


--
-- Name: entity_external_identifier entity_external_identifier_pkey; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_external_identifier
    ADD CONSTRAINT entity_external_identifier_pkey PRIMARY KEY (entity_external_identifier_id);


--
-- Name: entity_lifecycle_event entity_lifecycle_event_pkey; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_lifecycle_event
    ADD CONSTRAINT entity_lifecycle_event_pkey PRIMARY KEY (lifecycle_event_id);


--
-- Name: entity_lifecycle_participant entity_lifecycle_participant_lifecycle_event_id_fund_id_com_key; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_lifecycle_participant
    ADD CONSTRAINT entity_lifecycle_participant_lifecycle_event_id_fund_id_com_key UNIQUE (lifecycle_event_id, fund_id, company_id, participant_role);


--
-- Name: entity_lifecycle_participant entity_lifecycle_participant_pkey; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_lifecycle_participant
    ADD CONSTRAINT entity_lifecycle_participant_pkey PRIMARY KEY (participant_id);


--
-- Name: entity_name entity_name_pkey; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_name
    ADD CONSTRAINT entity_name_pkey PRIMARY KEY (entity_name_id);


--
-- Name: entity_relationship entity_relationship_pkey; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_relationship
    ADD CONSTRAINT entity_relationship_pkey PRIMARY KEY (entity_relationship_id);


--
-- Name: fund fund_pkey; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.fund
    ADD CONSTRAINT fund_pkey PRIMARY KEY (global_fund_id);


--
-- Name: tenant_entity_lifecycle_evidence tenant_entity_lifecycle_evidence_pkey; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_lifecycle_evidence
    ADD CONSTRAINT tenant_entity_lifecycle_evidence_pkey PRIMARY KEY (tenant_id, lifecycle_event_id, source_reference_id);


--
-- Name: tenant_entity_name tenant_entity_name_pkey; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_name
    ADD CONSTRAINT tenant_entity_name_pkey PRIMARY KEY (tenant_id, tenant_entity_name_id);


--
-- Name: tenant_entity_revision tenant_entity_revision_pkey; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_revision
    ADD CONSTRAINT tenant_entity_revision_pkey PRIMARY KEY (tenant_id, canonicalization_run_id, candidate_id);


--
-- Name: tenant_lifecycle_revision tenant_lifecycle_revision_pkey; Type: CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_lifecycle_revision
    ADD CONSTRAINT tenant_lifecycle_revision_pkey PRIMARY KEY (tenant_id, lifecycle_event_id, canonicalization_run_id, candidate_id);


--
-- Name: candidate_review_event candidate_review_event_pkey; Type: CONSTRAINT; Schema: corvis_review; Owner: -
--

ALTER TABLE ONLY corvis_review.candidate_review_event
    ADD CONSTRAINT candidate_review_event_pkey PRIMARY KEY (tenant_id, review_event_id);


--
-- Name: candidate_review_event candidate_review_event_tenant_id_extraction_run_id_candidat_key; Type: CONSTRAINT; Schema: corvis_review; Owner: -
--

ALTER TABLE ONLY corvis_review.candidate_review_event
    ADD CONSTRAINT candidate_review_event_tenant_id_extraction_run_id_candidat_key UNIQUE (tenant_id, extraction_run_id, candidate_id, event_sequence);


--
-- Name: candidate_review_requirement candidate_review_requirement_pkey; Type: CONSTRAINT; Schema: corvis_review; Owner: -
--

ALTER TABLE ONLY corvis_review.candidate_review_requirement
    ADD CONSTRAINT candidate_review_requirement_pkey PRIMARY KEY (tenant_id, extraction_run_id, candidate_id, review_policy_version);


--
-- Name: extraction_review_gate extraction_review_gate_pkey; Type: CONSTRAINT; Schema: corvis_review; Owner: -
--

ALTER TABLE ONLY corvis_review.extraction_review_gate
    ADD CONSTRAINT extraction_review_gate_pkey PRIMARY KEY (tenant_id, extraction_run_id, review_policy_version);


--
-- Name: metric_definition metric_definition_pkey; Type: CONSTRAINT; Schema: corvis_semantic; Owner: -
--

ALTER TABLE ONLY corvis_semantic.metric_definition
    ADD CONSTRAINT metric_definition_pkey PRIMARY KEY (metric_code, definition_version);


--
-- Name: sector_alias sector_alias_pkey; Type: CONSTRAINT; Schema: corvis_semantic; Owner: -
--

ALTER TABLE ONLY corvis_semantic.sector_alias
    ADD CONSTRAINT sector_alias_pkey PRIMARY KEY (taxonomy_version, alias_normalized);


--
-- Name: sector sector_pkey; Type: CONSTRAINT; Schema: corvis_semantic; Owner: -
--

ALTER TABLE ONLY corvis_semantic.sector
    ADD CONSTRAINT sector_pkey PRIMARY KEY (taxonomy_version, sector_code);


--
-- Name: sector sector_taxonomy_version_display_order_key; Type: CONSTRAINT; Schema: corvis_semantic; Owner: -
--

ALTER TABLE ONLY corvis_semantic.sector
    ADD CONSTRAINT sector_taxonomy_version_display_order_key UNIQUE (taxonomy_version, display_order);


--
-- Name: export_download_grant export_download_grant_pkey; Type: CONSTRAINT; Schema: corvis_serving; Owner: -
--

ALTER TABLE ONLY corvis_serving.export_download_grant
    ADD CONSTRAINT export_download_grant_pkey PRIMARY KEY (grant_id);


--
-- Name: export_download_grant export_download_grant_tenant_id_grant_id_key; Type: CONSTRAINT; Schema: corvis_serving; Owner: -
--

ALTER TABLE ONLY corvis_serving.export_download_grant
    ADD CONSTRAINT export_download_grant_tenant_id_grant_id_key UNIQUE (tenant_id, grant_id);


--
-- Name: export_download_grant export_download_grant_token_sha256_key; Type: CONSTRAINT; Schema: corvis_serving; Owner: -
--

ALTER TABLE ONLY corvis_serving.export_download_grant
    ADD CONSTRAINT export_download_grant_token_sha256_key UNIQUE (token_sha256);


--
-- Name: export_job export_job_pkey; Type: CONSTRAINT; Schema: corvis_serving; Owner: -
--

ALTER TABLE ONLY corvis_serving.export_job
    ADD CONSTRAINT export_job_pkey PRIMARY KEY (export_id);


--
-- Name: export_job export_job_tenant_id_export_id_key; Type: CONSTRAINT; Schema: corvis_serving; Owner: -
--

ALTER TABLE ONLY corvis_serving.export_job
    ADD CONSTRAINT export_job_tenant_id_export_id_key UNIQUE (tenant_id, export_id);


--
-- Name: acquired_document acquired_document_pkey; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.acquired_document
    ADD CONSTRAINT acquired_document_pkey PRIMARY KEY (acquisition_id);


--
-- Name: acquired_document acquired_document_tenant_id_acquisition_id_key; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.acquired_document
    ADD CONSTRAINT acquired_document_tenant_id_acquisition_id_key UNIQUE (tenant_id, acquisition_id);



--
-- Name: document_artifact_version document_artifact_version_pkey; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document_artifact_version
    ADD CONSTRAINT document_artifact_version_pkey PRIMARY KEY (document_artifact_version_id);


--
-- Name: document_artifact_version document_artifact_version_tenant_id_document_artifact_versi_key; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document_artifact_version
    ADD CONSTRAINT document_artifact_version_tenant_id_document_artifact_versi_key UNIQUE (tenant_id, document_artifact_version_id);


--
-- Name: document_artifact_version document_artifact_version_tenant_id_ingestion_id_key; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document_artifact_version
    ADD CONSTRAINT document_artifact_version_tenant_id_ingestion_id_key UNIQUE (tenant_id, ingestion_id);


--
-- Name: document document_pkey; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document
    ADD CONSTRAINT document_pkey PRIMARY KEY (document_id);


--
-- Name: document_representation document_representation_pkey; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document_representation
    ADD CONSTRAINT document_representation_pkey PRIMARY KEY (tenant_id, representation_id);


--
-- Name: document_representation document_representation_tenant_id_document_artifact_version_key; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document_representation
    ADD CONSTRAINT document_representation_tenant_id_document_artifact_version_key UNIQUE (tenant_id, document_artifact_version_id, representation_type);


--
-- Name: document document_tenant_id_document_id_key; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document
    ADD CONSTRAINT document_tenant_id_document_id_key UNIQUE (tenant_id, document_id);


--
-- Name: extraction_candidate extraction_candidate_pkey; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_candidate
    ADD CONSTRAINT extraction_candidate_pkey PRIMARY KEY (tenant_id, extraction_run_id, candidate_id);


--
-- Name: extraction_candidate_source_reference extraction_candidate_source_r_tenant_id_extraction_run_id_c_key; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_candidate_source_reference
    ADD CONSTRAINT extraction_candidate_source_r_tenant_id_extraction_run_id_c_key UNIQUE (tenant_id, extraction_run_id, candidate_id, reference_key);


--
-- Name: extraction_candidate_source_reference extraction_candidate_source_reference_pkey; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_candidate_source_reference
    ADD CONSTRAINT extraction_candidate_source_reference_pkey PRIMARY KEY (tenant_id, extraction_run_id, source_reference_id);


--
-- Name: extraction_candidate extraction_candidate_tenant_id_extraction_run_id_candidate__key; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_candidate
    ADD CONSTRAINT extraction_candidate_tenant_id_extraction_run_id_candidate__key UNIQUE (tenant_id, extraction_run_id, candidate_key);


--
-- Name: extraction_run extraction_run_pkey; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_run
    ADD CONSTRAINT extraction_run_pkey PRIMARY KEY (tenant_id, extraction_run_id);


--
-- Name: extraction_run extraction_run_tenant_id_representation_id_extraction_contr_key; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_run
    ADD CONSTRAINT extraction_run_tenant_id_representation_id_extraction_contr_key UNIQUE (tenant_id, representation_id, extraction_contract_version, schema_version, skill_id, skill_version);


--
-- Name: source_connection source_connection_pkey; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_connection
    ADD CONSTRAINT source_connection_pkey PRIMARY KEY (source_connection_id);


--
-- Name: source_connection_run source_connection_run_pkey; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_connection_run
    ADD CONSTRAINT source_connection_run_pkey PRIMARY KEY (run_id);


--
-- Name: source_connection_run source_connection_run_tenant_id_run_id_key; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_connection_run
    ADD CONSTRAINT source_connection_run_tenant_id_run_id_key UNIQUE (tenant_id, run_id);


--
-- Name: source_connection source_connection_tenant_id_source_connection_id_key; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_connection
    ADD CONSTRAINT source_connection_tenant_id_source_connection_id_key UNIQUE (tenant_id, source_connection_id);


--
-- Name: source_reference source_reference_pkey; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_reference
    ADD CONSTRAINT source_reference_pkey PRIMARY KEY (source_reference_id);


--
-- Name: source_reference source_reference_tenant_id_source_reference_id_key; Type: CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_reference
    ADD CONSTRAINT source_reference_tenant_id_source_reference_id_key UNIQUE (tenant_id, source_reference_id);


--
-- Name: consolidated_fact_processing_identity_uniq; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE UNIQUE INDEX consolidated_fact_processing_identity_uniq ON corvis_consolidated.consolidated_fact USING btree (tenant_id, reconciliation_run_id, semantic_grain_hash, normalized_value_hash) WHERE ((reconciliation_run_id IS NOT NULL) AND (semantic_grain_hash IS NOT NULL) AND (normalized_value_hash IS NOT NULL));


--
-- Name: consolidated_fact_snapshot_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX consolidated_fact_snapshot_idx ON corvis_consolidated.consolidated_fact USING btree (tenant_id, snapshot_id, snapshot_version, metric_code) WHERE (snapshot_id IS NOT NULL);


--
-- Name: consolidation_run_document_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX consolidation_run_document_idx ON corvis_consolidated.consolidation_run USING btree (tenant_id, document_id, completed_at DESC);


--
-- Name: consolidation_run_snapshot_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX consolidation_run_snapshot_idx ON corvis_consolidated.consolidation_run USING btree (tenant_id, snapshot_id, snapshot_version, completed_at DESC);


--
-- Name: publication_run_document_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX publication_run_document_idx ON corvis_consolidated.publication_run USING btree (tenant_id, document_id, completed_at DESC);


--
-- Name: publication_run_snapshot_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX publication_run_snapshot_idx ON corvis_consolidated.publication_run USING btree (tenant_id, snapshot_id, published_snapshot_version, completed_at DESC);


--
-- Name: reconciliation_exception_fund_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX reconciliation_exception_fund_idx ON corvis_consolidated.reconciliation_exception USING btree (tenant_id, fund_id, report_period, status);


--
-- Name: reconciliation_exception_run_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX reconciliation_exception_run_idx ON corvis_consolidated.reconciliation_exception USING btree (tenant_id, reconciliation_run_id, status, created_at) WHERE (reconciliation_run_id IS NOT NULL);


--
-- Name: reconciliation_exception_snapshot_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX reconciliation_exception_snapshot_idx ON corvis_consolidated.reconciliation_exception USING btree (tenant_id, snapshot_id, snapshot_version, status, created_at);


--
-- Name: reconciliation_resolution_exception_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX reconciliation_resolution_exception_idx ON corvis_consolidated.reconciliation_resolution_event USING btree (tenant_id, exception_id, created_at DESC);


--
-- Name: reconciliation_run_canonicalization_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX reconciliation_run_canonicalization_idx ON corvis_consolidated.reconciliation_run USING btree (tenant_id, canonicalization_run_id, created_at DESC);


--
-- Name: reconciliation_run_document_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX reconciliation_run_document_idx ON corvis_consolidated.reconciliation_run USING btree (tenant_id, document_id, created_at DESC);


--
-- Name: reconciliation_run_fund_created_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX reconciliation_run_fund_created_idx ON corvis_consolidated.reconciliation_run USING btree (tenant_id, fund_id, created_at DESC);


--
-- Name: reconciliation_run_snapshot_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX reconciliation_run_snapshot_idx ON corvis_consolidated.reconciliation_run USING btree (tenant_id, snapshot_id, snapshot_version, status, created_at);


--
-- Name: snapshot_tenant_fund_period_idx; Type: INDEX; Schema: corvis_consolidated; Owner: -
--

CREATE INDEX snapshot_tenant_fund_period_idx ON corvis_consolidated.fund_period_snapshot USING btree (tenant_id, fund_id, report_period, version DESC);


--
-- Name: audit_event_tenant_time_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX audit_event_tenant_time_idx ON corvis_control.audit_event USING btree (tenant_id, occurred_at DESC);


--
-- Name: control_evidence_escalation_open_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE UNIQUE INDEX control_evidence_escalation_open_idx ON corvis_control.control_evidence_escalation USING btree (tenant_id, control_code, source_key) WHERE (resolved_at IS NULL);


--
-- Name: control_evidence_record_currency_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX control_evidence_record_currency_idx ON corvis_control.control_evidence_record USING btree (tenant_id, control_code, source_key, revision DESC);


--
-- Name: data_correction_open_scope_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX data_correction_open_scope_idx ON corvis_control.data_correction_incident USING btree (tenant_id, fund_id, report_period, opened_at DESC) WHERE (state = ANY (ARRAY['open'::text, 'reprocessing'::text]));


--
-- Name: data_issue_case_correction_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX data_issue_case_correction_idx ON corvis_control.data_issue_case USING btree (tenant_id, correction_incident_id) WHERE (correction_incident_id IS NOT NULL);


--
-- Name: data_issue_case_event_case_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX data_issue_case_event_case_idx ON corvis_control.data_issue_case_event USING btree (tenant_id, case_id, event_seq);


--
-- Name: data_issue_case_reporter_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX data_issue_case_reporter_idx ON corvis_control.data_issue_case USING btree (tenant_id, reporter_auth_method, reporter_subject, created_at DESC, case_id DESC);


--
-- Name: data_issue_case_tenant_created_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX data_issue_case_tenant_created_idx ON corvis_control.data_issue_case USING btree (tenant_id, created_at DESC, case_id DESC);


--
-- Name: data_rights_active_resource_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX data_rights_active_resource_idx ON corvis_control.data_rights USING btree (tenant_id, resource_type, resource_id, effective_from, effective_to);


--
-- Name: deletion_execution_evidence_request_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX deletion_execution_evidence_request_idx ON corvis_control.deletion_execution_evidence USING btree (tenant_id, deletion_request_id, attempt DESC);


--
-- Name: deletion_request_customer_pending_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE UNIQUE INDEX deletion_request_customer_pending_idx ON corvis_control.deletion_request USING btree (tenant_id) WHERE (state = 'pending_customer_approval'::text);


--
-- Name: deletion_request_tenant_requested_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX deletion_request_tenant_requested_idx ON corvis_control.deletion_request USING btree (tenant_id, requested_at DESC, deletion_request_id DESC);


--
-- Name: email_outbox_digest_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX email_outbox_digest_idx ON corvis_control.email_outbox USING btree (tenant_id, recipient_user_id, created_at) WHERE (status = 'digest_pending'::text);


--
-- Name: email_outbox_dispatch_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX email_outbox_dispatch_idx ON corvis_control.email_outbox USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'retry'::text, 'sending'::text]));


--
-- Name: email_outbox_tenant_created_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX email_outbox_tenant_created_idx ON corvis_control.email_outbox USING btree (tenant_id, created_at DESC);


--
-- Name: entitlement_subject_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX entitlement_subject_idx ON corvis_control.resource_entitlement USING btree (tenant_id, workspace_id, subject_user_id, resource_type, resource_id);


--
-- Name: event_inbox_aggregate_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX event_inbox_aggregate_idx ON corvis_control.event_inbox USING btree (tenant_id, aggregate_type, aggregate_id, first_received_at);


--
-- Name: event_inbox_dispatch_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX event_inbox_dispatch_idx ON corvis_control.event_inbox USING btree (tenant_id, consumer_name, state, next_attempt_at, lease_expires_at);


--
-- Name: exception_open_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX exception_open_idx ON corvis_control.exception USING btree (tenant_id, snapshot_id, severity) WHERE (state = 'open'::text);


--
-- Name: export_schedule_calendar_due_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX export_schedule_calendar_due_idx ON corvis_control.export_schedule USING btree (next_run_at) WHERE ((status = 'active'::text) AND (trigger_kind <> 'on_publish'::text));


--
-- Name: export_schedule_on_publish_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX export_schedule_on_publish_idx ON corvis_control.export_schedule USING btree (tenant_id, scope_fund_id) WHERE ((status = 'active'::text) AND (trigger_kind = 'on_publish'::text));


--
-- Name: export_schedule_owner_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX export_schedule_owner_idx ON corvis_control.export_schedule USING btree (tenant_id, owner_auth_method, owner_subject, created_at DESC, schedule_id DESC) WHERE (status <> 'deleted'::text);


--
-- Name: export_schedule_run_export_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX export_schedule_run_export_idx ON corvis_control.export_schedule_run USING btree (tenant_id, export_id) WHERE (export_id IS NOT NULL);


--
-- Name: export_schedule_run_schedule_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX export_schedule_run_schedule_idx ON corvis_control.export_schedule_run USING btree (tenant_id, schedule_id, created_at DESC, run_id DESC);


--
-- Name: export_schedule_run_tenant_created_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX export_schedule_run_tenant_created_idx ON corvis_control.export_schedule_run USING btree (tenant_id, created_at DESC, run_id DESC);


--
-- Name: export_schedule_tenant_created_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX export_schedule_tenant_created_idx ON corvis_control.export_schedule USING btree (tenant_id, created_at DESC, schedule_id DESC) WHERE (status <> 'deleted'::text);


--
-- Name: feature_flag_retirement_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX feature_flag_retirement_idx ON corvis_control.feature_flag USING btree (tenant_id, retire_by) WHERE (retired_at IS NULL);


--
-- Name: idempotency_key_expires_at_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX idempotency_key_expires_at_idx ON corvis_control.idempotency_key USING btree (expires_at);


--
-- Name: identity_lifecycle_event_user_time_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX identity_lifecycle_event_user_time_idx ON corvis_control.identity_lifecycle_event USING btree (tenant_id, user_id, created_at DESC);


--
-- Name: identity_subject_user_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX identity_subject_user_idx ON corvis_control.identity_subject USING btree (tenant_id, user_id) WHERE (status = 'active'::text);


--
-- Name: legal_hold_active_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX legal_hold_active_idx ON corvis_control.legal_hold USING btree (tenant_id, data_class) WHERE (released_at IS NULL);


--
-- Name: membership_user_active_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX membership_user_active_idx ON corvis_control.membership USING btree (user_id, tenant_id, workspace_id) WHERE (status = 'active'::text);


--
-- Name: oidc_logout_token_use_used_at_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX oidc_logout_token_use_used_at_idx ON corvis_control.oidc_logout_token_use USING btree (used_at);


--
-- Name: outbox_processing_transport_claim_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX outbox_processing_transport_claim_idx ON corvis_control.outbox_event USING btree (COALESCE(next_attempt_at, created_at), created_at, event_id) WHERE ((published_at IS NULL) AND (transport_dead_lettered_at IS NULL) AND (event_type = ANY (ARRAY['DocumentRegistered'::text, 'ProcessingStageReady'::text, 'ProcessingStageRetryScheduled'::text, 'ProcessingJobRetryRequested'::text])));


--
-- Name: outbox_processing_transport_ready_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX outbox_processing_transport_ready_idx ON corvis_control.outbox_event USING btree (COALESCE(next_attempt_at, created_at), created_at) WHERE ((published_at IS NULL) AND (transport_dead_lettered_at IS NULL));


--
-- Name: outbox_unpublished_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX outbox_unpublished_idx ON corvis_control.outbox_event USING btree (created_at) WHERE (published_at IS NULL);


--
-- Name: outbox_webhook_fanout_pending_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX outbox_webhook_fanout_pending_idx ON corvis_control.outbox_event USING btree (tenant_id, event_type, created_at) WHERE (webhook_fanout_completed_at IS NULL);


--
-- Name: processing_job_document_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX processing_job_document_idx ON corvis_control.processing_job USING btree (tenant_id, document_id, updated_at DESC);


--
-- Name: processing_recovery_job_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX processing_recovery_job_idx ON corvis_control.processing_recovery_event USING btree (tenant_id, job_id, created_at DESC);


--
-- Name: processing_stage_effect_document_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX processing_stage_effect_document_idx ON corvis_control.processing_stage_effect USING btree (tenant_id, document_id, stage, last_started_at DESC);


--
-- Name: research_answer_pin_subject_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX research_answer_pin_subject_idx ON corvis_control.research_answer_pin USING btree (tenant_id, workspace_id, auth_method, subject, pinned_at DESC);


--
-- Name: review_item_comment_thread_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX review_item_comment_thread_idx ON corvis_control.review_item_comment USING btree (tenant_id, workspace_id, subject_kind, subject_id, comment_seq);


--
-- Name: review_item_thread_assignee_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX review_item_thread_assignee_idx ON corvis_control.review_item_thread USING btree (tenant_id, workspace_id, assignee_user_id, assignment_changed_at DESC) WHERE (assignee_user_id IS NOT NULL);


--
-- Name: review_item_thread_listing_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX review_item_thread_listing_idx ON corvis_control.review_item_thread USING btree (tenant_id, workspace_id, subject_kind, subject_id);


--
-- Name: semantic_query_tenant_time_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX semantic_query_tenant_time_idx ON corvis_control.semantic_query_log USING btree (tenant_id, created_at DESC);


--
-- Name: service_account_active_expiry_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX service_account_active_expiry_idx ON corvis_control.service_account USING btree (expires_at) WHERE (status = 'active'::text);


--
-- Name: service_account_active_name_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE UNIQUE INDEX service_account_active_name_idx ON corvis_control.service_account USING btree (tenant_id, lower(btrim(display_name))) WHERE (status = 'active'::text);


--
-- Name: service_account_credential_account_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX service_account_credential_account_idx ON corvis_control.service_account_credential USING btree (tenant_id, service_account_id, created_at DESC);


--
-- Name: service_account_credential_current_expiry_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX service_account_credential_current_expiry_idx ON corvis_control.service_account_credential USING btree (expires_at) WHERE ((status = 'active'::text) AND (ends_at IS NULL));


--
-- Name: service_account_credential_current_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE UNIQUE INDEX service_account_credential_current_idx ON corvis_control.service_account_credential USING btree (tenant_id, service_account_id) WHERE ((status = 'active'::text) AND (ends_at IS NULL));


--
-- Name: service_account_tenant_created_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX service_account_tenant_created_idx ON corvis_control.service_account USING btree (tenant_id, created_at DESC, service_account_id DESC);


--
-- Name: service_identity_grant_active_expiry_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX service_identity_grant_active_expiry_idx ON corvis_control.service_identity_grant USING btree (tenant_id, valid_until, next_review_at) WHERE (status = 'active'::text);


--
-- Name: session_revocation_tenant_subject_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX session_revocation_tenant_subject_idx ON corvis_control.session_revocation USING btree (tenant_id, auth_method, subject, revoked_at DESC);


--
-- Name: support_access_grant_active_expiry_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX support_access_grant_active_expiry_idx ON corvis_control.support_access_grant USING btree (tenant_id, valid_until, workspace_id) WHERE (status = 'active'::text);


--
-- Name: support_access_grant_pending_ack_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX support_access_grant_pending_ack_idx ON corvis_control.support_access_grant USING btree (tenant_id, valid_until, created_at) WHERE (status = 'pending_ack'::text);


--
-- Name: tenant_access_notification_unread_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_access_notification_unread_idx ON corvis_control.tenant_access_notification USING btree (tenant_id, created_at DESC) WHERE (read_at IS NULL);


--
-- Name: tenant_export_download_grant_expiry_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_export_download_grant_expiry_idx ON corvis_control.tenant_export_download_grant USING btree (expires_at);


--
-- Name: tenant_export_download_grant_request_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_export_download_grant_request_idx ON corvis_control.tenant_export_download_grant USING btree (tenant_id, request_id, expires_at DESC);


--
-- Name: tenant_export_request_active_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE UNIQUE INDEX tenant_export_request_active_idx ON corvis_control.tenant_export_request USING btree (tenant_id) WHERE (state = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'building'::text]));


--
-- Name: tenant_export_request_artifact_sweep_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_export_request_artifact_sweep_idx ON corvis_control.tenant_export_request USING btree (artifact_expires_at) WHERE ((state = 'complete'::text) AND (artifact_deleted_at IS NULL));


--
-- Name: tenant_export_request_build_queue_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_export_request_build_queue_idx ON corvis_control.tenant_export_request USING btree (build_next_attempt_at) WHERE (state = 'approved'::text);


--
-- Name: tenant_export_request_event_request_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_export_request_event_request_idx ON corvis_control.tenant_export_request_event USING btree (tenant_id, request_id, event_seq);


--
-- Name: tenant_export_request_failed_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_export_request_failed_idx ON corvis_control.tenant_export_request USING btree (state_changed_at DESC, request_id DESC) WHERE ((state = 'failed'::text) OR (last_error IS NOT NULL));


--
-- Name: tenant_export_request_tenant_requested_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_export_request_tenant_requested_idx ON corvis_control.tenant_export_request USING btree (tenant_id, requested_at DESC, request_id DESC);


--
-- Name: tenant_invitation_pending_email_uq; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE UNIQUE INDEX tenant_invitation_pending_email_uq ON corvis_control.tenant_invitation USING btree (tenant_id, workspace_id, email) WHERE (status = 'pending'::text);


--
-- Name: tenant_invitation_pending_expiry_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_invitation_pending_expiry_idx ON corvis_control.tenant_invitation USING btree (expires_at) WHERE (status = 'pending'::text);


--
-- Name: tenant_invitation_tenant_created_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_invitation_tenant_created_idx ON corvis_control.tenant_invitation USING btree (tenant_id, created_at DESC);


--
-- Name: tenant_scim_identity_user_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_scim_identity_user_idx ON corvis_control.tenant_scim_identity USING btree (tenant_id, user_id);


--
-- Name: tenant_session_activity_last_seen_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_session_activity_last_seen_idx ON corvis_control.tenant_session_activity USING btree (last_seen_at);


--
-- Name: tenant_session_activity_subject_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX tenant_session_activity_subject_idx ON corvis_control.tenant_session_activity USING btree (tenant_id, auth_method, subject, last_seen_at DESC);


--
-- Name: tenant_verified_domain_domain_key; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE UNIQUE INDEX tenant_verified_domain_domain_key ON corvis_control.tenant_verified_domain USING btree (domain);


--
-- Name: webhook_delivery_delivering_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX webhook_delivery_delivering_idx ON corvis_control.webhook_delivery USING btree (created_at) WHERE (state = 'delivering'::text);


--
-- Name: webhook_delivery_diagnostics_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX webhook_delivery_diagnostics_idx ON corvis_control.webhook_delivery USING btree (tenant_id, webhook_id, created_at DESC, delivery_id DESC);


--
-- Name: webhook_delivery_event_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX webhook_delivery_event_idx ON corvis_control.webhook_delivery USING btree (tenant_id, webhook_id, event_id, state);


--
-- Name: webhook_delivery_retry_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX webhook_delivery_retry_idx ON corvis_control.webhook_delivery USING btree (tenant_id, state, next_attempt_at);


--
-- Name: webhook_signing_key_lookup_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX webhook_signing_key_lookup_idx ON corvis_control.webhook_signing_key USING btree (tenant_id, webhook_id, status);


--
-- Name: webhook_signing_key_one_active_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE UNIQUE INDEX webhook_signing_key_one_active_idx ON corvis_control.webhook_signing_key USING btree (tenant_id, webhook_id) WHERE (status = 'active'::text);


--
-- Name: workspace_user_preference_subject_idx; Type: INDEX; Schema: corvis_control; Owner: -
--

CREATE INDEX workspace_user_preference_subject_idx ON corvis_control.workspace_user_preference USING btree (tenant_id, auth_method, subject, workspace_id);


--
-- Name: canonical_candidate_run_type_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX canonical_candidate_run_type_idx ON corvis_facts.canonical_candidate USING btree (tenant_id, canonicalization_run_id, candidate_type, candidate_key);


--
-- Name: canonicalization_run_document_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX canonicalization_run_document_idx ON corvis_facts.canonicalization_run USING btree (tenant_id, document_id, completed_at DESC);


--
-- Name: client_portfolio_fund_fund_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX client_portfolio_fund_fund_idx ON corvis_facts.client_portfolio_fund_position USING btree (tenant_id, fund_id, portfolio_id);


--
-- Name: client_portfolio_fund_portfolio_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX client_portfolio_fund_portfolio_idx ON corvis_facts.client_portfolio_fund_position USING btree (tenant_id, portfolio_id, fund_id, portfolio_fund_position_id);


--
-- Name: client_portfolio_workspace_status_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX client_portfolio_workspace_status_idx ON corvis_facts.client_portfolio USING btree (tenant_id, workspace_id, status, display_name, portfolio_id);


--
-- Name: company_sector_classification_current_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE UNIQUE INDEX company_sector_classification_current_idx ON corvis_facts.company_sector_classification USING btree (tenant_id, company_id) WHERE (superseded_at IS NULL);


--
-- Name: holding_company_target_review_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX holding_company_target_review_idx ON corvis_facts.holding USING btree (tenant_id, target_company_id, review_state) WHERE (target_company_id IS NOT NULL);


--
-- Name: holding_fund_target_review_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX holding_fund_target_review_idx ON corvis_facts.holding USING btree (tenant_id, target_fund_id, review_state) WHERE (target_fund_id IS NOT NULL);


--
-- Name: holding_revision_lineage_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX holding_revision_lineage_idx ON corvis_facts.holding_revision USING btree (tenant_id, canonicalization_run_id, candidate_id);


--
-- Name: holding_tenant_fund_review_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX holding_tenant_fund_review_idx ON corvis_facts.holding USING btree (tenant_id, fund_id, review_state, updated_at DESC);


--
-- Name: instrument_holding_review_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX instrument_holding_review_idx ON corvis_facts.instrument USING btree (tenant_id, holding_id, review_state, updated_at DESC);


--
-- Name: instrument_revision_lineage_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX instrument_revision_lineage_idx ON corvis_facts.instrument_revision USING btree (tenant_id, canonicalization_run_id, candidate_id);


--
-- Name: observation_correction_latest_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX observation_correction_latest_idx ON corvis_facts.observation_correction USING btree (tenant_id, observation_id, created_at DESC);


--
-- Name: observation_extraction_candidate_uniq; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE UNIQUE INDEX observation_extraction_candidate_uniq ON corvis_facts.observation USING btree (tenant_id, extraction_run_id, candidate_id) WHERE ((extraction_run_id IS NOT NULL) AND (candidate_id IS NOT NULL));


--
-- Name: observation_source_reference_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX observation_source_reference_idx ON corvis_facts.observation USING btree (tenant_id, source_reference_id);


--
-- Name: observation_source_reference_source_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX observation_source_reference_source_idx ON corvis_facts.observation_source_reference USING btree (tenant_id, source_reference_id, observation_id);


--
-- Name: observation_tenant_fund_metric_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX observation_tenant_fund_metric_idx ON corvis_facts.observation USING btree (tenant_id, fund_id, metric_code, updated_at DESC);


--
-- Name: position_financial_statement_company_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX position_financial_statement_company_idx ON corvis_facts.position_financial_statement USING btree (tenant_id, company_id, statement_type, source_document_period_end DESC);


--
-- Name: position_financial_statement_line_order_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX position_financial_statement_line_order_idx ON corvis_facts.position_financial_statement_line USING btree (tenant_id, statement_id, display_order, line_id);


--
-- Name: position_financial_statement_position_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX position_financial_statement_position_idx ON corvis_facts.position_financial_statement USING btree (tenant_id, fund_id, holding_id, statement_type, source_document_period_end DESC);


--
-- Name: position_financial_statement_value_period_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX position_financial_statement_value_period_idx ON corvis_facts.position_financial_statement_value USING btree (tenant_id, statement_id, period_type, fiscal_year, fiscal_quarter, period_end);


--
-- Name: review_event_tenant_observation_decision_idx; Type: INDEX; Schema: corvis_facts; Owner: -
--

CREATE INDEX review_event_tenant_observation_decision_idx ON corvis_facts.review_event USING btree (tenant_id, observation_id, decision);


--
-- Name: entity_external_identifier_company_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_external_identifier_company_idx ON corvis_identity.entity_external_identifier USING btree (company_id, is_current DESC, identifier_type) WHERE (company_id IS NOT NULL);


--
-- Name: entity_external_identifier_fund_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_external_identifier_fund_idx ON corvis_identity.entity_external_identifier USING btree (fund_id, is_current DESC, identifier_type) WHERE (fund_id IS NOT NULL);


--
-- Name: entity_external_identifier_lookup_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_external_identifier_lookup_idx ON corvis_identity.entity_external_identifier USING btree (identifier_type, identifier_value, is_current DESC, valid_from DESC NULLS LAST);


--
-- Name: entity_lifecycle_event_effective_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_lifecycle_event_effective_idx ON corvis_identity.entity_lifecycle_event USING btree (effective_date DESC NULLS LAST, event_type, event_status);


--
-- Name: entity_lifecycle_participant_company_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_lifecycle_participant_company_idx ON corvis_identity.entity_lifecycle_participant USING btree (company_id, lifecycle_event_id) WHERE (company_id IS NOT NULL);


--
-- Name: entity_lifecycle_participant_company_role_uniq; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE UNIQUE INDEX entity_lifecycle_participant_company_role_uniq ON corvis_identity.entity_lifecycle_participant USING btree (lifecycle_event_id, company_id, participant_role) WHERE (company_id IS NOT NULL);


--
-- Name: entity_lifecycle_participant_fund_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_lifecycle_participant_fund_idx ON corvis_identity.entity_lifecycle_participant USING btree (fund_id, lifecycle_event_id) WHERE (fund_id IS NOT NULL);


--
-- Name: entity_lifecycle_participant_fund_role_uniq; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE UNIQUE INDEX entity_lifecycle_participant_fund_role_uniq ON corvis_identity.entity_lifecycle_participant USING btree (lifecycle_event_id, fund_id, participant_role) WHERE (fund_id IS NOT NULL);


--
-- Name: entity_name_company_history_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_name_company_history_idx ON corvis_identity.entity_name USING btree (company_id, is_current DESC, valid_from DESC NULLS LAST, recorded_at DESC) WHERE (company_id IS NOT NULL);


--
-- Name: entity_name_current_company_canonical_uniq; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE UNIQUE INDEX entity_name_current_company_canonical_uniq ON corvis_identity.entity_name USING btree (company_id) WHERE ((company_id IS NOT NULL) AND (name_kind = 'canonical'::text) AND is_current);


--
-- Name: entity_name_current_fund_canonical_uniq; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE UNIQUE INDEX entity_name_current_fund_canonical_uniq ON corvis_identity.entity_name USING btree (fund_id) WHERE ((fund_id IS NOT NULL) AND (name_kind = 'canonical'::text) AND is_current);


--
-- Name: entity_name_fund_history_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_name_fund_history_idx ON corvis_identity.entity_name USING btree (fund_id, is_current DESC, valid_from DESC NULLS LAST, recorded_at DESC) WHERE (fund_id IS NOT NULL);


--
-- Name: entity_name_normalized_lookup_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_name_normalized_lookup_idx ON corvis_identity.entity_name USING btree (normalized_name, is_current DESC, recorded_at DESC);


--
-- Name: entity_relationship_company_to_company_event_uniq; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE UNIQUE INDEX entity_relationship_company_to_company_event_uniq ON corvis_identity.entity_relationship USING btree (relationship_type, source_company_id, target_company_id, lifecycle_event_id) WHERE ((source_company_id IS NOT NULL) AND (target_company_id IS NOT NULL) AND (lifecycle_event_id IS NOT NULL));


--
-- Name: entity_relationship_company_to_fund_event_uniq; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE UNIQUE INDEX entity_relationship_company_to_fund_event_uniq ON corvis_identity.entity_relationship USING btree (relationship_type, source_company_id, target_fund_id, lifecycle_event_id) WHERE ((source_company_id IS NOT NULL) AND (target_fund_id IS NOT NULL) AND (lifecycle_event_id IS NOT NULL));


--
-- Name: entity_relationship_fund_to_company_event_uniq; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE UNIQUE INDEX entity_relationship_fund_to_company_event_uniq ON corvis_identity.entity_relationship USING btree (relationship_type, source_fund_id, target_company_id, lifecycle_event_id) WHERE ((source_fund_id IS NOT NULL) AND (target_company_id IS NOT NULL) AND (lifecycle_event_id IS NOT NULL));


--
-- Name: entity_relationship_fund_to_fund_event_uniq; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE UNIQUE INDEX entity_relationship_fund_to_fund_event_uniq ON corvis_identity.entity_relationship USING btree (relationship_type, source_fund_id, target_fund_id, lifecycle_event_id) WHERE ((source_fund_id IS NOT NULL) AND (target_fund_id IS NOT NULL) AND (lifecycle_event_id IS NOT NULL));


--
-- Name: entity_relationship_source_company_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_relationship_source_company_idx ON corvis_identity.entity_relationship USING btree (source_company_id, relationship_status, valid_from DESC NULLS LAST) WHERE (source_company_id IS NOT NULL);


--
-- Name: entity_relationship_source_fund_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_relationship_source_fund_idx ON corvis_identity.entity_relationship USING btree (source_fund_id, relationship_status, valid_from DESC NULLS LAST) WHERE (source_fund_id IS NOT NULL);


--
-- Name: entity_relationship_target_company_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_relationship_target_company_idx ON corvis_identity.entity_relationship USING btree (target_company_id, relationship_status, valid_from DESC NULLS LAST) WHERE (target_company_id IS NOT NULL);


--
-- Name: entity_relationship_target_fund_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX entity_relationship_target_fund_idx ON corvis_identity.entity_relationship USING btree (target_fund_id, relationship_status, valid_from DESC NULLS LAST) WHERE (target_fund_id IS NOT NULL);


--
-- Name: tenant_entity_lifecycle_evidence_event_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX tenant_entity_lifecycle_evidence_event_idx ON corvis_identity.tenant_entity_lifecycle_evidence USING btree (tenant_id, lifecycle_event_id, review_status, created_at DESC);


--
-- Name: tenant_entity_lifecycle_evidence_source_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX tenant_entity_lifecycle_evidence_source_idx ON corvis_identity.tenant_entity_lifecycle_evidence USING btree (tenant_id, source_reference_id, lifecycle_event_id);


--
-- Name: tenant_entity_name_company_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX tenant_entity_name_company_idx ON corvis_identity.tenant_entity_name USING btree (tenant_id, company_id, last_seen_date DESC NULLS LAST) WHERE (company_id IS NOT NULL);


--
-- Name: tenant_entity_name_fund_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX tenant_entity_name_fund_idx ON corvis_identity.tenant_entity_name USING btree (tenant_id, fund_id, last_seen_date DESC NULLS LAST) WHERE (fund_id IS NOT NULL);


--
-- Name: tenant_entity_name_lookup_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX tenant_entity_name_lookup_idx ON corvis_identity.tenant_entity_name USING btree (tenant_id, normalized_name, review_status, last_seen_date DESC NULLS LAST);


--
-- Name: tenant_entity_revision_identity_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX tenant_entity_revision_identity_idx ON corvis_identity.tenant_entity_revision USING btree (tenant_id, entity_type, global_entity_id, recorded_at DESC);


--
-- Name: tenant_lifecycle_revision_event_idx; Type: INDEX; Schema: corvis_identity; Owner: -
--

CREATE INDEX tenant_lifecycle_revision_event_idx ON corvis_identity.tenant_lifecycle_revision USING btree (tenant_id, lifecycle_event_id, recorded_at DESC);


--
-- Name: candidate_review_event_candidate_idx; Type: INDEX; Schema: corvis_review; Owner: -
--

CREATE INDEX candidate_review_event_candidate_idx ON corvis_review.candidate_review_event USING btree (tenant_id, extraction_run_id, candidate_id, event_sequence);


--
-- Name: candidate_review_requirement_run_idx; Type: INDEX; Schema: corvis_review; Owner: -
--

CREATE INDEX candidate_review_requirement_run_idx ON corvis_review.candidate_review_requirement USING btree (tenant_id, extraction_run_id, review_policy_version, risk_tier);


--
-- Name: extraction_review_gate_status_idx; Type: INDEX; Schema: corvis_review; Owner: -
--

CREATE INDEX extraction_review_gate_status_idx ON corvis_review.extraction_review_gate USING btree (tenant_id, status, evaluated_at DESC);


--
-- Name: export_download_grant_expiry_idx; Type: INDEX; Schema: corvis_serving; Owner: -
--

CREATE INDEX export_download_grant_expiry_idx ON corvis_serving.export_download_grant USING btree (expires_at);


--
-- Name: export_download_grant_lookup_idx; Type: INDEX; Schema: corvis_serving; Owner: -
--

CREATE INDEX export_download_grant_lookup_idx ON corvis_serving.export_download_grant USING btree (tenant_id, export_id, subject, expires_at DESC);


--
-- Name: export_job_delivering_idx; Type: INDEX; Schema: corvis_serving; Owner: -
--

CREATE INDEX export_job_delivering_idx ON corvis_serving.export_job USING btree (delivery_started_at) WHERE (state = 'delivering'::text);


--
-- Name: export_job_delivery_queue_idx; Type: INDEX; Schema: corvis_serving; Owner: -
--

CREATE INDEX export_job_delivery_queue_idx ON corvis_serving.export_job USING btree (created_at) WHERE (state = ANY (ARRAY['queued'::text, 'retryable'::text]));


--
-- Name: export_job_requester_history_idx; Type: INDEX; Schema: corvis_serving; Owner: -
--

CREATE INDEX export_job_requester_history_idx ON corvis_serving.export_job USING btree (tenant_id, requested_by, created_at DESC);


--
-- Name: export_job_tenant_state_idx; Type: INDEX; Schema: corvis_serving; Owner: -
--

CREATE INDEX export_job_tenant_state_idx ON corvis_serving.export_job USING btree (tenant_id, state, created_at DESC);


--
-- Name: acquired_document_document_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX acquired_document_document_idx ON corvis_source.acquired_document USING btree (tenant_id, document_id);


--
-- Name: acquired_document_remote_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX acquired_document_remote_idx ON corvis_source.acquired_document USING btree (tenant_id, source_connection_id, remote_document_id, acquired_at DESC);


--
-- Name: acquired_document_run_outcome_unique_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE UNIQUE INDEX acquired_document_run_outcome_unique_idx ON corvis_source.acquired_document USING btree (tenant_id, source_connection_id, run_id, acquisition_key, disposition);


--
-- Name: document_artifact_version_document_created_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX document_artifact_version_document_created_idx ON corvis_source.document_artifact_version USING btree (tenant_id, document_id, created_at DESC);


--
-- Name: document_artifact_version_release_queue_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX document_artifact_version_release_queue_idx ON corvis_source.document_artifact_version USING btree (tenant_id, last_release_attempt_at NULLS FIRST, created_at) WHERE ((malware_scan_status = 'pending'::text) AND (quarantine_status = 'quarantined'::text) AND (storage_generation IS NOT NULL));


--
-- Name: document_representation_document_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX document_representation_document_idx ON corvis_source.document_representation USING btree (tenant_id, document_id, document_artifact_version_id, created_at DESC);


--
-- Name: document_tenant_created_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX document_tenant_created_idx ON corvis_source.document USING btree (tenant_id, created_at DESC);


--
-- Name: extraction_candidate_document_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX extraction_candidate_document_idx ON corvis_source.extraction_candidate USING btree (tenant_id, document_id, extraction_run_id, candidate_type);


--
-- Name: extraction_candidate_reference_candidate_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX extraction_candidate_reference_candidate_idx ON corvis_source.extraction_candidate_source_reference USING btree (tenant_id, extraction_run_id, candidate_id, created_at);


--
-- Name: extraction_candidate_reference_segment_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX extraction_candidate_reference_segment_idx ON corvis_source.extraction_candidate_source_reference USING btree (tenant_id, extraction_run_id, document_segment_id, work_unit_id) WHERE (document_segment_id IS NOT NULL);


--
-- Name: extraction_run_document_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX extraction_run_document_idx ON corvis_source.extraction_run USING btree (tenant_id, document_id, representation_id, created_at DESC);


--
-- Name: extraction_run_orchestration_contract_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX extraction_run_orchestration_contract_idx ON corvis_source.extraction_run USING btree (tenant_id, skill_id, skill_version, schema_version, orchestration_policy_version, created_at DESC);


--
-- Name: source_connection_run_connection_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX source_connection_run_connection_idx ON corvis_source.source_connection_run USING btree (tenant_id, source_connection_id, started_at DESC);


--
-- Name: source_connection_schedule_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX source_connection_schedule_idx ON corvis_source.source_connection USING btree (tenant_id, status, next_scheduled_at);


--
-- Name: source_reference_document_idx; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE INDEX source_reference_document_idx ON corvis_source.source_reference USING btree (tenant_id, document_id);


--
-- Name: source_reference_extraction_lineage_uniq; Type: INDEX; Schema: corvis_source; Owner: -
--

CREATE UNIQUE INDEX source_reference_extraction_lineage_uniq ON corvis_source.source_reference USING btree (tenant_id, extraction_run_id, candidate_id, reference_key) WHERE ((extraction_run_id IS NOT NULL) AND (candidate_id IS NOT NULL) AND (reference_key IS NOT NULL));


--
-- Name: fund_period_snapshot fund_period_snapshot_inherit_review_deadline; Type: TRIGGER; Schema: corvis_consolidated; Owner: -
--

CREATE TRIGGER fund_period_snapshot_inherit_review_deadline BEFORE INSERT ON corvis_consolidated.fund_period_snapshot FOR EACH ROW EXECUTE FUNCTION corvis_consolidated.inherit_snapshot_review_deadline();


--
-- Name: reconciliation_exception reconciliation_exception_resume_processing; Type: TRIGGER; Schema: corvis_consolidated; Owner: -
--

CREATE TRIGGER reconciliation_exception_resume_processing AFTER UPDATE OF status ON corvis_consolidated.reconciliation_exception FOR EACH ROW EXECUTE FUNCTION corvis_consolidated.resume_reconciliation_after_resolution();


--
-- Name: audit_event audit_event_append_only; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER audit_event_append_only BEFORE DELETE OR UPDATE ON corvis_control.audit_event FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_audit_event_mutation();


--
-- Name: audit_event audit_event_no_truncate; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON corvis_control.audit_event FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_audit_event_mutation();


--
-- Name: control_evidence_record control_evidence_record_append_only; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER control_evidence_record_append_only BEFORE DELETE OR UPDATE ON corvis_control.control_evidence_record FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_control_evidence_mutation();


--
-- Name: data_issue_case_event data_issue_case_event_append_only; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER data_issue_case_event_append_only BEFORE DELETE OR UPDATE ON corvis_control.data_issue_case_event FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_data_issue_event_mutation();


--
-- Name: data_issue_case_event data_issue_case_event_no_truncate; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER data_issue_case_event_no_truncate BEFORE TRUNCATE ON corvis_control.data_issue_case_event FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_data_issue_event_mutation();


--
-- Name: data_issue_case data_issue_case_guard_update; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER data_issue_case_guard_update BEFORE UPDATE ON corvis_control.data_issue_case FOR EACH ROW EXECUTE FUNCTION corvis_control.guard_data_issue_case_update();


--
-- Name: deletion_request deletion_request_guard_update; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER deletion_request_guard_update BEFORE UPDATE ON corvis_control.deletion_request FOR EACH ROW EXECUTE FUNCTION corvis_control.guard_deletion_request_update();


--
-- Name: export_schedule export_schedule_guard_update; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER export_schedule_guard_update BEFORE UPDATE ON corvis_control.export_schedule FOR EACH ROW EXECUTE FUNCTION corvis_control.guard_export_schedule_update();


--
-- Name: export_schedule export_schedule_no_delete; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER export_schedule_no_delete BEFORE DELETE ON corvis_control.export_schedule FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_export_schedule_delete();


--
-- Name: export_schedule export_schedule_no_truncate; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER export_schedule_no_truncate BEFORE TRUNCATE ON corvis_control.export_schedule FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_export_schedule_delete();


--
-- Name: export_schedule_run export_schedule_run_append_only; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER export_schedule_run_append_only BEFORE DELETE OR UPDATE ON corvis_control.export_schedule_run FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_export_schedule_run_mutation();


--
-- Name: export_schedule_run export_schedule_run_no_truncate; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER export_schedule_run_no_truncate BEFORE TRUNCATE ON corvis_control.export_schedule_run FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_export_schedule_run_mutation();


--
-- Name: outbox_event outbox_processing_stage_predecessor_result; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER outbox_processing_stage_predecessor_result BEFORE INSERT ON corvis_control.outbox_event FOR EACH ROW WHEN ((new.event_type = 'ProcessingStageReady'::text)) EXECUTE FUNCTION corvis_control.attach_processing_stage_predecessor_result();


--
-- Name: processing_job processing_job_canonicalization_guard; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER processing_job_canonicalization_guard BEFORE UPDATE OF state ON corvis_control.processing_job FOR EACH ROW EXECUTE FUNCTION corvis_facts.enforce_ready_canonicalization_before_success();


--
-- Name: processing_job processing_job_consolidation_gate_guard; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER processing_job_consolidation_gate_guard BEFORE UPDATE OF state ON corvis_control.processing_job FOR EACH ROW EXECUTE FUNCTION corvis_consolidated.enforce_ready_consolidation_before_success();


--
-- Name: processing_job processing_job_publication_gate_guard; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER processing_job_publication_gate_guard BEFORE UPDATE OF state ON corvis_control.processing_job FOR EACH ROW EXECUTE FUNCTION corvis_consolidated.enforce_ready_publication_before_success();


--
-- Name: processing_job processing_job_reconciliation_gate_guard; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER processing_job_reconciliation_gate_guard BEFORE UPDATE OF state ON corvis_control.processing_job FOR EACH ROW EXECUTE FUNCTION corvis_consolidated.enforce_ready_reconciliation_before_success();


--
-- Name: processing_job processing_job_review_gate_guard; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER processing_job_review_gate_guard BEFORE UPDATE OF state ON corvis_control.processing_job FOR EACH ROW EXECUTE FUNCTION corvis_review.enforce_ready_gate_before_review_success();


--
-- Name: review_item_comment review_item_comment_append_only; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER review_item_comment_append_only BEFORE DELETE OR UPDATE ON corvis_control.review_item_comment FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_review_item_comment_mutation();


--
-- Name: review_item_comment review_item_comment_no_truncate; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER review_item_comment_no_truncate BEFORE TRUNCATE ON corvis_control.review_item_comment FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_review_item_comment_mutation();


--
-- Name: review_item_thread review_item_thread_guard_update; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER review_item_thread_guard_update BEFORE UPDATE ON corvis_control.review_item_thread FOR EACH ROW EXECUTE FUNCTION corvis_control.guard_review_item_thread_update();


--
-- Name: review_item_thread review_item_thread_no_delete; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER review_item_thread_no_delete BEFORE DELETE ON corvis_control.review_item_thread FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_review_item_thread_removal();


--
-- Name: review_item_thread review_item_thread_no_truncate; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER review_item_thread_no_truncate BEFORE TRUNCATE ON corvis_control.review_item_thread FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_review_item_thread_removal();


--
-- Name: service_account_credential service_account_credential_guard_update; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER service_account_credential_guard_update BEFORE UPDATE ON corvis_control.service_account_credential FOR EACH ROW EXECUTE FUNCTION corvis_control.guard_service_account_credential_update();


--
-- Name: service_account service_account_guard_update; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER service_account_guard_update BEFORE UPDATE ON corvis_control.service_account FOR EACH ROW EXECUTE FUNCTION corvis_control.guard_service_account_update();


--
-- Name: tenant_export_request_event tenant_export_request_event_append_only; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER tenant_export_request_event_append_only BEFORE DELETE OR UPDATE ON corvis_control.tenant_export_request_event FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_tenant_export_event_mutation();


--
-- Name: tenant_export_request_event tenant_export_request_event_no_truncate; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER tenant_export_request_event_no_truncate BEFORE TRUNCATE ON corvis_control.tenant_export_request_event FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_tenant_export_event_mutation();


--
-- Name: tenant_export_request_event tenant_export_request_event_notify; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER tenant_export_request_event_notify AFTER INSERT ON corvis_control.tenant_export_request_event FOR EACH ROW EXECUTE FUNCTION corvis_control.notify_tenant_export_event();


--
-- Name: tenant_export_request tenant_export_request_guard_update; Type: TRIGGER; Schema: corvis_control; Owner: -
--

CREATE TRIGGER tenant_export_request_guard_update BEFORE UPDATE ON corvis_control.tenant_export_request FOR EACH ROW EXECUTE FUNCTION corvis_control.guard_tenant_export_request_update();


--
-- Name: canonical_candidate canonical_candidate_position_financial_statement; Type: TRIGGER; Schema: corvis_facts; Owner: -
--

CREATE TRIGGER canonical_candidate_position_financial_statement AFTER INSERT ON corvis_facts.canonical_candidate FOR EACH ROW EXECUTE FUNCTION corvis_facts.materialize_position_financial_statement_candidate();


--
-- Name: company_sector_classification company_sector_classification_append_only; Type: TRIGGER; Schema: corvis_facts; Owner: -
--

CREATE TRIGGER company_sector_classification_append_only BEFORE UPDATE ON corvis_facts.company_sector_classification FOR EACH ROW EXECUTE FUNCTION corvis_facts.guard_company_sector_classification();


--
-- Name: instrument instrument_company_holding_guard; Type: TRIGGER; Schema: corvis_facts; Owner: -
--

CREATE TRIGGER instrument_company_holding_guard BEFORE INSERT OR UPDATE OF tenant_id, holding_id ON corvis_facts.instrument FOR EACH ROW EXECUTE FUNCTION corvis_facts.enforce_instrument_company_holding();


--
-- Name: company company_canonical_name_history; Type: TRIGGER; Schema: corvis_identity; Owner: -
--

CREATE TRIGGER company_canonical_name_history AFTER UPDATE OF canonical_name ON corvis_identity.company FOR EACH ROW EXECUTE FUNCTION corvis_identity.capture_company_canonical_name_history();


--
-- Name: company company_canonical_name_history_on_insert; Type: TRIGGER; Schema: corvis_identity; Owner: -
--

CREATE TRIGGER company_canonical_name_history_on_insert AFTER INSERT ON corvis_identity.company FOR EACH ROW EXECUTE FUNCTION corvis_identity.seed_company_canonical_name_history();


--
-- Name: fund fund_canonical_name_history; Type: TRIGGER; Schema: corvis_identity; Owner: -
--

CREATE TRIGGER fund_canonical_name_history AFTER UPDATE OF canonical_name ON corvis_identity.fund FOR EACH ROW EXECUTE FUNCTION corvis_identity.capture_fund_canonical_name_history();


--
-- Name: fund fund_canonical_name_history_on_insert; Type: TRIGGER; Schema: corvis_identity; Owner: -
--

CREATE TRIGGER fund_canonical_name_history_on_insert AFTER INSERT ON corvis_identity.fund FOR EACH ROW EXECUTE FUNCTION corvis_identity.seed_fund_canonical_name_history();


--
-- Name: candidate_review_event candidate_review_event_lifecycle_guard; Type: TRIGGER; Schema: corvis_review; Owner: -
--

CREATE TRIGGER candidate_review_event_lifecycle_guard BEFORE INSERT ON corvis_review.candidate_review_event FOR EACH ROW EXECUTE FUNCTION corvis_review.guard_review_event_lifecycle();


--
-- Name: consolidated_fact consolidated_fact_reconciliation_run_fk; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidated_fact
    ADD CONSTRAINT consolidated_fact_reconciliation_run_fk FOREIGN KEY (tenant_id, reconciliation_run_id) REFERENCES corvis_consolidated.reconciliation_run(tenant_id, reconciliation_run_id);


--
-- Name: consolidated_fact consolidated_fact_snapshot_fk; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidated_fact
    ADD CONSTRAINT consolidated_fact_snapshot_fk FOREIGN KEY (tenant_id, snapshot_id, snapshot_version) REFERENCES corvis_consolidated.fund_period_snapshot(tenant_id, snapshot_id, version);


--
-- Name: consolidated_fact consolidated_fact_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidated_fact
    ADD CONSTRAINT consolidated_fact_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: consolidation_run consolidation_run_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidation_run
    ADD CONSTRAINT consolidation_run_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: consolidation_run consolidation_run_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidation_run
    ADD CONSTRAINT consolidation_run_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: consolidation_run consolidation_run_tenant_id_reconciliation_run_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidation_run
    ADD CONSTRAINT consolidation_run_tenant_id_reconciliation_run_id_fkey FOREIGN KEY (tenant_id, reconciliation_run_id) REFERENCES corvis_consolidated.reconciliation_run(tenant_id, reconciliation_run_id);


--
-- Name: consolidation_run consolidation_run_tenant_id_snapshot_id_snapshot_version_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.consolidation_run
    ADD CONSTRAINT consolidation_run_tenant_id_snapshot_id_snapshot_version_fkey FOREIGN KEY (tenant_id, snapshot_id, snapshot_version) REFERENCES corvis_consolidated.fund_period_snapshot(tenant_id, snapshot_id, version);


--
-- Name: fund_period_snapshot fund_period_snapshot_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.fund_period_snapshot
    ADD CONSTRAINT fund_period_snapshot_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: publication_run publication_run_tenant_id_consolidation_run_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.publication_run
    ADD CONSTRAINT publication_run_tenant_id_consolidation_run_id_fkey FOREIGN KEY (tenant_id, consolidation_run_id) REFERENCES corvis_consolidated.consolidation_run(tenant_id, consolidation_run_id);


--
-- Name: publication_run publication_run_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.publication_run
    ADD CONSTRAINT publication_run_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: publication_run publication_run_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.publication_run
    ADD CONSTRAINT publication_run_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: publication_run publication_run_tenant_id_publication_event_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.publication_run
    ADD CONSTRAINT publication_run_tenant_id_publication_event_id_fkey FOREIGN KEY (tenant_id, publication_event_id) REFERENCES corvis_consolidated.snapshot_publication_event(tenant_id, publication_event_id);


--
-- Name: publication_run publication_run_tenant_id_snapshot_id_published_snapshot_v_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.publication_run
    ADD CONSTRAINT publication_run_tenant_id_snapshot_id_published_snapshot_v_fkey FOREIGN KEY (tenant_id, snapshot_id, published_snapshot_version) REFERENCES corvis_consolidated.fund_period_snapshot(tenant_id, snapshot_id, version);


--
-- Name: publication_run publication_run_tenant_id_snapshot_id_source_snapshot_vers_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.publication_run
    ADD CONSTRAINT publication_run_tenant_id_snapshot_id_source_snapshot_vers_fkey FOREIGN KEY (tenant_id, snapshot_id, source_snapshot_version) REFERENCES corvis_consolidated.fund_period_snapshot(tenant_id, snapshot_id, version);


--
-- Name: reconciliation_exception reconciliation_exception_reconciliation_run_fk; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_exception
    ADD CONSTRAINT reconciliation_exception_reconciliation_run_fk FOREIGN KEY (tenant_id, reconciliation_run_id) REFERENCES corvis_consolidated.reconciliation_run(tenant_id, reconciliation_run_id);


--
-- Name: reconciliation_exception reconciliation_exception_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_exception
    ADD CONSTRAINT reconciliation_exception_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: reconciliation_exception reconciliation_exception_tenant_id_snapshot_id_snapshot_ve_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_exception
    ADD CONSTRAINT reconciliation_exception_tenant_id_snapshot_id_snapshot_ve_fkey FOREIGN KEY (tenant_id, snapshot_id, snapshot_version) REFERENCES corvis_consolidated.fund_period_snapshot(tenant_id, snapshot_id, version);


--
-- Name: reconciliation_resolution_event reconciliation_resolution_event_tenant_id_exception_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_resolution_event
    ADD CONSTRAINT reconciliation_resolution_event_tenant_id_exception_id_fkey FOREIGN KEY (tenant_id, exception_id) REFERENCES corvis_consolidated.reconciliation_exception(tenant_id, exception_id);


--
-- Name: reconciliation_resolution_event reconciliation_resolution_event_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_resolution_event
    ADD CONSTRAINT reconciliation_resolution_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: reconciliation_run reconciliation_run_tenant_id_canonicalization_run_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_run
    ADD CONSTRAINT reconciliation_run_tenant_id_canonicalization_run_id_fkey FOREIGN KEY (tenant_id, canonicalization_run_id) REFERENCES corvis_facts.canonicalization_run(tenant_id, canonicalization_run_id);


--
-- Name: reconciliation_run reconciliation_run_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_run
    ADD CONSTRAINT reconciliation_run_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: reconciliation_run reconciliation_run_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_run
    ADD CONSTRAINT reconciliation_run_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: reconciliation_run reconciliation_run_tenant_id_snapshot_id_snapshot_version_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation_run
    ADD CONSTRAINT reconciliation_run_tenant_id_snapshot_id_snapshot_version_fkey FOREIGN KEY (tenant_id, snapshot_id, snapshot_version) REFERENCES corvis_consolidated.fund_period_snapshot(tenant_id, snapshot_id, version);


--
-- Name: reconciliation reconciliation_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.reconciliation
    ADD CONSTRAINT reconciliation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: snapshot_publication_event snapshot_publication_event_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE ONLY corvis_consolidated.snapshot_publication_event
    ADD CONSTRAINT snapshot_publication_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: api_rate_limit api_rate_limit_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.api_rate_limit
    ADD CONSTRAINT api_rate_limit_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id) ON DELETE CASCADE;


--
-- Name: audit_event audit_event_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.audit_event
    ADD CONSTRAINT audit_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: control_definition control_definition_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_definition
    ADD CONSTRAINT control_definition_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: control_evidence_escalation control_evidence_escalation_tenant_id_control_code_source__fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_escalation
    ADD CONSTRAINT control_evidence_escalation_tenant_id_control_code_source__fkey FOREIGN KEY (tenant_id, control_code, source_key) REFERENCES corvis_control.control_evidence_requirement(tenant_id, control_code, source_key);


--
-- Name: control_evidence_escalation control_evidence_escalation_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_escalation
    ADD CONSTRAINT control_evidence_escalation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: control_evidence_record control_evidence_record_tenant_id_control_code_source_key_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_record
    ADD CONSTRAINT control_evidence_record_tenant_id_control_code_source_key_fkey FOREIGN KEY (tenant_id, control_code, source_key) REFERENCES corvis_control.control_evidence_requirement(tenant_id, control_code, source_key);


--
-- Name: control_evidence_record control_evidence_record_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_record
    ADD CONSTRAINT control_evidence_record_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: control_evidence_requirement control_evidence_requirement_tenant_id_control_code_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_requirement
    ADD CONSTRAINT control_evidence_requirement_tenant_id_control_code_fkey FOREIGN KEY (tenant_id, control_code) REFERENCES corvis_control.control_definition(tenant_id, control_code);


--
-- Name: control_evidence_requirement control_evidence_requirement_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence_requirement
    ADD CONSTRAINT control_evidence_requirement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: control_evidence control_evidence_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.control_evidence
    ADD CONSTRAINT control_evidence_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: data_correction_incident data_correction_incident_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_correction_incident
    ADD CONSTRAINT data_correction_incident_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: data_correction_incident data_correction_incident_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_correction_incident
    ADD CONSTRAINT data_correction_incident_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: data_issue_case_event data_issue_case_event_tenant_id_case_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_issue_case_event
    ADD CONSTRAINT data_issue_case_event_tenant_id_case_id_fkey FOREIGN KEY (tenant_id, case_id) REFERENCES corvis_control.data_issue_case(tenant_id, case_id);


--
-- Name: data_issue_case data_issue_case_tenant_id_correction_incident_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_issue_case
    ADD CONSTRAINT data_issue_case_tenant_id_correction_incident_id_fkey FOREIGN KEY (tenant_id, correction_incident_id) REFERENCES corvis_control.data_correction_incident(tenant_id, incident_id);


--
-- Name: data_issue_case data_issue_case_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_issue_case
    ADD CONSTRAINT data_issue_case_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: data_issue_case data_issue_case_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_issue_case
    ADD CONSTRAINT data_issue_case_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: data_rights data_rights_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.data_rights
    ADD CONSTRAINT data_rights_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: deletion_execution_evidence deletion_execution_evidence_tenant_id_deletion_request_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.deletion_execution_evidence
    ADD CONSTRAINT deletion_execution_evidence_tenant_id_deletion_request_id_fkey FOREIGN KEY (tenant_id, deletion_request_id) REFERENCES corvis_control.deletion_request(tenant_id, deletion_request_id);


--
-- Name: deletion_execution_evidence deletion_execution_evidence_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.deletion_execution_evidence
    ADD CONSTRAINT deletion_execution_evidence_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: deletion_request deletion_request_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.deletion_request
    ADD CONSTRAINT deletion_request_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: email_outbox email_outbox_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.email_outbox
    ADD CONSTRAINT email_outbox_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id) ON DELETE CASCADE;


--
-- Name: event_inbox event_inbox_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.event_inbox
    ADD CONSTRAINT event_inbox_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: exception exception_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.exception
    ADD CONSTRAINT exception_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: export_schedule_run export_schedule_run_tenant_id_schedule_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.export_schedule_run
    ADD CONSTRAINT export_schedule_run_tenant_id_schedule_id_fkey FOREIGN KEY (tenant_id, schedule_id) REFERENCES corvis_control.export_schedule(tenant_id, schedule_id);


--
-- Name: export_schedule export_schedule_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.export_schedule
    ADD CONSTRAINT export_schedule_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: export_schedule export_schedule_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.export_schedule
    ADD CONSTRAINT export_schedule_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: feature_flag_emergency_stop feature_flag_emergency_stop_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.feature_flag_emergency_stop
    ADD CONSTRAINT feature_flag_emergency_stop_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: feature_flag feature_flag_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.feature_flag
    ADD CONSTRAINT feature_flag_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: idempotency_key idempotency_key_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.idempotency_key
    ADD CONSTRAINT idempotency_key_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: identity_lifecycle_event identity_lifecycle_event_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.identity_lifecycle_event
    ADD CONSTRAINT identity_lifecycle_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: identity_subject identity_subject_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.identity_subject
    ADD CONSTRAINT identity_subject_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: legal_hold legal_hold_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.legal_hold
    ADD CONSTRAINT legal_hold_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: membership membership_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.membership
    ADD CONSTRAINT membership_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: membership membership_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.membership
    ADD CONSTRAINT membership_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: notification_preference notification_preference_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.notification_preference
    ADD CONSTRAINT notification_preference_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id) ON DELETE CASCADE;


--
-- Name: notification_recipient notification_recipient_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.notification_recipient
    ADD CONSTRAINT notification_recipient_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id) ON DELETE CASCADE;


--
-- Name: outbox_event outbox_event_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.outbox_event
    ADD CONSTRAINT outbox_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: processing_job processing_job_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_job
    ADD CONSTRAINT processing_job_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: processing_job processing_job_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_job
    ADD CONSTRAINT processing_job_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: processing_recovery_event processing_recovery_event_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_recovery_event
    ADD CONSTRAINT processing_recovery_event_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: processing_recovery_event processing_recovery_event_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_recovery_event
    ADD CONSTRAINT processing_recovery_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: processing_recovery_event processing_recovery_event_tenant_id_job_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_recovery_event
    ADD CONSTRAINT processing_recovery_event_tenant_id_job_id_fkey FOREIGN KEY (tenant_id, job_id) REFERENCES corvis_control.processing_job(tenant_id, job_id);


--
-- Name: processing_stage_effect processing_stage_effect_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_stage_effect
    ADD CONSTRAINT processing_stage_effect_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: processing_stage_effect processing_stage_effect_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_stage_effect
    ADD CONSTRAINT processing_stage_effect_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: processing_stage_effect processing_stage_effect_tenant_id_job_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.processing_stage_effect
    ADD CONSTRAINT processing_stage_effect_tenant_id_job_id_fkey FOREIGN KEY (tenant_id, job_id) REFERENCES corvis_control.processing_job(tenant_id, job_id);


--
-- Name: research_answer_pin research_answer_pin_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.research_answer_pin
    ADD CONSTRAINT research_answer_pin_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: research_answer_pin research_answer_pin_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.research_answer_pin
    ADD CONSTRAINT research_answer_pin_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: resource_entitlement resource_entitlement_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.resource_entitlement
    ADD CONSTRAINT resource_entitlement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: resource_entitlement resource_entitlement_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.resource_entitlement
    ADD CONSTRAINT resource_entitlement_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: retention_policy retention_policy_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.retention_policy
    ADD CONSTRAINT retention_policy_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: review_item_comment review_item_comment_tenant_id_workspace_id_subject_kind_su_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.review_item_comment
    ADD CONSTRAINT review_item_comment_tenant_id_workspace_id_subject_kind_su_fkey FOREIGN KEY (tenant_id, workspace_id, subject_kind, subject_id) REFERENCES corvis_control.review_item_thread(tenant_id, workspace_id, subject_kind, subject_id);


--
-- Name: review_item_thread review_item_thread_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.review_item_thread
    ADD CONSTRAINT review_item_thread_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: review_item_thread review_item_thread_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.review_item_thread
    ADD CONSTRAINT review_item_thread_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: semantic_query_log semantic_query_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.semantic_query_log
    ADD CONSTRAINT semantic_query_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: service_account_credential service_account_credential_tenant_id_service_account_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_account_credential
    ADD CONSTRAINT service_account_credential_tenant_id_service_account_id_fkey FOREIGN KEY (tenant_id, service_account_id) REFERENCES corvis_control.service_account(tenant_id, service_account_id);


--
-- Name: service_account service_account_tenant_id_auth_method_subject_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_account
    ADD CONSTRAINT service_account_tenant_id_auth_method_subject_fkey FOREIGN KEY (tenant_id, auth_method, subject) REFERENCES corvis_control.identity_subject(tenant_id, auth_method, subject);


--
-- Name: service_account service_account_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_account
    ADD CONSTRAINT service_account_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: service_account service_account_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_account
    ADD CONSTRAINT service_account_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: service_identity_grant service_identity_grant_tenant_id_auth_method_subject_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_identity_grant
    ADD CONSTRAINT service_identity_grant_tenant_id_auth_method_subject_fkey FOREIGN KEY (tenant_id, auth_method, subject) REFERENCES corvis_control.identity_subject(tenant_id, auth_method, subject) ON DELETE CASCADE;


--
-- Name: service_identity_grant service_identity_grant_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.service_identity_grant
    ADD CONSTRAINT service_identity_grant_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: session_revocation session_revocation_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.session_revocation
    ADD CONSTRAINT session_revocation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: support_access_grant support_access_grant_tenant_id_auth_method_subject_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.support_access_grant
    ADD CONSTRAINT support_access_grant_tenant_id_auth_method_subject_fkey FOREIGN KEY (tenant_id, auth_method, subject) REFERENCES corvis_control.identity_subject(tenant_id, auth_method, subject) ON DELETE CASCADE;


--
-- Name: support_access_grant support_access_grant_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.support_access_grant
    ADD CONSTRAINT support_access_grant_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: support_access_grant support_access_grant_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.support_access_grant
    ADD CONSTRAINT support_access_grant_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: tenant_access_notification tenant_access_notification_support_grant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_access_notification
    ADD CONSTRAINT tenant_access_notification_support_grant_id_fkey FOREIGN KEY (support_grant_id) REFERENCES corvis_control.support_access_grant(support_grant_id) ON DELETE CASCADE;


--
-- Name: tenant_access_notification tenant_access_notification_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_access_notification
    ADD CONSTRAINT tenant_access_notification_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id) ON DELETE CASCADE;


--
-- Name: tenant_export_download_grant tenant_export_download_grant_tenant_id_request_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_export_download_grant
    ADD CONSTRAINT tenant_export_download_grant_tenant_id_request_id_fkey FOREIGN KEY (tenant_id, request_id) REFERENCES corvis_control.tenant_export_request(tenant_id, request_id);


--
-- Name: tenant_export_request_event tenant_export_request_event_tenant_id_request_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_export_request_event
    ADD CONSTRAINT tenant_export_request_event_tenant_id_request_id_fkey FOREIGN KEY (tenant_id, request_id) REFERENCES corvis_control.tenant_export_request(tenant_id, request_id);


--
-- Name: tenant_export_request tenant_export_request_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_export_request
    ADD CONSTRAINT tenant_export_request_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: tenant_export_request tenant_export_request_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_export_request
    ADD CONSTRAINT tenant_export_request_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: tenant_identity_provider tenant_identity_provider_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_identity_provider
    ADD CONSTRAINT tenant_identity_provider_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: tenant_invitation tenant_invitation_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_invitation
    ADD CONSTRAINT tenant_invitation_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: tenant_scim_configuration tenant_scim_configuration_tenant_id_default_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_scim_configuration
    ADD CONSTRAINT tenant_scim_configuration_tenant_id_default_workspace_id_fkey FOREIGN KEY (tenant_id, default_workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: tenant_scim_configuration tenant_scim_configuration_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_scim_configuration
    ADD CONSTRAINT tenant_scim_configuration_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id) ON DELETE CASCADE;


--
-- Name: tenant_scim_identity tenant_scim_identity_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_scim_identity
    ADD CONSTRAINT tenant_scim_identity_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id) ON DELETE CASCADE;


--
-- Name: tenant_session_activity tenant_session_activity_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_session_activity
    ADD CONSTRAINT tenant_session_activity_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: tenant_session_policy tenant_session_policy_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_session_policy
    ADD CONSTRAINT tenant_session_policy_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: tenant_verified_domain tenant_verified_domain_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.tenant_verified_domain
    ADD CONSTRAINT tenant_verified_domain_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: webhook_delivery webhook_delivery_tenant_id_event_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_delivery
    ADD CONSTRAINT webhook_delivery_tenant_id_event_id_fkey FOREIGN KEY (tenant_id, event_id) REFERENCES corvis_control.outbox_event(tenant_id, event_id);


--
-- Name: webhook_delivery webhook_delivery_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_delivery
    ADD CONSTRAINT webhook_delivery_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: webhook_delivery webhook_delivery_tenant_id_webhook_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_delivery
    ADD CONSTRAINT webhook_delivery_tenant_id_webhook_id_fkey FOREIGN KEY (tenant_id, webhook_id) REFERENCES corvis_control.webhook_subscription(tenant_id, webhook_id);


--
-- Name: webhook_signing_key webhook_signing_key_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_signing_key
    ADD CONSTRAINT webhook_signing_key_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: webhook_signing_key webhook_signing_key_tenant_id_webhook_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_signing_key
    ADD CONSTRAINT webhook_signing_key_tenant_id_webhook_id_fkey FOREIGN KEY (tenant_id, webhook_id) REFERENCES corvis_control.webhook_subscription(tenant_id, webhook_id);


--
-- Name: webhook_subscription webhook_subscription_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.webhook_subscription
    ADD CONSTRAINT webhook_subscription_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: workspace workspace_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.workspace
    ADD CONSTRAINT workspace_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: workspace_user_preference workspace_user_preference_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.workspace_user_preference
    ADD CONSTRAINT workspace_user_preference_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: workspace_user_preference workspace_user_preference_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_control; Owner: -
--

ALTER TABLE ONLY corvis_control.workspace_user_preference
    ADD CONSTRAINT workspace_user_preference_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: canonical_candidate canonical_candidate_tenant_id_canonicalization_run_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.canonical_candidate
    ADD CONSTRAINT canonical_candidate_tenant_id_canonicalization_run_id_fkey FOREIGN KEY (tenant_id, canonicalization_run_id) REFERENCES corvis_facts.canonicalization_run(tenant_id, canonicalization_run_id);


--
-- Name: canonical_candidate canonical_candidate_tenant_id_extraction_run_id_candidate__fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.canonical_candidate
    ADD CONSTRAINT canonical_candidate_tenant_id_extraction_run_id_candidate__fkey FOREIGN KEY (tenant_id, extraction_run_id, candidate_id) REFERENCES corvis_source.extraction_candidate(tenant_id, extraction_run_id, candidate_id);


--
-- Name: canonicalization_run canonicalization_run_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.canonicalization_run
    ADD CONSTRAINT canonicalization_run_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: canonicalization_run canonicalization_run_tenant_id_extraction_run_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.canonicalization_run
    ADD CONSTRAINT canonicalization_run_tenant_id_extraction_run_id_fkey FOREIGN KEY (tenant_id, extraction_run_id) REFERENCES corvis_source.extraction_run(tenant_id, extraction_run_id);


--
-- Name: canonicalization_run canonicalization_run_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.canonicalization_run
    ADD CONSTRAINT canonicalization_run_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: client_portfolio_fund_position client_portfolio_fund_position_fund_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.client_portfolio_fund_position
    ADD CONSTRAINT client_portfolio_fund_position_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES corvis_identity.fund(global_fund_id);


--
-- Name: client_portfolio_fund_position client_portfolio_fund_position_tenant_id_portfolio_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.client_portfolio_fund_position
    ADD CONSTRAINT client_portfolio_fund_position_tenant_id_portfolio_id_fkey FOREIGN KEY (tenant_id, portfolio_id) REFERENCES corvis_facts.client_portfolio(tenant_id, portfolio_id);


--
-- Name: client_portfolio client_portfolio_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.client_portfolio
    ADD CONSTRAINT client_portfolio_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: client_portfolio client_portfolio_tenant_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.client_portfolio
    ADD CONSTRAINT client_portfolio_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES corvis_control.workspace(tenant_id, workspace_id);


--
-- Name: company_sector_classification company_sector_classification_company_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.company_sector_classification
    ADD CONSTRAINT company_sector_classification_company_id_fkey FOREIGN KEY (company_id) REFERENCES corvis_identity.company(global_company_id);


--
-- Name: company_sector_classification company_sector_classification_taxonomy_version_sector_code_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.company_sector_classification
    ADD CONSTRAINT company_sector_classification_taxonomy_version_sector_code_fkey FOREIGN KEY (taxonomy_version, sector_code) REFERENCES corvis_semantic.sector(taxonomy_version, sector_code);


--
-- Name: company_sector_classification company_sector_classification_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.company_sector_classification
    ADD CONSTRAINT company_sector_classification_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: holding holding_fund_identity_fk; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.holding
    ADD CONSTRAINT holding_fund_identity_fk FOREIGN KEY (fund_id) REFERENCES corvis_identity.fund(global_fund_id);


--
-- Name: holding_revision holding_revision_tenant_id_canonicalization_run_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.holding_revision
    ADD CONSTRAINT holding_revision_tenant_id_canonicalization_run_id_fkey FOREIGN KEY (tenant_id, canonicalization_run_id) REFERENCES corvis_facts.canonicalization_run(tenant_id, canonicalization_run_id);


--
-- Name: holding_revision holding_revision_tenant_id_holding_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.holding_revision
    ADD CONSTRAINT holding_revision_tenant_id_holding_id_fkey FOREIGN KEY (tenant_id, holding_id) REFERENCES corvis_facts.holding(tenant_id, holding_id);


--
-- Name: holding holding_target_company_identity_fk; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.holding
    ADD CONSTRAINT holding_target_company_identity_fk FOREIGN KEY (target_company_id) REFERENCES corvis_identity.company(global_company_id);


--
-- Name: holding holding_target_fund_identity_fk; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.holding
    ADD CONSTRAINT holding_target_fund_identity_fk FOREIGN KEY (target_fund_id) REFERENCES corvis_identity.fund(global_fund_id);


--
-- Name: holding holding_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.holding
    ADD CONSTRAINT holding_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: holding holding_tenant_id_source_reference_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.holding
    ADD CONSTRAINT holding_tenant_id_source_reference_id_fkey FOREIGN KEY (tenant_id, source_reference_id) REFERENCES corvis_source.source_reference(tenant_id, source_reference_id);


--
-- Name: instrument_revision instrument_revision_tenant_id_canonicalization_run_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.instrument_revision
    ADD CONSTRAINT instrument_revision_tenant_id_canonicalization_run_id_fkey FOREIGN KEY (tenant_id, canonicalization_run_id) REFERENCES corvis_facts.canonicalization_run(tenant_id, canonicalization_run_id);


--
-- Name: instrument_revision instrument_revision_tenant_id_instrument_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.instrument_revision
    ADD CONSTRAINT instrument_revision_tenant_id_instrument_id_fkey FOREIGN KEY (tenant_id, instrument_id) REFERENCES corvis_facts.instrument(tenant_id, instrument_id);


--
-- Name: instrument instrument_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.instrument
    ADD CONSTRAINT instrument_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: instrument instrument_tenant_id_holding_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.instrument
    ADD CONSTRAINT instrument_tenant_id_holding_id_fkey FOREIGN KEY (tenant_id, holding_id) REFERENCES corvis_facts.holding(tenant_id, holding_id);


--
-- Name: instrument instrument_tenant_id_source_reference_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.instrument
    ADD CONSTRAINT instrument_tenant_id_source_reference_id_fkey FOREIGN KEY (tenant_id, source_reference_id) REFERENCES corvis_source.source_reference(tenant_id, source_reference_id);


--
-- Name: observation_correction observation_correction_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.observation_correction
    ADD CONSTRAINT observation_correction_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: observation_correction observation_correction_tenant_id_observation_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.observation_correction
    ADD CONSTRAINT observation_correction_tenant_id_observation_id_fkey FOREIGN KEY (tenant_id, observation_id) REFERENCES corvis_facts.observation(tenant_id, observation_id);


--
-- Name: observation_source_reference observation_source_reference_tenant_id_observation_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.observation_source_reference
    ADD CONSTRAINT observation_source_reference_tenant_id_observation_id_fkey FOREIGN KEY (tenant_id, observation_id) REFERENCES corvis_facts.observation(tenant_id, observation_id);


--
-- Name: observation_source_reference observation_source_reference_tenant_id_source_reference_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.observation_source_reference
    ADD CONSTRAINT observation_source_reference_tenant_id_source_reference_id_fkey FOREIGN KEY (tenant_id, source_reference_id) REFERENCES corvis_source.source_reference(tenant_id, source_reference_id);


--
-- Name: observation observation_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.observation
    ADD CONSTRAINT observation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: observation observation_tenant_id_source_reference_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.observation
    ADD CONSTRAINT observation_tenant_id_source_reference_id_fkey FOREIGN KEY (tenant_id, source_reference_id) REFERENCES corvis_source.source_reference(tenant_id, source_reference_id);


--
-- Name: position_financial_statement_line position_financial_statement_line_tenant_id_statement_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement_line
    ADD CONSTRAINT position_financial_statement_line_tenant_id_statement_id_fkey FOREIGN KEY (tenant_id, statement_id) REFERENCES corvis_facts.position_financial_statement(tenant_id, statement_id);


--
-- Name: position_financial_statement position_financial_statement_tenant_id_canonicalization_ru_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement
    ADD CONSTRAINT position_financial_statement_tenant_id_canonicalization_ru_fkey FOREIGN KEY (tenant_id, canonicalization_run_id) REFERENCES corvis_facts.canonicalization_run(tenant_id, canonicalization_run_id);


--
-- Name: position_financial_statement position_financial_statement_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement
    ADD CONSTRAINT position_financial_statement_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: position_financial_statement position_financial_statement_tenant_id_extraction_run_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement
    ADD CONSTRAINT position_financial_statement_tenant_id_extraction_run_id_fkey FOREIGN KEY (tenant_id, extraction_run_id) REFERENCES corvis_source.extraction_run(tenant_id, extraction_run_id);


--
-- Name: position_financial_statement position_financial_statement_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement
    ADD CONSTRAINT position_financial_statement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: position_financial_statement_value position_financial_statement_value_tenant_id_line_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement_value
    ADD CONSTRAINT position_financial_statement_value_tenant_id_line_id_fkey FOREIGN KEY (tenant_id, line_id) REFERENCES corvis_facts.position_financial_statement_line(tenant_id, line_id);


--
-- Name: position_financial_statement_value position_financial_statement_value_tenant_id_statement_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.position_financial_statement_value
    ADD CONSTRAINT position_financial_statement_value_tenant_id_statement_id_fkey FOREIGN KEY (tenant_id, statement_id) REFERENCES corvis_facts.position_financial_statement(tenant_id, statement_id);


--
-- Name: review_event review_event_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.review_event
    ADD CONSTRAINT review_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: review_event review_event_tenant_id_observation_id_fkey; Type: FK CONSTRAINT; Schema: corvis_facts; Owner: -
--

ALTER TABLE ONLY corvis_facts.review_event
    ADD CONSTRAINT review_event_tenant_id_observation_id_fkey FOREIGN KEY (tenant_id, observation_id) REFERENCES corvis_facts.observation(tenant_id, observation_id);


--
-- Name: entity_external_identifier entity_external_identifier_company_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_external_identifier
    ADD CONSTRAINT entity_external_identifier_company_id_fkey FOREIGN KEY (company_id) REFERENCES corvis_identity.company(global_company_id);


--
-- Name: entity_external_identifier entity_external_identifier_fund_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_external_identifier
    ADD CONSTRAINT entity_external_identifier_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES corvis_identity.fund(global_fund_id);


--
-- Name: entity_lifecycle_participant entity_lifecycle_participant_company_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_lifecycle_participant
    ADD CONSTRAINT entity_lifecycle_participant_company_id_fkey FOREIGN KEY (company_id) REFERENCES corvis_identity.company(global_company_id);


--
-- Name: entity_lifecycle_participant entity_lifecycle_participant_fund_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_lifecycle_participant
    ADD CONSTRAINT entity_lifecycle_participant_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES corvis_identity.fund(global_fund_id);


--
-- Name: entity_lifecycle_participant entity_lifecycle_participant_lifecycle_event_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_lifecycle_participant
    ADD CONSTRAINT entity_lifecycle_participant_lifecycle_event_id_fkey FOREIGN KEY (lifecycle_event_id) REFERENCES corvis_identity.entity_lifecycle_event(lifecycle_event_id) ON DELETE CASCADE;


--
-- Name: entity_name entity_name_company_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_name
    ADD CONSTRAINT entity_name_company_id_fkey FOREIGN KEY (company_id) REFERENCES corvis_identity.company(global_company_id);


--
-- Name: entity_name entity_name_fund_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_name
    ADD CONSTRAINT entity_name_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES corvis_identity.fund(global_fund_id);


--
-- Name: entity_relationship entity_relationship_lifecycle_event_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_relationship
    ADD CONSTRAINT entity_relationship_lifecycle_event_id_fkey FOREIGN KEY (lifecycle_event_id) REFERENCES corvis_identity.entity_lifecycle_event(lifecycle_event_id);


--
-- Name: entity_relationship entity_relationship_source_company_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_relationship
    ADD CONSTRAINT entity_relationship_source_company_id_fkey FOREIGN KEY (source_company_id) REFERENCES corvis_identity.company(global_company_id);


--
-- Name: entity_relationship entity_relationship_source_fund_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_relationship
    ADD CONSTRAINT entity_relationship_source_fund_id_fkey FOREIGN KEY (source_fund_id) REFERENCES corvis_identity.fund(global_fund_id);


--
-- Name: entity_relationship entity_relationship_target_company_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_relationship
    ADD CONSTRAINT entity_relationship_target_company_id_fkey FOREIGN KEY (target_company_id) REFERENCES corvis_identity.company(global_company_id);


--
-- Name: entity_relationship entity_relationship_target_fund_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.entity_relationship
    ADD CONSTRAINT entity_relationship_target_fund_id_fkey FOREIGN KEY (target_fund_id) REFERENCES corvis_identity.fund(global_fund_id);


--
-- Name: tenant_entity_lifecycle_evidence tenant_entity_lifecycle_evide_tenant_id_source_reference_i_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_lifecycle_evidence
    ADD CONSTRAINT tenant_entity_lifecycle_evide_tenant_id_source_reference_i_fkey FOREIGN KEY (tenant_id, source_reference_id) REFERENCES corvis_source.source_reference(tenant_id, source_reference_id);


--
-- Name: tenant_entity_lifecycle_evidence tenant_entity_lifecycle_evidence_lifecycle_event_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_lifecycle_evidence
    ADD CONSTRAINT tenant_entity_lifecycle_evidence_lifecycle_event_id_fkey FOREIGN KEY (lifecycle_event_id) REFERENCES corvis_identity.entity_lifecycle_event(lifecycle_event_id);


--
-- Name: tenant_entity_lifecycle_evidence tenant_entity_lifecycle_evidence_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_lifecycle_evidence
    ADD CONSTRAINT tenant_entity_lifecycle_evidence_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: tenant_entity_name tenant_entity_name_company_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_name
    ADD CONSTRAINT tenant_entity_name_company_id_fkey FOREIGN KEY (company_id) REFERENCES corvis_identity.company(global_company_id);


--
-- Name: tenant_entity_name tenant_entity_name_fund_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_name
    ADD CONSTRAINT tenant_entity_name_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES corvis_identity.fund(global_fund_id);


--
-- Name: tenant_entity_name tenant_entity_name_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_name
    ADD CONSTRAINT tenant_entity_name_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: tenant_entity_name tenant_entity_name_tenant_id_source_reference_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_name
    ADD CONSTRAINT tenant_entity_name_tenant_id_source_reference_id_fkey FOREIGN KEY (tenant_id, source_reference_id) REFERENCES corvis_source.source_reference(tenant_id, source_reference_id);


--
-- Name: tenant_entity_revision tenant_entity_revision_tenant_id_canonicalization_run_id_c_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_revision
    ADD CONSTRAINT tenant_entity_revision_tenant_id_canonicalization_run_id_c_fkey FOREIGN KEY (tenant_id, canonicalization_run_id, candidate_id) REFERENCES corvis_facts.canonical_candidate(tenant_id, canonicalization_run_id, candidate_id);


--
-- Name: tenant_entity_revision tenant_entity_revision_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_entity_revision
    ADD CONSTRAINT tenant_entity_revision_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: tenant_lifecycle_revision tenant_lifecycle_revision_lifecycle_event_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_lifecycle_revision
    ADD CONSTRAINT tenant_lifecycle_revision_lifecycle_event_id_fkey FOREIGN KEY (lifecycle_event_id) REFERENCES corvis_identity.entity_lifecycle_event(lifecycle_event_id);


--
-- Name: tenant_lifecycle_revision tenant_lifecycle_revision_tenant_id_canonicalization_run_i_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_lifecycle_revision
    ADD CONSTRAINT tenant_lifecycle_revision_tenant_id_canonicalization_run_i_fkey FOREIGN KEY (tenant_id, canonicalization_run_id) REFERENCES corvis_facts.canonicalization_run(tenant_id, canonicalization_run_id);


--
-- Name: tenant_lifecycle_revision tenant_lifecycle_revision_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_identity; Owner: -
--

ALTER TABLE ONLY corvis_identity.tenant_lifecycle_revision
    ADD CONSTRAINT tenant_lifecycle_revision_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: candidate_review_event candidate_review_event_tenant_id_extraction_run_id_candida_fkey; Type: FK CONSTRAINT; Schema: corvis_review; Owner: -
--

ALTER TABLE ONLY corvis_review.candidate_review_event
    ADD CONSTRAINT candidate_review_event_tenant_id_extraction_run_id_candida_fkey FOREIGN KEY (tenant_id, extraction_run_id, candidate_id) REFERENCES corvis_source.extraction_candidate(tenant_id, extraction_run_id, candidate_id);


--
-- Name: candidate_review_requirement candidate_review_requirement_tenant_id_extraction_run_id_c_fkey; Type: FK CONSTRAINT; Schema: corvis_review; Owner: -
--

ALTER TABLE ONLY corvis_review.candidate_review_requirement
    ADD CONSTRAINT candidate_review_requirement_tenant_id_extraction_run_id_c_fkey FOREIGN KEY (tenant_id, extraction_run_id, candidate_id) REFERENCES corvis_source.extraction_candidate(tenant_id, extraction_run_id, candidate_id);


--
-- Name: extraction_review_gate extraction_review_gate_tenant_id_extraction_run_id_fkey; Type: FK CONSTRAINT; Schema: corvis_review; Owner: -
--

ALTER TABLE ONLY corvis_review.extraction_review_gate
    ADD CONSTRAINT extraction_review_gate_tenant_id_extraction_run_id_fkey FOREIGN KEY (tenant_id, extraction_run_id) REFERENCES corvis_source.extraction_run(tenant_id, extraction_run_id);


--
-- Name: sector_alias sector_alias_taxonomy_version_sector_code_fkey; Type: FK CONSTRAINT; Schema: corvis_semantic; Owner: -
--

ALTER TABLE ONLY corvis_semantic.sector_alias
    ADD CONSTRAINT sector_alias_taxonomy_version_sector_code_fkey FOREIGN KEY (taxonomy_version, sector_code) REFERENCES corvis_semantic.sector(taxonomy_version, sector_code);


--
-- Name: export_download_grant export_download_grant_export_id_fkey; Type: FK CONSTRAINT; Schema: corvis_serving; Owner: -
--

ALTER TABLE ONLY corvis_serving.export_download_grant
    ADD CONSTRAINT export_download_grant_export_id_fkey FOREIGN KEY (export_id) REFERENCES corvis_serving.export_job(export_id) ON DELETE CASCADE;


--
-- Name: export_download_grant export_download_grant_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_serving; Owner: -
--

ALTER TABLE ONLY corvis_serving.export_download_grant
    ADD CONSTRAINT export_download_grant_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: export_job export_job_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_serving; Owner: -
--

ALTER TABLE ONLY corvis_serving.export_job
    ADD CONSTRAINT export_job_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: acquired_document acquired_document_tenant_id_document_artifact_version_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.acquired_document
    ADD CONSTRAINT acquired_document_tenant_id_document_artifact_version_id_fkey FOREIGN KEY (tenant_id, document_artifact_version_id) REFERENCES corvis_source.document_artifact_version(tenant_id, document_artifact_version_id);


--
-- Name: acquired_document acquired_document_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.acquired_document
    ADD CONSTRAINT acquired_document_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: acquired_document acquired_document_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.acquired_document
    ADD CONSTRAINT acquired_document_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: acquired_document acquired_document_tenant_id_run_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.acquired_document
    ADD CONSTRAINT acquired_document_tenant_id_run_id_fkey FOREIGN KEY (tenant_id, run_id) REFERENCES corvis_source.source_connection_run(tenant_id, run_id);


--
-- Name: acquired_document acquired_document_tenant_id_source_connection_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.acquired_document
    ADD CONSTRAINT acquired_document_tenant_id_source_connection_id_fkey FOREIGN KEY (tenant_id, source_connection_id) REFERENCES corvis_source.source_connection(tenant_id, source_connection_id);


--
-- Name: document_artifact_version document_artifact_version_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document_artifact_version
    ADD CONSTRAINT document_artifact_version_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: document_artifact_version document_artifact_version_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document_artifact_version
    ADD CONSTRAINT document_artifact_version_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: document_representation document_representation_tenant_id_document_artifact_versio_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document_representation
    ADD CONSTRAINT document_representation_tenant_id_document_artifact_versio_fkey FOREIGN KEY (tenant_id, document_artifact_version_id) REFERENCES corvis_source.document_artifact_version(tenant_id, document_artifact_version_id);


--
-- Name: document_representation document_representation_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document_representation
    ADD CONSTRAINT document_representation_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: document_representation document_representation_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document_representation
    ADD CONSTRAINT document_representation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: document document_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.document
    ADD CONSTRAINT document_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: extraction_candidate_source_reference extraction_candidate_source_r_tenant_id_extraction_run_id__fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_candidate_source_reference
    ADD CONSTRAINT extraction_candidate_source_r_tenant_id_extraction_run_id__fkey FOREIGN KEY (tenant_id, extraction_run_id, candidate_id) REFERENCES corvis_source.extraction_candidate(tenant_id, extraction_run_id, candidate_id);


--
-- Name: extraction_candidate_source_reference extraction_candidate_source_re_tenant_id_representation_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_candidate_source_reference
    ADD CONSTRAINT extraction_candidate_source_re_tenant_id_representation_id_fkey FOREIGN KEY (tenant_id, representation_id) REFERENCES corvis_source.document_representation(tenant_id, representation_id);


--
-- Name: extraction_candidate_source_reference extraction_candidate_source_referenc_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_candidate_source_reference
    ADD CONSTRAINT extraction_candidate_source_referenc_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: extraction_candidate extraction_candidate_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_candidate
    ADD CONSTRAINT extraction_candidate_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: extraction_candidate extraction_candidate_tenant_id_extraction_run_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_candidate
    ADD CONSTRAINT extraction_candidate_tenant_id_extraction_run_id_fkey FOREIGN KEY (tenant_id, extraction_run_id) REFERENCES corvis_source.extraction_run(tenant_id, extraction_run_id);


--
-- Name: extraction_candidate extraction_candidate_tenant_id_representation_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_candidate
    ADD CONSTRAINT extraction_candidate_tenant_id_representation_id_fkey FOREIGN KEY (tenant_id, representation_id) REFERENCES corvis_source.document_representation(tenant_id, representation_id);


--
-- Name: extraction_run extraction_run_tenant_id_document_artifact_version_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_run
    ADD CONSTRAINT extraction_run_tenant_id_document_artifact_version_id_fkey FOREIGN KEY (tenant_id, document_artifact_version_id) REFERENCES corvis_source.document_artifact_version(tenant_id, document_artifact_version_id);


--
-- Name: extraction_run extraction_run_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_run
    ADD CONSTRAINT extraction_run_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: extraction_run extraction_run_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_run
    ADD CONSTRAINT extraction_run_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: extraction_run extraction_run_tenant_id_representation_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.extraction_run
    ADD CONSTRAINT extraction_run_tenant_id_representation_id_fkey FOREIGN KEY (tenant_id, representation_id) REFERENCES corvis_source.document_representation(tenant_id, representation_id);


--
-- Name: source_connection_run source_connection_run_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_connection_run
    ADD CONSTRAINT source_connection_run_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: source_connection_run source_connection_run_tenant_id_source_connection_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_connection_run
    ADD CONSTRAINT source_connection_run_tenant_id_source_connection_id_fkey FOREIGN KEY (tenant_id, source_connection_id) REFERENCES corvis_source.source_connection(tenant_id, source_connection_id);


--
-- Name: source_connection source_connection_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_connection
    ADD CONSTRAINT source_connection_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: source_reference source_reference_tenant_id_document_artifact_version_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_reference
    ADD CONSTRAINT source_reference_tenant_id_document_artifact_version_id_fkey FOREIGN KEY (tenant_id, document_artifact_version_id) REFERENCES corvis_source.document_artifact_version(tenant_id, document_artifact_version_id);


--
-- Name: source_reference source_reference_tenant_id_document_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_reference
    ADD CONSTRAINT source_reference_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES corvis_source.document(tenant_id, document_id);


--
-- Name: source_reference source_reference_tenant_id_fkey; Type: FK CONSTRAINT; Schema: corvis_source; Owner: -
--

ALTER TABLE ONLY corvis_source.source_reference
    ADD CONSTRAINT source_reference_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES corvis_control.tenant(tenant_id);


--
-- Name: consolidated_fact; Type: ROW SECURITY; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE corvis_consolidated.consolidated_fact ENABLE ROW LEVEL SECURITY;

--
-- Name: consolidated_fact consolidated_fact_tenant_select; Type: POLICY; Schema: corvis_consolidated; Owner: -
--

CREATE POLICY consolidated_fact_tenant_select ON corvis_consolidated.consolidated_fact FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: consolidation_run; Type: ROW SECURITY; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE corvis_consolidated.consolidation_run ENABLE ROW LEVEL SECURITY;

--
-- Name: fund_period_snapshot; Type: ROW SECURITY; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE corvis_consolidated.fund_period_snapshot ENABLE ROW LEVEL SECURITY;

--
-- Name: publication_run; Type: ROW SECURITY; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE corvis_consolidated.publication_run ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation; Type: ROW SECURITY; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE corvis_consolidated.reconciliation ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation_exception; Type: ROW SECURITY; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE corvis_consolidated.reconciliation_exception ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation_exception reconciliation_exception_tenant_select; Type: POLICY; Schema: corvis_consolidated; Owner: -
--

CREATE POLICY reconciliation_exception_tenant_select ON corvis_consolidated.reconciliation_exception FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: reconciliation_resolution_event; Type: ROW SECURITY; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE corvis_consolidated.reconciliation_resolution_event ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation_resolution_event reconciliation_resolution_event_tenant_select; Type: POLICY; Schema: corvis_consolidated; Owner: -
--

CREATE POLICY reconciliation_resolution_event_tenant_select ON corvis_consolidated.reconciliation_resolution_event FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: reconciliation_run; Type: ROW SECURITY; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE corvis_consolidated.reconciliation_run ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation reconciliation_tenant_select; Type: POLICY; Schema: corvis_consolidated; Owner: -
--

CREATE POLICY reconciliation_tenant_select ON corvis_consolidated.reconciliation FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: snapshot_publication_event; Type: ROW SECURITY; Schema: corvis_consolidated; Owner: -
--

ALTER TABLE corvis_consolidated.snapshot_publication_event ENABLE ROW LEVEL SECURITY;

--
-- Name: snapshot_publication_event snapshot_publication_event_tenant_select; Type: POLICY; Schema: corvis_consolidated; Owner: -
--

CREATE POLICY snapshot_publication_event_tenant_select ON corvis_consolidated.snapshot_publication_event FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: fund_period_snapshot snapshot_tenant_select; Type: POLICY; Schema: corvis_consolidated; Owner: -
--

CREATE POLICY snapshot_tenant_select ON corvis_consolidated.fund_period_snapshot FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: api_rate_limit; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.api_rate_limit ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_event; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.audit_event ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_event audit_event_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY audit_event_select ON corvis_control.audit_event FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: control_definition; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.control_definition ENABLE ROW LEVEL SECURITY;

--
-- Name: control_definition control_definition_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY control_definition_tenant_select ON corvis_control.control_definition FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: control_evidence; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.control_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: control_evidence_escalation; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.control_evidence_escalation ENABLE ROW LEVEL SECURITY;

--
-- Name: control_evidence_escalation control_evidence_escalation_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY control_evidence_escalation_tenant_select ON corvis_control.control_evidence_escalation FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: control_evidence_record; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.control_evidence_record ENABLE ROW LEVEL SECURITY;

--
-- Name: control_evidence_record control_evidence_record_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY control_evidence_record_tenant_select ON corvis_control.control_evidence_record FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: control_evidence_requirement; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.control_evidence_requirement ENABLE ROW LEVEL SECURITY;

--
-- Name: control_evidence_requirement control_evidence_requirement_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY control_evidence_requirement_tenant_select ON corvis_control.control_evidence_requirement FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: control_evidence control_evidence_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY control_evidence_tenant_select ON corvis_control.control_evidence FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: data_correction_incident; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.data_correction_incident ENABLE ROW LEVEL SECURITY;

--
-- Name: data_correction_incident data_correction_incident_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY data_correction_incident_tenant_select ON corvis_control.data_correction_incident FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: data_issue_case; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.data_issue_case ENABLE ROW LEVEL SECURITY;

--
-- Name: data_issue_case_event; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.data_issue_case_event ENABLE ROW LEVEL SECURITY;

--
-- Name: data_rights; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.data_rights ENABLE ROW LEVEL SECURITY;

--
-- Name: data_rights data_rights_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY data_rights_tenant_select ON corvis_control.data_rights FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: deletion_execution_evidence; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.deletion_execution_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: deletion_execution_evidence deletion_execution_evidence_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY deletion_execution_evidence_select ON corvis_control.deletion_execution_evidence FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: deletion_request; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.deletion_request ENABLE ROW LEVEL SECURITY;

--
-- Name: deletion_request deletion_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY deletion_tenant_select ON corvis_control.deletion_request FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: email_outbox; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.email_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_entitlement entitlement_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY entitlement_select ON corvis_control.resource_entitlement FOR SELECT USING (((subject_user_id = auth.uid()) AND corvis_control.has_workspace_access(tenant_id, workspace_id)));


--
-- Name: event_inbox; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.event_inbox ENABLE ROW LEVEL SECURITY;

--
-- Name: exception; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.exception ENABLE ROW LEVEL SECURITY;

--
-- Name: exception exception_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY exception_tenant_select ON corvis_control.exception FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: export_schedule; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.export_schedule ENABLE ROW LEVEL SECURITY;

--
-- Name: export_schedule_run; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.export_schedule_run ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flag; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.feature_flag ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flag_emergency_stop; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.feature_flag_emergency_stop ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flag_emergency_stop feature_flag_emergency_stop_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY feature_flag_emergency_stop_select ON corvis_control.feature_flag_emergency_stop FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: feature_flag feature_flag_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY feature_flag_select ON corvis_control.feature_flag FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: idempotency_key; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.idempotency_key ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_lifecycle_event; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.identity_lifecycle_event ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_subject; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.identity_subject ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_subject identity_subject_self_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY identity_subject_self_select ON corvis_control.identity_subject FOR SELECT USING ((corvis_control.has_tenant_access(tenant_id) AND (user_id = auth.uid())));


--
-- Name: legal_hold; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.legal_hold ENABLE ROW LEVEL SECURITY;

--
-- Name: legal_hold legal_hold_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY legal_hold_select ON corvis_control.legal_hold FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: membership; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.membership ENABLE ROW LEVEL SECURITY;

--
-- Name: membership membership_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY membership_select ON corvis_control.membership FOR SELECT USING (((user_id = auth.uid()) OR corvis_control.has_workspace_access(tenant_id, workspace_id)));


--
-- Name: notification_preference; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.notification_preference ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_recipient; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.notification_recipient ENABLE ROW LEVEL SECURITY;

--
-- Name: oidc_logout_token_use; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.oidc_logout_token_use ENABLE ROW LEVEL SECURITY;

--
-- Name: outbox_event; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.outbox_event ENABLE ROW LEVEL SECURITY;

--
-- Name: outbox_event outbox_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY outbox_tenant_select ON corvis_control.outbox_event FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: processing_job; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.processing_job ENABLE ROW LEVEL SECURITY;

--
-- Name: processing_job processing_job_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY processing_job_tenant_select ON corvis_control.processing_job FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: processing_recovery_event; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.processing_recovery_event ENABLE ROW LEVEL SECURITY;

--
-- Name: processing_stage_effect; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.processing_stage_effect ENABLE ROW LEVEL SECURITY;

--
-- Name: research_answer_pin; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.research_answer_pin ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_entitlement; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.resource_entitlement ENABLE ROW LEVEL SECURITY;

--
-- Name: retention_policy; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.retention_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: retention_policy retention_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY retention_tenant_select ON corvis_control.retention_policy FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: review_item_comment; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.review_item_comment ENABLE ROW LEVEL SECURITY;

--
-- Name: review_item_thread; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.review_item_thread ENABLE ROW LEVEL SECURITY;

--
-- Name: semantic_query_log; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.semantic_query_log ENABLE ROW LEVEL SECURITY;

--
-- Name: semantic_query_log semantic_query_log_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY semantic_query_log_tenant_select ON corvis_control.semantic_query_log FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: service_account; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.service_account ENABLE ROW LEVEL SECURITY;

--
-- Name: service_account_credential; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.service_account_credential ENABLE ROW LEVEL SECURITY;

--
-- Name: service_identity_grant; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.service_identity_grant ENABLE ROW LEVEL SECURITY;

--
-- Name: session_revocation; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.session_revocation ENABLE ROW LEVEL SECURITY;

--
-- Name: support_access_grant; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.support_access_grant ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_access_notification; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_access_notification ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_export_download_grant; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_export_download_grant ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_export_request; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_export_request ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_export_request_event; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_export_request_event ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_identity_provider; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_identity_provider ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_invitation; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_invitation ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_scim_configuration; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_scim_configuration ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_scim_identity; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_scim_identity ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY tenant_select ON corvis_control.tenant FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: tenant_session_activity; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_session_activity ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_session_policy; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_session_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_verified_domain; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.tenant_verified_domain ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_delivery; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.webhook_delivery ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_delivery webhook_delivery_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY webhook_delivery_tenant_select ON corvis_control.webhook_delivery FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: webhook_signing_key; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.webhook_signing_key ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_signing_key webhook_signing_key_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY webhook_signing_key_tenant_select ON corvis_control.webhook_signing_key FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: webhook_subscription; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.webhook_subscription ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_subscription webhook_subscription_tenant_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY webhook_subscription_tenant_select ON corvis_control.webhook_subscription FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: workspace; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.workspace ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace workspace_select; Type: POLICY; Schema: corvis_control; Owner: -
--

CREATE POLICY workspace_select ON corvis_control.workspace FOR SELECT USING (corvis_control.has_workspace_access(tenant_id, workspace_id));


--
-- Name: workspace_user_preference; Type: ROW SECURITY; Schema: corvis_control; Owner: -
--

ALTER TABLE corvis_control.workspace_user_preference ENABLE ROW LEVEL SECURITY;

--
-- Name: canonical_candidate; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.canonical_candidate ENABLE ROW LEVEL SECURITY;

--
-- Name: canonicalization_run; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.canonicalization_run ENABLE ROW LEVEL SECURITY;

--
-- Name: client_portfolio; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.client_portfolio ENABLE ROW LEVEL SECURITY;

--
-- Name: client_portfolio_fund_position; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.client_portfolio_fund_position ENABLE ROW LEVEL SECURITY;

--
-- Name: client_portfolio_fund_position client_portfolio_fund_workspace_select; Type: POLICY; Schema: corvis_facts; Owner: -
--

CREATE POLICY client_portfolio_fund_workspace_select ON corvis_facts.client_portfolio_fund_position FOR SELECT USING ((EXISTS ( SELECT 1
   FROM corvis_facts.client_portfolio p
  WHERE ((p.tenant_id = client_portfolio_fund_position.tenant_id) AND (p.portfolio_id = client_portfolio_fund_position.portfolio_id) AND corvis_control.has_workspace_access(p.tenant_id, p.workspace_id)))));


--
-- Name: client_portfolio client_portfolio_workspace_select; Type: POLICY; Schema: corvis_facts; Owner: -
--

CREATE POLICY client_portfolio_workspace_select ON corvis_facts.client_portfolio FOR SELECT USING (corvis_control.has_workspace_access(tenant_id, workspace_id));


--
-- Name: company_sector_classification; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.company_sector_classification ENABLE ROW LEVEL SECURITY;

--
-- Name: company_sector_classification company_sector_classification_tenant_select; Type: POLICY; Schema: corvis_facts; Owner: -
--

CREATE POLICY company_sector_classification_tenant_select ON corvis_facts.company_sector_classification FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: holding; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.holding ENABLE ROW LEVEL SECURITY;

--
-- Name: holding_revision; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.holding_revision ENABLE ROW LEVEL SECURITY;

--
-- Name: holding holding_tenant_select; Type: POLICY; Schema: corvis_facts; Owner: -
--

CREATE POLICY holding_tenant_select ON corvis_facts.holding FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: instrument; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.instrument ENABLE ROW LEVEL SECURITY;

--
-- Name: instrument_revision; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.instrument_revision ENABLE ROW LEVEL SECURITY;

--
-- Name: instrument instrument_tenant_select; Type: POLICY; Schema: corvis_facts; Owner: -
--

CREATE POLICY instrument_tenant_select ON corvis_facts.instrument FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: observation; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.observation ENABLE ROW LEVEL SECURITY;

--
-- Name: observation_correction; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.observation_correction ENABLE ROW LEVEL SECURITY;

--
-- Name: observation_correction observation_correction_tenant_select; Type: POLICY; Schema: corvis_facts; Owner: -
--

CREATE POLICY observation_correction_tenant_select ON corvis_facts.observation_correction FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: observation_source_reference; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.observation_source_reference ENABLE ROW LEVEL SECURITY;

--
-- Name: observation observation_tenant_select; Type: POLICY; Schema: corvis_facts; Owner: -
--

CREATE POLICY observation_tenant_select ON corvis_facts.observation FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: position_financial_statement; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.position_financial_statement ENABLE ROW LEVEL SECURITY;

--
-- Name: position_financial_statement_line; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.position_financial_statement_line ENABLE ROW LEVEL SECURITY;

--
-- Name: position_financial_statement_line position_financial_statement_line_tenant_select; Type: POLICY; Schema: corvis_facts; Owner: -
--

CREATE POLICY position_financial_statement_line_tenant_select ON corvis_facts.position_financial_statement_line FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: position_financial_statement position_financial_statement_tenant_select; Type: POLICY; Schema: corvis_facts; Owner: -
--

CREATE POLICY position_financial_statement_tenant_select ON corvis_facts.position_financial_statement FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: position_financial_statement_value; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.position_financial_statement_value ENABLE ROW LEVEL SECURITY;

--
-- Name: position_financial_statement_value position_financial_statement_value_tenant_select; Type: POLICY; Schema: corvis_facts; Owner: -
--

CREATE POLICY position_financial_statement_value_tenant_select ON corvis_facts.position_financial_statement_value FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: review_event; Type: ROW SECURITY; Schema: corvis_facts; Owner: -
--

ALTER TABLE corvis_facts.review_event ENABLE ROW LEVEL SECURITY;

--
-- Name: review_event review_event_tenant_select; Type: POLICY; Schema: corvis_facts; Owner: -
--

CREATE POLICY review_event_tenant_select ON corvis_facts.review_event FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: tenant_entity_lifecycle_evidence; Type: ROW SECURITY; Schema: corvis_identity; Owner: -
--

ALTER TABLE corvis_identity.tenant_entity_lifecycle_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_entity_lifecycle_evidence tenant_entity_lifecycle_evidence_select; Type: POLICY; Schema: corvis_identity; Owner: -
--

CREATE POLICY tenant_entity_lifecycle_evidence_select ON corvis_identity.tenant_entity_lifecycle_evidence FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: tenant_entity_name; Type: ROW SECURITY; Schema: corvis_identity; Owner: -
--

ALTER TABLE corvis_identity.tenant_entity_name ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_entity_name tenant_entity_name_tenant_select; Type: POLICY; Schema: corvis_identity; Owner: -
--

CREATE POLICY tenant_entity_name_tenant_select ON corvis_identity.tenant_entity_name FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: tenant_entity_revision; Type: ROW SECURITY; Schema: corvis_identity; Owner: -
--

ALTER TABLE corvis_identity.tenant_entity_revision ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_entity_revision tenant_entity_revision_select; Type: POLICY; Schema: corvis_identity; Owner: -
--

CREATE POLICY tenant_entity_revision_select ON corvis_identity.tenant_entity_revision FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: tenant_lifecycle_revision; Type: ROW SECURITY; Schema: corvis_identity; Owner: -
--

ALTER TABLE corvis_identity.tenant_lifecycle_revision ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_lifecycle_revision tenant_lifecycle_revision_select; Type: POLICY; Schema: corvis_identity; Owner: -
--

CREATE POLICY tenant_lifecycle_revision_select ON corvis_identity.tenant_lifecycle_revision FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: candidate_review_event; Type: ROW SECURITY; Schema: corvis_review; Owner: -
--

ALTER TABLE corvis_review.candidate_review_event ENABLE ROW LEVEL SECURITY;

--
-- Name: candidate_review_requirement; Type: ROW SECURITY; Schema: corvis_review; Owner: -
--

ALTER TABLE corvis_review.candidate_review_requirement ENABLE ROW LEVEL SECURITY;

--
-- Name: extraction_review_gate; Type: ROW SECURITY; Schema: corvis_review; Owner: -
--

ALTER TABLE corvis_review.extraction_review_gate ENABLE ROW LEVEL SECURITY;

--
-- Name: export_download_grant; Type: ROW SECURITY; Schema: corvis_serving; Owner: -
--

ALTER TABLE corvis_serving.export_download_grant ENABLE ROW LEVEL SECURITY;

--
-- Name: export_download_grant export_download_grant_tenant_select; Type: POLICY; Schema: corvis_serving; Owner: -
--

CREATE POLICY export_download_grant_tenant_select ON corvis_serving.export_download_grant FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: export_job; Type: ROW SECURITY; Schema: corvis_serving; Owner: -
--

ALTER TABLE corvis_serving.export_job ENABLE ROW LEVEL SECURITY;

--
-- Name: export_job export_job_tenant_select; Type: POLICY; Schema: corvis_serving; Owner: -
--

CREATE POLICY export_job_tenant_select ON corvis_serving.export_job FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: acquired_document; Type: ROW SECURITY; Schema: corvis_source; Owner: -
--

ALTER TABLE corvis_source.acquired_document ENABLE ROW LEVEL SECURITY;

--
-- Name: acquired_document acquired_document_tenant_select; Type: POLICY; Schema: corvis_source; Owner: -
--

CREATE POLICY acquired_document_tenant_select ON corvis_source.acquired_document FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: document_artifact_version artifact_tenant_select; Type: POLICY; Schema: corvis_source; Owner: -
--

CREATE POLICY artifact_tenant_select ON corvis_source.document_artifact_version FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: document; Type: ROW SECURITY; Schema: corvis_source; Owner: -
--

ALTER TABLE corvis_source.document ENABLE ROW LEVEL SECURITY;

--
-- Name: document_artifact_version; Type: ROW SECURITY; Schema: corvis_source; Owner: -
--

ALTER TABLE corvis_source.document_artifact_version ENABLE ROW LEVEL SECURITY;

--
-- Name: document_representation; Type: ROW SECURITY; Schema: corvis_source; Owner: -
--

ALTER TABLE corvis_source.document_representation ENABLE ROW LEVEL SECURITY;

--
-- Name: document document_tenant_select; Type: POLICY; Schema: corvis_source; Owner: -
--

CREATE POLICY document_tenant_select ON corvis_source.document FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: extraction_candidate; Type: ROW SECURITY; Schema: corvis_source; Owner: -
--

ALTER TABLE corvis_source.extraction_candidate ENABLE ROW LEVEL SECURITY;

--
-- Name: extraction_candidate_source_reference; Type: ROW SECURITY; Schema: corvis_source; Owner: -
--

ALTER TABLE corvis_source.extraction_candidate_source_reference ENABLE ROW LEVEL SECURITY;

--
-- Name: extraction_run; Type: ROW SECURITY; Schema: corvis_source; Owner: -
--

ALTER TABLE corvis_source.extraction_run ENABLE ROW LEVEL SECURITY;

--
-- Name: source_connection; Type: ROW SECURITY; Schema: corvis_source; Owner: -
--

ALTER TABLE corvis_source.source_connection ENABLE ROW LEVEL SECURITY;

--
-- Name: source_connection_run; Type: ROW SECURITY; Schema: corvis_source; Owner: -
--

ALTER TABLE corvis_source.source_connection_run ENABLE ROW LEVEL SECURITY;

--
-- Name: source_connection_run source_connection_run_tenant_select; Type: POLICY; Schema: corvis_source; Owner: -
--

CREATE POLICY source_connection_run_tenant_select ON corvis_source.source_connection_run FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: source_reference; Type: ROW SECURITY; Schema: corvis_source; Owner: -
--

ALTER TABLE corvis_source.source_reference ENABLE ROW LEVEL SECURITY;

--
-- Name: source_reference source_reference_tenant_select; Type: POLICY; Schema: corvis_source; Owner: -
--

CREATE POLICY source_reference_tenant_select ON corvis_source.source_reference FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));


--
-- Name: FUNCTION accept_tenant_invitation(p_token_sha256 text, p_auth_method text, p_subject text, p_email text, p_email_verified boolean, p_correlation_id text); Type: ACL; Schema: corvis_control; Owner: -
--

REVOKE ALL ON FUNCTION corvis_control.accept_tenant_invitation(p_token_sha256 text, p_auth_method text, p_subject text, p_email text, p_email_verified boolean, p_correlation_id text) FROM PUBLIC;


--
-- Name: FUNCTION apply_data_right_admin_authorized(p_target_tenant_id uuid, p_actor_tenant_id uuid, p_actor_subject text, p_actor_workspace_id uuid, p_correlation_id text, p_operation text, p_resource_type text, p_resource_id text, p_client_visible boolean, p_internal_analytics_allowed boolean, p_model_training_allowed boolean, p_redistribution_allowed boolean, p_source_document_access_allowed boolean, p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_contract_reference text, p_reason text); Type: ACL; Schema: corvis_control; Owner: -
--

REVOKE ALL ON FUNCTION corvis_control.apply_data_right_admin_authorized(p_target_tenant_id uuid, p_actor_tenant_id uuid, p_actor_subject text, p_actor_workspace_id uuid, p_correlation_id text, p_operation text, p_resource_type text, p_resource_id text, p_client_visible boolean, p_internal_analytics_allowed boolean, p_model_training_allowed boolean, p_redistribution_allowed boolean, p_source_document_access_allowed boolean, p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_contract_reference text, p_reason text) FROM PUBLIC;


--
-- Name: FUNCTION consume_api_rate_limit(p_tenant_id uuid, p_subject text, p_limit integer); Type: ACL; Schema: corvis_control; Owner: -
--

REVOKE ALL ON FUNCTION corvis_control.consume_api_rate_limit(p_tenant_id uuid, p_subject text, p_limit integer) FROM PUBLIC;

INSERT INTO corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) VALUES ('corvis_sector_v1', 'technology', 'Technology', 'Software, IT services, semiconductors and technology hardware.', 1);
INSERT INTO corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) VALUES ('corvis_sector_v1', 'healthcare', 'Healthcare', 'Healthcare providers and services, pharmaceuticals, biotechnology, medical devices and life sciences tools.', 2);
INSERT INTO corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) VALUES ('corvis_sector_v1', 'financials', 'Financials', 'Banks, insurance, asset and wealth management, payments and specialty finance.', 3);
INSERT INTO corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) VALUES ('corvis_sector_v1', 'industrials', 'Industrials', 'Capital goods, aerospace and defense, transportation, logistics and business services.', 4);
INSERT INTO corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) VALUES ('corvis_sector_v1', 'consumer_discretionary', 'Consumer discretionary', 'Retail, leisure, hospitality, automotive, education and consumer services.', 5);
INSERT INTO corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) VALUES ('corvis_sector_v1', 'consumer_staples', 'Consumer staples', 'Food, beverage, household and personal products, and staples retail.', 6);
INSERT INTO corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) VALUES ('corvis_sector_v1', 'communication_services', 'Communication services', 'Telecommunications, media, entertainment and interactive platforms.', 7);
INSERT INTO corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) VALUES ('corvis_sector_v1', 'energy', 'Energy', 'Oil, gas and consumable fuels, and energy equipment and services.', 8);
INSERT INTO corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) VALUES ('corvis_sector_v1', 'materials', 'Materials', 'Chemicals, construction materials, packaging, metals and mining.', 9);
INSERT INTO corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) VALUES ('corvis_sector_v1', 'real_estate', 'Real estate', 'Real estate owners, operators, developers and services.', 10);
INSERT INTO corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) VALUES ('corvis_sector_v1', 'utilities', 'Utilities', 'Electric, gas and water utilities, and renewable power producers.', 11);
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'technology', 'technology');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'tech', 'technology');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'information technology', 'technology');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'it', 'technology');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'software', 'technology');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'software and services', 'technology');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'tmt', 'technology');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'semiconductors', 'technology');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'healthcare', 'healthcare');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'health care', 'healthcare');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'life sciences', 'healthcare');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'pharmaceuticals', 'healthcare');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'biotechnology', 'healthcare');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'medical devices', 'healthcare');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'financials', 'financials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'financial services', 'financials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'insurance', 'financials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'banking', 'financials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'industrials', 'industrials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'industrial', 'industrials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'business services', 'industrials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'aerospace and defense', 'industrials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'transportation', 'industrials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'logistics', 'industrials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'consumer discretionary', 'consumer_discretionary');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'consumer', 'consumer_discretionary');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'retail', 'consumer_discretionary');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'leisure', 'consumer_discretionary');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'education', 'consumer_discretionary');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'consumer staples', 'consumer_staples');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'food and beverage', 'consumer_staples');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'communication services', 'communication_services');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'communications', 'communication_services');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'media', 'communication_services');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'telecommunications', 'communication_services');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'telecom', 'communication_services');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'energy', 'energy');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'oil and gas', 'energy');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'materials', 'materials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'chemicals', 'materials');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'real estate', 'real_estate');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'property', 'real_estate');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'utilities', 'utilities');
INSERT INTO corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) VALUES ('corvis_sector_v1', 'infrastructure and utilities', 'utilities');

-- Supabase's `service_role` exists only on Supabase-style layouts, so its grants are conditional.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on corvis_control.api_rate_limit to service_role;
    grant execute on function corvis_control.consume_api_rate_limit(uuid, text, integer) to service_role;
    grant execute on function corvis_control.accept_tenant_invitation(text, text, text, text, boolean, text) to service_role;
    grant execute on function corvis_control.apply_data_right_admin_authorized(uuid, uuid, text, uuid, text, text, text, text, boolean, boolean, boolean, boolean, boolean, timestamptz, timestamptz, text, text) to service_role;
  end if;
end;
$$;

commit;
