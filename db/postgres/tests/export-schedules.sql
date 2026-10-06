-- Acceptance (F4 #260, F4b #328, F1c #332): scheduled exports, their notifications and the scorecard scope.
--
-- Proves, against the real SQL functions on an isolated disposable database:
--   * a schedule is saved idempotently per owner, validated, bounded (50 per owner) and starts from "now": a calendar
--     schedule from the next month/quarter start in UTC (whatever the session time zone), a publication schedule from a
--     watermark at creation, so nothing that happened before it is ever exported;
--   * only the owner pauses, resumes or deletes; pausing holds without catching up; a stopped or deleted schedule never
--     comes back; content is immutable and rows are never deleted;
--   * a trigger is claimed once: calendar triggers advance to the next period (a long outage is one run for the current
--     period), publication triggers coalesce a burst into the newest settled publication of the latest version, match only
--     the schedule's own snapshot or fund in the schedule's own tenant, and a trigger that already has a run is only
--     advanced past; a paused or deleted schedule is never due;
--   * a run is unique per schedule and trigger key, its outcome columns are consistent, and history is append-only;
--   * schedules stop automatically when the owner is disabled or loses the workspace membership, and only then;
--   * (090) the owner's notification switch is on by default, chosen at creation and changed by the owner only; a run ends in at
--     most one webhook event (completed or failed, including fail-closed refusals) whose payload is ids, the label and a closed
--     reason code; the webhook allow-list and the F2 category checks accept the new names and still refuse unknown ones;
--   * (097) the performance scorecard is a schedulable scope: validated in SQL (the marker, at most a bounded fund and period
--     filter, nothing else), unfiltered it names no fund and no snapshot, a fund filter makes it a fund schedule; its publication
--     trigger can be narrowed to the funds the owner holds when it is claimed, publications of other funds are consumed without a
--     run, the claim is never widened by a fund filter or across tenants; the earlier functions are replaced, not overloaded;
--   * RLS is enabled and forced with no client policy, so a role without BYPASSRLS reads nothing.
--
-- Run after supabase-auth-fixture.sql and the full migration chain. Everything is rolled back.

\set ON_ERROR_STOP on

begin;

-- Runs a statement that must fail and checks that the raised message contains the expected fragment.
create function pg_temp.expect_error(statement text, fragment text) returns void language plpgsql as $$
declare
  raised text;
begin
  begin
    execute statement;
  exception when others then
    raised := sqlerrm;
  end;
  if raised is null then
    raise exception 'expected failure containing "%" but the statement succeeded: %', fragment, statement;
  end if;
  if position(fragment in raised) = 0 then
    raise exception 'expected failure containing "%" but got "%"', fragment, raised;
  end if;
end;
$$;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('a0850000-0000-4000-8000-00000000000a','export-schedule-a','Export Schedule A'),
       ('b0850000-0000-4000-8000-00000000000b','export-schedule-b','Export Schedule B');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name)
values ('a0850000-0000-4000-8000-0000000000a1','a0850000-0000-4000-8000-00000000000a','primary','A primary'),
       ('b0850000-0000-4000-8000-0000000000b1','b0850000-0000-4000-8000-00000000000b','primary','B primary');
insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject,status)
values ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000e1','oidc','idp|owner','active'),
       ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000e2','oidc','idp|other','active'),
       ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000e3','oidc','idp|leaver','active'),
       ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000e4','oidc','idp|moved','active'),
       ('b0850000-0000-4000-8000-00000000000b','b0850000-0000-4000-8000-0000000000e5','oidc','idp|b-owner','active');
insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name)
values ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000a1','a0850000-0000-4000-8000-0000000000e1','analyst'),
       ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000a1','a0850000-0000-4000-8000-0000000000e2','analyst'),
       ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000a1','a0850000-0000-4000-8000-0000000000e3','analyst'),
       ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000a1','a0850000-0000-4000-8000-0000000000e4','analyst'),
       ('b0850000-0000-4000-8000-00000000000b','b0850000-0000-4000-8000-0000000000b1','b0850000-0000-4000-8000-0000000000e5','analyst');

