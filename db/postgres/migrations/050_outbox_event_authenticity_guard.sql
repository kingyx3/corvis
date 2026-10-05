-- Outbox event authenticity guard for worker deliveries.
-- Depends on migrations 001-048.
--
-- claim_event_delivery (013) and claim_processing_stage_delivery (046) trust
-- whatever event_id/event_type/payload a push request carries. Worker ingress
-- (app/api/internal/processing-stage/route.ts, GcpOidcVerifier) authenticates
-- only the CALLER: OIDC proves Pub/Sub or Cloud Tasks delivered the HTTP
-- request, never that Corvis itself published this event_id. Anyone with IAM
-- publish rights on the configured topic/queue (not only this application)
-- could inject a fabricated event that the inbox then claims and processes as
-- genuine, and stage handlers trust payload.predecessorResult from it.
--
-- Every legitimate delivery originates from a corvis_control.outbox_event row
-- (dispatchConfiguredProcessingTransport in lib/server/processing-transport.ts
-- is the only producer of a Pub/Sub message or Cloud Tasks task in this
-- codebase, and it publishes exactly the outbox row's tenant_id/event_id/
-- event_type/payload; retry_processing_job, fail_processing_stage_delivery's
-- retry/dead-letter signal and recover_dead_letter_processing_job all insert
-- a fresh outbox_event row rather than dispatching directly). Both claim
-- functions now require a matching, payload-identical outbox_event row before
-- claiming a delivery. A request whose event_id/event_type/payload was never
-- published by Corvis is rejected with a distinct exception
-- ('event id has no matching outbox record') instead of being claimed. The
-- worker (lib/server/processing-stage-worker.ts) catches that exact message
-- around the claim call and returns a terminal "rejected" outcome, which the
-- ingress route acknowledges (2xx) like every other terminal outcome, so a
-- forged delivery is dropped once instead of retried forever by the
-- transport.
--
-- Bodies below are copied verbatim from their prior definitions (013 for
-- claim_event_delivery, 046 for claim_processing_stage_delivery) with only
-- the new guard clause added; every other statement, comment ordering and
-- control-flow path is unchanged.

begin;

create or replace function corvis_control.claim_event_delivery(
  p_tenant_id uuid,
  p_consumer_name text,
  p_event_id uuid,
  p_event_type text,
  p_aggregate_type text,
  p_aggregate_id text,
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
  claim_state text
)
language plpgsql
security invoker
as $$
declare
  current_row corvis_control.event_inbox%rowtype;
  next_token uuid;
  inserted_count integer;
begin
  if p_consumer_name is null or btrim(p_consumer_name)='' then raise exception 'consumer name is required'; end if;
  if p_payload_sha256 is null or btrim(p_payload_sha256)='' then raise exception 'payload hash is required'; end if;
  if p_max_attempts < 1 then raise exception 'max attempts must be positive'; end if;
  if p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'lease seconds out of range'; end if;

  -- Authenticity guard: this event must be one Corvis itself published to the
  -- outbox (dispatchConfiguredProcessingTransport is the only producer of a
  -- transport message, and it always publishes the outbox row's own
  -- tenant_id/event_id/event_type/payload unmodified). A delivery carrying an
  -- event_id/event_type/payload combination with no such row was never
  -- emitted by Corvis and must be rejected before it is claimed, not merely
  -- deduplicated against whatever a prior delivery of the same event_id wrote.
  if not exists (
    select 1
    from corvis_control.outbox_event o
    where o.tenant_id=p_tenant_id
      and o.event_id=p_event_id
      and o.event_type=p_event_type
      and o.payload=p_payload
  ) then
    raise exception 'event id has no matching outbox record';
  end if;

  insert into corvis_control.event_inbox (
    tenant_id,consumer_name,event_id,event_type,aggregate_type,aggregate_id,payload,payload_sha256,
    state,delivery_count,attempt,max_attempts,first_received_at,last_received_at
  ) values (
    p_tenant_id,p_consumer_name,p_event_id,p_event_type,p_aggregate_type,p_aggregate_id,p_payload,p_payload_sha256,
    'received',1,0,p_max_attempts,now(),now()
  ) on conflict (tenant_id,consumer_name,event_id) do nothing;
  get diagnostics inserted_count = row_count;

  select * into current_row
  from corvis_control.event_inbox
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
  for update;

  if not found then raise exception 'event inbox claim failed'; end if;
  if current_row.payload_sha256 <> p_payload_sha256 then raise exception 'event id payload mismatch'; end if;
  if current_row.event_type <> p_event_type or current_row.aggregate_type <> p_aggregate_type or current_row.aggregate_id <> p_aggregate_id then
    raise exception 'event id metadata mismatch';
  end if;

  if inserted_count = 0 then
    update corvis_control.event_inbox
    set delivery_count=delivery_count+1,last_received_at=now()
    where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
    returning * into current_row;
  end if;

  if current_row.state='complete' then
    return query select false,true,null::uuid,current_row.attempt,current_row.state;
    return;
  end if;
  if current_row.state='failed' or current_row.attempt >= current_row.max_attempts then
    update corvis_control.event_inbox
    set state='failed',lease_token=null,lease_expires_at=null,next_attempt_at=null
    where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
    returning * into current_row;
    return query select false,false,null::uuid,current_row.attempt,current_row.state;
    return;
  end if;
  if current_row.state='processing' and current_row.lease_expires_at is not null and current_row.lease_expires_at > now() then
    return query select false,false,null::uuid,current_row.attempt,current_row.state;
    return;
  end if;
  if current_row.state='retryable' and current_row.next_attempt_at is not null and current_row.next_attempt_at > now() then
    return query select false,false,null::uuid,current_row.attempt,current_row.state;
    return;
  end if;

  next_token := gen_random_uuid();
  update corvis_control.event_inbox
  set state='processing',
      attempt=attempt+1,
      lease_token=next_token,
      lease_expires_at=now()+make_interval(secs => p_lease_seconds),
      next_attempt_at=null,
      last_error=null,
      last_received_at=now()
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
  returning * into current_row;

  return query select true,false,next_token,current_row.attempt,current_row.state;
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

  -- Same authenticity guard as claim_event_delivery, checked directly here
  -- too (rather than relying solely on the delegated call below) so this
  -- stage-specific entry point never claims a fabricated delivery even if a
  -- future caller reaches it through a path that does not route through
  -- claim_event_delivery's own check.
  if not exists (
    select 1
    from corvis_control.outbox_event o
    where o.tenant_id=p_tenant_id
      and o.event_id=p_event_id
      and o.event_type=p_event_type
      and o.payload=p_payload
  ) then
    raise exception 'event id has no matching outbox record';
  end if;

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

commit;
