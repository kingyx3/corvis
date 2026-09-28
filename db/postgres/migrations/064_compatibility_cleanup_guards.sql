-- Normalize compatibility-era data that can be repaired deterministically and
-- enforce the current semantic/external-contract rules for all future writes.

begin;

-- Consolidated facts have always required subject_type. The current
-- consolidation stage also persists semanticDimensions.subjectLevel, but facts
-- created before that semantic payload existed may not carry the JSON field.
-- An empty subject_type cannot be inferred safely, so fail closed instead of
-- inventing a semantic level during migration.
do $$
begin
  if exists (
    select 1
    from corvis_consolidated.consolidated_fact
    where nullif(btrim(subject_type), '') is null
  ) then
    raise exception 'consolidated_fact contains blank subject_type; governed backfill required before migration 064';
  end if;
end
$$;

update corvis_consolidated.consolidated_fact
set value = jsonb_set(
  value,
  '{semanticDimensions}',
  (case
    when jsonb_typeof(value->'semanticDimensions') = 'object' then value->'semanticDimensions'
    else '{}'::jsonb
  end) || jsonb_build_object('subjectLevel', subject_type),
  true
)
where nullif(btrim(value->'semanticDimensions'->>'subjectLevel'), '') is null;

alter table corvis_consolidated.consolidated_fact
  add constraint consolidated_fact_subject_type_nonempty
  check (nullif(btrim(subject_type), '') is not null) not valid;

alter table corvis_consolidated.consolidated_fact
  validate constraint consolidated_fact_subject_type_nonempty;

alter table corvis_consolidated.consolidated_fact
  add constraint consolidated_fact_subject_level_present
  check (nullif(btrim(value->'semanticDimensions'->>'subjectLevel'), '') is not null) not valid;

alter table corvis_consolidated.consolidated_fact
  validate constraint consolidated_fact_subject_level_present;

-- Earlier webhook rows could name internal outbox/transport event types before
-- the customer-facing event allowlist was formalized. Runtime delivery already
-- refuses those event types. Normalize persisted subscriptions to the current
-- customer contract as well. If a row has no customer-facing event left, pause
-- it with an empty event set rather than leaving an apparently active no-op.
with normalized as (
  select tenant_id,
         webhook_id,
         array(
           select distinct event_type
           from unnest(event_types) as event_type
           where event_type = any(array[
             'SnapshotPublicationChanged',
             'DataCorrectionOpened',
             'DataCorrectionResolved',
             'CorrectionReplacementDeliveryRequested',
             'ExportRequested'
           ]::text[])
           order by event_type
         ) as event_types
  from corvis_control.webhook_subscription
), desired as (
  select tenant_id,
         webhook_id,
         event_types,
         case when cardinality(event_types) = 0 then 'paused' else null end as forced_status
  from normalized
)
update corvis_control.webhook_subscription s
set event_types = d.event_types,
    status = case when d.forced_status is not null and s.status = 'active' then d.forced_status else s.status end,
    updated_at = now()
from desired d
where s.tenant_id = d.tenant_id
  and s.webhook_id = d.webhook_id
  and (
    s.event_types is distinct from d.event_types
    or (d.forced_status is not null and s.status = 'active')
  );

alter table corvis_control.webhook_subscription
  add constraint webhook_subscription_customer_event_types
  check (
    event_types <@ array[
      'SnapshotPublicationChanged',
      'DataCorrectionOpened',
      'DataCorrectionResolved',
      'CorrectionReplacementDeliveryRequested',
      'ExportRequested'
    ]::text[]
    and (status <> 'active' or cardinality(event_types) > 0)
  ) not valid;

alter table corvis_control.webhook_subscription
  validate constraint webhook_subscription_customer_event_types;

commit;