-- Snapshots. Tenant A: snapshot c1 (fund-x) has v1 superseded and v2 published; c2 and c3 are other published snapshots
-- of fund-x; c4 is a snapshot of fund-y. Tenant B has its own published snapshot of fund-x. Publication times are in the
-- past, because the whole test is one transaction and now() does not move.
insert into corvis_consolidated.fund_period_snapshot
  (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
values
  ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000c1','fund-x','2026-Q1',1,'superseded','1','1',now() - interval '5 hours'),
  ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000c1','fund-x','2026-Q1',2,'published','1','1',now() - interval '3 hours'),
  ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000c2','fund-x','2026-Q2',1,'published','1','1',now() - interval '2 hours'),
  ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000c3','fund-x','2026-Q3',1,'published','1','1',now() - interval '90 minutes'),
  ('a0850000-0000-4000-8000-00000000000a','a0850000-0000-4000-8000-0000000000c4','fund-y','2026-Q1',1,'published','1','1',now() - interval '80 minutes'),
  ('b0850000-0000-4000-8000-00000000000b','b0850000-0000-4000-8000-0000000000c9','fund-x','2026-Q1',1,'published','1','1',now() - interval '70 minutes');

-- 1. The calendar helper: next month/quarter start in UTC, whatever the session time zone.
do $$
declare
  case_row record;
begin
  for case_row in select * from (values
    ('monthly',   '2026-01-31 23:59:59+00'::timestamptz, '2026-02-01 00:00:00+00'::timestamptz),
    ('monthly',   '2026-12-15 12:00:00+00',              '2027-01-01 00:00:00+00'),
    ('monthly',   '2026-03-01 00:00:00+00',              '2026-04-01 00:00:00+00'),
    ('quarterly', '2026-02-01 00:00:00+00',              '2026-04-01 00:00:00+00'),
    ('quarterly', '2026-03-31 23:59:59+00',              '2026-04-01 00:00:00+00'),
    ('quarterly', '2026-11-30 08:00:00+00',              '2027-01-01 00:00:00+00'),
    ('quarterly', '2026-10-01 00:00:00+00',              '2027-01-01 00:00:00+00')
  ) as t(kind, after, expected) loop
    if corvis_control.export_schedule_next_run_at(case_row.kind, case_row.after) is distinct from case_row.expected then
      raise exception 'next run after % (%) must be %, got %', case_row.after, case_row.kind, case_row.expected, corvis_control.export_schedule_next_run_at(case_row.kind, case_row.after);
    end if;
  end loop;
  if corvis_control.export_schedule_next_run_at('on_publish', now()) is not null then raise exception 'a publication trigger has no calendar run'; end if;
  -- 2026-01-31 23:30 in New York is already 2026-02-01 04:30 UTC: the period is the UTC one.
  set local timezone = 'America/New_York';
  if corvis_control.export_schedule_next_run_at('monthly', '2026-01-31 23:30:00-05') <> '2026-03-01 00:00:00+00' then raise exception 'periods are UTC, not session-local'; end if;
  if corvis_control.export_schedule_next_run_at('monthly', '2026-01-31 18:30:00-05') <> '2026-02-01 00:00:00+00' then raise exception 'a late evening in New York can still be January in UTC'; end if;
  set local timezone = 'UTC';
end $$;

-- 2. Saving a schedule: idempotent, validated, bounded and started from now.
do $$
declare
  tenant uuid := 'a0850000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0850000-0000-4000-8000-0000000000a1';
  hash text := repeat('a', 64);
  first_row corvis_control.export_schedule%rowtype;
  replay corvis_control.export_schedule%rowtype;
  other corvis_control.export_schedule%rowtype;
  quarterly corvis_control.export_schedule%rowtype;
  position_scope jsonb := '{"positionFinancials":{"fundId":"fund-x","holdingId":"h-1","companyId":"company-1","periodicity":"quarterly"}}';
begin
  select * into first_row from corvis_control.create_export_schedule(tenant,'a0850000-0000-4000-8000-0000000000d1',workspace,'oidc','idp|owner',
    'key-1',hash,'Fund X monthly',position_scope,'Position financials · company-1 · quarterly','csv','monthly');
  if first_row.status <> 'active' or first_row.stop_reason is not null or first_row.workspace_id <> workspace then raise exception 'a new schedule is active: %', row_to_json(first_row); end if;
  if first_row.scope_fund_id <> 'fund-x' or first_row.scope_snapshot_id is not null then raise exception 'a position scope matches by fund: %', row_to_json(first_row); end if;
  if first_row.next_run_at <> corvis_control.export_schedule_next_run_at('monthly', now()) or first_row.publish_watermark is not null then
    raise exception 'a monthly schedule starts at the next month start and has no watermark: %', row_to_json(first_row);
  end if;
  if first_row.next_run_at <= now() then raise exception 'the first calendar run is in the future'; end if;

  -- Same owner, same key, same content: the original comes back and nothing is added.
  select * into replay from corvis_control.create_export_schedule(tenant,'a0850000-0000-4000-8000-0000000000d9',workspace,'oidc','idp|owner',
    'key-1',hash,'ignored',position_scope,'ignored','csv','monthly');
  if replay.schedule_id <> first_row.schedule_id then raise exception 'replay must return the original schedule, got %', replay.schedule_id; end if;
  if (select count(*) from corvis_control.export_schedule where tenant_id = tenant) <> 1 then raise exception 'replay must not create a second schedule'; end if;

  -- Same key, different content is refused; another owner may reuse the key text for its own schedule.
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','key-1',%L,'x',%L::jsonb,'x','csv','monthly')$f$,
    tenant,'a0850000-0000-4000-8000-0000000000da',workspace,repeat('b', 64),position_scope), 'idempotency key reused with different export schedule');
  select * into other from corvis_control.create_export_schedule(tenant,'a0850000-0000-4000-8000-0000000000d2',workspace,'oidc','idp|other',
    'key-1',repeat('c', 64),'Snapshot c3 on publish','{"snapshotId":"a0850000-0000-4000-8000-0000000000c3"}','Snapshot a0850000-0000-4000-8000-0000000000c3','xlsx','on_publish');
  if other.schedule_id = first_row.schedule_id then raise exception 'idempotency keys are per owner'; end if;
  if other.scope_snapshot_id <> 'a0850000-0000-4000-8000-0000000000c3' or other.scope_fund_id is not null then raise exception 'a snapshot scope matches the snapshot: %', row_to_json(other); end if;
  if other.publish_watermark <> now() or other.next_run_at is not null then raise exception 'a publication schedule starts from now and has no calendar run: %', row_to_json(other); end if;

  select * into quarterly from corvis_control.create_export_schedule(tenant,'a0850000-0000-4000-8000-0000000000d3',workspace,'oidc','idp|owner',
    'key-q',repeat('d', 64),'Quarterly',position_scope,'Position financials','parquet','quarterly');
  if quarterly.next_run_at <> corvis_control.export_schedule_next_run_at('quarterly', now()) then raise exception 'a quarterly schedule starts at the next quarter start'; end if;

  -- The scope must be one an export request carries and the table's own checks hold.
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','key-bad-1',%L,'x','{"snapshotId":"not-a-uuid"}'::jsonb,'x','csv','monthly')$f$,
    tenant,'a0850000-0000-4000-8000-0000000000db',workspace,repeat('e', 64)), 'export schedule scope is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','key-bad-2',%L,'x','{"snapshotId":7}'::jsonb,'x','csv','monthly')$f$,
    tenant,'a0850000-0000-4000-8000-0000000000dc',workspace,repeat('f', 64)), 'export schedule scope is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','key-bad-3',%L,'x','{}'::jsonb,'x','csv','monthly')$f$,
    tenant,'a0850000-0000-4000-8000-0000000000dd',workspace,repeat('1', 64)), 'export schedule scope is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','key-bad-4',%L,'x','{"positionFinancials":"fund-x"}'::jsonb,'x','csv','monthly')$f$,
    tenant,'a0850000-0000-4000-8000-0000000000de',workspace,repeat('2', 64)), 'export schedule scope is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','key-bad-5',%L,'x',%L::jsonb,'x','json','monthly')$f$,
    tenant,'a0850000-0000-4000-8000-0000000000df',workspace,repeat('3', 64),position_scope), 'violates check constraint');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','key-bad-6',%L,'x',%L::jsonb,'x','csv','weekly')$f$,
    tenant,'a0850000-0000-4000-8000-0000000000e0',workspace,repeat('4', 64),position_scope), 'violates check constraint');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','key-bad-7',%L,'  padded ',%L::jsonb,'x','csv','monthly')$f$,
    tenant,'a0850000-0000-4000-8000-0000000000e5',workspace,repeat('5', 64),position_scope), 'violates check constraint');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,'b0850000-0000-4000-8000-0000000000b1','oidc','idp|owner','key-bad-8',%L,'x',%L::jsonb,'x','csv','monthly')$f$,
    tenant,'a0850000-0000-4000-8000-0000000000e6',repeat('6', 64),position_scope), 'violates foreign key constraint');

  -- At most 50 schedules per owner that have not been deleted: a deleted one frees its place.
  for i in 1..47 loop
    perform corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|owner','bulk-' || i,repeat('7', 64),'Bulk ' || i,position_scope,'Position financials','csv','monthly');
  end loop;
  if (select count(*) from corvis_control.export_schedule where tenant_id = tenant and owner_subject = 'idp|owner') <> 49 then raise exception 'expected 49 schedules for the owner'; end if;
  perform corvis_control.create_export_schedule(tenant,'a0850000-0000-4000-8000-0000000000f0',workspace,'oidc','idp|owner','bulk-last',repeat('8', 64),'Fiftieth',position_scope,'Position financials','csv','monthly');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','bulk-over',%L,'Fifty-first',%L::jsonb,'x','csv','monthly')$f$,
    tenant,'a0850000-0000-4000-8000-0000000000f1',workspace,repeat('9', 64),position_scope), 'export schedule limit reached');
  perform corvis_control.set_export_schedule_status(tenant,'a0850000-0000-4000-8000-0000000000f0','oidc','idp|owner','delete');
  perform corvis_control.create_export_schedule(tenant,'a0850000-0000-4000-8000-0000000000f2',workspace,'oidc','idp|owner','bulk-after-delete',repeat('0', 64),'Fifty-first',position_scope,'Position financials','csv','monthly');
  -- The limit is per owner.
  perform corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|other','other-extra',repeat('1', 64),'Other extra',position_scope,'Position financials','csv','monthly');
end $$;

-- Keep the rest of the test small: drop the bulk schedules (no run references them).
alter table corvis_control.export_schedule disable trigger export_schedule_no_delete;
delete from corvis_control.export_schedule where label like 'Bulk %' or label like 'Fifty%' or label = 'Other extra';
alter table corvis_control.export_schedule enable trigger export_schedule_no_delete;

-- 3. Owner-only status changes, and what holding does and does not do.
do $$
declare
  tenant uuid := 'a0850000-0000-4000-8000-00000000000a';
  monthly uuid := (select schedule_id from corvis_control.export_schedule where idempotency_key = 'key-1' and owner_subject = 'idp|owner');
  on_publish uuid := (select schedule_id from corvis_control.export_schedule where idempotency_key = 'key-1' and owner_subject = 'idp|other');
  moved corvis_control.export_schedule%rowtype;
