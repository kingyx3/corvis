-- Acceptance for migration 050: claim_event_delivery and
-- claim_processing_stage_delivery must refuse a delivery whose
-- event_id/event_type/payload has no matching corvis_control.outbox_event
-- row (a fabricated/injected event), while every genuine outbox-originated
-- delivery -- including a fresh worker claim, an automatic
-- ProcessingStageRetryScheduled signal, an operator retry_processing_job
-- replay and a dead-letter recover_dead_letter_processing_job replay --
-- still claims exactly as before. Run after the full migration chain on an
-- isolated disposable database. Rolled back.

\set ON_ERROR_STOP on

begin;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('a0490000-0000-4000-8000-000000000001','outbox-authenticity-ci','Outbox Authenticity CI');

insert into corvis_source.document (tenant_id,document_id,display_name,media_type,status,created_by)
values
  ('a0490000-0000-4000-8000-000000000001','a0490000-0000-4000-8000-0000000000d1','Genuine fixture','application/pdf','registered','ci'),
  ('a0490000-0000-4000-8000-000000000001','a0490000-0000-4000-8000-0000000000d2','Forged fixture','application/pdf','registered','ci'),
  ('a0490000-0000-4000-8000-000000000001','a0490000-0000-4000-8000-0000000000d3','Dead-letter fixture','application/pdf','registered','ci');

insert into corvis_control.processing_job
  (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
values
  ('a0490000-0000-4000-8000-000000000001','registered:a0490000-0000-4000-8000-0000000000d1',
   'a0490000-0000-4000-8000-0000000000d1','registered','queued',0,5,'ci-genuine',1),
  ('a0490000-0000-4000-8000-000000000001','registered:a0490000-0000-4000-8000-0000000000d2',
   'a0490000-0000-4000-8000-0000000000d2','registered','queued',0,5,'ci-forged',1),
  ('a0490000-0000-4000-8000-000000000001','registered:a0490000-0000-4000-8000-0000000000d3',
   'a0490000-0000-4000-8000-0000000000d3','registered','dead_letter',5,5,'ci-recover',3);

-- 1. A claim for an event_id with no matching outbox_event row is refused by
--    claim_event_delivery directly, and no inbox row is created for it.
do $$
declare
  tenant uuid := 'a0490000-0000-4000-8000-000000000001';
  payload jsonb := jsonb_build_object('jobId','registered:a0490000-0000-4000-8000-0000000000d2');
  event uuid := 'a0490000-0000-4000-8000-0000000000f1';
  raised boolean := false;
begin
  begin
    perform * from corvis_control.claim_event_delivery(
      tenant,'processing-stage-worker',event,'DocumentRegistered','document',
      'a0490000-0000-4000-8000-0000000000d2',payload,md5(payload::text),5,300);
  exception when others then
    if sqlerrm <> 'event id has no matching outbox record' then raise; end if;
    raised := true;
  end;
  if not raised then raise exception 'a fabricated event must be refused by claim_event_delivery'; end if;
  if exists (select 1 from corvis_control.event_inbox where tenant_id=tenant and event_id=event) then
    raise exception 'a refused claim must not create an inbox row';
  end if;
end;
$$;

-- 2. The same fabrication is refused through claim_processing_stage_delivery
--    (the actual worker ingress entry point), and no inbox row or processing
--    job state change results.
do $$
declare
  tenant uuid := 'a0490000-0000-4000-8000-000000000001';
  doc uuid := 'a0490000-0000-4000-8000-0000000000d2';
  job text := 'registered:a0490000-0000-4000-8000-0000000000d2';
  payload jsonb := jsonb_build_object('jobId',job);
  event uuid := 'a0490000-0000-4000-8000-0000000000f2';
  raised boolean := false;
begin
  begin
    perform * from corvis_control.claim_processing_stage_delivery(
      tenant,'processing-stage-worker',event,'DocumentRegistered',doc,job,'registered',
      payload,md5(payload::text),5,300);
  exception when others then
    if sqlerrm <> 'event id has no matching outbox record' then raise; end if;
    raised := true;
  end;
  if not raised then raise exception 'a fabricated event must be refused by claim_processing_stage_delivery'; end if;
  if exists (select 1 from corvis_control.event_inbox where tenant_id=tenant and event_id=event) then
    raise exception 'a refused stage claim must not create an inbox row';
  end if;
  if (select attempt from corvis_control.processing_job where tenant_id=tenant and job_id=job) <> 0 then
    raise exception 'a refused stage claim must not charge the job an attempt';
  end if;
end;
$$;

-- 3. A payload that has been tampered with (event_id/event_type genuine, but
--    payload does not match the outbox row) is refused the same way as a
--    wholly fabricated event -- an attacker cannot reuse a real event_id
--    with a substituted payload/predecessorResult.
do $$
declare
  tenant uuid := 'a0490000-0000-4000-8000-000000000001';
  doc uuid := 'a0490000-0000-4000-8000-0000000000d2';
  job text := 'registered:a0490000-0000-4000-8000-0000000000d2';
  real_payload jsonb := jsonb_build_object('jobId',job);
  tampered_payload jsonb := jsonb_build_object('jobId',job,'predecessorResult',jsonb_build_object('injected',true));
  event uuid := 'a0490000-0000-4000-8000-0000000000f3';
  raised boolean := false;
begin
  insert into corvis_control.outbox_event (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload)
  values (tenant,event,'DocumentRegistered','document',doc::text,real_payload);

  begin
    perform * from corvis_control.claim_processing_stage_delivery(
      tenant,'processing-stage-worker',event,'DocumentRegistered',doc,job,'registered',
      tampered_payload,md5(tampered_payload::text),5,300);
  exception when others then
    if sqlerrm <> 'event id has no matching outbox record' then raise; end if;
    raised := true;
  end;
  if not raised then raise exception 'a tampered payload must be refused even with a genuine event_id'; end if;
end;
$$;

-- 4. A genuine outbox-originated delivery still claims exactly as before.
do $$
declare
  tenant uuid := 'a0490000-0000-4000-8000-000000000001';
  doc uuid := 'a0490000-0000-4000-8000-0000000000d1';
  job text := 'registered:a0490000-0000-4000-8000-0000000000d1';
  payload jsonb := jsonb_build_object('jobId',job,'documentId',doc,'stage','registered');
  event uuid := 'a0490000-0000-4000-8000-0000000000f4';
  claim record;
  failure record;
  retry_event uuid;
  retry_type text;
  retry_payload jsonb;
begin
  insert into corvis_control.outbox_event (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload)
  values (tenant,event,'DocumentRegistered','document',doc::text,payload);

  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker',event,'DocumentRegistered',doc,job,'registered',
    payload,md5(payload::text),5,300);
  if claim.claimed is not true then raise exception 'a genuine outbox delivery must still be claimed: %', row_to_json(claim); end if;

  -- 5. fail_processing_stage_delivery's own ProcessingStageRetryScheduled
  --    signal is itself a fresh outbox_event row, so the automatic retry it
  --    drives must also claim cleanly through the new guard.
  select * into failure from corvis_control.fail_processing_stage_delivery(
    tenant,'processing-stage-worker',event,claim.claim_lease_token,job,'ci induced failure');
  if failure.next_state <> 'retryable' then raise exception 'expected retryable, got %', failure.next_state; end if;

  select o.event_id,o.event_type,o.payload into retry_event,retry_type,retry_payload
  from corvis_control.outbox_event o
  where o.tenant_id=tenant and o.aggregate_id=job and o.event_type='ProcessingStageRetryScheduled';
  if retry_event is null then raise exception 'retry signal missing'; end if;

  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker',retry_event,retry_type,doc,job,'registered',
    retry_payload,md5(retry_payload::text),5,300);
  if claim.claimed is not true then raise exception 'the automatic retry signal must claim cleanly: %', row_to_json(claim); end if;
