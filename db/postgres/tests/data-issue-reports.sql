-- Acceptance for migration 083 (F5, #261): customer data-issue reports on published figures.
--
-- Proves, against the real SQL functions on an isolated disposable database:
--   * reporting is idempotent per reporter and writes only the case and its history row: no snapshot, observation,
--     correction incident or outbox change (reporting never changes data or publication state);
--   * the received -> investigating -> corrected | no_change machine, its guards, and the link to the governed
--     correction (022): a corrected case exposes the replacement snapshot id and version, and resolving the
--     correction closes every linked investigating case exactly once;
--   * report content and history are immutable, and tenants are isolated;
--   * RLS is enabled and forced with no client policy, so a role without BYPASSRLS reads nothing;
--   * the new notification category is accepted by the outbox and preference tables.
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
values ('a0830000-0000-4000-8000-00000000000a','data-issue-a','Data Issue A'),
       ('b0830000-0000-4000-8000-00000000000b','data-issue-b','Data Issue B');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name)
values ('a0830000-0000-4000-8000-0000000000a1','a0830000-0000-4000-8000-00000000000a','primary','A primary'),
       ('b0830000-0000-4000-8000-0000000000b1','b0830000-0000-4000-8000-00000000000b','primary','B primary');
insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject,status)
values ('a0830000-0000-4000-8000-00000000000a','a0830000-0000-4000-8000-0000000000e1','oidc','idp|reporter-a','active'),
       ('a0830000-0000-4000-8000-00000000000a','a0830000-0000-4000-8000-0000000000e2','oidc','idp|other-reporter','active');

