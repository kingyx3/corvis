-- F7d (#337): housekeeping for corvis_control.tenant_session_activity.
-- Depends on migrations 001-090 (087 session policy and activity, 008 session revocation).
--
-- tenant_session_activity (087) holds one row per session Corvis has seen and nothing ever removed one, so it grew with
-- every sign-in for as long as the tenant existed. This migration adds the purge the delivery tick runs
-- (src/lib/server/session-activity-sweep.ts). What it must never do is touch a session that could still matter:
--
--   * Enforcement. A session is measured from the row's first_seen_at (maximum length, at most 10080 minutes) and
--     last_seen_at (idle timeout, at most 480 minutes). A row whose last_seen_at is older than the longest maximum
--     session has also been first seen longer ago than that, so under every policy the bounds allow it is already past
--     both limits and has nothing left to decide. The function refuses any retention shorter than that longest session
--     plus a day of margin (11520 minutes), so no caller, configuration or typo can purge a session a limit is still
--     measuring. The retention actually used is much longer (90 days, src/core/session-policy.ts): the longer the window, the
--     longer a session that went quiet is still recognised as the same session rather than a new one.
--   * Revocation. Sign-out-everywhere and revoked sessions live in corvis_control.session_revocation (008), which every
--     authoritative request consults on its own, before the policy. This function never reads or writes it, so a revoked
--     session stays refused whether or not its activity row still exists.
--   * Liveness. Only rows not seen for the whole retention window are removed; a session in use refreshes last_seen_at at
--     least every 30 seconds, so an active session is never a candidate. Rows locked by a concurrent request are skipped.
--
-- The purge is bounded per call (so a tick never holds a long scan or lock) and returns how many rows it removed; a full
-- batch means more remain for the next tick. No audit event is written (the rows are bookkeeping, not decisions); the
-- worker logs the count. RLS stays enabled and forced on the table and the function is security invoker.

begin;

-- Candidates are found by age alone, across tenants; 087's index is keyed on the subject first and cannot serve that.
create index if not exists tenant_session_activity_last_seen_idx
  on corvis_control.tenant_session_activity (last_seen_at);

create or replace function corvis_control.purge_tenant_session_activity(
  p_retention_minutes integer,
  p_limit integer default 5000
)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_count integer;
begin
  -- 10080 (the longest maximum session the policy allows) + 1440 (a day of margin).
  if p_retention_minutes is null or p_retention_minutes < 11520 then
    raise exception 'session activity retention is shorter than the longest session';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'session activity purge limit is out of range';
  end if;

  delete from corvis_control.tenant_session_activity a
  where (a.tenant_id, a.auth_method, a.subject, a.session_id) in (
    select x.tenant_id, x.auth_method, x.subject, x.session_id
    from corvis_control.tenant_session_activity x
    where x.last_seen_at < now() - make_interval(mins => p_retention_minutes)
    order by x.last_seen_at
    limit p_limit
    for update skip locked
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

commit;
