-- Corvis governed processing operator recovery v1
-- Depends on migrations 001-026.

begin;

alter table corvis_control.processing_job
  add column if not exists recovery_count integer not null default 0 check (recovery_count >= 0);

create table if not exists corvis_control.processing_recovery_event (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  recovery_event_id uuid not null,
  job_id text not null,
  document_id uuid not null,
  stage text not null,
  action text not null check (action in ('recover_dead_letter')),
  actor_subject text not null,
  reason_code text not null,
  note text,
  source_event_id uuid not null,
  source_job_version integer not null check (source_job_version > 0),
  source_attempt integer not null check (source_attempt >= 0),
  source_max_attempts integer not null check (source_max_attempts > 0),
  recovery_count integer not null check (recovery_count > 0),
  result_job_version integer not null check (result_job_version > 0),
  before_state jsonb not null,
  after_state jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, recovery_event_id),
  foreign key (tenant_id, job_id)
    references corvis_control.processing_job(tenant_id, job_id),
  foreign key (tenant_id, document_id)
    references corvis_source.document(tenant_id, document_id),
  check (btrim(actor_subject) <> ''),
  check (btrim(reason_code) <> ''),
  check (jsonb_typeof(before_state)='object'),
  check (jsonb_typeof(after_state)='object')
);

alter table corvis_control.processing_recovery_event enable row level security;
alter table corvis_control.processing_recovery_event force row level security;
-- Server/admin use-case managed only; no direct client mutation policy.

create index if not exists processing_recovery_job_idx
  on corvis_control.processing_recovery_event (tenant_id, job_id, created_at desc);

create or replace function corvis_control.recover_dead_letter_processing_job(
  p_tenant_id uuid,
  p_job_id text,
  p_expected_version integer,
  p_recovery_event_id uuid,
  p_actor_subject text,
  p_reason_code text,
  p_note text default null
)
returns table(new_version integer, recovery_count integer, recovery_event_id uuid)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
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

  -- Reuse the exact durable payload that originally drove this logical stage.
  -- A fresh outbox/event-inbox identity avoids the exhausted delivery record while
  -- the unchanged job/stage effect key preserves idempotent side-effect semantics.
  select i.* into source_inbox
  from corvis_control.event_inbox i
  where i.tenant_id=p_tenant_id
    and i.consumer_name='processing-stage-worker'
    and i.aggregate_id=current_job.document_id::text
    and (
      i.payload ->> 'jobId'=p_job_id
      or (current_job.stage='registered' and i.event_type='DocumentRegistered')
    )
  order by i.last_received_at desc,i.event_id desc
  limit 1;

  if not found then
    raise exception 'dead-letter recovery requires retained durable stage-delivery evidence';
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

commit;
