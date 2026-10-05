-- F1c (#332): the performance scorecard export is a schedulable scope.
-- Depends on migrations 001-092 (085 schedules, 090 per-schedule notification switch and the 13-argument create function).
--
-- A schedule saves one "Export this view" scope. Until now that was one snapshot or one Position Financials view, each of
-- which names a fund (or a snapshot, which belongs to one). The scorecard scope is `{"performanceScorecard":true}` plus the
-- optional filters `fundId` (one entitled fund) and `period` (a reporting-period label), and unfiltered it names no fund at all:
-- it means "every fund the owner is entitled to *now*". Three things follow, and this migration is all of them:
--
--   1. The saved scope may carry no snapshot and no fund (`scope_snapshot_id` and `scope_fund_id` both null), but only for a
--      scorecard scope. A scorecard scope with a `fundId` filter keeps that fund in `scope_fund_id`, so its on-publish trigger
--      is exactly the existing one (any snapshot of that fund). The old "exactly one of the two" check is replaced.
--   2. `create_export_schedule` (same 13-argument signature, `p_notify_on_completion` last) validates the scorecard scope:
--      the marker must be the boolean `true`, nothing but `fundId` and `period` may accompany it, and each filter is a trimmed
--      single-value string within its bound. Everything it did before is unchanged.
--   3. On publish, an all-funds scorecard follows the owner's *current* entitlements, which only the application can resolve.
--      `export_schedule_latest_publication` and `claim_export_schedule_trigger` therefore take the funds the owner is entitled
--      to at claim time (`p_fund_ids` / `p_entitled_fund_ids`, null meaning "not narrowed"): only a publication of one of those
--      funds is a trigger. Publications of any other fund are consumed (the watermark moves past them) so the schedule is not
--      listed as due for them again, and no run is recorded for them: the owner never learns that an unentitled fund published.
--      The list of due schedules (085) stays the coarse hint it always was; the claim is what decides, under the row lock.
--
-- Run-time re-authorization is not new SQL: the worker (lib/server/export-schedule.ts) re-resolves the owner's membership,
-- entitlements and data rights for every claimed trigger and requests the export through the same governed path as an interactive
-- request, so a scorecard run re-resolves "all funds" from what the owner holds at that moment, and is recorded as failed with a
-- stable reason when they hold none. Nothing in the notification category checks (086/090) is touched.

begin;

-- 1. A scorecard scope may name no fund and no snapshot. The 085 check is anonymous; it is found by its definition.
do $$
declare
  v_constraint text;
begin
  for v_constraint in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'corvis_control.export_schedule'::regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%scope_snapshot_id IS NOT NULL%scope_fund_id IS NOT NULL%'
  loop
    execute format('alter table corvis_control.export_schedule drop constraint %I', v_constraint);
  end loop;
end;
$$;

alter table corvis_control.export_schedule drop constraint if exists export_schedule_scope_target_check;
alter table corvis_control.export_schedule add constraint export_schedule_scope_target_check check (
  (scope_snapshot_id is not null) <> (scope_fund_id is not null)
  or (scope_snapshot_id is null and scope_fund_id is null and scope ? 'performanceScorecard')
);

-- 3. The newest settled publication newer than the watermark that matches the scope. For an all-funds scorecard, `p_fund_ids`
-- (the owner's entitled funds, when the application passes them) narrows it; without them it matches any fund of the tenant.
drop function if exists corvis_control.export_schedule_latest_publication(corvis_control.export_schedule);

create or replace function corvis_control.export_schedule_latest_publication(p_schedule corvis_control.export_schedule, p_fund_ids jsonb default null)
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
      or (p_schedule.scope_fund_id is not null and s.fund_id = p_schedule.scope_fund_id)
      or (p_schedule.scope_snapshot_id is null and p_schedule.scope_fund_id is null
          and (p_fund_ids is null or s.fund_id in (select jsonb_array_elements_text(p_fund_ids)))))
  order by s.published_at desc, s.snapshot_id, s.version desc
  limit 1
$$;

drop function if exists corvis_control.claim_export_schedule_trigger(uuid, uuid);

create or replace function corvis_control.claim_export_schedule_trigger(p_tenant_id uuid, p_schedule_id uuid, p_entitled_fund_ids jsonb default null)
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
    select * into v_publication from corvis_control.export_schedule_latest_publication(v_schedule, p_entitled_fund_ids);
    if not found then
      -- An all-funds scorecard narrowed to the owner's funds: a publication of any other fund is not a trigger. It is consumed,
      -- so the schedule is not listed as due for it again, and no run is recorded.
      if p_entitled_fund_ids is not null and v_schedule.scope_snapshot_id is null and v_schedule.scope_fund_id is null then
        select * into v_publication from corvis_control.export_schedule_latest_publication(v_schedule);
        if found then
          update corvis_control.export_schedule s
          set publish_watermark = v_publication.published_at, updated_at = v_now
          where s.tenant_id = p_tenant_id and s.schedule_id = p_schedule_id;
        end if;
      end if;
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

-- 2. Saving a schedule: the 090 function with the scorecard scope added. Idempotency, the 50-schedule limit and every other
-- validation are unchanged.
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

  if p_scope ? 'performanceScorecard' then
    -- The performance scorecard: the marker `true`, and at most the two filters. A fund filter is the fund an on-publish
    -- trigger follows; without one the schedule names no fund (every fund the owner is entitled to at the time of a run).
    if p_scope -> 'performanceScorecard' <> 'true'::jsonb
       or p_scope ?| array['snapshotId', 'positionFinancials']
       or (p_scope - 'performanceScorecard' - 'fundId' - 'period') <> '{}'::jsonb then
      raise exception 'export schedule scope is invalid';
    end if;
    if (p_scope ? 'fundId' and (jsonb_typeof(p_scope -> 'fundId') <> 'string'
          or length(p_scope ->> 'fundId') not between 1 and 512 or (p_scope ->> 'fundId') <> btrim(p_scope ->> 'fundId')))
       or (p_scope ? 'period' and (jsonb_typeof(p_scope -> 'period') <> 'string'
          or length(p_scope ->> 'period') not between 1 and 64 or (p_scope ->> 'period') <> btrim(p_scope ->> 'period'))) then
      raise exception 'export schedule scorecard filter is invalid';
    end if;
    v_fund_id := p_scope ->> 'fundId';
  elsif p_scope ? 'snapshotId' then
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

commit;
