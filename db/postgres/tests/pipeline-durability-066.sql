-- Acceptance for migration 066 (issues #230, #231, #232): transport lease
-- release, dead-letter reporting, deletion execution lease, snapshot-scoped
-- publication pre-flight counts, export retry backoff column and single-use
-- download grants. Run after the full migration chain on an isolated disposable
-- database (superuser: it bypasses forced RLS and, via replica role, FKs and
-- triggers so the fixtures stay minimal). Everything is rolled back.
--
-- The three statements marked "keep in sync" are the exact SQL the application
-- issues (src/platform/platform-repositories.ts, data-lifecycle.ts,
-- physical-exports.ts); the TypeScript tests pin their text, this file pins
-- their behaviour against real Postgres.

\set ON_ERROR_STOP on

begin;
set local session_replication_role = replica;

-- 1. Transport: release hands an unattempted event back without burning an attempt;
--    the eighth failure dead-letters and reports it.
do $$
declare
  tenant uuid := 'a0660000-0000-4000-8000-000000000001';
  event uuid := 'a0660000-0000-4000-8000-0000000000e1';
  claimed record;
  released boolean;
  failed record;
  i integer;
begin
  insert into corvis_control.outbox_event (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload)
  values (tenant,event,'DocumentRegistered','document','doc-1','{}'::jsonb);

  select * into claimed from corvis_control.claim_processing_transport_events(10,60) where event_id=event;
  if claimed.attempt_count <> 1 then raise exception 'first claim must be attempt 1, got %', claimed.attempt_count; end if;

  select corvis_control.release_processing_transport_event(tenant,event,gen_random_uuid()) into released;
  if released then raise exception 'a stale/foreign lease token must not release the event'; end if;

  select corvis_control.release_processing_transport_event(tenant,event,claimed.lease_token) into released;
  if not released then raise exception 'the lease holder must be able to release'; end if;
  if exists (select 1 from corvis_control.outbox_event where event_id=event and (attempt_count<>0 or transport_lease_token is not null)) then
    raise exception 'release must clear the lease and refund the attempt';
  end if;

  select * into claimed from corvis_control.claim_processing_transport_events(10,60) where event_id=event;
  if claimed.attempt_count <> 1 then raise exception 'a released event must be claimable again as attempt 1'; end if;

  -- Drive the remaining attempts to the dead-letter threshold.
  for i in 1..8 loop
    select * into failed from corvis_control.fail_processing_transport_event(tenant,event,claimed.lease_token,'ci failure '||i,8);
    if i < 8 then
      if failed.dead_lettered is distinct from false then raise exception 'attempt % must not dead-letter', i; end if;
      update corvis_control.outbox_event set next_attempt_at=now()-interval '1 second' where event_id=event;
      select * into claimed from corvis_control.claim_processing_transport_events(10,60) where event_id=event;
    end if;
  end loop;
  if failed.dead_lettered is not true then raise exception 'the 8th failure must report dead_lettered'; end if;
  if not exists (select 1 from corvis_control.outbox_event where event_id=event and transport_dead_lettered_at is not null) then
    raise exception 'dead-letter timestamp missing';
  end if;
  select corvis_control.release_processing_transport_event(tenant,event,claimed.lease_token) into released;
  if released then raise exception 'a dead-lettered event cannot be released'; end if;
end
$$;

-- 2. Deletion execution lease: a live lease blocks the claim, an expired or legacy
--    (null) lease allows exactly one reclaimer. keep in sync with data-lifecycle.ts.
do $$
declare
  tenant uuid := 'a0660000-0000-4000-8000-000000000001';
  live uuid := 'a0660000-0000-4000-8000-0000000000a1';
  expired uuid := 'a0660000-0000-4000-8000-0000000000a2';
  legacy uuid := 'a0660000-0000-4000-8000-0000000000a3';
  affected integer;
  id uuid;
begin
  insert into corvis_control.deletion_request (tenant_id,deletion_request_id,requested_by,scope,reason,state,execution_attempts,execution_lease_expires_at)
  values (tenant,live,'requester','{"dataClasses":["x"]}','r','executing',1,now()+interval '5 minutes'),
         (tenant,expired,'requester','{"dataClasses":["x"]}','r','executing',1,now()-interval '1 minute'),
         (tenant,legacy,'requester','{"dataClasses":["x"]}','r','executing',1,null);

  foreach id in array array[live,expired,legacy] loop
    update corvis_control.deletion_request set
        state='executing', approved_by=coalesce(approved_by,'approver'), approved_at=coalesce(approved_at,now()),
        execution_attempts=2,
        execution_lease_expires_at=now()+make_interval(mins => 10),
        blocked_reason=null, last_error=null
      where tenant_id=tenant and deletion_request_id=id and state='executing' and execution_attempts=1
        and (state<>'executing' or coalesce(execution_lease_expires_at,'-infinity'::timestamptz) < now());
    get diagnostics affected = row_count;
    if id = live and affected <> 0 then raise exception 'a live lease must not be reclaimed'; end if;
    if id <> live and affected <> 1 then raise exception 'an expired/legacy lease must be reclaimed exactly once (%)', id; end if;
  end loop;

  -- The reclaimed rows now hold a fresh lease, so a second reclaimer loses the race.
  update corvis_control.deletion_request set execution_attempts=3
    where tenant_id=tenant and deletion_request_id=expired and state='executing' and execution_attempts=2
      and (state<>'executing' or coalesce(execution_lease_expires_at,'-infinity'::timestamptz) < now());
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'a second reclaimer must lose against the fresh lease'; end if;
end
$$;

-- 3. Publication pre-flight counts are scoped to the snapshot version's own source
--    observations and ignore terminal states. keep in sync with platform-repositories.ts.
do $$
declare
  tenant uuid := 'a0660000-0000-4000-8000-000000000001';
  snap uuid := 'a0660000-0000-4000-8000-0000000000b1';
  ref uuid := 'a0660000-0000-4000-8000-0000000000c1';
  o_approved uuid := 'a0660000-0000-4000-8000-0000000000d1';
  o_rejected uuid := 'a0660000-0000-4000-8000-0000000000d2';
  o_pending uuid := 'a0660000-0000-4000-8000-0000000000d3';
  o_other_period uuid := 'a0660000-0000-4000-8000-0000000000d4';
  o_dangling uuid := 'a0660000-0000-4000-8000-0000000000d5';
  counts record;
  dangling_needs_review integer;
begin
  insert into corvis_facts.observation (tenant_id,observation_id,fund_id,metric_code,value_number,review_state,source_reference_id,schema_version,risk_tier)
  values (tenant,o_approved,'fund-a','nav',1,'approved',ref,'v1','critical'),
         (tenant,o_rejected,'fund-a','nav',1,'rejected',ref,'v1','normal'),
         (tenant,o_pending,'fund-a','nav',1,'review_required',ref,'v1','normal'),
         (tenant,o_other_period,'fund-a','nav',1,'review_required',ref,'v1','normal');
  insert into corvis_consolidated.consolidated_fact (tenant_id,consolidated_fact_id,fund_id,subject_type,subject_id,metric_code,value,source_observation_ids,consolidation_rule_version)
  values (tenant,'a0660000-0000-4000-8000-0000000000f1','fund-a','fund','fund-a','nav','{"semanticDimensions":{"subjectLevel":"fund"}}'::jsonb,array[o_approved,o_rejected],'v1'),
         (tenant,'a0660000-0000-4000-8000-0000000000f2','fund-a','fund','fund-a','nav','{"semanticDimensions":{"subjectLevel":"fund"}}'::jsonb,array[o_pending,o_approved],'v1');
  insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,fact_ids,schema_version,taxonomy_version)
  values (tenant,snap,'fund-a','Q2 2026',1,'draft',
          array['a0660000-0000-4000-8000-0000000000f1','a0660000-0000-4000-8000-0000000000f2']::uuid[],'v1','v1');

  select * into counts from (
    with snapshot_observation as (
        select distinct src.observation_id
        from corvis_consolidated.fund_period_snapshot s
        join corvis_consolidated.consolidated_fact cf
          on cf.tenant_id=s.tenant_id and cf.consolidated_fact_id=any(s.fact_ids)
        cross join lateral unnest(cf.source_observation_ids) as src(observation_id)
        where s.tenant_id=tenant and s.snapshot_id=snap and s.version=1
      )
      select
        count(*) filter (where o.observation_id is null or o.review_state not in ('approved','rejected','superseded')) as needs_review_count,
        count(*) filter (where o.risk_tier='critical' and o.review_state='approved') as critical_count,
        count(*) filter (where o.review_state not in ('rejected','superseded') and o.source_reference_id is not null) as lineage_count,
        count(*) filter (where o.observation_id is null or o.review_state not in ('rejected','superseded')) as total_count
      from snapshot_observation so
      left join corvis_facts.observation o
        on o.tenant_id=tenant and o.observation_id=so.observation_id
  ) q;
  -- rejected row and the other-period pending row (o_other_period is in no fact) must not count.
  if counts.needs_review_count <> 1 then raise exception 'needs_review must be 1 (only o_pending), got %', counts.needs_review_count; end if;
  if counts.total_count <> 2 then raise exception 'total must exclude the rejected row, got %', counts.total_count; end if;
  if counts.lineage_count <> 2 then raise exception 'lineage must be 2, got %', counts.lineage_count; end if;
  if counts.critical_count <> 1 then raise exception 'critical must be 1, got %', counts.critical_count; end if;

  -- A dangling source observation id is never more lenient than the DB gate: it needs review.
  update corvis_consolidated.consolidated_fact set source_observation_ids=array[o_approved,o_dangling]
    where consolidated_fact_id='a0660000-0000-4000-8000-0000000000f1';
  select count(*) filter (where o.observation_id is null or o.review_state not in ('approved','rejected','superseded')) into dangling_needs_review
  from (
    select distinct src.observation_id
    from corvis_consolidated.fund_period_snapshot s
    join corvis_consolidated.consolidated_fact cf
      on cf.tenant_id=s.tenant_id and cf.consolidated_fact_id=any(s.fact_ids)
    cross join lateral unnest(cf.source_observation_ids) as src(observation_id)
    where s.tenant_id=tenant and s.snapshot_id=snap and s.version=1
  ) so left join corvis_facts.observation o on o.tenant_id=tenant and o.observation_id=so.observation_id;
  if dangling_needs_review <> 2 then raise exception 'a dangling reference must count as needing review, got %', dangling_needs_review; end if;
