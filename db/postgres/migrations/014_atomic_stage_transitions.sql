-- Corvis atomic processing-stage transition boundary v1
-- Depends on migrations 001-013.

begin;

-- Stage consumers must couple durable inbox ownership with authoritative job state.
-- This closes the crash window where work could be acknowledged in one store while
-- the processing job or next-stage signal remained stale.
create or replace function corvis_control.claim_processing_stage_delivery(
  p_tenant_id uuid,
  p_consumer_name text,
  p_event_id uuid,
  p_event_type text,
  p_document_id uuid,
  p_job_id text,
  p_expected_stage text,
  p_payload jsonb,
  p_payload_sha256 text,
  p_max_attempts integer default 5,
  p_lease_seconds integer default 300
)
returns table(
  claimed boolean,
  duplicate_complete boolean,
  claim_lease_token uuid,
  claim_attempt integer,
  inbox_state text,
  job_version integer,
  job_state text
)
language plpgsql
security invoker
as $$
declare
  inbox_claim record;
  current_job corvis_control.processing_job%rowtype;
begin
  if p_job_id is null or btrim(p_job_id)='' then raise exception 'job id is required'; end if;
  if p_expected_stage is null or btrim(p_expected_stage)='' then raise exception 'expected stage is required'; end if;

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
  if current_job.state not in ('queued','retryable') then raise exception 'processing job is not claimable'; end if;
  if current_job.attempt >= current_job.max_attempts then raise exception 'processing job attempts exhausted'; end if;

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

create or replace function corvis_control.complete_processing_stage_delivery(
  p_tenant_id uuid,
  p_consumer_name text,
  p_event_id uuid,
  p_lease_token uuid,
  p_job_id text
)
returns table(
  completed boolean,
  completed_job_version integer,
  next_job_id text,
  next_stage text
)
language plpgsql
security invoker
as $$
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
    computed_next_job_id := computed_next_stage || ':' || current_job.document_id::text;

    insert into corvis_control.processing_job
      (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version,created_at,updated_at)
    values (
      p_tenant_id,
      computed_next_job_id,
      current_job.document_id,
      computed_next_stage,
      'queued',
      0,
      current_job.max_attempts,
      current_job.correlation_id,
      1,
      now(),
      now()
    )
    on conflict (tenant_id,job_id) do nothing;
    get diagnostics inserted_count = row_count;

    if inserted_count = 1 then
      insert into corvis_control.outbox_event
        (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
      values (
        p_tenant_id,
        md5(p_tenant_id::text || ':' || computed_next_job_id || ':ready')::uuid,
        'ProcessingStageReady',
        'processing_job',
        computed_next_job_id,
        jsonb_build_object(
          'jobId',computed_next_job_id,
          'documentId',current_job.document_id,
          'stage',computed_next_stage,
          'correlationId',current_job.correlation_id,
          'predecessorJobId',p_job_id
        ),
        now()
      ) on conflict (tenant_id,event_id) do nothing;
    end if;
  end if;

  return query select true,current_job.version,computed_next_job_id,computed_next_stage;
end;
$$;

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
as $$
declare
  current_job corvis_control.processing_job%rowtype;
  computed_inbox_state text;
  inbox_row corvis_control.event_inbox%rowtype;
  computed_job_state text;
  signal_type text;
  signal_id uuid;
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

  select * into inbox_row
  from corvis_control.event_inbox
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id;

  computed_job_state := case computed_inbox_state when 'retryable' then 'retryable' else 'dead_letter' end;

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

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,
    signal_id,
    signal_type,
    'processing_job',
    p_job_id,
    jsonb_build_object(
      'jobId',p_job_id,
      'documentId',current_job.document_id,
      'stage',current_job.stage,
      'attempt',current_job.attempt,
      'nextAttemptAt',inbox_row.next_attempt_at,
      'correlationId',current_job.correlation_id
    ),
    now()
  ) on conflict (tenant_id,event_id) do nothing;

  return query select computed_job_state,current_job.version,inbox_row.attempt,inbox_row.next_attempt_at;
end;
$$;

commit;