begin
  -- Another person, another tenant or an unknown id find nothing: a 404, never a different error.
  if exists (select 1 from corvis_control.set_export_schedule_status(tenant,monthly,'oidc','idp|other','pause')) then raise exception 'only the owner may pause'; end if;
  if exists (select 1 from corvis_control.set_export_schedule_status('b0850000-0000-4000-8000-00000000000b',monthly,'oidc','idp|owner','pause')) then raise exception 'another tenant cannot pause'; end if;
  if exists (select 1 from corvis_control.set_export_schedule_status(tenant,gen_random_uuid(),'oidc','idp|owner','pause')) then raise exception 'an unknown schedule is not found'; end if;
  if exists (select 1 from corvis_control.set_export_schedule_status(tenant,monthly,'saml','idp|owner','pause')) then raise exception 'the auth method is part of the owner identity'; end if;
  if (select status from corvis_control.export_schedule where schedule_id = monthly) <> 'active' then raise exception 'a refused change leaves the schedule active'; end if;

  select * into moved from corvis_control.set_export_schedule_status(tenant,monthly,'oidc','idp|owner','pause');
  if moved.status <> 'paused' or moved.next_run_at is not null or moved.publish_watermark is not null or moved.status_changed_by <> 'idp|owner' then raise exception 'pause holds the schedule: %', row_to_json(moved); end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_export_schedule_status(%L,%L,'oidc','idp|owner','pause')$f$, tenant, monthly), 'export schedule transition not allowed');
  -- A paused schedule is never due, even when its calendar run had been overdue when it was held.
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,monthly)) then raise exception 'a paused schedule has nothing to claim'; end if;
  if exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = monthly) then raise exception 'a paused schedule is never due'; end if;
  select * into moved from corvis_control.set_export_schedule_status(tenant,monthly,'oidc','idp|owner','resume');
  if moved.status <> 'active' or moved.next_run_at <> corvis_control.export_schedule_next_run_at('monthly', now()) then raise exception 'resume restarts from the next period, with no catch-up: %', row_to_json(moved); end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_export_schedule_status(%L,%L,'oidc','idp|owner','resume')$f$, tenant, monthly), 'export schedule transition not allowed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_export_schedule_status(%L,%L,'oidc','idp|owner','explode')$f$, tenant, monthly), 'export schedule transition not allowed');

  select * into moved from corvis_control.set_export_schedule_status(tenant,on_publish,'oidc','idp|other','pause');
  select * into moved from corvis_control.set_export_schedule_status(tenant,on_publish,'oidc','idp|other','resume');
  if moved.publish_watermark <> now() or moved.next_run_at is not null then raise exception 'a resumed publication schedule restarts its watermark at now: %', row_to_json(moved); end if;

  -- Delete: allowed from any live state, then the schedule is gone to its owner and never comes back.
  select * into moved from corvis_control.set_export_schedule_status(tenant,on_publish,'oidc','idp|other','delete');
  if moved.status <> 'deleted' or moved.next_run_at is not null or moved.publish_watermark is not null then raise exception 'delete clears the trigger state: %', row_to_json(moved); end if;
  if exists (select 1 from corvis_control.set_export_schedule_status(tenant,on_publish,'oidc','idp|other','delete')) then raise exception 'a deleted schedule is not found'; end if;
  if exists (select 1 from corvis_control.set_export_schedule_status(tenant,on_publish,'oidc','idp|other','resume')) then raise exception 'a deleted schedule cannot be resumed'; end if;
  perform pg_temp.expect_error(format($f$update corvis_control.export_schedule set status = 'paused', next_run_at = null where schedule_id = %L$f$, on_publish), 'export schedule is deleted');
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,on_publish)) then raise exception 'a deleted schedule has nothing to claim'; end if;
end $$;

-- 4. Immutability and the table's own invariants.
do $$
declare
  monthly uuid := (select schedule_id from corvis_control.export_schedule where idempotency_key = 'key-1' and owner_subject = 'idp|owner');
begin
  perform pg_temp.expect_error(format($f$update corvis_control.export_schedule set label = 'renamed' where schedule_id = %L$f$, monthly), 'export schedule content is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.export_schedule set format = 'xlsx' where schedule_id = %L$f$, monthly), 'export schedule content is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.export_schedule set scope = '{"snapshotId":"a0850000-0000-4000-8000-0000000000c3"}' where schedule_id = %L$f$, monthly), 'export schedule content is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.export_schedule set owner_subject = 'idp|other' where schedule_id = %L$f$, monthly), 'export schedule content is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.export_schedule set status = 'paused' where schedule_id = %L$f$, monthly), 'violates check constraint');
  perform pg_temp.expect_error(format($f$update corvis_control.export_schedule set next_run_at = null where schedule_id = %L$f$, monthly), 'violates check constraint');
  perform pg_temp.expect_error(format($f$update corvis_control.export_schedule set status = 'stopped', next_run_at = null where schedule_id = %L$f$, monthly), 'violates check constraint');
  perform pg_temp.expect_error(format($f$delete from corvis_control.export_schedule where schedule_id = %L$f$, monthly), 'export schedules are deleted by status, never by row');
  perform pg_temp.expect_error('truncate corvis_control.export_schedule cascade', 'export schedules are deleted by status, never by row');
end $$;

-- 5. Calendar triggers: claimed once, advanced to the next period, one run for a long outage.
do $$
declare
  tenant uuid := 'a0850000-0000-4000-8000-00000000000a';
  monthly uuid := (select schedule_id from corvis_control.export_schedule where idempotency_key = 'key-1' and owner_subject = 'idp|owner');
  quarterly uuid := (select schedule_id from corvis_control.export_schedule where idempotency_key = 'key-q');
  claimed record;
  period_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  expected_key text := 'monthly:' || to_char(now() at time zone 'UTC', 'YYYY-MM');
  expected_quarter text := 'quarterly:' || to_char(now() at time zone 'UTC', 'YYYY') || '-Q' || to_char(now() at time zone 'UTC', 'Q');
begin
  -- Not due yet: nothing to claim and nothing listed.
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,monthly)) then raise exception 'a schedule whose run is in the future has nothing to claim'; end if;
  if exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id in (monthly, quarterly)) then raise exception 'a schedule whose run is in the future is not due'; end if;

  -- Due: this period's start has come.
  update corvis_control.export_schedule set next_run_at = period_start where schedule_id = monthly;
  if not exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = monthly) then raise exception 'an overdue schedule is listed as due'; end if;
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,monthly);
  if claimed.trigger_key <> expected_key or claimed.snapshot_id is not null or claimed.snapshot_version is not null then raise exception 'the trigger is the current month: %', row_to_json(claimed); end if;
  if (select next_run_at from corvis_control.export_schedule where schedule_id = monthly) <> corvis_control.export_schedule_next_run_at('monthly', now()) then raise exception 'the claim moves the schedule to the next period'; end if;
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,monthly)) then raise exception 'a trigger is claimed once'; end if;
  if exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = monthly) then raise exception 'a claimed schedule is no longer due'; end if;

  -- A long outage (the schedule is more than a month overdue) is one run, for the current period, not one per missed period.
  update corvis_control.export_schedule set next_run_at = period_start - interval '40 days' where schedule_id = monthly;
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,monthly);
  if claimed.trigger_key <> expected_key then raise exception 'an outage yields one trigger for the current period: %', row_to_json(claimed); end if;
  if (select next_run_at from corvis_control.export_schedule where schedule_id = monthly) <> corvis_control.export_schedule_next_run_at('monthly', now()) then raise exception 'the claim moves the schedule past the outage'; end if;

  -- Once that period's run is recorded, the same overdue state yields nothing and still advances (the unique run key is the backstop).
  insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome,export_id)
  values (tenant,'a0850000-0000-4000-8000-0000000000b1',monthly,expected_key,'requested','a0850000-0000-4000-8000-0000000000f9');
  update corvis_control.export_schedule set next_run_at = period_start - interval '40 days' where schedule_id = monthly;
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,monthly)) then raise exception 'a trigger with a recorded run is only advanced past'; end if;
  if (select next_run_at from corvis_control.export_schedule where schedule_id = monthly) <> corvis_control.export_schedule_next_run_at('monthly', now()) then raise exception 'a recorded trigger still advances the schedule'; end if;

  -- Quarterly: the key names the quarter.
  update corvis_control.export_schedule set next_run_at = date_trunc('quarter', now() at time zone 'UTC') at time zone 'UTC' where schedule_id = quarterly;
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,quarterly);
  if claimed.trigger_key <> expected_quarter then raise exception 'the quarterly trigger names the quarter, got %', claimed.trigger_key; end if;

  -- An unknown schedule or another tenant claims nothing.
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,gen_random_uuid())) then raise exception 'an unknown schedule has nothing to claim'; end if;
  if exists (select 1 from corvis_control.claim_export_schedule_trigger('b0850000-0000-4000-8000-00000000000b',quarterly)) then raise exception 'another tenant cannot claim'; end if;