end
$$;

-- 4. Export single-use grants. keep in sync with physical-exports.ts.
do $$
declare
  tenant uuid := 'a0660000-0000-4000-8000-000000000001';
  v_export uuid := 'a0660000-0000-4000-8000-0000000000e9';
  affected integer;
  i integer;
begin
  insert into corvis_serving.export_job (tenant_id,export_id,requested_by,format,state,object_uri,expires_at,checksum_sha256,manifest)
  values (tenant,v_export,'analyst','csv','complete','gs://b/exports/x.csv',now()+interval '1 hour',repeat('a',64),'{}'::jsonb);
  insert into corvis_serving.export_download_grant (tenant_id,export_id,subject,token_sha256,expires_at)
  values (tenant,v_export,'analyst','tokenhash',now()+interval '5 minutes');

  for i in 1..2 loop
    with redeemed as (
      update corvis_serving.export_download_grant g
      set consumed_at=now()
      from corvis_serving.export_job j
      where j.tenant_id=g.tenant_id and j.export_id=g.export_id
        and g.tenant_id=tenant and g.export_id=v_export and g.subject='analyst'
        and g.token_sha256='tokenhash' and g.expires_at>now() and g.consumed_at is null
        and j.requested_by='analyst' and j.state='complete' and j.expires_at>now()
      returning j.object_uri
    ) select count(*) into affected from redeemed;
    if i = 1 and affected <> 1 then raise exception 'the first redemption must succeed'; end if;
    if i = 2 and affected <> 0 then raise exception 'a replayed grant must not redeem'; end if;
  end loop;

  -- Export retry backoff column is selectable and gates the queue predicate.
  update corvis_serving.export_job set state='retryable', delivery_next_attempt_at=now()+interval '10 minutes' where export_job.export_id=v_export;
  if exists (select 1 from corvis_serving.export_job where state in ('queued','retryable')
      and coalesce(delivery_next_attempt_at,'-infinity'::timestamptz) <= now()) then
    raise exception 'a backed-off export must not be due';
  end if;
end
$$;

rollback;
\echo pipeline-durability-066: ok
