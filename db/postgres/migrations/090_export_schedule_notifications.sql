-- F4b (#328): per-schedule completion notification for scheduled exports.
-- Depends on migrations 001-089 (064 webhook event allow-list, 071/083/086/087 notification category checks, 085 schedules).
--
-- A scheduled run already notifies like any export (the owner's `export_ready` email on completion, `ExportRequested`
-- webhooks). This adds three things, none of which carries data:
--   1. `notify_on_completion`: the owner's switch for the *emails* about one schedule (default on, which is what every
--      existing schedule did). Chosen at creation, changed by the owner only (`set_export_schedule_notification`). It is a
--      workflow column, so the immutability guard on a schedule's content (085) does not apply to it.
--   2. Two customer-facing webhook events, `ExportScheduleRunCompleted` and `ExportScheduleRunFailed`, emitted through the
--      ordinary outbox (`emit_export_schedule_run_event`). The payload names the schedule (id and the label its owner chose),
--      the run and, from a closed set, why it failed: never a figure, a fund, a company or a person. They are not gated by the
--      owner's email switch: a subscriber chose the event for the whole organization.
--   3. A new optional F2 category, `export_schedule_failed`, for the owner when a run is refused or its export fails.

begin;

alter table corvis_control.export_schedule
  add column if not exists notify_on_completion boolean not null default true;

-- The webhook allow-list (064) gains the two run events.
alter table corvis_control.webhook_subscription drop constraint if exists webhook_subscription_customer_event_types;
alter table corvis_control.webhook_subscription add constraint webhook_subscription_customer_event_types
  check (
    event_types <@ array[
      'SnapshotPublicationChanged',
      'DataCorrectionOpened',
      'DataCorrectionResolved',
      'CorrectionReplacementDeliveryRequested',
      'ExportRequested',
      'ExportScheduleRunCompleted',
      'ExportScheduleRunFailed'
    ]::text[]
    and (status <> 'active' or cardinality(event_types) > 0)
  );

-- The F2 category: outbox rows and per-user preferences may now name it.
alter table corvis_control.email_outbox drop constraint if exists email_outbox_category_check;
alter table corvis_control.email_outbox add constraint email_outbox_category_check check (category in (
  'invitation','export_ready','pinned_fund_published','source_attention',
  'support_access','role_changed','digest','data_issue_update','review_discussion','security_policy','tenant_export_approval','tenant_export_outcome','export_schedule_failed'
));
alter table corvis_control.notification_preference drop constraint if exists notification_preference_category_check;
alter table corvis_control.notification_preference add constraint notification_preference_category_check
  check (category in ('export_ready','pinned_fund_published','source_attention','data_issue_update','review_discussion','tenant_export_outcome','export_schedule_failed'));

-- Saving a schedule now takes the switch. The 12-argument form is replaced, not overloaded: callers that do not pass it
-- get the default (on).
drop function if exists corvis_control.create_export_schedule(uuid, uuid, uuid, text, text, text, text, text, jsonb, text, text, text);

create or replace function corvis_control.create_export_schedule(
  p_tenant_id uuid,
  p_schedule_id uuid,
  p_workspace_id uuid,
  p_owner_auth_method text,
  p_owner_subject text,
  p_idempotency_key text,
  p_request_hash text,
  p_label text,
  p_scope jsonb,
  p_scope_label text,
  p_format text,
  p_trigger_kind text,
  p_notify_on_completion boolean default true
)
returns setof corvis_control.export_schedule
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_schedule corvis_control.export_schedule%rowtype;
  v_snapshot_id uuid;
  v_fund_id text;
  v_now timestamptz := now();
