-- Exponential backoff for automatic processing-stage retries.
-- Depends on migrations 013, 021, 043 and 050.
--
-- Defect: fail_processing_stage_delivery (043) took its retry delay from
-- fail_event_delivery (013), which computes least(900, 2^(inbox.attempt-1)).
-- Every automatic retry is a brand-new ProcessingStageRetryScheduled outbox
-- event delivered through a fresh event_inbox row, so inbox.attempt is always
-- 1 when a retry fails and the delay was always one second. That delay becomes
-- payload.nextAttemptAt (the Cloud Tasks schedule time in
-- src/lib/server/processing-transport.ts) and the retry event itself carried no
-- next_attempt_at, so a provider outage longer than a few seconds burned all
-- five job attempts and dead-lettered the job.
--
-- Fix: derive the delay from the JOB's attempt counter, which survives across
-- retry events:
--
--   delay_seconds = least(900, 60 * 2^(job.attempt - 1))
--
--   failed attempt   1    2    3    4    5 (max_attempts)
--   delay before     60s  120s 240s 480s dead_letter
--
-- With the default budget of 5 attempts the four retries span 15 minutes (well
-- inside the 60 minute publication freshness SLO in ops/slos.yaml and long
-- enough to ride out a typical provider incident); larger budgets keep
-- doubling until the 900s cap. The single computed instant is persisted on
--   * event_inbox.next_attempt_at of the failed delivery (and returned),
--   * payload.nextAttemptAt of the retry signal (Cloud Tasks schedule time),
--   * outbox_event.next_attempt_at of the retry signal, which
--     claim_processing_transport_events (021) and the partial claim index
--     (047) already honor via coalesce(next_attempt_at, created_at), so the
--     transport does not even pick the retry up before its backoff elapses.
-- Everything else is unchanged from 043: the job-budget dead-lettering, the
-- retry payload carryover and the deterministic signal id (replays stay
-- idempotent). Dead-letter signals carry no retry time. No index or index
-- predicate is touched.

begin;

create or replace function corvis_control.fail_processing_stage_delivery(
  p_tenant_id uuid,
  p_consumer_name text,
  p_event_id uuid,
  p_lease_token uuid,
  p_job_id text,
  p_error text
)
returns table(
  next_state text,
  job_version integer,
  inbox_attempt integer,
  next_attempt_at timestamptz
)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
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

commit;
