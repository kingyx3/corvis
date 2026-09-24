-- Polling indexes, export state domain, serialized key rotation and an
-- append-only audit log.
-- Depends on migrations 001-046.
--
-- 1. Processing transport claim. outbox_processing_transport_ready_idx
--    (migration 021) covers every outbox row with published_at null, but since
--    migration 043 only the processing transport sets published_at. Customer
--    facing events (SnapshotPublicationChanged, ExportRequested, ...) therefore
--    stay in that partial index forever, at the front of its ordering, and
--    every claim_processing_transport_events poll walked past all of them
--    ("Rows Removed by Filter" grew with total event volume). This index holds
--    only the four transport event types the claim can select, in the claim's
--    ORDER BY, so a poll reads only claimable rows.
-- 2. Export delivery queue. processQueuedExports scans
--    state in ('queued','retryable') across tenants ordered by created_at;
--    the only state index leads with tenant_id. The partial index holds only
--    queued/retryable rows, so the poll no longer grows with export history.
-- 3. export_job.state had no domain constraint (every other queue state column
--    does). NOT VALID enforces it for new writes without scanning or locking
--    existing history for a validation pass.
-- 4. /reconciliations lists a tenant's runs for the caller's entitled funds,
--    newest first; no index led with (tenant_id, fund_id).
-- 5. rotate_webhook_signing_key took no lock: two concurrent rotations both
--    retired the (same) old key and both inserted an active key, so the loser
--    hit webhook_signing_key_one_active_idx and surfaced as a 500. The
--    subscription row is now locked first, which serializes rotations with
--    each other and with pause/revoke; a rotation that waited behind a revoke
--    re-checks the status and reports "not found" instead of adding a key to a
--    revoked subscription.
-- 6. corvis_control.audit_event is the tenant audit trail but, unlike
--    control_evidence_record (migration 016), accepted UPDATE and DELETE.
--    Nothing in the application updates or deletes audit rows. A future
--    retention purge must be an explicit, reviewed migration that disables
--    this trigger for its own transaction only.
--
-- The runner applies each migration in one transaction, so indexes are built
-- without CONCURRENTLY.

begin;

-- 1. Processing transport claim ----------------------------------------------

create index if not exists outbox_processing_transport_claim_idx
  on corvis_control.outbox_event (coalesce(next_attempt_at, created_at), created_at, event_id)
  where published_at is null
    and transport_dead_lettered_at is null
    and event_type in ('DocumentRegistered','ProcessingStageReady','ProcessingStageRetryScheduled','ProcessingJobRetryRequested');

-- 2. Export delivery queue ---------------------------------------------------

create index if not exists export_job_delivery_queue_idx
  on corvis_serving.export_job (created_at)
  where state in ('queued','retryable');

-- 3. Export state domain -----------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'corvis_serving.export_job'::regclass and conname = 'export_job_state_check'
  ) then
    alter table corvis_serving.export_job
      add constraint export_job_state_check
      check (state in ('queued','delivering','retryable','complete','failed')) not valid;
  end if;
end;
$$;

-- 4. Reconciliation listing --------------------------------------------------

create index if not exists reconciliation_run_fund_created_idx
  on corvis_consolidated.reconciliation_run (tenant_id, fund_id, created_at desc);

-- 5. Serialized signing-key rotation ----------------------------------------

create or replace function corvis_control.rotate_webhook_signing_key(
  p_tenant_id uuid,
  p_webhook_id uuid,
  p_new_key_id uuid,
  p_new_secret text,
  p_created_by text,
  p_grace_seconds integer default 86400
)
returns uuid
language plpgsql
security invoker
as $$
begin
  if p_new_secret is null or length(p_new_secret) < 32 then
    raise exception 'signing secret must be at least 32 characters';
  end if;
  if p_grace_seconds < 0 or p_grace_seconds > 2592000 then
    raise exception 'grace period out of range';
  end if;

  perform 1 from corvis_control.webhook_subscription
  where tenant_id = p_tenant_id and webhook_id = p_webhook_id and status <> 'revoked'
  for update;
  if not found then raise exception 'webhook subscription not found'; end if;

  update corvis_control.webhook_signing_key
  set status = 'retiring', retire_by = now() + make_interval(secs => p_grace_seconds)
  where tenant_id = p_tenant_id and webhook_id = p_webhook_id and status = 'active';

  insert into corvis_control.webhook_signing_key
    (tenant_id, webhook_id, key_id, secret, status, created_at, created_by)
  values (p_tenant_id, p_webhook_id, p_new_key_id, p_new_secret, 'active', now(), p_created_by);

  return p_new_key_id;
end;
$$;

-- 6. Append-only audit trail -------------------------------------------------

create or replace function corvis_control.reject_audit_event_mutation()
returns trigger
language plpgsql
security invoker
as $$
begin
  raise exception 'corvis_control.audit_event is append-only';
end;
$$;

drop trigger if exists audit_event_append_only on corvis_control.audit_event;
create trigger audit_event_append_only
  before update or delete on corvis_control.audit_event
  for each row execute function corvis_control.reject_audit_event_mutation();

drop trigger if exists audit_event_no_truncate on corvis_control.audit_event;
create trigger audit_event_no_truncate
  before truncate on corvis_control.audit_event
  for each statement execute function corvis_control.reject_audit_event_mutation();

commit;
