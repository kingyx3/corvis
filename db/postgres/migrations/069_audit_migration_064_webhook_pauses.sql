-- Record the customer-visible change migration 064 made without an audit row (#228).
-- Depends on migrations 001-068.
--
-- 064 dropped internal event types from webhook subscriptions and paused every
-- active subscription left with no customer-facing event, without writing an
-- audit_event. The API refuses to create or update a subscription with an empty
-- event set (event_types_required), so a paused subscription with no event types
-- can only have been paused by 064. Each one gets one attributable audit row,
-- dated when 064 updated it, so tenant admins can see why their webhook stopped,
-- and the paused_at/paused_by that 064 left empty. Both statements are
-- idempotent: re-running them changes nothing.
--
-- Subscriptions that 064 only trimmed (and that stayed active) cannot be
-- identified after the fact because 064 kept no before-image; ops/RUNBOOK.md
-- records how to handle future data-rewriting migrations.
--
-- Like 064, this must run as a role that bypasses RLS (Supabase's `postgres`
-- migration role does); under FORCE RLS (051) a non-bypassing role would see and
-- audit no rows.

begin;

insert into corvis_control.audit_event
  (tenant_id, occurred_at, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
select s.tenant_id,
       s.updated_at,
       'system:migration-064',
       'webhook_subscription.paused_by_migration',
       'webhook_subscription',
       s.webhook_id::text,
       'success',
       'migration-069',
       jsonb_build_object(
         'migration', '064_compatibility_cleanup_guards.sql',
         'reason', 'no_customer_facing_event_types',
         'recordedBy', '069_audit_migration_064_webhook_pauses.sql'
       )
from corvis_control.webhook_subscription s
where s.status = 'paused'
  and cardinality(s.event_types) = 0
  and not exists (
    select 1
    from corvis_control.audit_event a
    where a.tenant_id = s.tenant_id
      and a.action = 'webhook_subscription.paused_by_migration'
      and a.target_id = s.webhook_id::text
  );

update corvis_control.webhook_subscription s
set paused_at = s.updated_at,
    paused_by = 'system:migration-064'
where s.status = 'paused'
  and cardinality(s.event_types) = 0
  and s.paused_at is null
  and s.paused_by is null;

commit;