-- A published figure (v1), its replacement (a separate published snapshot for the same fund-period), and a snapshot of
-- another fund, all in tenant A; tenant B has its own published snapshot.
insert into corvis_consolidated.fund_period_snapshot
  (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
values
  ('a0830000-0000-4000-8000-00000000000a','a0830000-0000-4000-8000-0000000000c1','f5-fund','2026-Q2',1,'published','1','1',now()),
  ('a0830000-0000-4000-8000-00000000000a','a0830000-0000-4000-8000-0000000000c2','f5-fund','2026-Q2',1,'published','1','1',now()),
  ('a0830000-0000-4000-8000-00000000000a','a0830000-0000-4000-8000-0000000000c3','f5-other-fund','2026-Q2',1,'published','1','1',now()),
  ('b0830000-0000-4000-8000-00000000000b','b0830000-0000-4000-8000-0000000000c1','f5-fund','2026-Q2',1,'published','1','1',now());

create temporary table f5_before on commit drop as
select
  (select count(*) from corvis_consolidated.fund_period_snapshot) as snapshots,
  (select md5(string_agg(s::text, '|' order by s.tenant_id, s.snapshot_id, s.version)) from corvis_consolidated.fund_period_snapshot s) as snapshot_digest,
  (select count(*) from corvis_consolidated.snapshot_publication_event) as publication_events,
  (select count(*) from corvis_control.data_correction_incident) as incidents,
  (select count(*) from corvis_control.outbox_event) as outbox_events,
  (select count(*) from corvis_control.processing_job) as jobs;

-- 1. Reporting: idempotent, scoped, inert.
do $$
declare
  tenant uuid := 'a0830000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0830000-0000-4000-8000-0000000000a1';
  snap uuid := 'a0830000-0000-4000-8000-0000000000c1';
  first_case corvis_control.data_issue_case%rowtype;
  replay corvis_control.data_issue_case%rowtype;
  other corvis_control.data_issue_case%rowtype;
  hash text := repeat('a', 64);
begin
  select * into first_case from corvis_control.report_data_issue(tenant,'a0830000-0000-4000-8000-0000000000d1',workspace,'oidc','idp|reporter-a',
    'key-1',hash,'review','f5-fund','F5 Fund','company-1','ABC Corp','revenue','Revenue','2026-Q2',snap,1,'  The revenue looks too high.  ');
  if first_case.status <> 'received' or first_case.routed_to <> 'data_operations' then raise exception 'new case must be received and routed to data operations: %', row_to_json(first_case); end if;
  if first_case.comment <> 'The revenue looks too high.' then raise exception 'comment must be trimmed, got %', first_case.comment; end if;
  if first_case.reporter_user_id <> 'a0830000-0000-4000-8000-0000000000e1' then raise exception 'reporter user must resolve from the active identity, got %', first_case.reporter_user_id; end if;
  if first_case.reporter_seen_status <> 'received' or first_case.replacement_snapshot_id is not null or first_case.correction_incident_id is not null then
    raise exception 'new case must have nothing to see and no correction: %', row_to_json(first_case);
  end if;
  if (select count(*) from corvis_control.data_issue_case_event where case_id = first_case.case_id and from_status is null and to_status = 'received') <> 1 then
    raise exception 'creation must record exactly one history row';
  end if;

  -- Same reporter, same key, same content: the original case comes back and nothing is added.
  select * into replay from corvis_control.report_data_issue(tenant,'a0830000-0000-4000-8000-0000000000d9',workspace,'oidc','idp|reporter-a',
    'key-1',hash,'review','f5-fund','F5 Fund','company-1','ABC Corp','revenue','Revenue','2026-Q2',snap,1,'ignored');
  if replay.case_id <> first_case.case_id then raise exception 'replay must return the original case, got %', replay.case_id; end if;
  if (select count(*) from corvis_control.data_issue_case where tenant_id = tenant) <> 1 then raise exception 'replay must not create a second case'; end if;

  -- Same key, different content is refused; another reporter may reuse the key text for its own case.
  perform pg_temp.expect_error(format($f$select * from corvis_control.report_data_issue(%L,%L,%L,'oidc','idp|reporter-a','key-1',%L,'review','f5-fund',null,null,null,null,null,'2026-Q2',null,null,'x')$f$,
    tenant,'a0830000-0000-4000-8000-0000000000da',workspace,repeat('b', 64)), 'idempotency key reused with different data issue report');
  select * into other from corvis_control.report_data_issue(tenant,'a0830000-0000-4000-8000-0000000000d2',workspace,'oidc','idp|other-reporter',
    'key-1',repeat('c', 64),'overview','f5-fund',null,null,null,null,null,'2026-Q2',null,null,'Numbers differ from my records.');
  if other.case_id = first_case.case_id then raise exception 'idempotency keys are per reporter'; end if;
  if other.reporter_user_id <> 'a0830000-0000-4000-8000-0000000000e2' then raise exception 'second reporter must resolve its own user'; end if;

  -- A reporter with no identity row still reports (in-app only): no user id, so no email later.
  if (select reporter_user_id from corvis_control.report_data_issue(tenant,'a0830000-0000-4000-8000-0000000000d3',workspace,'service_account','svc|ingest',
    'key-svc',repeat('d', 64),'position_financials','f5-fund',null,null,null,null,null,'2026-Q2',null,null,'Service report.')) is not null then
    raise exception 'a reporter without an identity row has no user id';
  end if;

  -- The snapshot named must exist in this tenant for this fund (and version).
  perform pg_temp.expect_error(format($f$select * from corvis_control.report_data_issue(%L,%L,%L,'oidc','idp|reporter-a','key-2',%L,'review','f5-fund',null,null,null,null,null,'2026-Q2',%L,1,'x')$f$,
    tenant,'a0830000-0000-4000-8000-0000000000db',workspace,repeat('e', 64),'a0830000-0000-4000-8000-0000000000c3'), 'data issue snapshot not found for fund');
  perform pg_temp.expect_error(format($f$select * from corvis_control.report_data_issue(%L,%L,%L,'oidc','idp|reporter-a','key-3',%L,'review','f5-fund',null,null,null,null,null,'2026-Q2',%L,2,'x')$f$,
    tenant,'a0830000-0000-4000-8000-0000000000dc',workspace,repeat('f', 64),snap), 'data issue snapshot not found for fund');
  perform pg_temp.expect_error(format($f$select * from corvis_control.report_data_issue(%L,%L,%L,'oidc','idp|reporter-a','key-4',%L,'review','f5-fund',null,null,null,null,null,'2026-Q2',%L,1,'x')$f$,
    tenant,'a0830000-0000-4000-8000-0000000000dd',workspace,repeat('1', 64),'b0830000-0000-4000-8000-0000000000c1'), 'data issue snapshot not found for fund');
  -- A version without its snapshot, an empty comment and an unknown figure are rejected by the table's own checks.
  perform pg_temp.expect_error(format($f$select * from corvis_control.report_data_issue(%L,%L,%L,'oidc','idp|reporter-a','key-5',%L,'review','f5-fund',null,null,null,null,null,'2026-Q2',null,1,'x')$f$,
    tenant,'a0830000-0000-4000-8000-0000000000de',workspace,repeat('2', 64)), 'violates check constraint');
  perform pg_temp.expect_error(format($f$select * from corvis_control.report_data_issue(%L,%L,%L,'oidc','idp|reporter-a','key-6',%L,'review','f5-fund',null,null,null,null,null,'2026-Q2',null,null,'   ')$f$,
    tenant,'a0830000-0000-4000-8000-0000000000df',workspace,repeat('3', 64)), 'violates check constraint');
  perform pg_temp.expect_error(format($f$select * from corvis_control.report_data_issue(%L,%L,%L,'oidc','idp|reporter-a','key-7',%L,'not-a-figure','f5-fund',null,null,null,null,null,'2026-Q2',null,null,'x')$f$,
    tenant,'a0830000-0000-4000-8000-0000000000f0',workspace,repeat('4', 64)), 'violates check constraint');
  -- A workspace of another tenant is refused by the foreign key.
  perform pg_temp.expect_error(format($f$select * from corvis_control.report_data_issue(%L,%L,'b0830000-0000-4000-8000-0000000000b1','oidc','idp|reporter-a','key-8',%L,'review','f5-fund',null,null,null,null,null,'2026-Q2',null,null,'x')$f$,
    tenant,'a0830000-0000-4000-8000-0000000000f1',repeat('5', 64)), 'violates foreign key constraint');
end $$;

-- 2. Reporting is inert: no snapshot, publication, correction, job or outbox change.
do $$
declare before_state record;
begin
  select * into before_state from f5_before;
  if (select count(*) from corvis_consolidated.fund_period_snapshot) <> before_state.snapshots
     or (select md5(string_agg(s::text, '|' order by s.tenant_id, s.snapshot_id, s.version)) from corvis_consolidated.fund_period_snapshot s) is distinct from before_state.snapshot_digest then
    raise exception 'reporting must not change any snapshot';
  end if;
  if (select count(*) from corvis_consolidated.snapshot_publication_event) <> before_state.publication_events then raise exception 'reporting must not change publication state'; end if;
  if (select count(*) from corvis_control.data_correction_incident) <> before_state.incidents then raise exception 'reporting must not open a correction incident'; end if;
  if (select count(*) from corvis_control.processing_job) <> before_state.jobs then raise exception 'reporting must not start processing'; end if;
  if (select count(*) from corvis_control.outbox_event) <> before_state.outbox_events then raise exception 'reporting must not publish any event'; end if;
  if (select count(*) from corvis_control.data_issue_case) <> 3 then raise exception 'exactly the three distinct reports must exist'; end if;
end $$;

-- 3. The state machine and its guards.
do $$
declare
  tenant uuid := 'a0830000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0830000-0000-4000-8000-0000000000a1';
  target uuid := (select c.case_id from corvis_control.data_issue_case c where c.reporter_subject = 'idp|reporter-a' and c.idempotency_key = 'key-1');
  moved corvis_control.data_issue_case%rowtype;
  open_incident uuid := 'a0830000-0000-4000-8000-0000000000f2';
  other_period_incident uuid := 'a0830000-0000-4000-8000-0000000000f3';
  cancelled_incident uuid := 'a0830000-0000-4000-8000-0000000000f4';
begin
  -- Unknown cases (and other tenants' cases) are a clean empty result, never a cross-tenant move.
  if exists (select 1 from corvis_control.transition_data_issue_case(tenant,'a0830000-0000-4000-8000-0000000000ff','investigate',null,'ops|1',null,null)) then raise exception 'unknown case must return no row'; end if;
  if exists (select 1 from corvis_control.transition_data_issue_case('b0830000-0000-4000-8000-00000000000b',target,'investigate',null,'ops|1',null,null)) then raise exception 'another tenant must not reach this case'; end if;

  -- received only moves to investigating.
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'correct',null,'ops|1',null,null)$f$, tenant, target), 'data issue transition not allowed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'no_change',null,'ops|1','note',null)$f$, tenant, target), 'data issue transition not allowed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'investigate','investigating','ops|1',null,null)$f$, tenant, target), 'data issue case status changed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'bogus',null,'ops|1',null,null)$f$, tenant, target), 'data issue transition not allowed');

  -- Governed correction incidents: one open, one for another period, one cancelled.
  perform corvis_control.open_data_correction_incident(tenant,open_incident,'f5-open',repeat('1', 64),'f5-fund','2026-Q2','revenue',
    'a0830000-0000-4000-8000-0000000000c1',1,null,'wrong revenue','restate revenue','ops|1');
  perform corvis_control.open_data_correction_incident(tenant,other_period_incident,'f5-other-period',repeat('2', 64),'f5-fund','2026-Q1',null,null,null,null,'x','y','ops|1');
  perform corvis_control.open_data_correction_incident(tenant,cancelled_incident,'f5-cancelled',repeat('3', 64),'f5-fund','2026-Q2',null,null,null,null,'x','y','ops|1');
  update corvis_control.data_correction_incident set state = 'cancelled' where tenant_id = tenant and incident_id = cancelled_incident;

  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'investigate',null,'ops|1',null,%L)$f$, tenant, target, 'a0830000-0000-4000-8000-0000000000f9'), 'data issue correction not found');
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'investigate',null,'ops|1',null,%L)$f$, tenant, target, other_period_incident), 'data issue correction scope mismatch');
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'investigate',null,'ops|1',null,%L)$f$, tenant, target, cancelled_incident), 'data issue correction was cancelled');
  if (select status from corvis_control.data_issue_case c where c.case_id = target) <> 'received' then raise exception 'a refused transition must leave the case untouched'; end if;

  select * into moved from corvis_control.transition_data_issue_case(tenant,target,'investigate','received','ops|1','Looking into the source mapping.',open_incident);
  if moved.status <> 'investigating' or moved.correction_incident_id <> open_incident or moved.status_changed_by <> 'ops|1' then raise exception 'investigate must link the incident: %', row_to_json(moved); end if;
  if moved.resolution_note is not null or moved.reporter_seen_status <> 'received' then raise exception 'investigating is not a resolution and the reporter has not seen it yet'; end if;

  -- investigating -> corrected needs a resolved incident; no_change needs a note; received/terminal states do not move on.
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'investigate',null,'ops|1',null,null)$f$, tenant, target), 'data issue transition not allowed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'correct',null,'ops|1',null,null)$f$, tenant, target), 'data issue correction is not resolved');
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'no_change',null,'ops|1','   ',null)$f$, tenant, target), 'data issue resolution note required');
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'no_change',null,'ops|1',null,null)$f$, tenant, target), 'data issue resolution note required');

  -- Closing for a correction that is still open finds nothing; the case stays investigating.
  if exists (select 1 from corvis_control.close_data_issue_cases_for_correction(tenant,open_incident,'ops|1')) then raise exception 'an unresolved correction closes nothing'; end if;