begin
  select * into v_schedule from corvis_control.export_schedule s
  where s.tenant_id = p_tenant_id and s.owner_auth_method = p_owner_auth_method
    and s.owner_subject = p_owner_subject and s.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_schedule.request_hash <> p_request_hash then
      raise exception 'idempotency key reused with different export schedule';
    end if;
    return next v_schedule;
    return;
  end if;

  if p_scope ? 'snapshotId' then
    if jsonb_typeof(p_scope -> 'snapshotId') <> 'string'
       or (p_scope ->> 'snapshotId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'export schedule scope is invalid';
    end if;
    v_snapshot_id := (p_scope ->> 'snapshotId')::uuid;
  else
    v_fund_id := p_scope -> 'positionFinancials' ->> 'fundId';
    if jsonb_typeof(p_scope -> 'positionFinancials') <> 'object' or v_fund_id is null or length(v_fund_id) not between 1 and 512 then
      raise exception 'export schedule scope is invalid';
    end if;
  end if;

  if (select count(*) from corvis_control.export_schedule s
      where s.tenant_id = p_tenant_id and s.owner_auth_method = p_owner_auth_method
        and s.owner_subject = p_owner_subject and s.status <> 'deleted') >= 50 then
    raise exception 'export schedule limit reached';
  end if;

  insert into corvis_control.export_schedule
    (tenant_id, schedule_id, workspace_id, owner_auth_method, owner_subject, idempotency_key, request_hash, label, scope,
     scope_label, scope_snapshot_id, scope_fund_id, format, trigger_kind, notify_on_completion, status, next_run_at, publish_watermark,
     status_changed_at, status_changed_by, created_at, updated_at)
  values
    (p_tenant_id, p_schedule_id, p_workspace_id, p_owner_auth_method, p_owner_subject, p_idempotency_key, p_request_hash,
     p_label, p_scope, p_scope_label, v_snapshot_id, v_fund_id, p_format, p_trigger_kind, coalesce(p_notify_on_completion, true), 'active',
     corvis_control.export_schedule_next_run_at(p_trigger_kind, v_now),
     case when p_trigger_kind = 'on_publish' then v_now end,
     v_now, p_owner_subject, v_now, v_now)
  returning * into v_schedule;

  return next v_schedule;
end;
$$;

-- The owner turns the emails about their own schedule on or off. Returns no row when the schedule does not exist for this
-- owner (or was deleted). Setting the value it already has changes nothing.
create or replace function corvis_control.set_export_schedule_notification(
  p_tenant_id uuid,
  p_schedule_id uuid,
  p_owner_auth_method text,
  p_owner_subject text,
  p_notify_on_completion boolean
)
returns setof corvis_control.export_schedule
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_schedule corvis_control.export_schedule%rowtype;
begin
  if p_notify_on_completion is null then
    raise exception 'export schedule notification setting is required';
  end if;
  select * into v_schedule from corvis_control.export_schedule s
  where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    and s.owner_auth_method = p_owner_auth_method and s.owner_subject = p_owner_subject
    and s.status <> 'deleted'
  for update;
  if not found then
    return;
  end if;
  if v_schedule.notify_on_completion <> p_notify_on_completion then
    update corvis_control.export_schedule s
    set notify_on_completion = p_notify_on_completion, updated_at = now()
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    returning * into v_schedule;
  end if;
  return next v_schedule;
end;
$$;

-- Emits the webhook event for the end of one scheduled run, once per run: `completed` when its export finished,
-- `failed` when the run was refused (fail-closed: owner_inactive, redistribution_not_permitted, ...) or its export could
-- not be delivered (`export_failed`). The event rides the ordinary outbox, so webhook delivery, retries and fan-out are
-- the existing ones. The payload is ids, the schedule's label and a closed reason code, and nothing else. Returns the
-- event id, or null when the run does not exist or already ended in an event.
create or replace function corvis_control.emit_export_schedule_run_event(
  p_tenant_id uuid,
  p_run_id uuid,
  p_outcome text,
  p_failure_reason text default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_run corvis_control.export_schedule_run%rowtype;
  v_label text;
  v_reason text;
  v_event_id uuid := gen_random_uuid();
  v_payload jsonb;
begin
  if p_outcome not in ('completed','failed') then
    raise exception 'export schedule run event outcome is invalid';
  end if;
  if p_failure_reason is not null and p_failure_reason not in (
    'owner_inactive','export_permission_revoked','redistribution_not_permitted','scope_not_entitled','scope_unavailable','format_unavailable','export_failed'
  ) then
    raise exception 'export schedule run event reason is invalid';
  end if;

  select * into v_run from corvis_control.export_schedule_run r
  where r.tenant_id = p_tenant_id and r.run_id = p_run_id;
  if not found then
    return null;
  end if;
  if p_outcome = 'completed' and v_run.outcome <> 'requested' then
    raise exception 'a refused export schedule run cannot complete';
  end if;
  if exists (
    select 1 from corvis_control.outbox_event e
    where e.tenant_id = p_tenant_id and e.aggregate_type = 'export_schedule_run' and e.aggregate_id = p_run_id::text
      and e.event_type in ('ExportScheduleRunCompleted','ExportScheduleRunFailed')
  ) then
    return null;
  end if;

  select s.label into v_label from corvis_control.export_schedule s
  where s.tenant_id = v_run.tenant_id and s.schedule_id = v_run.schedule_id;

  v_payload := jsonb_build_object('scheduleId', v_run.schedule_id, 'scheduleLabel', v_label, 'runId', v_run.run_id);
  if v_run.export_id is not null then
    v_payload := v_payload || jsonb_build_object('exportId', v_run.export_id);
  end if;
  if p_outcome = 'failed' then
    v_reason := coalesce(p_failure_reason, v_run.failure_reason, 'export_failed');
    v_payload := v_payload || jsonb_build_object('failureReason', v_reason);
  end if;

  insert into corvis_control.outbox_event (tenant_id, event_id, event_type, aggregate_type, aggregate_id, payload, created_at)
  values (p_tenant_id, v_event_id,
          case p_outcome when 'completed' then 'ExportScheduleRunCompleted' else 'ExportScheduleRunFailed' end,
          'export_schedule_run', p_run_id::text, v_payload, now());
  return v_event_id;
end;
$$;

commit;
