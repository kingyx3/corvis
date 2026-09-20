-- Corvis governed extraction-candidate review/quality gate v1
-- Depends on migrations 001-024.

begin;

create schema if not exists corvis_review;

alter table corvis_control.processing_job
  add column if not exists blocked_reason text;

create table if not exists corvis_review.candidate_review_requirement (
  tenant_id uuid not null,
  extraction_run_id uuid not null,
  candidate_id uuid not null,
  review_policy_version text not null,
  candidate_fingerprint_sha256 text not null,
  risk_tier text not null check (risk_tier in ('standard','critical')),
  required_approvals integer not null check (required_approvals > 0),
  requires_exception_resolution boolean not null default false,
  blocking_reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, extraction_run_id, candidate_id, review_policy_version),
  foreign key (tenant_id, extraction_run_id, candidate_id)
    references corvis_source.extraction_candidate(tenant_id, extraction_run_id, candidate_id),
  check (candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  check (jsonb_typeof(blocking_reasons)='array')
);

create table if not exists corvis_review.candidate_review_event (
  tenant_id uuid not null,
  review_event_id uuid not null,
  event_sequence bigint generated always as identity,
  extraction_run_id uuid not null,
  candidate_id uuid not null,
  review_policy_version text not null,
  actor_subject text not null,
  decision text not null check (decision in ('approve','reject','correct','resolve_exception')),
  reason_code text not null,
  correction_payload jsonb,
  resolved_exception_codes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, review_event_id),
  unique (tenant_id, extraction_run_id, candidate_id, event_sequence),
  foreign key (tenant_id, extraction_run_id, candidate_id)
    references corvis_source.extraction_candidate(tenant_id, extraction_run_id, candidate_id),
  check (btrim(actor_subject) <> ''),
  check (btrim(reason_code) <> ''),
  check (correction_payload is null or jsonb_typeof(correction_payload)='object'),
  check (jsonb_typeof(resolved_exception_codes)='array'),
  check ((decision='correct' and correction_payload is not null)
      or (decision<>'correct' and correction_payload is null)),
  check ((decision='resolve_exception' and jsonb_array_length(resolved_exception_codes) > 0)
      or (decision<>'resolve_exception' and jsonb_array_length(resolved_exception_codes) = 0))
);

create table if not exists corvis_review.extraction_review_gate (
  tenant_id uuid not null,
  extraction_run_id uuid not null,
  review_policy_version text not null,
  candidate_set_sha256 text not null,
  decision_set_sha256 text not null,
  status text not null check (status in ('pending','ready')),
  candidate_count integer not null check (candidate_count >= 0),
  blocking_candidate_count integer not null check (blocking_candidate_count >= 0),
  critical_candidate_count integer not null check (critical_candidate_count >= 0),
  exception_candidate_count integer not null check (exception_candidate_count >= 0),
  evaluated_at timestamptz not null default now(),
  primary key (tenant_id, extraction_run_id, review_policy_version),
  foreign key (tenant_id, extraction_run_id)
    references corvis_source.extraction_run(tenant_id, extraction_run_id),
  check (candidate_set_sha256 ~ '^[0-9a-f]{64}$'),
  check (decision_set_sha256 ~ '^[0-9a-f]{64}$'),
  check ((status='ready' and blocking_candidate_count=0) or status='pending')
);

alter table corvis_review.candidate_review_requirement enable row level security;
alter table corvis_review.candidate_review_requirement force row level security;
alter table corvis_review.candidate_review_event enable row level security;
alter table corvis_review.candidate_review_event force row level security;
alter table corvis_review.extraction_review_gate enable row level security;
alter table corvis_review.extraction_review_gate force row level security;

-- Candidate review state is a server/worker control surface, not a direct customer
-- persistence contract. Human review commands pass through authorized application
-- use cases; no direct client RLS policies are intentionally created here.
create index if not exists candidate_review_requirement_run_idx
  on corvis_review.candidate_review_requirement
    (tenant_id, extraction_run_id, review_policy_version, risk_tier);
create index if not exists candidate_review_event_candidate_idx
  on corvis_review.candidate_review_event
    (tenant_id, extraction_run_id, candidate_id, event_sequence);
create index if not exists extraction_review_gate_status_idx
  on corvis_review.extraction_review_gate
    (tenant_id, status, evaluated_at desc);

-- A review gate is not a technical failure. Complete the durable delivery, leave the
-- stage effect intentionally incomplete, and park the job until attributable review
-- decisions make the gate ready. This prevents transport retry/dead-letter machinery
-- from being used as a human-review scheduler.
create or replace function corvis_control.block_processing_stage_delivery(
  p_tenant_id uuid,
  p_consumer_name text,
  p_event_id uuid,
  p_lease_token uuid,
  p_job_id text,
  p_reason text
)
returns table(blocked boolean, job_version integer)
language plpgsql
security invoker
as $$
declare
  current_job corvis_control.processing_job%rowtype;
  completion_ok boolean;
  signal_id uuid;
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
  if completion_ok is not true then raise exception 'event lease no longer owns review-block transition'; end if;

  update corvis_control.processing_job
  set state='blocked',
      blocked_reason=left(coalesce(p_reason,'review_required'),500),
      last_error=null,
      version=version+1,
      updated_at=now()
  where tenant_id=p_tenant_id and job_id=p_job_id
  returning * into current_job;

  signal_id := md5(p_tenant_id::text || ':' || p_event_id::text || ':ProcessingStageBlocked')::uuid;
  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,signal_id,'ProcessingStageBlocked','processing_job',p_job_id,
    jsonb_build_object(
      'jobId',p_job_id,
      'documentId',current_job.document_id,
      'stage',current_job.stage,
      'reason',current_job.blocked_reason,
      'correlationId',current_job.correlation_id
    ),now()
  ) on conflict (tenant_id,event_id) do nothing;

  return query select true,current_job.version;