end $$;

-- 4. Resolving the governed correction links the replacement publication and closes the linked case exactly once.
do $$
declare
  tenant uuid := 'a0830000-0000-4000-8000-00000000000a';
  target uuid := (select c.case_id from corvis_control.data_issue_case c where c.reporter_subject = 'idp|reporter-a' and c.idempotency_key = 'key-1');
  open_incident uuid := 'a0830000-0000-4000-8000-0000000000f2';
  closed corvis_control.data_issue_case%rowtype;
  closed_count integer;
begin
  perform corvis_control.resolve_data_correction_incident(tenant,open_incident,'a0830000-0000-4000-8000-0000000000c2',1,'ops|1','{"ticket":"DQ-1"}'::jsonb);
  select count(*) into closed_count from corvis_control.close_data_issue_cases_for_correction(tenant,open_incident,'ops|1');
  if closed_count <> 1 then raise exception 'exactly the linked investigating case closes, closed %', closed_count; end if;
  select * into closed from corvis_control.data_issue_case c where c.case_id = target;
  if closed.status <> 'corrected' or closed.replacement_snapshot_id <> 'a0830000-0000-4000-8000-0000000000c2' or closed.replacement_snapshot_version <> 1
     or closed.correction_incident_id <> open_incident or closed.status_changed_by <> 'ops|1' then
    raise exception 'closing must expose the replacement publication: %', row_to_json(closed);
  end if;
  if closed.reporter_seen_status <> 'received' then raise exception 'the reporter has not seen the change yet'; end if;
  if (select string_agg(to_status, ',' order by event_seq) from corvis_control.data_issue_case_event e where e.case_id = target) <> 'received,investigating,corrected' then raise exception 'history must keep the earlier steps in order'; end if;
  if (select count(*) from corvis_control.data_issue_case_event e where e.case_id = target) <> 3 then raise exception 'received, investigating and corrected are the three history rows'; end if;

  -- Idempotent: nothing left to close, and a closed case cannot be moved again.
  if exists (select 1 from corvis_control.close_data_issue_cases_for_correction(tenant,open_incident,'ops|1')) then raise exception 'closing twice must be a no-op'; end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'no_change',null,'ops|1','late',null)$f$, tenant, target), 'data issue transition not allowed');
  -- An incident of another tenant (or an unknown one) closes nothing.
  if exists (select 1 from corvis_control.close_data_issue_cases_for_correction('b0830000-0000-4000-8000-00000000000b',open_incident,'ops|1')) then raise exception 'another tenant must not close this tenant''s cases'; end if;
