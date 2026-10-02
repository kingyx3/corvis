-- Acceptance for migration 081: automatic stage retries back off exponentially.
--
-- Every automatic retry is a brand-new outbox event with a fresh event_inbox
-- row, so event_inbox.attempt is always 1 on a retry's failure. Before 081 the
-- retry delay was derived from that inbox attempt and was therefore always one
-- second, which burned all five job attempts inside a few seconds of a
-- provider outage. The delay is now derived from the JOB's attempt counter:
-- 60s doubling, capped at 900s. The same instant is persisted on the retry
-- signal's payload.nextAttemptAt (Cloud Tasks schedule time), on the signal's
-- outbox_event.next_attempt_at (transport claim gate) and on the failed
-- delivery's inbox row.
--
-- Run after the full migration chain on an isolated disposable database.
-- Everything is rolled back. The transaction keeps now() constant, so every
-- delay below is measured exactly.

\set ON_ERROR_STOP on

begin;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('a0810000-0000-4000-8000-000000000001','stage-retry-backoff-ci','Stage Retry Backoff CI');

insert into corvis_source.document (tenant_id,document_id,display_name,media_type,status,created_by)
values
  ('a0810000-0000-4000-8000-000000000001','a0810000-0000-4000-8000-0000000000d1','Default budget fixture','application/pdf','registered','ci'),
  ('a0810000-0000-4000-8000-000000000001','a0810000-0000-4000-8000-0000000000d2','Large budget fixture','application/pdf','registered','ci');

