-- F4 (#260): scheduled exports.
-- Depends on migrations 001-083 (007 identity subjects, 039/066 governed export jobs).
--
-- A schedule saves one "Export this view" scope with a format and a trigger: run when a matching snapshot is
-- published, on the first day of every month, or on the first day of every quarter (UTC). A schedule never exports
-- anything itself. The private delivery worker turns each *due trigger* into one governed export request made as the
-- schedule's owner (re-authorized at that moment, then delivered by the existing export worker), so this migration only
-- stores the schedule, decides what is due, and records one run per trigger.
--
-- Idempotency: a run is unique per (schedule, trigger key). A trigger key names the event, never the attempt:
-- `publish:<snapshot id>:v<version>`, `monthly:2026-10` or `quarterly:2026-Q4`. The worker claims a trigger under a row
-- lock on the schedule, advances the schedule past it, requests the export and records the run in one transaction, so a
-- crash leaves nothing behind and a second worker finds nothing due. The unique key is the backstop.
--
-- Publication triggers coalesce: the newest matching publication since the schedule's watermark is the trigger, and the
-- watermark moves to it, so several publications in one settle window produce one export, not one per snapshot. A
-- publication only counts once it has settled for a minute, because `published_at` is the transaction start time and a
-- slow commit could otherwise land behind an already-advanced watermark and be missed.
--
-- Access model (mirrors 071/083): both tables are server-managed. A schedule is changed by its owner only and read by its
-- owner and Organization Admins, which is a predicate on the owner's identity rather than on tenant membership, so there
-- is deliberately no client-facing policy: the application service role reads and writes with explicit tenant/owner
-- predicates after request authorization has succeeded. RLS is enabled and forced so a role without BYPASSRLS sees nothing.

begin;

create table if not exists corvis_control.export_schedule (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  schedule_id uuid not null,
  workspace_id uuid not null,
  owner_auth_method text not null check (owner_auth_method in ('oidc','saml','service_account')),
  owner_subject text not null check (length(owner_subject) between 1 and 1024),
  idempotency_key text not null check (length(idempotency_key) between 1 and 256),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  label text not null check (length(label) between 1 and 80 and label = btrim(label)),
  -- The exact scope an export request carries ({"snapshotId":...} or {"positionFinancials":{...}}).
  scope jsonb not null check (jsonb_typeof(scope) = 'object'),
  scope_label text not null check (length(scope_label) between 1 and 2000),
  -- What an on-publish trigger matches: that snapshot (any new version) or any snapshot of that fund. Exactly one is set.
  scope_snapshot_id uuid,
  scope_fund_id text check (scope_fund_id is null or length(scope_fund_id) between 1 and 512),
  format text not null check (format in ('csv','xlsx','parquet')),
  trigger_kind text not null check (trigger_kind in ('on_publish','monthly','quarterly')),
  status text not null default 'active' check (status in ('active','paused','stopped','deleted')),
  stop_reason text check (stop_reason is null or stop_reason in ('owner_inactive')),
  -- Calendar triggers: the next period start (UTC). On-publish triggers: publications at or before this have been handled.
  -- Both are set only while the schedule is active, so a resumed schedule never catches up on what it missed while held.
  next_run_at timestamptz,
  publish_watermark timestamptz,
  status_changed_at timestamptz not null default now(),
  status_changed_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, schedule_id),
  unique (tenant_id, owner_auth_method, owner_subject, idempotency_key),
  foreign key (tenant_id, workspace_id) references corvis_control.workspace(tenant_id, workspace_id),
  check ((scope_snapshot_id is not null) <> (scope_fund_id is not null)),
  check ((status = 'stopped') = (stop_reason is not null)),
  check (trigger_kind <> 'on_publish' or next_run_at is null),
  check (trigger_kind = 'on_publish' or publish_watermark is null),
  check ((status = 'active') = (case when trigger_kind = 'on_publish' then publish_watermark is not null else next_run_at is not null end))
);

alter table corvis_control.export_schedule enable row level security;
alter table corvis_control.export_schedule force row level security;

create index if not exists export_schedule_tenant_created_idx
  on corvis_control.export_schedule (tenant_id, created_at desc, schedule_id desc)
  where status <> 'deleted';
create index if not exists export_schedule_owner_idx
  on corvis_control.export_schedule (tenant_id, owner_auth_method, owner_subject, created_at desc, schedule_id desc)
  where status <> 'deleted';
create index if not exists export_schedule_calendar_due_idx
  on corvis_control.export_schedule (next_run_at)
  where status = 'active' and trigger_kind <> 'on_publish';
create index if not exists export_schedule_on_publish_idx
  on corvis_control.export_schedule (tenant_id, scope_fund_id)
  where status = 'active' and trigger_kind = 'on_publish';

