-- Correct audit rows written by migration 069 (#278).
-- Depends on migrations 001-072.
--
-- 069 recorded "webhook_subscription.paused_by_migration" for every paused subscription with no event types,
-- on the premise that only migration 064 could have paused one. That premise is false for a subscription a
-- tenant user had already paused before 064 emptied its event set: 064 only force-pauses `active` rows, so it
-- did not pause that one, yet 069 attributed the pause to the migration. Those rows are recognisable because
-- 069 left `paused_by` untouched when it was already set, so it still names the user (or another actor) that
-- paused it.
--
-- audit_event is append-only (047), so the false rows stay; each gets one correcting row that says so, and
-- readers of the trail see both. Idempotent: a corrected subscription is not corrected twice.
--
-- Like 064 and 069, run as a role that bypasses RLS (FORCE RLS would otherwise hide every row).

begin;

insert into corvis_control.audit_event
  (tenant_id, occurred_at, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
select s.tenant_id,
       now(),
       'system:migration-073',
       'webhook_subscription.paused_by_migration.corrected',
       'webhook_subscription',
       s.webhook_id::text,
       'success',
       'migration-073',
       jsonb_build_object(
         'corrects', '069_audit_migration_064_webhook_pauses.sql',
         'reason', 'paused_before_migration_064',
         'pausedBy', s.paused_by,
         'note', 'This subscription was paused by its recorded actor before migration 064 removed its internal event types; migration 064 did not pause it.'
       )
from corvis_control.webhook_subscription s
where s.status = 'paused'
  and cardinality(s.event_types) = 0
  and s.paused_by is not null
  and s.paused_by <> 'system:migration-064'
  and exists (
    select 1
    from corvis_control.audit_event a
    where a.tenant_id = s.tenant_id
      and a.action = 'webhook_subscription.paused_by_migration'
      and a.target_id = s.webhook_id::text
      and a.correlation_id = 'migration-069'
  )
  and not exists (
    select 1
    from corvis_control.audit_event c
    where c.tenant_id = s.tenant_id
      and c.action = 'webhook_subscription.paused_by_migration.corrected'
      and c.target_id = s.webhook_id::text
  );

commit;
