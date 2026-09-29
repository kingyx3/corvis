-- Pipeline durability and export delivery hardening (issues #230, #231).
-- Depends on migrations 001-065.
--
-- 1. Deletion requests get an execution lease. A worker that crashes after the
--    compare-and-swap into `executing` (or whose failure bookkeeping fails)
--    used to leave the request there forever because `executing` is not an
--    executable state. Once the lease has expired the next authorized execute
--    call may reclaim it; rows already stuck before this migration have a null
--    lease and are treated as expired.
-- 2. Processing transport events that a dispatcher claimed but never attempted
--    (its lease budget ran out) can be handed back without burning one of the
--    eight dead-letter attempts.
-- 3. Export retries get an explicit next-attempt time so redelivery backs off
--    exponentially instead of retrying on five consecutive ticks.
-- 4. Export download grants become single-use.

begin;

alter table corvis_control.deletion_request
  add column if not exists execution_lease_expires_at timestamptz;

alter table corvis_serving.export_job
  add column if not exists delivery_next_attempt_at timestamptz;

alter table corvis_serving.export_download_grant
  add column if not exists consumed_at timestamptz;

create or replace function corvis_control.release_processing_transport_event(
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
  -- Only the current lease holder may release, and only while the lease is still
  -- live: after expiry another dispatcher may already own the event.
  update corvis_control.outbox_event
  set transport_lease_token=null,
      transport_lease_expires_at=null,
      attempt_count=greatest(attempt_count-1,0)
  where tenant_id=p_tenant_id and event_id=p_event_id and published_at is null
    and transport_dead_lettered_at is null
    and transport_lease_token=p_lease_token and transport_lease_expires_at > now();
  return found;
end;
$$;

commit;