end $$;

-- 5. The manual paths: correct a case by naming a resolved incident, and close one with no change.
do $$
declare
  tenant uuid := 'a0830000-0000-4000-8000-00000000000a';
  second_case uuid := (select c.case_id from corvis_control.data_issue_case c where c.reporter_subject = 'idp|other-reporter');
  third_case uuid := (select c.case_id from corvis_control.data_issue_case c where c.reporter_subject = 'svc|ingest');
  manual_incident uuid := 'a0830000-0000-4000-8000-0000000000f5';
  moved corvis_control.data_issue_case%rowtype;
begin
  perform corvis_control.open_data_correction_incident(tenant,manual_incident,'f5-manual',repeat('4', 64),'f5-fund','2026-Q2',null,null,null,null,'x','y','ops|1');
  perform corvis_control.resolve_data_correction_incident(tenant,manual_incident,'a0830000-0000-4000-8000-0000000000c2',1,'ops|1','{}'::jsonb);

  perform corvis_control.transition_data_issue_case(tenant,second_case,'investigate',null,'ops|2','triage',null);
  select * into moved from corvis_control.transition_data_issue_case(tenant,second_case,'correct','investigating','ops|2','Republished.',manual_incident);
  if moved.status <> 'corrected' or moved.replacement_snapshot_id <> 'a0830000-0000-4000-8000-0000000000c2' or moved.replacement_snapshot_version <> 1
     or moved.resolution_note <> 'Republished.' then
    raise exception 'manual correction must link the replacement and keep the note: %', row_to_json(moved);
  end if;

  perform corvis_control.transition_data_issue_case(tenant,third_case,'investigate',null,'ops|2',null,null);
  select * into moved from corvis_control.transition_data_issue_case(tenant,third_case,'no_change',null,'ops|2','  The figure matches the source document.  ',null);
  if moved.status <> 'no_change' or moved.resolution_note <> 'The figure matches the source document.' or moved.replacement_snapshot_id is not null or moved.correction_incident_id is not null then
    raise exception 'no change keeps the note and has no correction: %', row_to_json(moved);
  end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.transition_data_issue_case(%L,%L,'correct',null,'ops|2',null,%L)$f$, tenant, third_case, manual_incident), 'data issue transition not allowed');