end;
$$;

-- 6. Operator dead-letter recovery emits its own fresh outbox_event row
--    (event_id = recovery_event_id), which then claims cleanly.
do $$
declare
  tenant uuid := 'a0490000-0000-4000-8000-000000000001';
  doc uuid := 'a0490000-0000-4000-8000-0000000000d3';
  job text := 'registered:a0490000-0000-4000-8000-0000000000d3';
  seed_event uuid := 'a0490000-0000-4000-8000-0000000000f5';
  seed_payload jsonb := jsonb_build_object('jobId',job,'documentId',doc,'stage','registered');
  recovery_event uuid := 'a0490000-0000-4000-8000-0000000000f6';
  recovered record;
  recovery_payload jsonb;
  claim record;
begin
  -- retained delivery evidence recover_dead_letter_processing_job replays.
  insert into corvis_control.event_inbox
    (tenant_id,consumer_name,event_id,event_type,aggregate_type,aggregate_id,payload,payload_sha256,state,attempt,max_attempts)
  values (tenant,'processing-stage-worker',seed_event,'DocumentRegistered','document',doc::text,seed_payload,md5(seed_payload::text),'complete',1,5);

  select * into recovered from corvis_control.recover_dead_letter_processing_job(
    tenant,job,3,recovery_event,'ci-operator','ci_recovery',null);
  if recovered.new_version is null then raise exception 'dead-letter recovery did not apply'; end if;

  select payload into recovery_payload from corvis_control.outbox_event
  where tenant_id=tenant and event_id=recovery_event and event_type='ProcessingJobRetryRequested';
  if recovery_payload is null then raise exception 'recovery signal missing from outbox'; end if;

  select * into claim from corvis_control.claim_processing_stage_delivery(
    tenant,'processing-stage-worker',recovery_event,'ProcessingJobRetryRequested',doc,job,'registered',
    recovery_payload,md5(recovery_payload::text),5,300);
  if claim.claimed is not true then raise exception 'the recovery signal must claim cleanly: %', row_to_json(claim); end if;
end;
$$;

rollback;