-- One row per handled trigger. `requested`: handed to the governed export worker (export_id). `failed`: re-authorization
-- or the export request was refused, so nothing was exported; the reason is one of a closed set and never carries data.
create table if not exists corvis_control.export_schedule_run (
  tenant_id uuid not null,
  run_id uuid not null,
  schedule_id uuid not null,
  trigger_key text not null check (length(trigger_key) between 1 and 200),
  outcome text not null check (outcome in ('requested','failed')),
  export_id uuid,
  failure_reason text check (failure_reason is null or failure_reason in (
    'owner_inactive','export_permission_revoked','redistribution_not_permitted','scope_not_entitled','scope_unavailable','format_unavailable'
  )),
  created_at timestamptz not null default now(),
  primary key (tenant_id, run_id),
  unique (tenant_id, schedule_id, trigger_key),
  foreign key (tenant_id, schedule_id) references corvis_control.export_schedule(tenant_id, schedule_id),
  check ((outcome = 'requested') = (export_id is not null)),
  check ((outcome = 'failed') = (failure_reason is not null))
);

alter table corvis_control.export_schedule_run enable row level security;
alter table corvis_control.export_schedule_run force row level security;

create index if not exists export_schedule_run_tenant_created_idx
  on corvis_control.export_schedule_run (tenant_id, created_at desc, run_id desc);
create index if not exists export_schedule_run_schedule_idx
  on corvis_control.export_schedule_run (tenant_id, schedule_id, created_at desc, run_id desc);
create index if not exists export_schedule_run_export_idx
  on corvis_control.export_schedule_run (tenant_id, export_id)
  where export_id is not null;

create or replace function corvis_control.reject_export_schedule_run_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  raise exception 'export schedule run history is append-only';
end;
$$;

drop trigger if exists export_schedule_run_append_only on corvis_control.export_schedule_run;
create trigger export_schedule_run_append_only
  before update or delete on corvis_control.export_schedule_run
  for each row execute function corvis_control.reject_export_schedule_run_mutation();
drop trigger if exists export_schedule_run_no_truncate on corvis_control.export_schedule_run;
create trigger export_schedule_run_no_truncate
  before truncate on corvis_control.export_schedule_run
  for each statement execute function corvis_control.reject_export_schedule_run_mutation();

-- What was scheduled never changes after the fact (a different scope is a new schedule), a deleted schedule is gone for
-- good, and a stopped one can only be deleted. Only the workflow columns may move.
create or replace function corvis_control.guard_export_schedule_update()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  if (new.tenant_id, new.schedule_id, new.workspace_id, new.owner_auth_method, new.owner_subject, new.idempotency_key,
      new.request_hash, new.label, new.scope, new.scope_label, new.scope_snapshot_id, new.scope_fund_id, new.format,
      new.trigger_kind, new.created_at)
    is distinct from
     (old.tenant_id, old.schedule_id, old.workspace_id, old.owner_auth_method, old.owner_subject, old.idempotency_key,
      old.request_hash, old.label, old.scope, old.scope_label, old.scope_snapshot_id, old.scope_fund_id, old.format,
      old.trigger_kind, old.created_at) then
    raise exception 'export schedule content is immutable';
  end if;
  if old.status = 'deleted' and new.status <> 'deleted' then
    raise exception 'export schedule is deleted';
  end if;
  if old.status = 'stopped' and new.status not in ('stopped','deleted') then
    raise exception 'export schedule is stopped';
  end if;
  return new;
end;
$$;

drop trigger if exists export_schedule_guard_update on corvis_control.export_schedule;
create trigger export_schedule_guard_update
  before update on corvis_control.export_schedule
  for each row execute function corvis_control.guard_export_schedule_update();

-- A schedule is deleted by status, never by row: its runs and the audit trail keep pointing at it.
create or replace function corvis_control.reject_export_schedule_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  raise exception 'export schedules are deleted by status, never by row';
end;
$$;

drop trigger if exists export_schedule_no_delete on corvis_control.export_schedule;
create trigger export_schedule_no_delete
  before delete on corvis_control.export_schedule
  for each row execute function corvis_control.reject_export_schedule_delete();
drop trigger if exists export_schedule_no_truncate on corvis_control.export_schedule;
create trigger export_schedule_no_truncate
  before truncate on corvis_control.export_schedule
  for each statement execute function corvis_control.reject_export_schedule_delete();

-- The first calendar run strictly after `p_after`: the next month or quarter start in UTC. Null for an on-publish trigger.
create or replace function corvis_control.export_schedule_next_run_at(p_trigger_kind text, p_after timestamptz)
returns timestamptz
language sql
immutable
set search_path = pg_catalog
as $$
  select case p_trigger_kind
    when 'monthly' then (date_trunc('month', p_after at time zone 'UTC') + interval '1 month') at time zone 'UTC'
    when 'quarterly' then (date_trunc('quarter', p_after at time zone 'UTC') + interval '3 months') at time zone 'UTC'
  end;
