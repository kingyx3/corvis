-- Corvis durable orchestration inbox v1
-- Depends on migrations 001-012.

begin;

create table if not exists corvis_control.event_inbox (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  consumer_name text not null,
  event_id uuid not null,
  event_type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  payload jsonb not null,
  payload_sha256 text not null,
  state text not null check (state in ('received','processing','retryable','complete','failed')),
  delivery_count integer not null default 1 check (delivery_count > 0),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  primary key (tenant_id, consumer_name, event_id)
);

alter table corvis_control.event_inbox enable row level security;
alter table corvis_control.event_inbox force row level security;

-- This table is worker/server managed. Deliberately do not add client mutation
-- policies; provider workers use the trusted Postgres service boundary.
create index if not exists event_inbox_dispatch_idx
  on corvis_control.event_inbox (tenant_id, consumer_name, state, next_attempt_at, lease_expires_at);
create index if not exists event_inbox_aggregate_idx
  on corvis_control.event_inbox (tenant_id, aggregate_type, aggregate_id, first_received_at);

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

create or replace function corvis_control.complete_event_delivery(
  p_tenant_id uuid,
  p_consumer_name text,
  p_event_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security invoker
as $$
begin
  update corvis_control.event_inbox
  set state='complete',completed_at=now(),lease_token=null,lease_expires_at=null,next_attempt_at=null,last_error=null
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
    and state='processing' and lease_token=p_lease_token;
  return found;
end;
$$;

create or replace function corvis_control.fail_event_delivery(
  p_tenant_id uuid,
  p_consumer_name text,
  p_event_id uuid,
  p_lease_token uuid,
  p_error text
)
returns text
language plpgsql
security invoker
as $$
declare
  current_row corvis_control.event_inbox%rowtype;
  next_state text;
  delay_seconds integer;
begin
  select * into current_row
  from corvis_control.event_inbox
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id
    and state='processing' and lease_token=p_lease_token
  for update;

  if not found then return null; end if;

  next_state := case when current_row.attempt >= current_row.max_attempts then 'failed' else 'retryable' end;
  delay_seconds := least(900, power(2, greatest(0, current_row.attempt-1))::integer);

  update corvis_control.event_inbox
  set state=next_state,
      lease_token=null,
      lease_expires_at=null,
      next_attempt_at=case when next_state='retryable' then now()+make_interval(secs => delay_seconds) else null end,
      last_error=left(coalesce(p_error,'unknown error'),2000)
  where tenant_id=p_tenant_id and consumer_name=p_consumer_name and event_id=p_event_id;

  return next_state;
end;
$$;

commit;
