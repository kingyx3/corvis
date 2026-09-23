-- Acceptance for migration 043: processing retries reach dead_letter,
-- superseded/exhausted claims never raise, webhook fan-out has its own
-- completion marker, and apply_identity_lifecycle resolves pgcrypto from the
-- Supabase `extensions` schema. Run after the full migration chain on an
-- isolated disposable database. Everything is rolled back.

\set ON_ERROR_STOP on

begin;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('a0430000-0000-4000-8000-000000000001','retry-exhaustion-ci','Retry Exhaustion CI');

insert into corvis_source.document (tenant_id,document_id,display_name,media_type,status,created_by)
values
  ('a0430000-0000-4000-8000-000000000001','a0430000-0000-4000-8000-0000000000d1','Exhaustion fixture','application/pdf','registered','ci'),
  ('a0430000-0000-4000-8000-000000000001','a0430000-0000-4000-8000-0000000000d2','Legacy stranded fixture','application/pdf','registered','ci'),
  ('a0430000-0000-4000-8000-000000000001','a0430000-0000-4000-8000-0000000000d3','Superseded fixture','application/pdf','registered','ci');

insert into corvis_control.processing_job
  (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
values
  ('a0430000-0000-4000-8000-000000000001','registered:a0430000-0000-4000-8000-0000000000d1',
   'a0430000-0000-4000-8000-0000000000d1','registered','queued',0,5,'ci-exhaustion',1),
  ('a0430000-0000-4000-8000-000000000001','registered:a0430000-0000-4000-8000-0000000000d2',
   'a0430000-0000-4000-8000-0000000000d2','registered','retryable',5,5,'ci-legacy',7),
  ('a0430000-0000-4000-8000-000000000001','registered:a0430000-0000-4000-8000-0000000000d3',
   'a0430000-0000-4000-8000-0000000000d3','registered','succeeded',1,5,'ci-superseded',3);

-- 1. Every automatic retry is a fresh outbox event (fresh inbox row). The
--    job's own budget must still dead-letter it on the fifth failure, and no
--    claim may raise.
do $$
declare
  tenant uuid := 'a0430000-0000-4000-8000-000000000001';
  doc uuid := 'a0430000-0000-4000-8000-0000000000d1';
  job text := 'registered:a0430000-0000-4000-8000-0000000000d1';
  current_event uuid := 'a0430000-0000-4000-8000-0000000000e1';
  current_type text := 'DocumentRegistered';
  current_payload jsonb := jsonb_build_object('jobId','registered:a0430000-0000-4000-8000-0000000000d1','documentId','a0430000-0000-4000-8000-0000000000d1','stage','registered');
  claim record;
  failure record;
  i integer;
  final_job corvis_control.processing_job%rowtype;
  recovered record;
begin
  for i in 1..5 loop
    select * into claim from corvis_control.claim_processing_stage_delivery(
      tenant,'processing-stage-worker',current_event,current_type,doc,job,'registered',
      current_payload,md5(current_payload::text),5,300);
    if claim.claimed is not true then raise exception 'attempt % was not claimed: %', i, row_to_json(claim); end if;

    select * into failure from corvis_control.fail_processing_stage_delivery(
      tenant,'processing-stage-worker',current_event,claim.claim_lease_token,job,'ci induced failure '||i);
    if i < 5 and failure.next_state <> 'retryable' then raise exception 'attempt % expected retryable, got %', i, failure.next_state; end if;
    if i = 5 and failure.next_state <> 'dead_letter' then raise exception 'fifth failure must dead-letter, got %', failure.next_state; end if;

    if i < 5 then
      select event_id,event_type,payload into current_event,current_type,current_payload
      from corvis_control.outbox_event
      where tenant_id=tenant and aggregate_id=job and event_type='ProcessingStageRetryScheduled'
        and (payload->>'attempt')::integer=i;
      if current_event is null then raise exception 'retry signal % missing', i; end if;
    end if;
  end loop;

  select * into final_job from corvis_control.processing_job where tenant_id=tenant and job_id=job;
  if final_job.state <> 'dead_letter' or final_job.attempt <> 5 then
    raise exception 'job must be dead_letter at attempt 5, got % at %', final_job.state, final_job.attempt;
  end if;
  if not exists (select 1 from corvis_control.outbox_event where tenant_id=tenant and aggregate_id=job and event_type='ProcessingStageDeadLettered') then
    raise exception 'dead-letter signal missing';
  end if;
  if exists (select 1 from corvis_control.event_inbox where tenant_id=tenant and event_id=current_event and state<>'failed') then
    raise exception 'exhausting event must be terminal in the inbox';
  end if;

  -- A late redelivery of the last retry event is acknowledged, not raised.
  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker',current_event,current_type,doc,job,'registered',
    current_payload,md5(current_payload::text),5,300);
  if claim.claimed or claim.job_state <> 'dead_letter' then raise exception 'late redelivery must report dead_letter: %', row_to_json(claim); end if;

  -- Operator recovery is now reachable.
  select * into recovered from corvis_control.recover_dead_letter_processing_job(
    tenant,job,final_job.version,'a0430000-0000-4000-8000-0000000000f1','ci-operator','ci_recovery',null);
  if recovered.new_version is null then raise exception 'dead-letter recovery did not apply'; end if;