$$;

-- Saves a schedule. Idempotent per owner: the same key and content returns the existing schedule, the same key with
-- different content is refused. The owner holds at most 50 schedules that have not been deleted.
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
  p_trigger_kind text
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
     scope_label, scope_snapshot_id, scope_fund_id, format, trigger_kind, status, next_run_at, publish_watermark,
     status_changed_at, status_changed_by, created_at, updated_at)
  values
    (p_tenant_id, p_schedule_id, p_workspace_id, p_owner_auth_method, p_owner_subject, p_idempotency_key, p_request_hash,
     p_label, p_scope, p_scope_label, v_snapshot_id, v_fund_id, p_format, p_trigger_kind, 'active',
     corvis_control.export_schedule_next_run_at(p_trigger_kind, v_now),
     case when p_trigger_kind = 'on_publish' then v_now end,
     v_now, p_owner_subject, v_now, v_now)
  returning * into v_schedule;

  return next v_schedule;
end;
$$;

-- The owner pauses, resumes or deletes their own schedule.
--   pause   active -> paused    (nothing runs, and nothing is caught up later)
--   resume  paused -> active    (the watermark / next calendar run restart from now)
--   delete  any not-yet-deleted -> deleted (the row stays for audit and history; it never runs again)
-- Returns no row when the schedule does not exist for this owner (or was already deleted).
create or replace function corvis_control.set_export_schedule_status(
  p_tenant_id uuid,
  p_schedule_id uuid,
  p_owner_auth_method text,
  p_owner_subject text,
  p_action text
)
returns setof corvis_control.export_schedule
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_schedule corvis_control.export_schedule%rowtype;
  v_now timestamptz := now();
begin
  select * into v_schedule from corvis_control.export_schedule s
  where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    and s.owner_auth_method = p_owner_auth_method and s.owner_subject = p_owner_subject
    and s.status <> 'deleted'
  for update;
  if not found then
    return;
  end if;

  if p_action = 'pause' and v_schedule.status = 'active' then
    update corvis_control.export_schedule s
    set status = 'paused', next_run_at = null, publish_watermark = null, status_changed_at = v_now, status_changed_by = p_owner_subject, updated_at = v_now
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    returning * into v_schedule;
  elsif p_action = 'resume' and v_schedule.status = 'paused' then
    update corvis_control.export_schedule s
    set status = 'active',
        next_run_at = corvis_control.export_schedule_next_run_at(s.trigger_kind, v_now),
        publish_watermark = case when s.trigger_kind = 'on_publish' then v_now end,
        status_changed_at = v_now, status_changed_by = p_owner_subject, updated_at = v_now
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    returning * into v_schedule;
  elsif p_action = 'delete' then
    update corvis_control.export_schedule s
    set status = 'deleted', stop_reason = null, next_run_at = null, publish_watermark = null,
        status_changed_at = v_now, status_changed_by = p_owner_subject, updated_at = v_now
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id
    returning * into v_schedule;
  else
    raise exception 'export schedule transition not allowed';
  end if;

  return next v_schedule;
end;
$$;

-- The newest published snapshot version that matches the schedule's scope, has settled, and is newer than the
-- schedule's watermark. Only the latest version of a snapshot counts (as in the governed export itself).
create or replace function corvis_control.export_schedule_latest_publication(p_schedule corvis_control.export_schedule)
returns table (snapshot_id uuid, snapshot_version integer, published_at timestamptz)
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control, corvis_consolidated
as $$
  select s.snapshot_id, s.version, s.published_at
  from corvis_consolidated.fund_period_snapshot s
  where p_schedule.trigger_kind = 'on_publish'
    and s.tenant_id = p_schedule.tenant_id
    and s.status = 'published'
    and s.published_at is not null
    and s.published_at > p_schedule.publish_watermark
    and s.published_at <= now() - interval '1 minute'
    and not exists (
      select 1 from corvis_consolidated.fund_period_snapshot newer
      where newer.tenant_id = s.tenant_id and newer.snapshot_id = s.snapshot_id and newer.version > s.version
    )
    and ((p_schedule.scope_snapshot_id is not null and s.snapshot_id = p_schedule.scope_snapshot_id)
      or (p_schedule.scope_fund_id is not null and s.fund_id = p_schedule.scope_fund_id))
  order by s.published_at desc, s.snapshot_id, s.version desc
  limit 1
$$;