end $$;

-- 6. Publication triggers: coalesced, settled, scoped, tenant-bound, latest-version only.
do $$
declare
  tenant uuid := 'a0850000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0850000-0000-4000-8000-0000000000a1';
  position_scope jsonb := '{"positionFinancials":{"fundId":"fund-x","holdingId":"h-1","companyId":"company-1","periodicity":"quarterly"}}';
  by_fund uuid;
  by_snapshot uuid;
  by_other_fund uuid;
  claimed record;
begin
  by_fund := (select schedule_id from corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|owner','pub-fund',repeat('a', 64),'Fund X on publish',position_scope,'Position financials','csv','on_publish'));
  by_snapshot := (select schedule_id from corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|owner','pub-snap',repeat('b', 64),'Snapshot c1 on publish','{"snapshotId":"a0850000-0000-4000-8000-0000000000c1"}','Snapshot c1','csv','on_publish'));
  by_other_fund := (select schedule_id from corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|owner','pub-other',repeat('c', 64),'Fund Z on publish','{"positionFinancials":{"fundId":"fund-z","holdingId":"h","companyId":"c","periodicity":"annual"}}','Position financials','csv','on_publish'));

  -- Everything published before the schedule existed is history: nothing is due, whatever it matches.
  if exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id in (by_fund, by_snapshot, by_other_fund)) then raise exception 'publications before the schedule are never exported'; end if;
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,by_fund)) then raise exception 'nothing newer than the watermark: nothing to claim'; end if;

  -- The schedules were created "now"; move their watermarks back so that c1 v2 (-3h), c2 (-2h) and c3 (-90m) are new.
  update corvis_control.export_schedule set publish_watermark = now() - interval '4 hours' where schedule_id in (by_fund, by_snapshot, by_other_fund);
  if not exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = by_fund) then raise exception 'a matching publication makes the fund schedule due'; end if;
  if not exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = by_snapshot) then raise exception 'a new version of the snapshot makes the snapshot schedule due'; end if;
  if exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = by_other_fund) then raise exception 'a fund with no publication is not due; other funds and other tenants never match'; end if;

  -- The snapshot schedule matches only its own snapshot, and only the latest version (v2; superseded v1 is history).
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,by_snapshot);
  if claimed.trigger_key <> 'publish:a0850000-0000-4000-8000-0000000000c1:v2' or claimed.snapshot_version <> 2 or claimed.snapshot_id <> 'a0850000-0000-4000-8000-0000000000c1' then
    raise exception 'the snapshot schedule triggers on its own latest version: %', row_to_json(claimed);
  end if;
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,by_snapshot)) then raise exception 'a publication triggers once'; end if;

  -- The fund schedule coalesces the burst (c1 v2, c2, c3) into the newest: one trigger, c3.
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,by_fund);
  if claimed.trigger_key <> 'publish:a0850000-0000-4000-8000-0000000000c3:v1' then raise exception 'a burst coalesces into the newest publication: %', row_to_json(claimed); end if;
  if (select publish_watermark from corvis_control.export_schedule where schedule_id = by_fund) <> now() - interval '90 minutes' then raise exception 'the watermark moves to the publication handled'; end if;
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,by_fund)) then raise exception 'the coalesced publications are not triggered again'; end if;

  -- A publication that has not settled for a minute is not a trigger yet; once it settles it is.
  insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
  values (tenant,'a0850000-0000-4000-8000-0000000000c5','fund-x','2026-Q4',1,'published','1','1',now() - interval '10 seconds');
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,by_fund)) then raise exception 'a fresh publication has not settled'; end if;
  update corvis_consolidated.fund_period_snapshot set published_at = now() - interval '2 minutes' where snapshot_id = 'a0850000-0000-4000-8000-0000000000c5';
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,by_fund);
  if claimed.trigger_key <> 'publish:a0850000-0000-4000-8000-0000000000c5:v1' then raise exception 'a settled publication triggers: %', row_to_json(claimed); end if;

  -- A later version of the snapshot supersedes the one already handled, and is a new trigger.
  update corvis_consolidated.fund_period_snapshot set status = 'superseded' where snapshot_id = 'a0850000-0000-4000-8000-0000000000c1' and version = 2;
  insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
  values (tenant,'a0850000-0000-4000-8000-0000000000c1','fund-x','2026-Q1',3,'published','1','1',now() - interval '5 minutes');
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,by_snapshot);
  if claimed.trigger_key <> 'publish:a0850000-0000-4000-8000-0000000000c1:v3' then raise exception 'a new version of the snapshot is a new trigger: %', row_to_json(claimed); end if;

  -- A withdrawn newer version is not a publication, and leaves nothing to export.
  insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
  values (tenant,'a0850000-0000-4000-8000-0000000000c6','fund-x','2026-Q4',1,'draft','1','1',null);
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,by_fund)) then raise exception 'an unpublished snapshot is never a trigger'; end if;

  -- A trigger whose run already exists is only advanced past (the unique run key is the idempotency backstop).
  insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
  values (tenant,'a0850000-0000-4000-8000-0000000000c7','fund-x','2027-Q1',1,'published','1','1',now() - interval '90 seconds');
  insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome,failure_reason)
  values (tenant,gen_random_uuid(),by_fund,'publish:a0850000-0000-4000-8000-0000000000c7:v1','failed','owner_inactive');
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,by_fund)) then raise exception 'a recorded trigger is not returned'; end if;
  if (select publish_watermark from corvis_control.export_schedule where schedule_id = by_fund) <> now() - interval '90 seconds' then raise exception 'a recorded trigger still moves the watermark'; end if;

  -- Another tenant's schedule for the same fund id never sees tenant A's publications, and tenant A's never sees B's.
  perform corvis_control.create_export_schedule('b0850000-0000-4000-8000-00000000000b',gen_random_uuid(),'b0850000-0000-4000-8000-0000000000b1','oidc','idp|b-owner','pub-b',repeat('d', 64),'B fund X',position_scope,'Position financials','csv','on_publish');
  update corvis_control.export_schedule set publish_watermark = now() - interval '4 hours' where tenant_id = 'b0850000-0000-4000-8000-00000000000b';
  select * into claimed from corvis_control.claim_export_schedule_trigger('b0850000-0000-4000-8000-00000000000b',(select schedule_id from corvis_control.export_schedule where idempotency_key = 'pub-b'));
  if claimed.trigger_key <> 'publish:b0850000-0000-4000-8000-0000000000c9:v1' then raise exception 'tenant B sees only its own publication: %', row_to_json(claimed); end if;
end $$;

-- 6b. F1c: the performance scorecard is a schedulable scope. Unfiltered it names no fund and no snapshot (every
-- fund the owner is entitled to when a run is claimed); a fund filter makes it a fund schedule; a publication trigger can be
-- narrowed to the funds the owner holds now, and publications of any other fund are consumed without a trigger.
do $$
declare
  tenant uuid := 'a0850000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0850000-0000-4000-8000-0000000000a1';
  scorecard_all corvis_control.export_schedule%rowtype;
  scorecard_fund corvis_control.export_schedule%rowtype;
  scorecard_monthly corvis_control.export_schedule%rowtype;
  scorecard_replay corvis_control.export_schedule%rowtype;
  claimed record;
  newest_all timestamptz;
