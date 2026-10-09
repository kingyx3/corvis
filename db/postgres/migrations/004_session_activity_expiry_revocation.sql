-- Keep policy-expired session IDs refused when their activity history is purged.
-- An IdP can refresh tokens with the same stable sid after months of inactivity;
-- forgetting that sid must not restart its Corvis idle/maximum-length clock.
-- Existing revocations are immutable here. Tenants without timeout limits retain
-- the existing bookkeeping-only cleanup behavior.
begin;

create or replace function corvis_control.purge_tenant_session_activity(
  p_retention_minutes integer, p_limit integer default 5000
) returns integer
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
declare
  v_count integer;
begin
  if p_retention_minutes is null or p_retention_minutes < 11520 then
    raise exception 'session activity retention is shorter than the longest session';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'session activity purge limit is out of range';
  end if;

  -- One statement makes removal and refusal atomic. SKIP LOCKED preserves the
  -- bounded concurrent-worker contract; an insertion failure rolls back removal.
  with purged as (
    delete from corvis_control.tenant_session_activity a
    where (a.tenant_id, a.auth_method, a.subject, a.session_id) in (
      select x.tenant_id, x.auth_method, x.subject, x.session_id
      from corvis_control.tenant_session_activity x
      where x.last_seen_at < now() - make_interval(mins => p_retention_minutes)
      order by x.last_seen_at
      limit p_limit
      for update skip locked
    )
    returning a.*
  ), revoked as (
    insert into corvis_control.session_revocation
      (tenant_id, auth_method, subject, session_id, revoked_by_subject, reason)
    select a.tenant_id, a.auth_method, a.subject, a.session_id,
      'system:session-activity-sweep', 'Session expired under organization policy before activity cleanup'
    from purged a
    join corvis_control.tenant_session_policy p on p.tenant_id = a.tenant_id
    where a.auth_method in ('oidc', 'saml') and (
      (p.idle_timeout_minutes is not null and a.last_seen_at + make_interval(mins => p.idle_timeout_minutes) <= now())
      or (p.max_session_minutes is not null and a.first_seen_at + make_interval(mins => p.max_session_minutes) <= now())
    )
    on conflict (tenant_id, auth_method, subject, session_id) do nothing
    returning 1
  )
  select count(*)::integer into v_count from purged;
  return v_count;
end;
$$;

commit;
