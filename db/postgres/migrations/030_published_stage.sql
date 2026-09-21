-- Corvis governed consolidation-to-publication stage v1
-- Depends on migrations 001-029.
--
-- Publication is an immutable snapshot-version transition. This migration also
-- repairs the shared publication function so later correction controls extend,
-- rather than replace, reconciliation/review/lineage gates.

begin;

create table if not exists corvis_consolidated.publication_run (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  publication_run_id uuid not null,
  consolidation_run_id uuid not null,
  document_id uuid not null,
  snapshot_id uuid not null,
  source_snapshot_version integer not null check (source_snapshot_version > 0),
  published_snapshot_version integer not null check (published_snapshot_version > source_snapshot_version),
  publication_event_id uuid not null,
  idempotency_key text not null,
  status text not null check (status='ready'),
  fact_count integer not null check (fact_count > 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  primary key (tenant_id,publication_run_id),
  foreign key (tenant_id,consolidation_run_id)
    references corvis_consolidated.consolidation_run(tenant_id,consolidation_run_id),
  foreign key (tenant_id,document_id)
    references corvis_source.document(tenant_id,document_id),
  foreign key (tenant_id,snapshot_id,source_snapshot_version)
    references corvis_consolidated.fund_period_snapshot(tenant_id,snapshot_id,version),
  foreign key (tenant_id,snapshot_id,published_snapshot_version)
    references corvis_consolidated.fund_period_snapshot(tenant_id,snapshot_id,version),
  foreign key (tenant_id,publication_event_id)
    references corvis_consolidated.snapshot_publication_event(tenant_id,publication_event_id),
  unique (tenant_id,consolidation_run_id),
  unique (tenant_id,idempotency_key),
  check (btrim(idempotency_key) <> '')
);

alter table corvis_consolidated.publication_run enable row level security;
alter table corvis_consolidated.publication_run force row level security;
-- Worker-managed publication state intentionally has no direct client policy.

create index if not exists publication_run_snapshot_idx
  on corvis_consolidated.publication_run
    (tenant_id,snapshot_id,published_snapshot_version,completed_at desc);
create index if not exists publication_run_document_idx
  on corvis_consolidated.publication_run
    (tenant_id,document_id,completed_at desc);

-- Central persistence gate used by both automated processing publication and the
-- existing authorized manual publication API. A caller cannot bypass it by invoking
-- append_snapshot_transition directly.
create or replace function corvis_consolidated.assert_snapshot_publishable(
  p_tenant_id uuid,
  p_snapshot_id uuid,
  p_snapshot_version integer
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, corvis_consolidated, corvis_facts, corvis_review, corvis_control
as $$
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

  -- Conflicting alternatives may be published only when the corresponding exact
  -- semantic-grain conflict was explicitly resolved. Consolidation still retains all
  -- alternatives; this gate proves that retaining them was an attributable decision.
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
          and e.reconciliation_run_id=cf.reconciliation_run_id
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

-- Restore the shared manual/API transition with the union of historical gates. The
-- publication path now calls the same authoritative gate as automated processing;
-- withdraw/supersede retain their existing immutable-version behavior.
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
set search_path = pg_catalog, corvis_consolidated, corvis_control
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

create or replace function corvis_consolidated.publish_consolidation(
  p_tenant_id uuid,
  p_document_id uuid,
  p_consolidation_run_id uuid,
  p_snapshot_id uuid,
  p_source_snapshot_version integer,
  p_idempotency_key text
)
returns table(
  publication_run_id uuid,
  consolidation_run_id uuid,
  snapshot_id uuid,
  source_snapshot_version integer,
  snapshot_version integer,
  publication_event_id uuid,
  fact_count integer,
  publication_ready boolean
)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_consolidated, corvis_control
as $$
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
      and j.job_id='consolidated:' || p_document_id::text
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

-- Final processing-stage persistence guard. There is no downstream stage after
-- `published`, but the job itself may not succeed unless an exact immutable published
-- snapshot and attributable publication event were committed.
create or replace function corvis_consolidated.enforce_ready_publication_before_success()
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

drop trigger if exists processing_job_publication_gate_guard
  on corvis_control.processing_job;
create trigger processing_job_publication_gate_guard
before update of state on corvis_control.processing_job
for each row
execute function corvis_consolidated.enforce_ready_publication_before_success();

commit;
