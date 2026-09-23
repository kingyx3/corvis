-- Delivery and processing hardening before UAT.
-- Depends on migrations 001-042.
--
-- 1. Webhook fan-out gets its own completion marker. Until now webhook
--    delivery reused outbox_event.published_at/attempt_count/last_error, which
--    are the processing transport's dispatch and dead-letter bookkeeping
--    (migration 021). A webhook subscribed to a transport event type could mark
--    a document "published" before the transport dispatched it (the document
--    never entered the pipeline), and a transport dispatch hid pending webhook
--    retries. Webhook delivery now reads/writes only webhook_fanout_completed_at.
-- 2. Export jobs record when a delivery attempt was claimed so a worker crash
--    mid-delivery can be reclaimed instead of sitting in 'delivering' forever.
-- 3. Processing retries reach dead_letter. Each automatic retry is a new outbox
--    event and therefore a fresh inbox row (attempt 0), so the inbox never
--    exhausted; meanwhile processing_job.attempt kept rising until
--    claim_processing_stage_delivery raised 'attempts exhausted', rolled back
--    and returned 500 forever with the job stuck 'retryable' (unrecoverable:
--    operator recovery requires dead_letter). Failure now dead-letters the job
--    once its own attempts are exhausted, claim dead-letters instead of raising,
--    and superseded deliveries are failed in the inbox instead of raising.
-- 4. apply_identity_lifecycle pins search_path so digest() resolves where
--    Supabase installs pgcrypto (the extensions schema).

begin;

-- 1. Webhook fan-out completion ------------------------------------------------

alter table corvis_control.outbox_event
  add column if not exists webhook_fanout_completed_at timestamptz;

-- Events already fanned out under the old contract were marked through
-- published_at. Carry that forward for non-transport event types only; the
-- transport types' published_at was (or will be) set by the transport.
update corvis_control.outbox_event
set webhook_fanout_completed_at=published_at
where published_at is not null
  and webhook_fanout_completed_at is null
  and event_type not in ('DocumentRegistered','ProcessingStageReady','ProcessingStageRetryScheduled','ProcessingJobRetryRequested');

create index if not exists outbox_webhook_fanout_pending_idx
  on corvis_control.outbox_event (tenant_id, event_type, created_at)
  where webhook_fanout_completed_at is null;

create index if not exists webhook_delivery_event_idx
  on corvis_control.webhook_delivery (tenant_id, webhook_id, event_id, state);

create index if not exists webhook_delivery_delivering_idx
  on corvis_control.webhook_delivery (created_at)
  where state='delivering';

-- 2. Export delivery claim timestamp -----------------------------------------

alter table corvis_serving.export_job
  add column if not exists delivery_started_at timestamptz;

-- Rows already 'delivering' have no claim time; start their reclaim clock now
-- so an in-flight delivery at deploy time is not reclaimed underneath itself.
update corvis_serving.export_job
set delivery_started_at=now()
where state='delivering' and delivery_started_at is null;

create index if not exists export_job_delivering_idx
  on corvis_serving.export_job (delivery_started_at)
  where state='delivering';

-- 3. Processing retry exhaustion ---------------------------------------------

-- Moves an exhausted job to dead_letter and emits the same
-- ProcessingStageDeadLettered outbox signal the failure path emits. Caller
-- must hold the processing_job row lock.
create or replace function corvis_control.dead_letter_exhausted_processing_job(
  p_tenant_id uuid,
  p_job_id text,
  p_signal_event_id uuid,
  p_error text,
  p_signal_payload jsonb default '{}'::jsonb
)
returns corvis_control.processing_job
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  current_job corvis_control.processing_job%rowtype;
begin
  update corvis_control.processing_job
  set state='dead_letter',
      version=version+1,
      updated_at=now(),
      last_error=left(coalesce(p_error,last_error,'processing job attempts exhausted'),2000)
  where tenant_id=p_tenant_id and job_id=p_job_id
  returning * into current_job;
  if not found then raise exception 'processing job not found for dead-letter transition'; end if;

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,
    p_signal_event_id,
    'ProcessingStageDeadLettered',
    'processing_job',
    p_job_id,
    (coalesce(p_signal_payload,'{}'::jsonb) - 'nextAttemptAt') || jsonb_build_object(
      'jobId',p_job_id,
      'documentId',current_job.document_id,
      'stage',current_job.stage,
      'attempt',current_job.attempt,
      'nextAttemptAt',null,
      'correlationId',current_job.correlation_id
    ),
    now()
  ) on conflict (tenant_id,event_id) do nothing;

  return current_job;
end;
$$;

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
  -- Another delivery currently owns the job. Transient: raise so the inbox
  -- claim rolls back and the transport redelivers later.
  if current_job.state='running' then raise exception 'processing job is not claimable'; end if;

  if current_job.state not in ('queued','retryable') then
    -- Superseded delivery (job already succeeded, blocked, dead-lettered or
    -- failed). Raising here rolled back and 500ed forever; instead fail this
    -- inbox event terminally so the ingress acknowledges it.
    terminal_error := 'processing job is not claimable in state ' || current_job.state;
  elsif current_job.attempt >= current_job.max_attempts then
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

