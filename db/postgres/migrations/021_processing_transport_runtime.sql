-- Durable outbox transport lease/retry boundary for production processing.
-- Depends on migrations 001-020.
begin;

alter table corvis_control.outbox_event add column if not exists transport_lease_token uuid;
alter table corvis_control.outbox_event add column if not exists transport_lease_expires_at timestamptz;
alter table corvis_control.outbox_event add column if not exists next_attempt_at timestamptz;
alter table corvis_control.outbox_event add column if not exists transport_dead_lettered_at timestamptz;

create index if not exists outbox_processing_transport_ready_idx
  on corvis_control.outbox_event (coalesce(next_attempt_at, created_at), created_at)
  where published_at is null and transport_dead_lettered_at is null;

create or replace function corvis_control.claim_processing_transport_events(
  p_limit integer default 50,
  p_lease_seconds integer default 60
)
returns table(
  tenant_id uuid,
  event_id uuid,
  event_type text,
  aggregate_type text,
  aggregate_id text,
  payload jsonb,
  attempt_count integer,
  lease_token uuid
)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
begin
  if p_limit < 1 or p_limit > 500 then raise exception 'transport claim limit out of bounds'; end if;
  if p_lease_seconds < 15 or p_lease_seconds > 600 then raise exception 'transport lease duration out of bounds'; end if;

  return query
  with candidates as (
    select o.tenant_id,o.event_id
    from corvis_control.outbox_event o
    where o.published_at is null
      and o.transport_dead_lettered_at is null
      and coalesce(o.next_attempt_at,o.created_at) <= now()
      and (o.transport_lease_expires_at is null or o.transport_lease_expires_at <= now())
      and o.event_type in ('DocumentRegistered','ProcessingStageReady','ProcessingStageRetryScheduled','ProcessingJobRetryRequested')
    order by coalesce(o.next_attempt_at,o.created_at),o.created_at,o.event_id
    for update skip locked
    limit p_limit
  )
  update corvis_control.outbox_event o
  set transport_lease_token=gen_random_uuid(),
      transport_lease_expires_at=now()+make_interval(secs => p_lease_seconds),
      attempt_count=o.attempt_count+1,
      last_error=null
  from candidates c
  where o.tenant_id=c.tenant_id and o.event_id=c.event_id
  returning o.tenant_id,o.event_id,o.event_type,o.aggregate_type,o.aggregate_id,o.payload,o.attempt_count,o.transport_lease_token;
end;
$$;

create or replace function corvis_control.complete_processing_transport_event(
  p_tenant_id uuid,
  p_event_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
begin
  update corvis_control.outbox_event
  set published_at=now(),transport_lease_token=null,transport_lease_expires_at=null,next_attempt_at=null,last_error=null
  where tenant_id=p_tenant_id and event_id=p_event_id and published_at is null
    and transport_lease_token=p_lease_token and transport_lease_expires_at > now();
  return found;
end;
$$;

create or replace function corvis_control.fail_processing_transport_event(
  p_tenant_id uuid,
  p_event_id uuid,
  p_lease_token uuid,
  p_error text,
  p_max_attempts integer default 8
)
returns table(next_attempt_at timestamptz, dead_lettered boolean)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  current_attempt integer;
  delay_seconds integer;
begin
  select attempt_count into current_attempt
  from corvis_control.outbox_event
  where tenant_id=p_tenant_id and event_id=p_event_id and published_at is null
    and transport_lease_token=p_lease_token and transport_lease_expires_at > now()
  for update;
  if not found then return; end if;

  if current_attempt >= p_max_attempts then
    update corvis_control.outbox_event
    set transport_lease_token=null,transport_lease_expires_at=null,next_attempt_at=null,
        transport_dead_lettered_at=now(),last_error=left(coalesce(p_error,'unknown transport failure'),2000)
    where tenant_id=p_tenant_id and event_id=p_event_id;
    return query select null::timestamptz,true;
    return;
  end if;

  delay_seconds := least(300,5 * power(2,greatest(current_attempt-1,0))::integer);
  update corvis_control.outbox_event
  set transport_lease_token=null,transport_lease_expires_at=null,
      next_attempt_at=now()+make_interval(secs => delay_seconds),
      last_error=left(coalesce(p_error,'unknown transport failure'),2000)
  where tenant_id=p_tenant_id and event_id=p_event_id
  returning corvis_control.outbox_event.next_attempt_at into next_attempt_at;
  dead_lettered := false;
  return next;
end;
$$;

commit;
