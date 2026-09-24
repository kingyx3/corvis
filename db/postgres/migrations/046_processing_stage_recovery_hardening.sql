-- Processing stage recovery hardening.
-- Depends on migrations 001-044.
--
-- 1. Reclaim processing jobs orphaned in 'running'.
--
-- claim_processing_stage_delivery (043) raises 'processing job is not
-- claimable' whenever the job is 'running', treating it as leased by another
-- in-flight delivery. But nothing ever moves a job out of 'running' except the
-- owning worker's complete/block/fail call. When that worker dies mid-stage
-- (instance crash, OOM, deploy SIGTERM, request timeout) or its complete/fail
-- call itself fails, the inbox lease expires and the transport redelivers, yet
-- every redelivery raises, rolls back and answers 500 forever. The job is
-- unrecoverable: operator recovery accepts only dead_letter jobs.
--
-- A 'running' job is now treated as orphaned when no other delivery for the
-- same document holds a live inbox lease. The orphaned attempt counts against
-- the job's budget: the claim either re-runs the stage (effects are journaled
-- and idempotent) or, once attempts are exhausted, dead-letters it through the
-- same path as 043. A job whose owner still holds a live lease stays transient.
-- Everything else is unchanged from 043.
--
-- 2. Operator retry carries the retained stage payload.
--
-- retry_processing_job (006) emitted ProcessingJobRetryRequested with only
-- {jobId, requestedBy}. The transport forwards the event payload verbatim to
-- the stage worker, and every stage handler requires its inputs from that
-- payload (registered: artifactVersionId/ingestionId; later stages:
-- predecessorResult). An operator retry therefore failed deterministically on
-- every attempt until the job dead-lettered. The retry signal now reuses the
-- retained inbox payload that drove this logical stage, the same evidence
-- operator dead-letter recovery (027) already uses.

begin;

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
set search_path = pg_catalog, corvis_control
as $$
declare
  inbox_claim record;
  current_job corvis_control.processing_job%rowtype;
  terminal_error text;
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

-- Same optimistic gate and outbox signal as 006; only the payload changes.
create or replace function corvis_control.retry_processing_job(
  p_tenant_id uuid,
  p_job_id text,
  p_expected_version integer,
  p_requested_by text
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
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

commit;