-- Same contract as migration 027 (retry payload carryover preserved), except
-- the job dead-letters when either the inbox event or the job's own attempt
-- budget is exhausted. Previously only inbox exhaustion counted, which a fresh
-- retry event never reaches.
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
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,
    signal_id,
    signal_type,
    'processing_job',
    p_job_id,
    signal_payload,
    now()
  ) on conflict (tenant_id,event_id) do nothing;

  return query select computed_job_state,current_job.version,inbox_row.attempt,inbox_row.next_attempt_at;
end;
$$;

-- Repair jobs already stranded by the old behavior: 'retryable' with their
-- attempt budget spent can never be claimed or operator-recovered. Move them
-- to dead_letter (with the standard signal) so recover_dead_letter_processing_job
-- applies. Deterministic signal ids keep this idempotent.
do $$
declare
  stranded record;
begin
  for stranded in
    select tenant_id,job_id,version
    from corvis_control.processing_job
    where state='retryable' and attempt >= max_attempts
    order by tenant_id,job_id
    for update
  loop
    perform corvis_control.dead_letter_exhausted_processing_job(
      stranded.tenant_id,
      stranded.job_id,
      md5(stranded.tenant_id::text || ':' || stranded.job_id || ':' || stranded.version::text || ':exhausted-repair:ProcessingStageDeadLettered')::uuid,
      null,
      jsonb_build_object('repair','043_delivery_processing_hardening')
    );
  end loop;
end;
$$;

-- 4. Identity lifecycle search_path -------------------------------------------