end;
$$;

-- 2. A job stranded before 043 (retryable with attempts exhausted) is
--    dead-lettered by the claim path instead of raising forever.
do $$
declare
  tenant uuid := 'a0430000-0000-4000-8000-000000000001';
  claim record;
  job_row corvis_control.processing_job%rowtype;
  payload jsonb := jsonb_build_object('jobId','registered:a0430000-0000-4000-8000-0000000000d2');
begin
  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker','a0430000-0000-4000-8000-0000000000e2','ProcessingStageRetryScheduled',
    'a0430000-0000-4000-8000-0000000000d2','registered:a0430000-0000-4000-8000-0000000000d2','registered',
    payload,md5(payload::text),5,300);
  if claim.claimed or claim.inbox_state <> 'failed' or claim.job_state <> 'dead_letter' then
    raise exception 'exhausted claim must dead-letter without raising: %', row_to_json(claim);
  end if;
  select * into job_row from corvis_control.processing_job where tenant_id=tenant and job_id='registered:a0430000-0000-4000-8000-0000000000d2';
  if job_row.state <> 'dead_letter' or job_row.version <> 8 then raise exception 'stranded job not dead-lettered: % v%', job_row.state, job_row.version; end if;
end;
$$;

-- 3. A superseded delivery for an already-succeeded job is terminal, not a raise.
do $$
declare
  tenant uuid := 'a0430000-0000-4000-8000-000000000001';
  claim record;
  payload jsonb := jsonb_build_object('jobId','registered:a0430000-0000-4000-8000-0000000000d3');
begin
  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker','a0430000-0000-4000-8000-0000000000e3','ProcessingJobRetryRequested',
    'a0430000-0000-4000-8000-0000000000d3','registered:a0430000-0000-4000-8000-0000000000d3','registered',
    payload,md5(payload::text),5,300);
  if claim.claimed or claim.inbox_state <> 'failed' or claim.job_state <> 'succeeded' then
    raise exception 'superseded claim must be terminal: %', row_to_json(claim);
  end if;
  if (select state from corvis_control.processing_job where tenant_id=tenant and job_id='registered:a0430000-0000-4000-8000-0000000000d3') <> 'succeeded' then
    raise exception 'superseded claim must not change the job';
  end if;
end;
$$;

-- 4. Webhook fan-out and export reclaim bookkeeping columns exist.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='corvis_control' and table_name='outbox_event' and column_name='webhook_fanout_completed_at') then
    raise exception 'outbox_event.webhook_fanout_completed_at missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='corvis_serving' and table_name='export_job' and column_name='delivery_started_at') then
    raise exception 'export_job.delivery_started_at missing';
  end if;
end;
$$;

-- 5. apply_identity_lifecycle resolves digest() from `extensions` even when
--    the caller's search_path cannot see pgcrypto (the Supabase layout).
create schema if not exists extensions;
alter extension pgcrypto set schema extensions;
set local search_path = pg_catalog;
select corvis_control.apply_identity_lifecycle(
  'a0430000-0000-4000-8000-000000000001','ci-lifecycle-1','ci-admin',null,'ci-correlation',
  'sync','oidc','ci-subject','a0430000-0000-4000-8000-0000000000a1','[]'::jsonb,'ci search_path check'
) is not null as identity_lifecycle_resolves_pgcrypto;

rollback;