begin
  -- Saving: the marker, the optional filters, and what the row records.
  select * into scorecard_all from corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|owner','sc-all',repeat('a', 64),
    'Scorecard on publish','{"performanceScorecard":true}','Performance scorecard · all entitled funds','csv','on_publish');
  if scorecard_all.scope_fund_id is not null or scorecard_all.scope_snapshot_id is not null then raise exception 'an unfiltered scorecard names no fund and no snapshot: %', row_to_json(scorecard_all); end if;
  if scorecard_all.status <> 'active' or scorecard_all.publish_watermark is null or scorecard_all.next_run_at is not null then raise exception 'an on-publish scorecard schedule starts from a watermark: %', row_to_json(scorecard_all); end if;
  if not scorecard_all.notify_on_completion then raise exception 'the scorecard schedule keeps the default notification switch'; end if;
  select * into scorecard_fund from corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|owner','sc-fund',repeat('b', 64),
    'Scorecard fund-y on publish','{"performanceScorecard":true,"fundId":"fund-y","period":"Q1 2026"}','Performance scorecard · fund-y · Q1 2026','xlsx','on_publish',false);
  if scorecard_fund.scope_fund_id <> 'fund-y' or scorecard_fund.scope_snapshot_id is not null or scorecard_fund.notify_on_completion then raise exception 'a fund filter is the fund an on-publish trigger follows: %', row_to_json(scorecard_fund); end if;
  select * into scorecard_monthly from corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|owner','sc-monthly',repeat('c', 64),
    'Scorecard monthly','{"performanceScorecard":true,"period":"Q1 2026"}','Performance scorecard · all entitled funds · Q1 2026','parquet','monthly');
  if scorecard_monthly.next_run_at <> corvis_control.export_schedule_next_run_at('monthly', now()) or scorecard_monthly.scope_fund_id is not null then raise exception 'a calendar scorecard schedule starts at the next month start: %', row_to_json(scorecard_monthly); end if;
  select * into scorecard_replay from corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|owner','sc-all',repeat('a', 64),'ignored','{"performanceScorecard":true}','ignored','csv','on_publish');
  if scorecard_replay.schedule_id <> scorecard_all.schedule_id then raise exception 'the scorecard schedule is idempotent per owner'; end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-all',%L,'x','{"performanceScorecard":true,"fundId":"fund-x"}'::jsonb,'x','csv','on_publish')$f$,
    tenant,gen_random_uuid(),workspace,repeat('d', 64)), 'idempotency key reused with different export schedule');

  -- Validation: the marker must be the boolean true, nothing else may accompany it but the two filters, and each filter is a
  -- bounded, trimmed string.
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-1',%L,'x','{"performanceScorecard":false}'::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('1', 64)), 'export schedule scope is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-2',%L,'x','{"performanceScorecard":"true"}'::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('2', 64)), 'export schedule scope is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-3',%L,'x','{"performanceScorecard":true,"extra":1}'::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('3', 64)), 'export schedule scope is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-4',%L,'x','{"performanceScorecard":true,"snapshotId":"a0850000-0000-4000-8000-0000000000c3"}'::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('4', 64)), 'export schedule scope is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-5',%L,'x','{"performanceScorecard":true,"positionFinancials":{"fundId":"fund-x"}}'::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('5', 64)), 'export schedule scope is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-6',%L,'x','{"performanceScorecard":true,"fundId":""}'::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('6', 64)), 'export schedule scorecard filter is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-7',%L,'x','{"performanceScorecard":true,"fundId":7}'::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('7', 64)), 'export schedule scorecard filter is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-8',%L,'x','{"performanceScorecard":true,"fundId":" fund-x"}'::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('8', 64)), 'export schedule scorecard filter is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-9',%L,'x',%L::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('9', 64), jsonb_build_object('performanceScorecard', true, 'fundId', repeat('f', 513))), 'export schedule scorecard filter is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-10',%L,'x','{"performanceScorecard":true,"period":""}'::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('a', 64)), 'export schedule scorecard filter is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-11',%L,'x','{"performanceScorecard":true,"period":null}'::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('b', 64)), 'export schedule scorecard filter is invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-bad-12',%L,'x',%L::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('c', 64), jsonb_build_object('performanceScorecard', true, 'period', repeat('p', 65))), 'export schedule scorecard filter is invalid');
  -- The bounds themselves are accepted.
  perform corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|owner','sc-edge',repeat('e', 64),'Edge',
    jsonb_build_object('performanceScorecard', true, 'fundId', repeat('f', 512), 'period', repeat('p', 64)),'Performance scorecard','csv','monthly');
  -- The earlier scopes are validated exactly as before (a scorecard marker is not a way around them).
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_export_schedule(%L,%L,%L,'oidc','idp|owner','sc-old-1',%L,'x','{}'::jsonb,'x','csv','monthly')$f$,
    tenant,gen_random_uuid(),workspace,repeat('d', 64)), 'export schedule scope is invalid');

  -- The table: a schedule names exactly one of snapshot or fund, or is a scorecard scope that names neither.
  perform pg_temp.expect_error(format($f$insert into corvis_control.export_schedule (tenant_id,schedule_id,workspace_id,owner_auth_method,owner_subject,idempotency_key,request_hash,label,scope,scope_label,format,trigger_kind,status,next_run_at,status_changed_by)
    values (%L,gen_random_uuid(),%L,'oidc','idp|owner','direct-1',%L,'x','{"snapshotId":"a0850000-0000-4000-8000-0000000000c3"}','x','csv','monthly','active',now() + interval '1 day','x')$f$,
    tenant,workspace,repeat('1', 64)), 'export_schedule_scope_target_check');
  perform pg_temp.expect_error(format($f$insert into corvis_control.export_schedule (tenant_id,schedule_id,workspace_id,owner_auth_method,owner_subject,idempotency_key,request_hash,label,scope,scope_label,scope_snapshot_id,scope_fund_id,format,trigger_kind,status,next_run_at,status_changed_by)
    values (%L,gen_random_uuid(),%L,'oidc','idp|owner','direct-2',%L,'x','{"performanceScorecard":true}','x','a0850000-0000-4000-8000-0000000000c3','fund-x','csv','monthly','active',now() + interval '1 day','x')$f$,
    tenant,workspace,repeat('2', 64)), 'export_schedule_scope_target_check');
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'corvis_control' and p.proname in ('create_export_schedule','claim_export_schedule_trigger','export_schedule_latest_publication')) <> 3 then
    raise exception 'the scorecard functions replace the earlier ones; they are not overloaded beside them';
  end if;

  -- Publication triggers. Tenant A has published: c1 v3 and c2, c3, c5, c7 (fund-x) and c4 (fund-y), all settled.
  update corvis_control.export_schedule set publish_watermark = now() - interval '10 hours' where schedule_id in (scorecard_all.schedule_id, scorecard_fund.schedule_id);
  if not exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = scorecard_all.schedule_id) then raise exception 'any publication of the tenant makes an all-funds scorecard due (the coarse hint)'; end if;
  if not exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = scorecard_fund.schedule_id) then raise exception 'a publication of the filtered fund makes the fund scorecard due'; end if;
  if exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = scorecard_monthly.schedule_id) then raise exception 'a calendar scorecard is not due before its period'; end if;

  -- Narrowed to the funds the owner holds now: only those publications are triggers, the newest of them, once.
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,scorecard_all.schedule_id,'["fund-y"]'::jsonb);
  if claimed.trigger_key <> 'publish:a0850000-0000-4000-8000-0000000000c4:v1' then raise exception 'only a publication of an entitled fund is a trigger: %', row_to_json(claimed); end if;
  if (select publish_watermark from corvis_control.export_schedule where schedule_id = scorecard_all.schedule_id) <> now() - interval '80 minutes' then raise exception 'the watermark moves to the publication handled'; end if;

  -- The remaining publications are of fund-x, which this owner does not hold: the coarse hint still lists the schedule, but they
  -- are not triggers, are consumed (the schedule is no longer listed as due for them) and record nothing. An entitled
  -- publication triggers once: the claim that follows finds nothing further.
  select max(published_at) into newest_all from corvis_consolidated.fund_period_snapshot where tenant_id = tenant and status = 'published';
  if not exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = scorecard_all.schedule_id) then raise exception 'the coarse hint still lists the schedule'; end if;
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,scorecard_all.schedule_id,'["fund-y"]'::jsonb)) then raise exception 'a publication of an unentitled fund is never a trigger, and an entitled one triggers once'; end if;
  if (select publish_watermark from corvis_control.export_schedule where schedule_id = scorecard_all.schedule_id) <> newest_all then raise exception 'unentitled publications are consumed up to the newest one'; end if;
  if exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = scorecard_all.schedule_id) then raise exception 'a consumed publication does not keep the schedule due'; end if;
  if exists (select 1 from corvis_control.export_schedule_run r where r.schedule_id = scorecard_all.schedule_id) then raise exception 'consuming an unentitled publication records no run, so the owner never learns of it'; end if;

  -- A fund the owner holds that publishes later is a trigger again; a fund they hold that did publish earlier is history.
  insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
  values (tenant,'a0850000-0000-4000-8000-0000000000c8','fund-y','2026-Q2',1,'published','1','1',now() - interval '70 seconds');
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,scorecard_all.schedule_id,'["fund-x","fund-y"]'::jsonb);
  if claimed.trigger_key <> 'publish:a0850000-0000-4000-8000-0000000000c8:v1' then raise exception 'a later publication of a held fund is a trigger: %', row_to_json(claimed); end if;

  -- Without the owner's funds (the application could not narrow: no funds held, or the owner could not be authorized) the claim is
  -- the coarse one, so the run is still claimed and the refusal is recorded for the owner to see.
  update corvis_control.export_schedule set publish_watermark = now() - interval '10 hours' where schedule_id = scorecard_all.schedule_id;
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,scorecard_all.schedule_id);
  if claimed.trigger_key <> 'publish:a0850000-0000-4000-8000-0000000000c8:v1' then raise exception 'without funds the claim matches any publication of the tenant: %', row_to_json(claimed); end if;
  update corvis_control.export_schedule set publish_watermark = now() - interval '10 hours' where schedule_id = scorecard_all.schedule_id;
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,scorecard_all.schedule_id,null);
  if claimed.trigger_key <> 'publish:a0850000-0000-4000-8000-0000000000c8:v1' then raise exception 'a null fund list is not a narrowing: %', row_to_json(claimed); end if;

  -- An empty list is a narrowing to nothing: nothing triggers and everything is consumed.
  update corvis_control.export_schedule set publish_watermark = now() - interval '10 hours' where schedule_id = scorecard_all.schedule_id;
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,scorecard_all.schedule_id,'[]'::jsonb)) then raise exception 'an empty fund list matches nothing'; end if;
  if exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id = scorecard_all.schedule_id) then raise exception 'and consumes what it skipped'; end if;

  -- A scorecard with a fund filter follows that fund whatever the application passes: it never widens to other funds.
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,scorecard_fund.schedule_id,'["fund-x"]'::jsonb);
  if claimed.trigger_key <> 'publish:a0850000-0000-4000-8000-0000000000c8:v1' then raise exception 'a fund-filtered scorecard follows its own fund: %', row_to_json(claimed); end if;

  -- Another tenant's publications never trigger tenant A's all-funds scorecard, and the reverse.
  perform corvis_control.create_export_schedule('b0850000-0000-4000-8000-00000000000b',gen_random_uuid(),'b0850000-0000-4000-8000-0000000000b1','oidc','idp|b-owner','sc-b',repeat('f', 64),'B scorecard','{"performanceScorecard":true}','Performance scorecard','csv','on_publish');
  update corvis_control.export_schedule set publish_watermark = now() - interval '10 hours' where idempotency_key = 'sc-b';
  select * into claimed from corvis_control.claim_export_schedule_trigger('b0850000-0000-4000-8000-00000000000b',(select schedule_id from corvis_control.export_schedule where idempotency_key = 'sc-b'),'["fund-x"]'::jsonb);
  if claimed.trigger_key <> 'publish:b0850000-0000-4000-8000-0000000000c9:v1' then raise exception 'tenant B sees only its own publication: %', row_to_json(claimed); end if;

  -- A calendar scorecard is claimed like any calendar schedule, whatever funds are passed.
  update corvis_control.export_schedule set next_run_at = now() - interval '1 minute' where schedule_id = scorecard_monthly.schedule_id;
  select * into claimed from corvis_control.claim_export_schedule_trigger(tenant,scorecard_monthly.schedule_id,'["fund-y"]'::jsonb);
  if claimed.trigger_key <> 'monthly:' || to_char(now() at time zone 'UTC', 'YYYY-MM') then raise exception 'a calendar scorecard runs on its period: %', row_to_json(claimed); end if;