-- Active schedules with something due, oldest first. Only a hint: the claim below re-checks under a row lock.
create or replace function corvis_control.list_due_export_schedules(p_limit integer)
returns table (tenant_id uuid, schedule_id uuid)
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select s.tenant_id, s.schedule_id
  from corvis_control.export_schedule s
  where s.status = 'active'
    and ((s.trigger_kind <> 'on_publish' and s.next_run_at <= now())
      or (s.trigger_kind = 'on_publish' and exists (select 1 from corvis_control.export_schedule_latest_publication(s))))
  order by coalesce(s.next_run_at, s.publish_watermark), s.schedule_id
  limit greatest(p_limit, 0)
$$;

-- Claims the schedule's due trigger, if any, under a row lock: the schedule is advanced past it (calendar: to the next
-- period start after now, so a long outage yields one run for the current period, not one per missed period;
-- publication: to the newest matching publication, so a burst is one run) and the trigger is returned. Nothing is
-- returned when the schedule is not active, nothing is due, or the trigger already has a run. The caller requests the
-- export and records the run in the same transaction; rolling that back releases the claim.
create or replace function corvis_control.claim_export_schedule_trigger(p_tenant_id uuid, p_schedule_id uuid)
returns table (trigger_key text, snapshot_id uuid, snapshot_version integer)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_schedule corvis_control.export_schedule%rowtype;
  v_publication record;
  v_snapshot_id uuid;
  v_snapshot_version integer;
  v_period timestamp;
  v_key text;
  v_now timestamptz := now();
begin
  select * into v_schedule from corvis_control.export_schedule s
  where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id and s.status = 'active'
  for update;
  if not found then
    return;
  end if;

  if v_schedule.trigger_kind = 'on_publish' then
    select * into v_publication from corvis_control.export_schedule_latest_publication(v_schedule);
    if not found then
      return;
    end if;
    v_snapshot_id := v_publication.snapshot_id;
    v_snapshot_version := v_publication.snapshot_version;
    v_key := 'publish:' || v_snapshot_id::text || ':v' || v_snapshot_version::text;
    update corvis_control.export_schedule s
    set publish_watermark = v_publication.published_at, updated_at = v_now
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id;
  else
    if v_schedule.next_run_at is null or v_schedule.next_run_at > v_now then
      return;
    end if;
    v_period := date_trunc(case v_schedule.trigger_kind when 'monthly' then 'month' else 'quarter' end, v_now at time zone 'UTC');
    v_key := v_schedule.trigger_kind || ':' || case v_schedule.trigger_kind
      when 'monthly' then to_char(v_period, 'YYYY-MM')
      else to_char(v_period, 'YYYY') || '-Q' || to_char(v_period, 'Q') end;
    update corvis_control.export_schedule s
    set next_run_at = corvis_control.export_schedule_next_run_at(s.trigger_kind, v_now), updated_at = v_now
    where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id;
  end if;

  if exists (select 1 from corvis_control.export_schedule_run r
             where r.tenant_id = p_tenant_id and r.schedule_id = p_schedule_id and r.trigger_key = v_key) then
    return;
  end if;

  trigger_key := v_key;
  snapshot_id := v_snapshot_id;
  snapshot_version := v_snapshot_version;
  return next;
end;
$$;

-- Schedules stop automatically when their owner is deactivated: the identity is disabled, or the owner no longer holds an
-- active membership in the schedule's workspace. Returns the schedules it stopped. Idempotent.
create or replace function corvis_control.stop_export_schedules_for_inactive_owners()
returns setof corvis_control.export_schedule
language sql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
  update corvis_control.export_schedule s
  set status = 'stopped', stop_reason = 'owner_inactive', next_run_at = null, publish_watermark = null,
      status_changed_at = now(), status_changed_by = 'system:export-scheduler', updated_at = now()
  where s.status in ('active','paused')
    and not exists (
      select 1
      from corvis_control.identity_subject i
      join corvis_control.membership m on m.tenant_id = i.tenant_id and m.user_id = i.user_id
      where i.tenant_id = s.tenant_id and i.auth_method = s.owner_auth_method and i.subject = s.owner_subject
        and i.status = 'active'
        and m.workspace_id = s.workspace_id and m.status = 'active'
        and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    )
  returning s.*
$$;

-- Stops one schedule whose owner the application has just proven can no longer be authorized (the membership, tenant,
-- workspace or service-identity lifecycle resolution found no active context). Returns no row when the schedule is
-- already stopped or deleted.
create or replace function corvis_control.stop_export_schedule(p_tenant_id uuid, p_schedule_id uuid)
returns setof corvis_control.export_schedule
language sql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
  update corvis_control.export_schedule s
  set status = 'stopped', stop_reason = 'owner_inactive', next_run_at = null, publish_watermark = null,
      status_changed_at = now(), status_changed_by = 'system:export-scheduler', updated_at = now()
  where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id and s.status in ('active','paused')
  returning s.*
$$;

commit;