end $$;

-- 6. Immutability: what was reported never changes, and history is append-only.
do $$
declare
  a_case uuid := (select c.case_id from corvis_control.data_issue_case c where c.reporter_subject = 'idp|reporter-a');
begin
  perform pg_temp.expect_error(format($f$update corvis_control.data_issue_case set comment = 'edited' where case_id = %L$f$, a_case), 'data issue report content is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.data_issue_case set fund_id = 'other' where case_id = %L$f$, a_case), 'data issue report content is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.data_issue_case set status = 'received' where case_id = %L$f$, a_case), 'violates check constraint');
  perform pg_temp.expect_error(format($f$update corvis_control.data_issue_case_event set note = 'x' where case_id = %L$f$, a_case), 'data issue case history is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_control.data_issue_case_event where case_id = %L$f$, a_case), 'data issue case history is append-only');
  perform pg_temp.expect_error('truncate corvis_control.data_issue_case_event', 'data issue case history is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_control.data_issue_case where case_id = %L$f$, a_case), 'violates foreign key constraint');
  -- Acknowledging an update is the one reporter-side write and touches only the seen marker.
  update corvis_control.data_issue_case set reporter_seen_status = status where case_id = a_case;
  if (select reporter_seen_status from corvis_control.data_issue_case where case_id = a_case) <> 'corrected' then raise exception 'acknowledging records the status the reporter saw'; end if;
end $$;

-- 7. Notification category: the outbox and preferences accept it, and still refuse anything else.
do $$
declare
  tenant uuid := 'a0830000-0000-4000-8000-00000000000a';
  user_id uuid := 'a0830000-0000-4000-8000-0000000000e1';
begin
  insert into corvis_control.email_outbox (tenant_id,category,recipient_user_id,workspace_id,fund_id,template_params,dedupe_key)
  values (tenant,'data_issue_update',user_id,'a0830000-0000-4000-8000-0000000000a1','f5-fund','{"status":"corrected"}'::jsonb,'data_issue_update:f5:corrected');
  insert into corvis_control.notification_preference (tenant_id,user_id,category,enabled,delivery)
  values (tenant,user_id,'data_issue_update',false,'daily_digest');
  perform pg_temp.expect_error(format($f$insert into corvis_control.email_outbox (tenant_id,category,recipient_user_id,dedupe_key) values (%L,'not_a_category',%L,'x')$f$, tenant, user_id), 'violates check constraint');
  perform pg_temp.expect_error(format($f$insert into corvis_control.notification_preference (tenant_id,user_id,category,enabled,delivery) values (%L,%L,'not_a_category',true,'immediate')$f$, tenant, user_id), 'violates check constraint');
end $$;

-- 8. RLS: enabled and forced, no client policy, and a non-owner role without BYPASSRLS reads nothing.
do $$
declare
  offenders text;
begin
  select string_agg(c.relname, ', ') into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'corvis_control' and c.relname in ('data_issue_case','data_issue_case_event') and not (c.relrowsecurity and c.relforcerowsecurity);
  if offenders is not null then raise exception 'RLS must be enabled and forced on %', offenders; end if;
  if exists (select 1 from pg_policies where schemaname = 'corvis_control' and policyname <> 'corvis_runtime_service' and tablename in ('data_issue_case','data_issue_case_event')) then
    raise exception 'data issue tables are server-managed: no client policy may exist';
  end if;
end $$;

drop role if exists corvis_data_issue_negative_role;
create role corvis_data_issue_negative_role nologin nosuperuser nobypassrls noinherit;
grant usage on schema corvis_control to corvis_data_issue_negative_role;
grant select on corvis_control.data_issue_case, corvis_control.data_issue_case_event to corvis_data_issue_negative_role;
set role corvis_data_issue_negative_role;
do $$
begin
  set local request.jwt.claim.sub = 'a0830000-0000-4000-8000-0000000000e1';
  if (select count(*) from corvis_control.data_issue_case) <> 0 or (select count(*) from corvis_control.data_issue_case_event) <> 0 then
    raise exception 'a non-owner role must not read cases or their history, even as the reporter';
  end if;
end $$;
reset role;
drop owned by corvis_data_issue_negative_role;
drop role corvis_data_issue_negative_role;

rollback;