-- Body copied verbatim from migration 011 (its only definition); only the
-- `set search_path` clause is added so digest() resolves when pgcrypto is
-- installed in Supabase's `extensions` schema rather than on the caller's path.
create or replace function corvis_control.apply_identity_lifecycle(
  p_tenant_id uuid,
  p_event_key text,
  p_actor_subject text,
  p_actor_workspace_id uuid,
  p_correlation_id text,
  p_operation text,
  p_auth_method text,
  p_subject text,
  p_user_id uuid,
  p_memberships jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, extensions, public
as $$
declare
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_existing_user_id uuid;
  v_existing_status text;
  v_revoked_memberships integer := 0;
  v_active_memberships integer := 0;
  v_expired_entitlements integer := 0;
  v_disabled_subjects integer := 0;
  v_disabled_service_grants integer := 0;
  v_result jsonb;
begin
  if p_operation not in ('sync','disable') then
    raise exception 'invalid identity lifecycle operation';
  end if;
  if p_auth_method not in ('oidc','saml') then
    raise exception 'human identity lifecycle only supports oidc or saml';
  end if;
  if length(trim(coalesce(p_event_key,''))) not between 1 and 256
     or length(coalesce(p_subject,'')) not between 1 and 1024
     or length(trim(coalesce(p_actor_subject,''))) not between 1 and 1024
     or length(trim(coalesce(p_reason,''))) not between 1 and 1000
     or length(trim(coalesce(p_correlation_id,''))) not between 1 and 256 then
    raise exception 'invalid identity lifecycle fields';
  end if;
  if p_memberships is null or jsonb_typeof(p_memberships) <> 'array' then
    raise exception 'memberships must be an array';
  end if;
  if p_operation='disable' and jsonb_array_length(p_memberships) <> 0 then
    raise exception 'disable must not include memberships';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_memberships) item
    where jsonb_typeof(item) <> 'object'
       or nullif(trim(item->>'workspaceId'),'') is null
       or nullif(trim(item->>'roleName'),'') is null
       or (item->>'roleName') not in ('tenant_admin','workspace_admin','reviewer','analyst','viewer')
  ) then
    raise exception 'invalid membership entry';
  end if;
  if (
    select count(*)
    from jsonb_array_elements(p_memberships)
  ) <> (
    select count(distinct ((item->>'workspaceId') || ':' || (item->>'roleName')))
    from jsonb_array_elements(p_memberships) item
  ) then
    raise exception 'duplicate membership entry';
  end if;

  v_request_hash := encode(digest(
    concat_ws(E'\n', p_operation, p_auth_method, p_subject, p_user_id::text, p_memberships::text, p_reason),
    'sha256'
  ), 'hex');

  select request_hash, result
    into v_existing_hash, v_existing_result
  from corvis_control.identity_lifecycle_event
  where tenant_id=p_tenant_id and event_key=p_event_key;

  if found then
    if v_existing_hash <> v_request_hash then
      raise exception 'identity lifecycle event replay conflict';
    end if;
    return v_existing_result;
  end if;

  if p_operation='sync' then
    select user_id,status into v_existing_user_id,v_existing_status
    from corvis_control.identity_subject
    where tenant_id=p_tenant_id and auth_method=p_auth_method and subject=p_subject
    for update;

    if found and v_existing_user_id <> p_user_id then
      raise exception 'identity subject is already mapped to a different user';
    end if;
    if found and v_existing_status='disabled' then
      raise exception 'disabled identity requires explicit reactivation';
    end if;

    insert into corvis_control.identity_subject
      (tenant_id,user_id,auth_method,subject,status,created_at,disabled_at)
    values (p_tenant_id,p_user_id,p_auth_method,p_subject,'active',now(),null)
    on conflict (tenant_id,auth_method,subject) do nothing;

    update corvis_control.membership m
    set status='revoked',
        valid_from=least(m.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where m.tenant_id=p_tenant_id
      and m.user_id=p_user_id
      and m.status='active'
      and not exists (
        select 1
        from jsonb_array_elements(p_memberships) item
        where (item->>'workspaceId')::uuid=m.workspace_id
          and item->>'roleName'=m.role_name
      );
    get diagnostics v_revoked_memberships = row_count;

    insert into corvis_control.membership as m
      (tenant_id,workspace_id,user_id,role_name,status,valid_from,valid_until,created_at)
    select p_tenant_id,(item->>'workspaceId')::uuid,p_user_id,item->>'roleName','active',now(),null,now()
    from jsonb_array_elements(p_memberships) item
    on conflict (tenant_id,workspace_id,user_id,role_name) do update
      set status='active',
          valid_from=case when m.status='active' and m.valid_until is null then m.valid_from else now() end,
          valid_until=null;
    get diagnostics v_active_memberships = row_count;

    update corvis_control.resource_entitlement e
    set valid_from=least(e.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where e.tenant_id=p_tenant_id
      and e.subject_user_id=p_user_id
      and (e.valid_until is null or e.valid_until > now())
      and not exists (
        select 1
        from jsonb_array_elements(p_memberships) item
        where (item->>'workspaceId')::uuid=e.workspace_id
      );
    get diagnostics v_expired_entitlements = row_count;
  else
    select user_id into v_existing_user_id
    from corvis_control.identity_subject
    where tenant_id=p_tenant_id and auth_method=p_auth_method and subject=p_subject
    for update;

    if not found or v_existing_user_id <> p_user_id then
      raise exception 'identity subject does not match the requested user';
    end if;

    update corvis_control.service_identity_grant g
    set status='disabled', disabled_at=coalesce(g.disabled_at,now())
    from corvis_control.identity_subject s
    where s.tenant_id=p_tenant_id
      and s.user_id=p_user_id
      and g.tenant_id=s.tenant_id
      and g.auth_method=s.auth_method
      and g.subject=s.subject
      and g.status='active';
    get diagnostics v_disabled_service_grants = row_count;

    update corvis_control.identity_subject s
    set status='disabled', disabled_at=coalesce(s.disabled_at,now())
    where s.tenant_id=p_tenant_id and s.user_id=p_user_id and s.status='active';
    get diagnostics v_disabled_subjects = row_count;

    update corvis_control.membership m
    set status='revoked',
        valid_from=least(m.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where m.tenant_id=p_tenant_id and m.user_id=p_user_id and m.status='active';
    get diagnostics v_revoked_memberships = row_count;

    update corvis_control.resource_entitlement e
    set valid_from=least(e.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where e.tenant_id=p_tenant_id
      and e.subject_user_id=p_user_id
      and (e.valid_until is null or e.valid_until > now());
    get diagnostics v_expired_entitlements = row_count;
  end if;

  v_result := jsonb_build_object(
    'eventKey',p_event_key,
    'operation',p_operation,
    'subject',p_subject,
    'userId',p_user_id,
    'activeMemberships',v_active_memberships,
    'revokedMemberships',v_revoked_memberships,
    'expiredEntitlements',v_expired_entitlements,
    'disabledSubjects',v_disabled_subjects,
    'disabledServiceGrants',v_disabled_service_grants
  );

  insert into corvis_control.identity_lifecycle_event
    (tenant_id,event_key,request_hash,operation,auth_method,subject,user_id,actor_subject,actor_workspace_id,reason,desired_memberships,result)
  values
    (p_tenant_id,p_event_key,v_request_hash,p_operation,p_auth_method,p_subject,p_user_id,p_actor_subject,p_actor_workspace_id,p_reason,p_memberships,v_result);

  insert into corvis_control.audit_event
    (tenant_id,audit_event_id,occurred_at,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values (
    p_tenant_id,gen_random_uuid(),now(),p_actor_workspace_id,p_actor_subject,
    'identity.lifecycle.' || p_operation,'identity_subject',p_subject,'success',p_correlation_id,
    jsonb_build_object(
      'eventKey',p_event_key,
      'authMethod',p_auth_method,
      'userId',p_user_id,
      'reason',p_reason,
      'result',v_result
    )
  );

  return v_result;
end;
$$;

commit;
