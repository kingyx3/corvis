-- One counter per authenticated tenant/subject across all API instances.
-- Expired windows overwrite their row; history does not accumulate per minute.
begin;
create table corvis_control.api_rate_limit (
  tenant_id uuid not null references corvis_control.tenant(tenant_id) on delete cascade,
  subject text not null check (length(subject) between 1 and 1024),
  window_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (tenant_id, subject)
);
alter table corvis_control.api_rate_limit enable row level security;
alter table corvis_control.api_rate_limit force row level security;
-- No client policies: only the privileged backend may consume budgets.
revoke all on corvis_control.api_rate_limit from public;

create function corvis_control.consume_api_rate_limit(p_tenant_id uuid, p_subject text, p_limit integer)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_start timestamptz;
  v_count integer;
begin
  if p_limit is null or p_limit < 1 or p_limit >= 2147483647 then
    raise exception 'invalid request limit';
  end if;
  -- ON CONFLICT serializes callers for the same identity. Saturating at
  -- limit+1 avoids overflow while preserving a stable denied state.
  insert into corvis_control.api_rate_limit as bucket
    (tenant_id, subject, window_start, request_count)
  values (p_tenant_id, p_subject, v_now, 1)
  on conflict (tenant_id, subject) do update set
    window_start = case when bucket.window_start + interval '60 seconds' <= v_now
      then v_now else bucket.window_start end,
    request_count = case when bucket.window_start + interval '60 seconds' <= v_now
      then 1 else least(bucket.request_count::bigint + 1, p_limit::bigint + 1)::integer end
  returning window_start, request_count into v_start, v_count;
  return query select v_count <= p_limit,
    greatest(1, least(60, ceil(extract(epoch from v_start + interval '60 seconds' - v_now))::integer));
end;
$$;
revoke all on function corvis_control.consume_api_rate_limit(uuid,text,integer) from public;
-- Supabase's server role is explicit; browser roles receive no grants.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on corvis_control.api_rate_limit to service_role;
    grant execute on function corvis_control.consume_api_rate_limit(uuid,text,integer) to service_role;
  end if;
end;
$$;
commit;