end;
$$;

-- Review commands call this only after the persisted gate becomes ready. The
-- database rechecks the exact extraction run/candidate-set gate so a caller cannot
-- resume the reviewed stage by merely changing job state.
create or replace function corvis_control.resume_blocked_reviewed_stage(
  p_tenant_id uuid,
  p_job_id text,
  p_extraction_run_id uuid,
  p_review_policy_version text
)
returns table(resumed boolean, resume_event_id uuid, job_version integer)
language plpgsql
security invoker
as $$
declare
  current_job corvis_control.processing_job%rowtype;
  run_row corvis_source.extraction_run%rowtype;
  signal_id uuid;
  predecessor_job_id text;
begin
  select * into current_job
  from corvis_control.processing_job
  where tenant_id=p_tenant_id and job_id=p_job_id
  for update;

  if not found then return; end if;
  if current_job.stage <> 'reviewed' or current_job.state <> 'blocked' then
    return query select false,null::uuid,current_job.version;
    return;
  end if;

  select * into run_row
  from corvis_source.extraction_run
  where tenant_id=p_tenant_id and extraction_run_id=p_extraction_run_id
    and document_id=current_job.document_id and status='ready';
  if not found then raise exception 'review resume requires finalized extraction run'; end if;

  if not exists (
    select 1
    from corvis_review.extraction_review_gate g
    where g.tenant_id=p_tenant_id
      and g.extraction_run_id=p_extraction_run_id
      and g.review_policy_version=p_review_policy_version
      and g.status='ready'
      and g.blocking_candidate_count=0
      and g.candidate_set_sha256=run_row.candidate_set_sha256
  ) then
    raise exception 'review gate is not ready';
  end if;

  update corvis_control.processing_job
  set state='queued',blocked_reason=null,last_error=null,version=version+1,updated_at=now()
  where tenant_id=p_tenant_id and job_id=p_job_id
  returning * into current_job;

  predecessor_job_id := 'extracted:' || current_job.document_id::text;
  signal_id := md5(
    p_tenant_id::text || ':' || p_job_id || ':review-resume:' || current_job.version::text
  )::uuid;

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,signal_id,'ProcessingStageReady','processing_job',p_job_id,
    jsonb_build_object(
      'jobId',p_job_id,
      'documentId',current_job.document_id,
      'stage','reviewed',
      'correlationId',current_job.correlation_id,
      'predecessorJobId',predecessor_job_id
    ),now()
  ) on conflict (tenant_id,event_id) do nothing;

  return query select true,signal_id,current_job.version;
end;
$$;

-- Persistence-bound fail-closed guard. Even if application code mistakenly asks
-- to complete the reviewed stage, no canonicalized job may be created until the
-- exact finalized extraction candidate set has a ready governed review gate.
create or replace function corvis_review.enforce_ready_gate_before_review_success()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_review, corvis_source
as $$
declare
  predecessor_result jsonb;
  run_id uuid;
  candidate_hash text;
begin
  if old.stage='reviewed' and old.state='running' and new.state='succeeded' then
    select e.result into predecessor_result
    from corvis_control.processing_stage_effect e
    where e.tenant_id=old.tenant_id
      and e.document_id=old.document_id
      and e.stage='extracted'
      and e.state='complete'
    order by e.completed_at desc nulls last
    limit 1;

    if predecessor_result is null then
      raise exception 'review completion requires committed extraction predecessor';
    end if;

    begin
      run_id := (predecessor_result ->> 'extractionRunId')::uuid;
    exception when others then
      raise exception 'review completion extraction predecessor is invalid';
    end;
    candidate_hash := predecessor_result ->> 'candidateSetSha256';

    if not exists (
      select 1
      from corvis_review.extraction_review_gate g
      join corvis_source.extraction_run r
        on r.tenant_id=g.tenant_id and r.extraction_run_id=g.extraction_run_id
      where g.tenant_id=old.tenant_id
        and g.extraction_run_id=run_id
        and g.review_policy_version='candidate_review_v1'
        and g.status='ready'
        and g.blocking_candidate_count=0
        and g.candidate_set_sha256=candidate_hash
        and r.document_id=old.document_id
        and r.status='ready'
        and r.candidate_set_sha256=candidate_hash
    ) then
      raise exception 'review gate blocks canonicalization';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists processing_job_review_gate_guard
  on corvis_control.processing_job;
create trigger processing_job_review_gate_guard
before update of state on corvis_control.processing_job
for each row
execute function corvis_review.enforce_ready_gate_before_review_success();

commit;