insert into corvis_control.processing_job
  (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
values
  ('a0810000-0000-4000-8000-000000000001','registered:a0810000-0000-4000-8000-0000000000d1',
   'a0810000-0000-4000-8000-0000000000d1','registered','queued',0,5,'ci-backoff-default',1),
  ('a0810000-0000-4000-8000-000000000001','registered:a0810000-0000-4000-8000-0000000000d2',
   'a0810000-0000-4000-8000-0000000000d2','registered','queued',0,9,'ci-backoff-large',1);

-- 1. Default budget (5 attempts): four retries with strictly growing delays,
--    then the fifth failure dead-letters with no retry time anywhere.
do $$
declare
  tenant uuid := 'a0810000-0000-4000-8000-000000000001';
  doc uuid := 'a0810000-0000-4000-8000-0000000000d1';
  job text := 'registered:a0810000-0000-4000-8000-0000000000d1';
  expected integer[] := array[60,120,240,480];
  current_event uuid := 'a0810000-0000-4000-8000-0000000000e1';
  current_type text := 'DocumentRegistered';
  current_payload jsonb := jsonb_build_object('jobId','registered:a0810000-0000-4000-8000-0000000000d1','documentId','a0810000-0000-4000-8000-0000000000d1','stage','registered');
  claim record;
  failure record;
  signal corvis_control.outbox_event%rowtype;
  inbox corvis_control.event_inbox%rowtype;
  previous_delay integer := 0;
  delay integer;
  i integer;
begin
  insert into corvis_control.outbox_event (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload)
  values (tenant,current_event,current_type,'document',job,current_payload);

  for i in 1..5 loop
    select * into claim from corvis_control.claim_processing_stage_delivery(
      tenant,'processing-stage-worker',current_event,current_type,doc,job,'registered',
      current_payload,md5(current_payload::text),5,300);
    if claim.claimed is not true then raise exception 'attempt % was not claimed: %', i, row_to_json(claim); end if;
    -- Fresh event, fresh inbox row: the inbox attempt is always 1, which is exactly why it cannot drive the backoff.
    if claim.claim_attempt <> 1 then raise exception 'attempt % expected inbox attempt 1, got %', i, claim.claim_attempt; end if;

    select * into failure from corvis_control.fail_processing_stage_delivery(
      tenant,'processing-stage-worker',current_event,claim.claim_lease_token,job,'ci induced failure '||i);

    if i = 5 then
      if failure.next_state <> 'dead_letter' then raise exception 'fifth failure must dead-letter, got %', failure.next_state; end if;
      if failure.next_attempt_at is not null then raise exception 'dead-letter must not carry a retry time, got %', failure.next_attempt_at; end if;
      select * into signal from corvis_control.outbox_event
      where tenant_id=tenant and aggregate_id=job and event_type='ProcessingStageDeadLettered';
      if signal.event_id is null then raise exception 'dead-letter signal missing'; end if;
      if signal.next_attempt_at is not null or signal.payload->>'nextAttemptAt' is not null then
        raise exception 'dead-letter signal must not be scheduled: % / %', signal.next_attempt_at, signal.payload;
      end if;
    else
      if failure.next_state <> 'retryable' then raise exception 'attempt % expected retryable, got %', i, failure.next_state; end if;

      delay := extract(epoch from (failure.next_attempt_at - now()))::integer;
      if delay <> expected[i] then raise exception 'failure % expected a %s delay, got %s', i, expected[i], delay; end if;
      if delay <= previous_delay then raise exception 'failure % delay % did not grow past %', i, delay, previous_delay; end if;
      previous_delay := delay;

      select * into signal from corvis_control.outbox_event
      where tenant_id=tenant and aggregate_id=job and event_type='ProcessingStageRetryScheduled'
        and (payload->>'attempt')::integer=i;
      if signal.event_id is null then raise exception 'retry signal % missing', i; end if;
      -- Cloud Tasks schedule time, transport claim gate and inbox row all carry the same instant.
      if (signal.payload->>'nextAttemptAt')::timestamptz is distinct from failure.next_attempt_at then
        raise exception 'signal % payload.nextAttemptAt % differs from returned %', i, signal.payload->>'nextAttemptAt', failure.next_attempt_at;
      end if;
      if signal.next_attempt_at is distinct from failure.next_attempt_at then
        raise exception 'signal % outbox next_attempt_at % differs from returned %', i, signal.next_attempt_at, failure.next_attempt_at;
      end if;
      select * into inbox from corvis_control.event_inbox
      where tenant_id=tenant and consumer_name='processing-stage-worker' and event_id=current_event;
      if inbox.state <> 'retryable' or inbox.next_attempt_at is distinct from failure.next_attempt_at then
        raise exception 'inbox for failure % must be retryable at %, got % at %', i, failure.next_attempt_at, inbox.state, inbox.next_attempt_at;
      end if;

      current_event := signal.event_id;
      current_type := signal.event_type;
      current_payload := signal.payload;
    end if;
  end loop;

  if (select count(*) from corvis_control.outbox_event where tenant_id=tenant and aggregate_id=job and event_type='ProcessingStageRetryScheduled') <> 4 then
    raise exception 'expected exactly four retry signals';
  end if;
end;
$$;

-- 2. Larger budget (9 attempts): the delay doubles up to the 900s cap and then
--    holds there, never exceeding it and never shrinking.
do $$
declare
  tenant uuid := 'a0810000-0000-4000-8000-000000000001';
  doc uuid := 'a0810000-0000-4000-8000-0000000000d2';
  job text := 'registered:a0810000-0000-4000-8000-0000000000d2';
  expected integer[] := array[60,120,240,480,900,900,900,900];
  current_event uuid := 'a0810000-0000-4000-8000-0000000000e2';
  current_type text := 'DocumentRegistered';
  current_payload jsonb := jsonb_build_object('jobId','registered:a0810000-0000-4000-8000-0000000000d2','documentId','a0810000-0000-4000-8000-0000000000d2','stage','registered');
  claim record;
  failure record;
  signal corvis_control.outbox_event%rowtype;
  previous_delay integer := 0;
  delay integer;
  i integer;
begin
  insert into corvis_control.outbox_event (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload)
  values (tenant,current_event,current_type,'document',job,current_payload);

  for i in 1..9 loop
    select * into claim from corvis_control.claim_processing_stage_delivery(
      tenant,'processing-stage-worker',current_event,current_type,doc,job,'registered',
      current_payload,md5(current_payload::text),5,300);
    if claim.claimed is not true then raise exception 'attempt % was not claimed: %', i, row_to_json(claim); end if;

    select * into failure from corvis_control.fail_processing_stage_delivery(
      tenant,'processing-stage-worker',current_event,claim.claim_lease_token,job,'ci induced failure '||i);

    if i = 9 then
      if failure.next_state <> 'dead_letter' then raise exception 'ninth failure must dead-letter, got %', failure.next_state; end if;
    else
      if failure.next_state <> 'retryable' then raise exception 'attempt % expected retryable, got %', i, failure.next_state; end if;
      delay := extract(epoch from (failure.next_attempt_at - now()))::integer;
      if delay <> expected[i] then raise exception 'failure % expected a %s delay, got %s', i, expected[i], delay; end if;
      if delay < previous_delay then raise exception 'failure % delay % shrank below %', i, delay, previous_delay; end if;
      if delay > 900 then raise exception 'failure % delay % exceeds the 900s cap', i, delay; end if;
      if i <= 5 and delay <= previous_delay then raise exception 'failure % delay % did not strictly grow past %', i, delay, previous_delay; end if;
      previous_delay := delay;

      select * into signal from corvis_control.outbox_event
      where tenant_id=tenant and aggregate_id=job and event_type='ProcessingStageRetryScheduled'
        and (payload->>'attempt')::integer=i;
      if signal.event_id is null then raise exception 'retry signal % missing', i; end if;
      current_event := signal.event_id;
      current_type := signal.event_type;
      current_payload := signal.payload;
    end if;
  end loop;
end;
$$;

-- 3. The transport claim honors the retry signal's next_attempt_at: the signal
--    is invisible until its backoff elapses, then claimable and publishable.
do $$
declare
  tenant uuid := 'a0810000-0000-4000-8000-000000000001';
  job text := 'registered:a0810000-0000-4000-8000-0000000000d1';
  signal_id uuid;
begin
  select event_id into signal_id from corvis_control.outbox_event
  where tenant_id=tenant and aggregate_id=job and event_type='ProcessingStageRetryScheduled'
    and (payload->>'attempt')::integer=1;
  if signal_id is null then raise exception 'first retry signal missing'; end if;

  if exists (select 1 from corvis_control.claim_processing_transport_events(500,60) c where c.event_id=signal_id) then
    raise exception 'retry signal was claimable before its backoff elapsed';
  end if;

  update corvis_control.outbox_event set next_attempt_at=now() where tenant_id=tenant and event_id=signal_id;
  if not exists (select 1 from corvis_control.claim_processing_transport_events(500,60) c where c.event_id=signal_id) then
    raise exception 'retry signal was not claimable once its backoff elapsed';
  end if;
end;
$$;

rollback;