end $$;

-- 7. Runs: unique per trigger, consistent outcomes, append-only.
do $$
declare
  tenant uuid := 'a0850000-0000-4000-8000-00000000000a';
  monthly uuid := (select schedule_id from corvis_control.export_schedule where idempotency_key = 'key-1' and owner_subject = 'idp|owner');
  a_run uuid := (select run_id from corvis_control.export_schedule_run where schedule_id = monthly);
begin
  perform pg_temp.expect_error(format($f$insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome,export_id) select tenant_id,gen_random_uuid(),schedule_id,trigger_key,'requested',gen_random_uuid() from corvis_control.export_schedule_run where run_id = %L$f$, a_run), 'duplicate key value violates unique constraint');
  perform pg_temp.expect_error(format($f$insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome) values (%L,gen_random_uuid(),%L,'monthly:1999-01','requested')$f$, tenant, monthly), 'violates check constraint');
  perform pg_temp.expect_error(format($f$insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome) values (%L,gen_random_uuid(),%L,'monthly:1999-02','failed')$f$, tenant, monthly), 'violates check constraint');
  perform pg_temp.expect_error(format($f$insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome,failure_reason) values (%L,gen_random_uuid(),%L,'monthly:1999-03','failed','because')$f$, tenant, monthly), 'violates check constraint');
  perform pg_temp.expect_error(format($f$insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome,export_id,failure_reason) values (%L,gen_random_uuid(),%L,'monthly:1999-04','requested',gen_random_uuid(),'owner_inactive')$f$, tenant, monthly), 'violates check constraint');
  perform pg_temp.expect_error(format($f$insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome,failure_reason) values (%L,gen_random_uuid(),gen_random_uuid(),'monthly:1999-05','failed','owner_inactive')$f$, tenant), 'violates foreign key constraint');
  perform pg_temp.expect_error(format($f$update corvis_control.export_schedule_run set outcome = 'failed' where run_id = %L$f$, a_run), 'export schedule run history is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_control.export_schedule_run where run_id = %L$f$, a_run), 'export schedule run history is append-only');
  perform pg_temp.expect_error('truncate corvis_control.export_schedule_run', 'export schedule run history is append-only');
end $$;

-- 8. Owners who are deactivated stop their schedules automatically, and only they do.
do $$
declare
  tenant uuid := 'a0850000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0850000-0000-4000-8000-0000000000a1';
  position_scope jsonb := '{"positionFinancials":{"fundId":"fund-y","holdingId":"h-1","companyId":"company-1","periodicity":"annual"}}';
  leaver_active uuid;
  leaver_paused uuid;
  moved_schedule uuid;
  stopped_count integer;
  stopped corvis_control.export_schedule%rowtype;
begin
  leaver_active := (select schedule_id from corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|leaver','l-1',repeat('a', 64),'Leaver monthly',position_scope,'Position financials','csv','monthly'));
  leaver_paused := (select schedule_id from corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|leaver','l-2',repeat('b', 64),'Leaver on publish',position_scope,'Position financials','csv','on_publish'));
  perform corvis_control.set_export_schedule_status(tenant,leaver_paused,'oidc','idp|leaver','pause');
  moved_schedule := (select schedule_id from corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|moved','m-1',repeat('c', 64),'Moved quarterly',position_scope,'Position financials','csv','quarterly'));

  -- Nobody is deactivated: nothing stops.
  if exists (select 1 from corvis_control.stop_export_schedules_for_inactive_owners()) then raise exception 'active owners keep their schedules'; end if;

  update corvis_control.identity_subject set status = 'disabled', disabled_at = now() where subject = 'idp|leaver' and tenant_id = tenant;
  update corvis_control.membership set status = 'revoked' where user_id = 'a0850000-0000-4000-8000-0000000000e4';
  select count(*) into stopped_count from corvis_control.stop_export_schedules_for_inactive_owners();
  if stopped_count <> 3 then raise exception 'a disabled identity (active and paused schedules) and an ended membership stop 3 schedules, stopped %', stopped_count; end if;
  for stopped in select * from corvis_control.export_schedule where schedule_id in (leaver_active, leaver_paused, moved_schedule) loop
    if stopped.status <> 'stopped' or stopped.stop_reason <> 'owner_inactive' or stopped.next_run_at is not null or stopped.publish_watermark is not null or stopped.status_changed_by <> 'system:export-scheduler' then
      raise exception 'a deactivated owner stops the schedule for good: %', row_to_json(stopped);
    end if;
  end loop;
  if (select count(*) from corvis_control.export_schedule where owner_subject in ('idp|owner','idp|other') and status in ('active','paused','deleted')) < 1 then raise exception 'other owners are untouched'; end if;
  if exists (select 1 from corvis_control.export_schedule where owner_subject = 'idp|owner' and status = 'stopped') then raise exception 'an active owner is never stopped'; end if;
  if exists (select 1 from corvis_control.stop_export_schedules_for_inactive_owners()) then raise exception 'stopping is idempotent'; end if;

  -- Stopped is final: never due, cannot be resumed (not even if the owner comes back), can still be deleted.
  if exists (select 1 from corvis_control.claim_export_schedule_trigger(tenant,leaver_active)) then raise exception 'a stopped schedule has nothing to claim'; end if;
  if exists (select 1 from corvis_control.list_due_export_schedules(100) d where d.schedule_id in (leaver_active, leaver_paused, moved_schedule)) then raise exception 'a stopped schedule is never due'; end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_export_schedule_status(%L,%L,'oidc','idp|leaver','resume')$f$, tenant, leaver_active), 'export schedule transition not allowed');
  perform pg_temp.expect_error(format($f$update corvis_control.export_schedule set status = 'active', stop_reason = null, next_run_at = now() where schedule_id = %L$f$, leaver_active), 'export schedule is stopped');
  if (select status from corvis_control.set_export_schedule_status(tenant,leaver_active,'oidc','idp|leaver','delete')) <> 'deleted' then raise exception 'a stopped schedule can be deleted'; end if;

  -- The single-schedule stop (the worker found the owner unauthorizable at run time) is idempotent and leaves deleted alone.
  update corvis_control.identity_subject set status = 'active', disabled_at = null where subject = 'idp|leaver' and tenant_id = tenant;
  update corvis_control.membership set status = 'active' where user_id = 'a0850000-0000-4000-8000-0000000000e4';
  if exists (select 1 from corvis_control.stop_export_schedule(tenant,leaver_active)) then raise exception 'a deleted schedule is not stopped'; end if;
  if exists (select 1 from corvis_control.stop_export_schedule(tenant,leaver_paused)) then raise exception 'an already stopped schedule is not stopped again'; end if;
  if exists (select 1 from corvis_control.stop_export_schedule(tenant,gen_random_uuid())) then raise exception 'an unknown schedule is not found'; end if;
  perform corvis_control.create_export_schedule(tenant,'a0850000-0000-4000-8000-0000000000f5',workspace,'oidc','idp|owner','one-more',repeat('d', 64),'To stop',position_scope,'Position financials','csv','monthly');
  select * into stopped from corvis_control.stop_export_schedule(tenant,'a0850000-0000-4000-8000-0000000000f5');
  if stopped.status <> 'stopped' or stopped.stop_reason <> 'owner_inactive' then raise exception 'the application can stop one schedule: %', row_to_json(stopped); end if;
end $$;

-- 8b. F4b: the owner's notification switch, the run webhook events and the F2 category.
do $$
declare
  tenant constant uuid := 'a0850000-0000-4000-8000-00000000000a';
  other_tenant constant uuid := 'b0850000-0000-4000-8000-00000000000b';
  workspace constant uuid := 'a0850000-0000-4000-8000-0000000000a1';
  position_scope constant jsonb := '{"positionFinancials":{"fundId":"fund-x","holdingId":"h-1","companyId":"c-1","periodicity":"quarterly"}}';
  loud uuid := gen_random_uuid();
  quiet uuid := gen_random_uuid();
  schedule corvis_control.export_schedule%rowtype;
  run_ok uuid := gen_random_uuid();
  run_refused uuid := gen_random_uuid();
  run_lost uuid := gen_random_uuid();
  emitted uuid;
  payload jsonb;
  before_updated timestamptz;
begin
  -- The switch is on by default (every schedule that existed before 090 was notified), and chosen at creation.
  select * into schedule from corvis_control.create_export_schedule(tenant,loud,workspace,'oidc','idp|owner','n-loud',repeat('e', 64),'Loud',position_scope,'Position financials','csv','monthly');
  if schedule.notify_on_completion is not true then raise exception 'emails about a schedule are on unless the owner says otherwise'; end if;
  select * into schedule from corvis_control.create_export_schedule(tenant,quiet,workspace,'oidc','idp|owner','n-quiet',repeat('f', 64),'Quiet',position_scope,'Position financials','csv','monthly',false);
  if schedule.notify_on_completion is not false then raise exception 'the owner can opt a schedule out at creation'; end if;
  if (select notify_on_completion from corvis_control.create_export_schedule(tenant,gen_random_uuid(),workspace,'oidc','idp|owner','n-quiet',repeat('f', 64),'Quiet',position_scope,'Position financials','csv','monthly',false)) is not false then
    raise exception 'a replay returns the original schedule';
  end if;

  -- Only the owner changes it, in their own tenant; nothing else about the schedule moves.
  select * into schedule from corvis_control.set_export_schedule_notification(tenant,loud,'oidc','idp|owner',false);
  if schedule.notify_on_completion is not false or schedule.status <> 'active' or schedule.status_changed_by <> 'idp|owner' then raise exception 'the owner switches emails off: %', row_to_json(schedule); end if;
  before_updated := schedule.updated_at;
  perform pg_sleep(0.01);
  select * into schedule from corvis_control.set_export_schedule_notification(tenant,loud,'oidc','idp|owner',false);
  if schedule.updated_at is distinct from before_updated then raise exception 'setting the value it already has changes nothing'; end if;
  select * into schedule from corvis_control.set_export_schedule_notification(tenant,loud,'oidc','idp|owner',true);
  if schedule.notify_on_completion is not true then raise exception 'the owner switches emails back on'; end if;
  if exists (select 1 from corvis_control.set_export_schedule_notification(tenant,loud,'oidc','idp|other',false)) then raise exception 'a colleague cannot change the switch'; end if;
  if exists (select 1 from corvis_control.set_export_schedule_notification(tenant,loud,'saml','idp|owner',false)) then raise exception 'the same subject under another auth method is another person'; end if;
  if exists (select 1 from corvis_control.set_export_schedule_notification(other_tenant,loud,'oidc','idp|owner',false)) then raise exception 'another tenant cannot change the switch'; end if;
  if exists (select 1 from corvis_control.set_export_schedule_notification(tenant,gen_random_uuid(),'oidc','idp|owner',false)) then raise exception 'an unknown schedule is not found'; end if;
  if (select notify_on_completion from corvis_control.export_schedule where schedule_id = loud) is not true then raise exception 'refused changes leave the switch alone'; end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_export_schedule_notification(%L,%L,'oidc','idp|owner',null)$f$, tenant, loud), 'export schedule notification setting is required');
  -- The guard on a schedule's content still holds beside the new workflow column.
  perform pg_temp.expect_error(format($f$update corvis_control.export_schedule set label = 'Renamed', notify_on_completion = false where schedule_id = %L$f$, loud), 'export schedule content is immutable');
  perform corvis_control.set_export_schedule_status(tenant,quiet,'oidc','idp|owner','delete');
  if exists (select 1 from corvis_control.set_export_schedule_notification(tenant,quiet,'oidc','idp|owner',true)) then raise exception 'a deleted schedule has no switch to change'; end if;

  -- Runs: one accepted (requested) and one refused (failed, fail-closed).
  insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome,export_id)
  values (tenant,run_ok,loud,'monthly:2031-01','requested',gen_random_uuid());
  insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome,failure_reason)
  values (tenant,run_refused,loud,'monthly:2031-02','failed','redistribution_not_permitted'),
         (tenant,run_lost,loud,'monthly:2031-03','failed','owner_inactive');

  -- Completion: one event per run, carrying ids and the label only.
  emitted := corvis_control.emit_export_schedule_run_event(tenant,run_ok,'completed');
  if emitted is null then raise exception 'a requested run completes with one event'; end if;
  select e.payload into payload from corvis_control.outbox_event e where e.event_id = emitted and e.event_type = 'ExportScheduleRunCompleted' and e.aggregate_type = 'export_schedule_run' and e.aggregate_id = run_ok::text and e.tenant_id = tenant;
  if payload is null then raise exception 'the completion event is on the outbox for the run'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(payload) k) <> array['exportId','runId','scheduleId','scheduleLabel'] then raise exception 'the completion payload is ids and the label only: %', payload; end if;
  if payload->>'scheduleId' <> loud::text or payload->>'scheduleLabel' <> 'Loud' or payload->>'runId' <> run_ok::text then raise exception 'the payload names the schedule and the run: %', payload; end if;
  if corvis_control.emit_export_schedule_run_event(tenant,run_ok,'completed') is not null or corvis_control.emit_export_schedule_run_event(tenant,run_ok,'failed','export_failed') is not null then
    raise exception 'a run ends in one event, however often it is announced';
  end if;

  -- Failure: a refusal carries its closed reason code (and no export); an export that could not be delivered is export_failed.
  emitted := corvis_control.emit_export_schedule_run_event(tenant,run_refused,'failed');
  select e.payload into payload from corvis_control.outbox_event e where e.event_id = emitted and e.event_type = 'ExportScheduleRunFailed' and e.tenant_id = tenant;
  if (select array_agg(k order by k) from jsonb_object_keys(payload) k) <> array['failureReason','runId','scheduleId','scheduleLabel'] or payload->>'failureReason' <> 'redistribution_not_permitted' then
    raise exception 'the refusal payload is ids, the label and the reason code: %', payload;
  end if;
  emitted := corvis_control.emit_export_schedule_run_event(tenant,run_lost,'failed','owner_inactive');
  if (select e.payload->>'failureReason' from corvis_control.outbox_event e where e.event_id = emitted) <> 'owner_inactive' then raise exception 'fail-closed refusals such as owner_inactive are announced'; end if;
  insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome,export_id)
  values (tenant,'a0850000-0000-4000-8000-0000000000f6',loud,'monthly:2031-04','requested','a0850000-0000-4000-8000-0000000000f7');
  emitted := corvis_control.emit_export_schedule_run_event(tenant,'a0850000-0000-4000-8000-0000000000f6','failed','export_failed');
  select e.payload into payload from corvis_control.outbox_event e where e.event_id = emitted;
  if payload->>'failureReason' <> 'export_failed' or payload->>'exportId' <> 'a0850000-0000-4000-8000-0000000000f7' then raise exception 'an accepted export that failed to deliver is a failure: %', payload; end if;

  -- Refusals of the function itself.
  if corvis_control.emit_export_schedule_run_event(tenant,gen_random_uuid(),'completed') is not null then raise exception 'an unknown run announces nothing'; end if;
  if corvis_control.emit_export_schedule_run_event(other_tenant,run_ok,'failed') is not null then raise exception 'another tenant announces nothing for the run'; end if;
  perform pg_temp.expect_error(format($f$select corvis_control.emit_export_schedule_run_event(%L,%L,'cancelled')$f$, tenant, run_ok), 'outcome is invalid');
  perform pg_temp.expect_error(format($f$select corvis_control.emit_export_schedule_run_event(%L,%L,'failed','a free text reason')$f$, tenant, run_refused), 'reason is invalid');
  insert into corvis_control.export_schedule_run (tenant_id,run_id,schedule_id,trigger_key,outcome,failure_reason)
  values (tenant,'a0850000-0000-4000-8000-0000000000f8',loud,'monthly:2031-05','failed','scope_unavailable');
  perform pg_temp.expect_error(format($f$select corvis_control.emit_export_schedule_run_event(%L,'a0850000-0000-4000-8000-0000000000f8','completed')$f$, tenant), 'a refused export schedule run cannot complete');
  if exists (select 1 from corvis_control.outbox_event e where e.aggregate_id = 'a0850000-0000-4000-8000-0000000000f8') then raise exception 'a refused completion leaves no event'; end if;

  -- The webhook allow-list accepts the two new events and nothing else new; an unknown event is still refused.
  insert into corvis_control.webhook_subscription (tenant_id,webhook_id,endpoint_url,event_types,status,created_by)
  values (tenant,gen_random_uuid(),'https://hooks.example.test/corvis',array['ExportScheduleRunCompleted','ExportScheduleRunFailed','ExportRequested'],'active','idp|owner');
  perform pg_temp.expect_error(format($f$insert into corvis_control.webhook_subscription (tenant_id,webhook_id,endpoint_url,event_types,status,created_by) values (%L,gen_random_uuid(),'https://hooks.example.test/x',array['ExportScheduleRunDeleted'],'active','idp|owner')$f$, tenant), 'webhook_subscription_customer_event_types');
  perform pg_temp.expect_error(format($f$insert into corvis_control.webhook_subscription (tenant_id,webhook_id,endpoint_url,event_types,status,created_by) values (%L,gen_random_uuid(),'https://hooks.example.test/y',array[]::text[],'active','idp|owner')$f$, tenant), 'webhook_subscription_customer_event_types');

  -- The F2 category is accepted by the outbox and as a preference, and a made-up one still is not.
  insert into corvis_control.email_outbox (tenant_id,category,recipient_user_id,workspace_id,template_params,dedupe_key)
  values (tenant,'export_schedule_failed','a0850000-0000-4000-8000-0000000000e1',workspace,'{"reason":"owner_inactive"}','export_schedule_failed:' || run_refused::text);
  insert into corvis_control.notification_preference (tenant_id,user_id,category,enabled,delivery)
  values (tenant,'a0850000-0000-4000-8000-0000000000e1','export_schedule_failed',false,'immediate');
  perform pg_temp.expect_error(format($f$insert into corvis_control.email_outbox (tenant_id,category,recipient_user_id,workspace_id,template_params,dedupe_key) values (%L,'export_schedule_exploded','a0850000-0000-4000-8000-0000000000e1',%L,'{}','x-1')$f$, tenant, workspace), 'email_outbox_category_check');
  -- The earlier categories (including 087's mandatory security notice) were not lost when the check was rebuilt.
  insert into corvis_control.email_outbox (tenant_id,category,recipient_user_id,workspace_id,template_params,dedupe_key)
  select tenant,c,'a0850000-0000-4000-8000-0000000000e1',workspace,'{}','keep:' || c
  from unnest(array['invitation','export_ready','pinned_fund_published','source_attention','support_access','role_changed','digest','data_issue_update','review_discussion','security_policy']) c;
end $$;

-- 9. RLS: enabled and forced, no client policy, and a non-owner role without BYPASSRLS reads nothing.
do $$
declare
  offenders text;
begin
  select string_agg(c.relname, ', ') into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'corvis_control' and c.relname in ('export_schedule','export_schedule_run') and not (c.relrowsecurity and c.relforcerowsecurity);
  if offenders is not null then raise exception 'RLS must be enabled and forced on %', offenders; end if;
  if exists (select 1 from pg_policies where schemaname = 'corvis_control' and policyname <> 'corvis_runtime_service' and tablename in ('export_schedule','export_schedule_run')) then
    raise exception 'export schedule tables are server-managed: no client policy may exist';
  end if;
end $$;

drop role if exists corvis_export_schedule_negative_role;
create role corvis_export_schedule_negative_role nologin nosuperuser nobypassrls noinherit;
grant usage on schema corvis_control to corvis_export_schedule_negative_role;
grant select on corvis_control.export_schedule, corvis_control.export_schedule_run to corvis_export_schedule_negative_role;
set role corvis_export_schedule_negative_role;
do $$
begin
  set local request.jwt.claim.sub = 'a0850000-0000-4000-8000-0000000000e1';
  if (select count(*) from corvis_control.export_schedule) <> 0 or (select count(*) from corvis_control.export_schedule_run) <> 0 then
    raise exception 'a non-owner role must not read schedules or their runs, even as the owner';
  end if;
end $$;
reset role;
drop owned by corvis_export_schedule_negative_role;
drop role corvis_export_schedule_negative_role;

rollback;
