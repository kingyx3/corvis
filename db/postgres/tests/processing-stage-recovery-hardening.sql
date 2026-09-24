-- Acceptance for migration 046: a processing job orphaned in 'running' (its
-- worker died before complete/block/fail) is reclaimed or dead-lettered once
-- the owning inbox lease expires, instead of raising on every redelivery.
-- A job whose owner still holds a live lease stays transient. Operator retry
-- re-emits the retained stage inputs. Run after the full migration chain on an
-- isolated disposable database. Rolled back.

\set ON_ERROR_STOP on

begin;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('a0450000-0000-4000-8000-000000000001','orphan-reclaim-ci','Orphan Reclaim CI');

insert into corvis_source.document (tenant_id,document_id,display_name,media_type,status,created_by)
values
  ('a0450000-0000-4000-8000-000000000001','a0450000-0000-4000-8000-0000000000d1','Orphan fixture','application/pdf','registered','ci'),
  ('a0450000-0000-4000-8000-000000000001','a0450000-0000-4000-8000-0000000000d2','Live lease fixture','application/pdf','registered','ci'),
  ('a0450000-0000-4000-8000-000000000001','a0450000-0000-4000-8000-0000000000d3','Exhausted orphan fixture','application/pdf','registered','ci');

insert into corvis_control.processing_job
  (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
values
  ('a0450000-0000-4000-8000-000000000001','registered:a0450000-0000-4000-8000-0000000000d1',
   'a0450000-0000-4000-8000-0000000000d1','registered','queued',0,5,'ci-orphan',1),
  ('a0450000-0000-4000-8000-000000000001','registered:a0450000-0000-4000-8000-0000000000d2',
   'a0450000-0000-4000-8000-0000000000d2','registered','queued',0,5,'ci-live',1),
  ('a0450000-0000-4000-8000-000000000001','registered:a0450000-0000-4000-8000-0000000000d3',
   'a0450000-0000-4000-8000-0000000000d3','registered','queued',4,5,'ci-exhausted',1);

-- 1. The worker claims, then dies. After the lease expires the redelivered
--    event re-claims the orphaned job and charges the lost attempt.
do $$
declare
  tenant uuid := 'a0450000-0000-4000-8000-000000000001';
  doc uuid := 'a0450000-0000-4000-8000-0000000000d1';
  job text := 'registered:a0450000-0000-4000-8000-0000000000d1';
  event uuid := 'a0450000-0000-4000-8000-0000000000e1';
  payload jsonb := jsonb_build_object('jobId','registered:a0450000-0000-4000-8000-0000000000d1');
  claim record;
  job_row corvis_control.processing_job%rowtype;
begin
  insert into corvis_control.outbox_event (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload)
  values (tenant,event,'DocumentRegistered','document',doc::text,payload);

  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker',event,'DocumentRegistered',doc,job,'registered',payload,md5(payload::text),5,300);
  if claim.claimed is not true then raise exception 'first delivery was not claimed: %', row_to_json(claim); end if;

  -- While the lease is live, a redelivery is simply busy (not claimed, no raise).
  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker',event,'DocumentRegistered',doc,job,'registered',payload,md5(payload::text),5,300);
  if claim.claimed or claim.inbox_state <> 'processing' then raise exception 'live lease must report busy: %', row_to_json(claim); end if;

  update corvis_control.event_inbox set lease_expires_at=now()-interval '1 second'
  where tenant_id=tenant and event_id=event;

  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker',event,'DocumentRegistered',doc,job,'registered',payload,md5(payload::text),5,300);
  if claim.claimed is not true or claim.claim_lease_token is null then
    raise exception 'orphaned running job must be re-claimed after lease expiry: %', row_to_json(claim);
  end if;
  select * into job_row from corvis_control.processing_job where tenant_id=tenant and job_id=job;
  if job_row.state <> 'running' or job_row.attempt <> 2 then
    raise exception 'orphaned attempt must be charged: % at %', job_row.state, job_row.attempt;
  end if;

  -- The new lease owns the job's transitions again.
  if (select next_state from corvis_control.fail_processing_stage_delivery(
    tenant,'processing-stage-worker',event,claim.claim_lease_token,job,'ci failure after reclaim')) <> 'retryable' then
    raise exception 'reclaimed lease must own the failure transition';
  end if;
end;
$$;

-- 2. A running job whose owner (a different event) still holds a live lease
--    remains transient: the claim raises and rolls back.
do $$
declare
  tenant uuid := 'a0450000-0000-4000-8000-000000000001';
  doc uuid := 'a0450000-0000-4000-8000-0000000000d2';
  job text := 'registered:a0450000-0000-4000-8000-0000000000d2';
  payload jsonb := jsonb_build_object('jobId','registered:a0450000-0000-4000-8000-0000000000d2');
  claim record;
  raised boolean := false;
begin
  insert into corvis_control.outbox_event (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload)
  values
    (tenant,'a0450000-0000-4000-8000-0000000000e2','DocumentRegistered','document',doc::text,payload),
    (tenant,'a0450000-0000-4000-8000-0000000000e3','ProcessingJobRetryRequested','document',doc::text,payload);

  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker','a0450000-0000-4000-8000-0000000000e2','DocumentRegistered',doc,job,'registered',payload,md5(payload::text),5,300);
  if claim.claimed is not true then raise exception 'owner delivery was not claimed'; end if;

  begin
    perform * from corvis_control.claim_processing_stage_delivery(
      tenant,'processing-stage-worker','a0450000-0000-4000-8000-0000000000e3','ProcessingJobRetryRequested',doc,job,'registered',payload,md5(payload::text),5,300);
  exception when others then
    if sqlerrm <> 'processing job is not claimable' then raise; end if;
    raised := true;
  end;
  if not raised then raise exception 'a live-leased running job must stay transient'; end if;
  if exists (select 1 from corvis_control.event_inbox where tenant_id=tenant and event_id='a0450000-0000-4000-8000-0000000000e3') then
    raise exception 'transient claim must roll back its inbox row';
  end if;
  if (select attempt from corvis_control.processing_job where tenant_id=tenant and job_id=job) <> 1 then
    raise exception 'transient claim must not charge an attempt';
  end if;
end;
$$;

-- 3. An orphaned job with no attempts left is dead-lettered (recoverable),
--    and the delivery is acknowledged rather than raised.
do $$
declare
  tenant uuid := 'a0450000-0000-4000-8000-000000000001';
  doc uuid := 'a0450000-0000-4000-8000-0000000000d3';
  job text := 'registered:a0450000-0000-4000-8000-0000000000d3';
  event uuid := 'a0450000-0000-4000-8000-0000000000e4';
  payload jsonb := jsonb_build_object('jobId','registered:a0450000-0000-4000-8000-0000000000d3');
  claim record;
  job_row corvis_control.processing_job%rowtype;
begin
  insert into corvis_control.outbox_event (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload)
  values (tenant,event,'DocumentRegistered','document',doc::text,payload);

  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker',event,'DocumentRegistered',doc,job,'registered',payload,md5(payload::text),5,300);
  if claim.claimed is not true then raise exception 'last attempt was not claimed'; end if;

  update corvis_control.event_inbox set lease_expires_at=now()-interval '1 second'
  where tenant_id=tenant and event_id=event;

  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker',event,'DocumentRegistered',doc,job,'registered',payload,md5(payload::text),5,300);
  if claim.claimed or claim.inbox_state <> 'failed' or claim.job_state <> 'dead_letter' then
    raise exception 'exhausted orphan must dead-letter without raising: %', row_to_json(claim);
  end if;
  select * into job_row from corvis_control.processing_job where tenant_id=tenant and job_id=job;
  if job_row.state <> 'dead_letter' then raise exception 'exhausted orphan not dead-lettered: %', job_row.state; end if;
  if not exists (select 1 from corvis_control.outbox_event where tenant_id=tenant and aggregate_id=job and event_type='ProcessingStageDeadLettered') then
    raise exception 'dead-letter signal missing for exhausted orphan';
  end if;
end;
$$;

-- 4. Operator retry re-emits the retained stage inputs (predecessorResult),
--    so the retried stage handler can actually run.
do $$
declare
  tenant uuid := 'a0450000-0000-4000-8000-000000000001';
  doc uuid := 'a0450000-0000-4000-8000-0000000000d1';
  job text := 'represented:a0450000-0000-4000-8000-0000000000d1';
  retained jsonb := jsonb_build_object(
    'jobId','represented:a0450000-0000-4000-8000-0000000000d1',
    'documentId','a0450000-0000-4000-8000-0000000000d1',
    'stage','represented',
    'predecessorResult',jsonb_build_object('artifactVersionId','a0450000-0000-4000-8000-0000000000a1'),
    'nextAttemptAt','2026-09-20T00:00:00Z');
  new_version integer;
  signal jsonb;
begin
  insert into corvis_control.processing_job
    (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
  values (tenant,job,doc,'represented','retryable',2,5,'ci-orphan',6);
  insert into corvis_control.event_inbox
    (tenant_id,consumer_name,event_id,event_type,aggregate_type,aggregate_id,payload,payload_sha256,state,attempt,max_attempts)
  values (tenant,'processing-stage-worker','a0450000-0000-4000-8000-0000000000e5','ProcessingStageRetryScheduled',
    'document',doc::text,retained,md5(retained::text),'complete',1,5);

  new_version := corvis_control.retry_processing_job(tenant,job,6,'ci-operator');
  if new_version is distinct from 7 then raise exception 'operator retry did not apply: %', new_version; end if;

  select payload into signal from corvis_control.outbox_event
  where tenant_id=tenant and aggregate_id=job and event_type='ProcessingJobRetryRequested';
  if signal is null then raise exception 'operator retry signal missing'; end if;
  if signal -> 'predecessorResult' is distinct from retained -> 'predecessorResult' then
    raise exception 'operator retry must carry retained predecessorResult: %', signal;
  end if;
  if signal ->> 'requestedBy' <> 'ci-operator' or signal ->> 'stage' <> 'represented' or signal ? 'nextAttemptAt' then
    raise exception 'operator retry payload is malformed: %', signal;
  end if;

  -- The optimistic version gate is unchanged.
  if corvis_control.retry_processing_job(tenant,job,6,'ci-operator') is not null then
    raise exception 'stale operator retry must not apply';
  end if;
end;
$$;

rollback;
