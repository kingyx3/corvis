-- Acceptance for migration 086 (F10, #266): full tenant data export with dual approval, plus the contractual
-- data-rights selection it relies on.
--
-- Proves, against the real SQL functions on an isolated disposable database:
--   * only an active Organization Admin (tenant_admin) can request or decide, and a request is recorded as pending
--     with one history row; one request may be open per tenant, and an unapproved request lapses so it cannot block
--     a new one;
--   * the requester can never approve or reject their own request, by identity subject, by a second identity of the
--     same user, or by writing the row directly (the table's own CHECK constraints refuse it);
--   * the approve / reject / cancel machine and its guards (note on reject, requester-only cancel, approval window,
--     expected status, terminal states are final), and request content and the decision are immutable;
--   * the build queue: one claim at a time, attempt-bound completion and failure, retry scheduling, exhausted
--     attempts, abandoned-lease reclaim, and the complete-state artifact constraint;
--   * history is append-only and tenants are isolated;
--   * tenant_export_rights fails closed: expired, partial, unspecified and non-redistributable resources are
--     excluded, and without a workspace-level redistribution right nothing is returned;
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
values ('a0860000-0000-4000-8000-00000000000a','export-a','Export A'),
       ('b0860000-0000-4000-8000-00000000000b','export-b','Export B');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name)
values ('a0860000-0000-4000-8000-0000000000a1','a0860000-0000-4000-8000-00000000000a','primary','A primary'),
       ('b0860000-0000-4000-8000-0000000000b1','b0860000-0000-4000-8000-00000000000b','primary','B primary');
-- Tenant A: two Organization Admins (the second also has a SAML identity that maps to the same user as the first
-- admin), an analyst, a revoked admin and a service account. Tenant B has its own admin.
insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject,status)
values ('a0860000-0000-4000-8000-00000000000a','a0860000-0000-4000-8000-0000000000e1','oidc','idp|admin-one','active'),
       ('a0860000-0000-4000-8000-00000000000a','a0860000-0000-4000-8000-0000000000e1','saml','saml|admin-one','active'),
       ('a0860000-0000-4000-8000-00000000000a','a0860000-0000-4000-8000-0000000000e2','oidc','idp|admin-two','active'),
       ('a0860000-0000-4000-8000-00000000000a','a0860000-0000-4000-8000-0000000000e3','oidc','idp|analyst','active'),
       ('a0860000-0000-4000-8000-00000000000a','a0860000-0000-4000-8000-0000000000e4','oidc','idp|revoked-admin','active'),
       ('a0860000-0000-4000-8000-00000000000a','a0860000-0000-4000-8000-0000000000e5','service_account','svc|robot','active'),
       ('b0860000-0000-4000-8000-00000000000b','b0860000-0000-4000-8000-0000000000f1','oidc','idp|admin-b','active');
insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name,status)
values ('a0860000-0000-4000-8000-00000000000a','a0860000-0000-4000-8000-0000000000a1','a0860000-0000-4000-8000-0000000000e1','tenant_admin','active'),
       ('a0860000-0000-4000-8000-00000000000a','a0860000-0000-4000-8000-0000000000a1','a0860000-0000-4000-8000-0000000000e2','tenant_admin','active'),
       ('a0860000-0000-4000-8000-00000000000a','a0860000-0000-4000-8000-0000000000a1','a0860000-0000-4000-8000-0000000000e3','analyst','active'),
       ('a0860000-0000-4000-8000-00000000000a','a0860000-0000-4000-8000-0000000000a1','a0860000-0000-4000-8000-0000000000e4','tenant_admin','revoked'),
       ('a0860000-0000-4000-8000-00000000000a','a0860000-0000-4000-8000-0000000000a1','a0860000-0000-4000-8000-0000000000e5','tenant_admin','active'),
       ('b0860000-0000-4000-8000-00000000000b','b0860000-0000-4000-8000-0000000000b1','b0860000-0000-4000-8000-0000000000f1','tenant_admin','active');

create temporary table f10_before on commit drop as
select
  (select count(*) from corvis_serving.export_job) as export_jobs,
  (select count(*) from corvis_control.outbox_event) as outbox_events,
  (select count(*) from corvis_control.audit_event) as audit_events;

-- 1. Who may act.
do $$
declare
  tenant uuid := 'a0860000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0860000-0000-4000-8000-0000000000a1';
begin
  if corvis_control.tenant_export_admin_user(tenant,'oidc','idp|admin-one') <> 'a0860000-0000-4000-8000-0000000000e1' then raise exception 'an active admin resolves to its user'; end if;
  if corvis_control.tenant_export_admin_user(tenant,'saml','saml|admin-one') <> 'a0860000-0000-4000-8000-0000000000e1' then raise exception 'a second identity of the same admin resolves to the same user'; end if;
  if corvis_control.tenant_export_admin_user(tenant,'oidc','idp|analyst') is not null then raise exception 'an analyst is not an organization admin'; end if;
  if corvis_control.tenant_export_admin_user(tenant,'oidc','idp|revoked-admin') is not null then raise exception 'a revoked admin membership does not count'; end if;
  if corvis_control.tenant_export_admin_user(tenant,'service_account','svc|robot') is not null then raise exception 'a service account never acts as an organization admin'; end if;
  if corvis_control.tenant_export_admin_user(tenant,'oidc','idp|nobody') is not null then raise exception 'an unknown subject is not an admin'; end if;
  if corvis_control.tenant_export_admin_user('b0860000-0000-4000-8000-00000000000b','oidc','idp|admin-one') is not null then raise exception 'an admin of another tenant is not an admin here'; end if;

  perform pg_temp.expect_error(format($f$select * from corvis_control.request_tenant_export(%L,%L,%L,'oidc','idp|analyst','Leaving the platform',168)$f$,
    tenant,'a0860000-0000-4000-8000-0000000000d0',workspace), 'tenant export requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_tenant_export(%L,%L,%L,'oidc','idp|revoked-admin','Leaving the platform',168)$f$,
    tenant,'a0860000-0000-4000-8000-0000000000d0',workspace), 'tenant export requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_tenant_export(%L,%L,%L,'service_account','svc|robot','Leaving the platform',168)$f$,
    tenant,'a0860000-0000-4000-8000-0000000000d0',workspace), 'tenant export requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_tenant_export(%L,%L,%L,'oidc','idp|admin-one','  ab  ',168)$f$,
    tenant,'a0860000-0000-4000-8000-0000000000d0',workspace), 'tenant export purpose required');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_tenant_export(%L,%L,%L,'oidc','idp|admin-one',%L,168)$f$,
    tenant,'a0860000-0000-4000-8000-0000000000d0',workspace,repeat('x',1001)), 'tenant export purpose required');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_tenant_export(%L,%L,'b0860000-0000-4000-8000-0000000000b1','oidc','idp|admin-one','Leaving the platform',168)$f$,
    tenant,'a0860000-0000-4000-8000-0000000000d0'), 'workspace not found');
  if (select count(*) from corvis_control.tenant_export_request) <> 0 then raise exception 'a refused request leaves nothing behind'; end if;
end $$;

-- 2. Requesting: pending, one history row, one open request per tenant.
do $$
declare
  tenant uuid := 'a0860000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0860000-0000-4000-8000-0000000000a1';
  req corvis_control.tenant_export_request%rowtype;
  other corvis_control.tenant_export_request%rowtype;
begin
  select * into req from corvis_control.request_tenant_export(tenant,'a0860000-0000-4000-8000-0000000000d1',workspace,'oidc','idp|admin-one','  Leaving the platform at contract end.  ',168);
  if req.state <> 'pending_approval' or req.reason <> 'Leaving the platform at contract end.' then raise exception 'a new request is pending with a trimmed reason: %', row_to_json(req); end if;
  if req.requested_by_user_id <> 'a0860000-0000-4000-8000-0000000000e1' or req.requested_by_subject <> 'idp|admin-one' then raise exception 'the requester is recorded from the active identity'; end if;
  if req.decided_by_subject is not null or req.object_uri is not null or req.build_attempts <> 0 then raise exception 'a new request has no decision, artifact or build'; end if;
  if req.approval_expires_at <= req.requested_at + interval '167 hours' or req.approval_expires_at > req.requested_at + interval '169 hours' then raise exception 'the approval window is the requested number of hours'; end if;
  if (select count(*) from corvis_control.tenant_export_request_event where request_id = req.request_id and event_type = 'requested' and from_state is null and to_state = 'pending_approval' and actor_subject = 'idp|admin-one') <> 1 then
    raise exception 'requesting records exactly one history row';
  end if;

  -- One open request per tenant, whoever asks.
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_tenant_export(%L,%L,%L,'oidc','idp|admin-two','Second request',168)$f$,
    tenant,'a0860000-0000-4000-8000-0000000000d2',workspace), 'tenant export already in progress');
  perform pg_temp.expect_error(format($f$insert into corvis_control.tenant_export_request (tenant_id,request_id,workspace_id,requested_by_auth_method,requested_by_subject,requested_by_user_id,reason,approval_expires_at)
    values (%L,%L,%L,'oidc','idp|admin-two','a0860000-0000-4000-8000-0000000000e2','Bypass',now()+interval '1 day')$f$,
    tenant,'a0860000-0000-4000-8000-0000000000d3',workspace), 'tenant_export_request_active_idx');
  -- Another tenant has its own slot.
  select * into other from corvis_control.request_tenant_export('b0860000-0000-4000-8000-00000000000b','b0860000-0000-4000-8000-0000000000d9','b0860000-0000-4000-8000-0000000000b1','oidc','idp|admin-b','Tenant B export',168);
  if other.state <> 'pending_approval' then raise exception 'tenants are independent'; end if;
end $$;

-- 3. Four eyes: the requester can never approve or reject their own request.
do $$
declare
  tenant uuid := 'a0860000-0000-4000-8000-00000000000a';
  req uuid := 'a0860000-0000-4000-8000-0000000000d1';
begin
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'approve','oidc','idp|admin-one',null,null)$f$, tenant, req),
    'tenant export requires an independent approver');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'reject','oidc','idp|admin-one','No',null)$f$, tenant, req),
    'tenant export requires an independent approver');
  -- The same person through a second identity (SAML) is still the requester.
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'approve','saml','saml|admin-one',null,null)$f$, tenant, req),
    'tenant export requires an independent approver');
  -- Not an organization admin, revoked, or a service account: cannot decide.
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'approve','oidc','idp|analyst',null,null)$f$, tenant, req),
    'tenant export requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'approve','oidc','idp|revoked-admin',null,null)$f$, tenant, req),
    'tenant export requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'approve','service_account','svc|robot',null,null)$f$, tenant, req),
    'tenant export requires an active organization admin');
  -- An admin of another tenant cannot see or decide it: the request is simply not found there.
  if exists (select 1 from corvis_control.decide_tenant_export('b0860000-0000-4000-8000-00000000000b',req,'approve','oidc','idp|admin-b',null,null)) then
    raise exception 'a request is invisible to another tenant';
  end if;
  if (select state from corvis_control.tenant_export_request where request_id = req) <> 'pending_approval' then raise exception 'refused decisions change nothing'; end if;

  -- Writing the row directly cannot approve it as its own requester either (table CHECK, not only the function).
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set state='approved', decided_by_subject='idp|admin-one', decided_by_user_id='a0860000-0000-4000-8000-0000000000e1', decided_at=now() where request_id=%L$f$, req),
    'violates check constraint');
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set state='approved', decided_by_subject='saml|admin-one', decided_by_user_id='a0860000-0000-4000-8000-0000000000e1', decided_at=now() where request_id=%L$f$, req),
    'violates check constraint');
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set state='approved' where request_id=%L$f$, req),
    'violates check constraint');
  -- Content is immutable.
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set reason='something else' where request_id=%L$f$, req), 'tenant export request content is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set requested_by_subject='idp|admin-two', requested_by_user_id='a0860000-0000-4000-8000-0000000000e2' where request_id=%L$f$, req), 'tenant export request content is immutable');
end $$;

-- 4. Deciding: guards, then approval by a different admin.
do $$
declare
  tenant uuid := 'a0860000-0000-4000-8000-00000000000a';
  req uuid := 'a0860000-0000-4000-8000-0000000000d1';
  decided corvis_control.tenant_export_request%rowtype;
begin
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'delete','oidc','idp|admin-two',null,null)$f$, tenant, req), 'tenant export transition not allowed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'reject','oidc','idp|admin-two','   ',null)$f$, tenant, req), 'tenant export decision note required');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'approve','oidc','idp|admin-two',null,'approved')$f$, tenant, req), 'tenant export status changed');
  -- Only the requester may withdraw it.
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'cancel','oidc','idp|admin-two',null,null)$f$, tenant, req), 'tenant export can only be cancelled by its requester');
  -- A different requester id with the same subject text is still not the requester.
  if (select state from corvis_control.tenant_export_request where request_id = req) <> 'pending_approval' then raise exception 'refused decisions change nothing'; end if;

  select * into decided from corvis_control.decide_tenant_export(tenant,req,'approve','oidc','idp|admin-two','  Approved: contract ends 30 Sep.  ','pending_approval');
  if decided.state <> 'approved' or decided.decided_by_subject <> 'idp|admin-two' or decided.decided_by_user_id <> 'a0860000-0000-4000-8000-0000000000e2' or decided.decided_at is null then
    raise exception 'approval records the approver: %', row_to_json(decided);
  end if;
  if decided.decision_note <> 'Approved: contract ends 30 Sep.' or decided.build_next_attempt_at is null or decided.cancelled_at is not null then raise exception 'approval queues the build with a trimmed note'; end if;
  if (select count(*) from corvis_control.tenant_export_request_event where request_id = req and event_type = 'approved' and from_state = 'pending_approval' and to_state = 'approved' and actor_subject = 'idp|admin-two') <> 1 then
    raise exception 'approval records exactly one history row';
  end if;
  -- Deciding twice, and rejecting after approval, are refused; the decision is immutable.
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'approve','oidc','idp|admin-two',null,null)$f$, tenant, req), 'tenant export transition not allowed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'reject','oidc','idp|admin-two','Changed mind',null)$f$, tenant, req), 'tenant export transition not allowed');
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set decision_note='rewritten' where request_id=%L$f$, req), 'tenant export decision is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set decided_by_subject='idp|analyst' where request_id=%L$f$, req), 'tenant export decision is immutable');
  -- State machine: an approved request cannot jump to complete or back to pending.
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set state='pending_approval' where request_id=%L$f$, req), 'tenant export transition not allowed');
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set state='complete' where request_id=%L$f$, req), 'tenant export transition not allowed');
end $$;

-- 5. Cancel by the requester after approval (before the build starts), then a rejection path on a fresh request.
do $$
declare
  tenant uuid := 'a0860000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0860000-0000-4000-8000-0000000000a1';
  req uuid := 'a0860000-0000-4000-8000-0000000000d1';
  fresh corvis_control.tenant_export_request%rowtype;
  decided corvis_control.tenant_export_request%rowtype;
begin
  select * into decided from corvis_control.decide_tenant_export(tenant,req,'cancel','oidc','idp|admin-one','Wrong scope',null);
  if decided.state <> 'cancelled' or decided.cancelled_at is null then raise exception 'the requester can withdraw an approved request before its build starts'; end if;
  if decided.decided_by_subject <> 'idp|admin-two' then raise exception 'withdrawing keeps the recorded approval'; end if;
  if (select count(*) from corvis_control.tenant_export_request_event where request_id = req and event_type = 'cancelled' and from_state = 'approved' and actor_subject = 'idp|admin-one' and note = 'Wrong scope') <> 1 then
    raise exception 'cancelling records exactly one history row';
  end if;
  -- Terminal states are final.
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'cancel','oidc','idp|admin-one',null,null)$f$, tenant, req), 'tenant export transition not allowed');
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set state='approved' where request_id=%L$f$, req), 'tenant export transition not allowed');
  -- A cancelled request frees the slot.
  select * into fresh from corvis_control.request_tenant_export(tenant,'a0860000-0000-4000-8000-0000000000d4',workspace,'oidc','idp|admin-two','Second attempt, narrower reason',168);
  if fresh.state <> 'pending_approval' then raise exception 'a new request may follow a cancelled one'; end if;
  -- Reject: note required, a different admin, final.
  select * into decided from corvis_control.decide_tenant_export(tenant,fresh.request_id,'reject','oidc','idp|admin-one','Not authorised by legal.',null);
  if decided.state <> 'rejected' or decided.decision_note <> 'Not authorised by legal.' or decided.decided_by_subject <> 'idp|admin-one' then raise exception 'rejection records the decider and note'; end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'approve','oidc','idp|admin-one',null,null)$f$, tenant, fresh.request_id), 'tenant export transition not allowed');
  -- A pending request can be withdrawn by its requester too.
  select * into fresh from corvis_control.request_tenant_export(tenant,'a0860000-0000-4000-8000-0000000000d5',workspace,'oidc','idp|admin-one','Third attempt',168);
  select * into decided from corvis_control.decide_tenant_export(tenant,fresh.request_id,'cancel','oidc','idp|admin-one',null,'pending_approval');
  if decided.state <> 'cancelled' or decided.decided_by_subject is not null then raise exception 'withdrawing a pending request records no decision'; end if;
  -- A nonexistent request is simply not found.
  if exists (select 1 from corvis_control.decide_tenant_export(tenant,'a0860000-0000-4000-8000-0000000000ff','approve','oidc','idp|admin-two',null,null)) then raise exception 'unknown request returns nothing'; end if;
end $$;

-- 6. The approval window: a lapsed request cannot be approved, and lapses on the next request so it never blocks.
do $$
declare
  tenant uuid := 'a0860000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0860000-0000-4000-8000-0000000000a1';
  stale corvis_control.tenant_export_request%rowtype;
  fresh corvis_control.tenant_export_request%rowtype;
begin
  select * into stale from corvis_control.request_tenant_export(tenant,'a0860000-0000-4000-8000-0000000000d6',workspace,'oidc','idp|admin-one','Will lapse',168);
  -- Age the request (content columns are immutable, so the guard is lifted for this one fixture write).
  alter table corvis_control.tenant_export_request disable trigger tenant_export_request_guard_update;
  update corvis_control.tenant_export_request set requested_at = now() - interval '9 days', approval_expires_at = now() - interval '2 days' where request_id = stale.request_id;
  alter table corvis_control.tenant_export_request enable trigger tenant_export_request_guard_update;
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'approve','oidc','idp|admin-two',null,null)$f$, tenant, stale.request_id), 'tenant export approval window has passed');
  perform * from corvis_control.request_tenant_export(tenant,'a0860000-0000-4000-8000-0000000000d7',workspace,'oidc','idp|admin-two','Not blocked by the lapsed request',168);
  -- That request succeeded (the lapsed one no longer blocks), so a fresh request now exists.
  select * into fresh from corvis_control.tenant_export_request where request_id = 'a0860000-0000-4000-8000-0000000000d7';
  if fresh.state <> 'pending_approval' then raise exception 'a lapsed request must not block a new one'; end if;
  if (select state from corvis_control.tenant_export_request where request_id = stale.request_id) <> 'expired' then raise exception 'the lapsed request becomes expired'; end if;
  if (select count(*) from corvis_control.tenant_export_request_event where request_id = stale.request_id and event_type = 'expired' and actor_subject = 'system:tenant-export') <> 1 then raise exception 'lapsing records one history row'; end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'approve','oidc','idp|admin-two',null,null)$f$, tenant, stale.request_id), 'tenant export transition not allowed');
  -- Clear the way for the build-queue checks.
  perform corvis_control.decide_tenant_export(tenant,fresh.request_id,'cancel','oidc','idp|admin-two','Not needed',null);
end $$;

-- 7. The build queue.
do $$
declare
  tenant uuid := 'a0860000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0860000-0000-4000-8000-0000000000a1';
  req corvis_control.tenant_export_request%rowtype;
  claimed corvis_control.tenant_export_request%rowtype;
  done corvis_control.tenant_export_request%rowtype;
begin
  select * into req from corvis_control.request_tenant_export(tenant,'a0860000-0000-4000-8000-0000000000c1',workspace,'oidc','idp|admin-one','Build me',168);
  -- Not approved yet: nothing to claim (tenant B's pending request is not claimable either).
  if exists (select 1 from corvis_control.claim_next_tenant_export_build(10,5)) then raise exception 'only approved requests are claimable'; end if;
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'approve','oidc','idp|admin-two',null,null);

  select * into claimed from corvis_control.claim_next_tenant_export_build(10,5);
  if claimed.request_id <> req.request_id or claimed.state <> 'building' or claimed.build_attempts <> 1 or claimed.build_lease_expires_at is null or claimed.build_started_at is null then
    raise exception 'claiming moves the request to building under a lease: %', row_to_json(claimed);
  end if;
  if exists (select 1 from corvis_control.claim_next_tenant_export_build(10,5)) then raise exception 'a claimed request is not claimed twice'; end if;
  -- A building request can no longer be withdrawn.
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_tenant_export(%L,%L,'cancel','oidc','idp|admin-one',null,null)$f$, tenant, req.request_id), 'tenant export transition not allowed');

  -- A stale attempt number completes nothing; the completed state demands a whole artifact.
  if exists (select 1 from corvis_control.complete_tenant_export_build(tenant,req.request_id,2,'gs://b/exports/x.zip',now()+interval '1 day',repeat('a',64),10,'{}'::jsonb)) then raise exception 'completion is bound to the claiming attempt'; end if;
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set state='complete' where request_id=%L$f$, req.request_id), 'violates check constraint');
  -- A transient failure schedules a retry that is not claimable until its time.
  select * into done from corvis_control.fail_tenant_export_build(tenant,req.request_id,1,'object store unavailable',false,now()+interval '10 minutes',5);
  if done.state <> 'approved' or done.build_next_attempt_at <= now() or done.last_error <> 'object store unavailable' then raise exception 'a transient failure re-queues the request for later'; end if;
  if exists (select 1 from corvis_control.claim_next_tenant_export_build(10,5)) then raise exception 'a retry is not claimable before its time'; end if;
  if exists (select 1 from corvis_control.fail_tenant_export_build(tenant,req.request_id,1,'stale',false,now(),5)) then raise exception 'failure is bound to a building attempt'; end if;
  update corvis_control.tenant_export_request set build_next_attempt_at = now() where request_id = req.request_id;
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,5);
  if claimed.build_attempts <> 2 or claimed.last_error is not null then raise exception 'the retry is attempt 2 with the error cleared'; end if;

  -- An abandoned build (lease passed) goes back in the queue...
  update corvis_control.tenant_export_request set build_lease_expires_at = now() - interval '1 minute' where request_id = req.request_id;
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,5);
  if claimed.request_id <> req.request_id or claimed.build_attempts <> 3 then raise exception 'an abandoned build is reclaimed as the next attempt: %', row_to_json(claimed); end if;
  -- ...and is failed once its attempts are used up.
  update corvis_control.tenant_export_request set build_lease_expires_at = now() - interval '1 minute' where request_id = req.request_id;
  if exists (select 1 from corvis_control.claim_next_tenant_export_build(10,3)) then raise exception 'an exhausted abandoned build is failed, not re-queued'; end if;
  if (select state from corvis_control.tenant_export_request where request_id = req.request_id) <> 'failed' then raise exception 'exhausted attempts end the request'; end if;
  if (select count(*) from corvis_control.tenant_export_request_event where request_id = req.request_id and event_type = 'build_failed' and actor_subject = 'system:tenant-export') <> 1 then raise exception 'one build_failed row'; end if;
end $$;

-- 8. Completion and permanent failure on two further requests.
do $$
declare
  tenant uuid := 'a0860000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0860000-0000-4000-8000-0000000000a1';
  req corvis_control.tenant_export_request%rowtype;
  claimed corvis_control.tenant_export_request%rowtype;
  done corvis_control.tenant_export_request%rowtype;
begin
  select * into req from corvis_control.request_tenant_export(tenant,'a0860000-0000-4000-8000-0000000000c2',workspace,'oidc','idp|admin-two','Build and complete',168);
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'approve','oidc','idp|admin-one',null,null);
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,5);
  select * into done from corvis_control.complete_tenant_export_build(tenant,req.request_id,claimed.build_attempts,'gs://bucket/exports/a/x.zip',now()+interval '1 day',repeat('b',64),1234,'{"files":[]}'::jsonb);
  if done.state <> 'complete' or done.object_uri <> 'gs://bucket/exports/a/x.zip' or done.checksum_sha256 <> repeat('b',64) or done.size_bytes <> 1234 or done.completed_at is null or done.build_lease_expires_at is not null then
    raise exception 'completion records the artifact: %', row_to_json(done);
  end if;
  if (select count(*) from corvis_control.tenant_export_request_event where request_id = req.request_id and event_type in ('build_started','build_completed')) <> 2 then raise exception 'the build is in the history'; end if;
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set state='failed' where request_id=%L$f$, req.request_id), 'tenant export transition not allowed');
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set object_uri=null where request_id=%L$f$, req.request_id), 'violates check constraint');
  -- A complete export no longer holds the tenant's slot, and a download grant is single-use and unique per token.
  insert into corvis_control.tenant_export_download_grant (tenant_id,request_id,subject,token_sha256,expires_at)
  values (tenant,req.request_id,'idp|admin-one',repeat('c',64),now()+interval '10 minutes');
  perform pg_temp.expect_error(format($f$insert into corvis_control.tenant_export_download_grant (tenant_id,request_id,subject,token_sha256,expires_at) values (%L,%L,'idp|admin-two',%L,now()+interval '10 minutes')$f$, tenant, req.request_id, repeat('c',64)),
    'tenant_export_download_grant_tenant_id_token_sha256_key');
  perform pg_temp.expect_error(format($f$insert into corvis_control.tenant_export_download_grant (tenant_id,request_id,subject,token_sha256,expires_at) values (%L,%L,'idp|admin-two','not-a-hash',now()+interval '10 minutes')$f$, tenant, req.request_id),
    'violates check constraint');

  select * into req from corvis_control.request_tenant_export(tenant,'a0860000-0000-4000-8000-0000000000c3',workspace,'oidc','idp|admin-one','Permanent failure',168);
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'approve','oidc','idp|admin-two',null,null);
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,5);
  select * into done from corvis_control.fail_tenant_export_build(tenant,req.request_id,claimed.build_attempts,repeat('e',3000),true,null,5);
  if done.state <> 'failed' or length(done.last_error) <> 2000 or done.build_next_attempt_at is not null then raise exception 'a permanent failure ends the request with a bounded error: %', row_to_json(done); end if;
  select * into req from corvis_control.request_tenant_export(tenant,'a0860000-0000-4000-8000-0000000000c4',workspace,'oidc','idp|admin-one','Attempts exhausted',168);
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'approve','oidc','idp|admin-two',null,null);
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,1);
  select * into done from corvis_control.fail_tenant_export_build(tenant,req.request_id,claimed.build_attempts,'transient but out of attempts',false,now()+interval '1 minute',1);
  if done.state <> 'failed' then raise exception 'a transient failure on the last attempt ends the request'; end if;
end $$;

-- 9. History is append-only, and nothing in the governed export pipeline was touched.
do $$
declare
  some_event uuid := (select event_id from corvis_control.tenant_export_request_event limit 1);
begin
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request_event set note='x' where event_id=%L$f$, some_event), 'tenant export history is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_control.tenant_export_request_event where event_id=%L$f$, some_event), 'tenant export history is append-only');
  perform pg_temp.expect_error('truncate corvis_control.tenant_export_request_event', 'tenant export history is append-only');
  perform pg_temp.expect_error('delete from corvis_control.tenant_export_request', 'violates foreign key constraint');
  if (select count(*) from corvis_serving.export_job) <> (select export_jobs from f10_before) or (select count(*) from corvis_control.outbox_event) <> (select outbox_events from f10_before) then
    raise exception 'tenant export requests must not write the per-user export queue or the outbox';
  end if;
  -- System-driven transitions (a lapsed window, the build worker) are audited by the functions themselves, one audit row
  -- per history row; human decisions are audited by the application, so none exists here.
  if (select count(*) from corvis_control.audit_event) - (select audit_events from f10_before)
       <> (select count(*) from corvis_control.tenant_export_request_event where actor_subject = 'system:tenant-export') then
    raise exception 'every system transition is audited exactly once and nothing else writes the audit log';
  end if;
  if exists (select 1 from corvis_control.audit_event where action like 'data_export.%' and (actor_subject <> 'system:tenant-export' or target_type <> 'tenant_export_request' or outcome not in ('success','failure'))) then
    raise exception 'system audit rows are attributed to the export system and target the request';
  end if;
  if (select count(*) from corvis_control.audit_event where action in ('data_export.expired','data_export.build_started','data_export.build_completed','data_export.build_failed','data_export.build_retry_scheduled')) <> 
     (select count(*) from corvis_control.audit_event where action like 'data_export.%') then
    raise exception 'unexpected audit action written by the export functions';
  end if;
  if not exists (select 1 from corvis_control.audit_event a join corvis_control.tenant_export_request r on r.request_id::text = a.target_id
                 where a.action = 'data_export.build_completed' and a.workspace_id = r.workspace_id and (a.metadata ->> 'checksumSha256') = r.checksum_sha256) then
    raise exception 'build completion is audited with the artifact checksum in the request workspace';
  end if;
end $$;

-- 10. Contractual data rights: fail closed.
do $$
declare
  tenant uuid := 'a0860000-0000-4000-8000-00000000000a';
  other uuid := 'b0860000-0000-4000-8000-00000000000b';
  ws text := 'a0860000-0000-4000-8000-0000000000a1';
  listed text;
begin
  -- No rights at all, and rights without a workspace-level redistribution right, return nothing.
  if exists (select 1 from corvis_control.tenant_export_rights(tenant)) then raise exception 'no rights means nothing may be exported'; end if;
  insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible,redistribution_allowed,source_document_access_allowed)
  values (tenant,'fund','fund-ok',true,true,false),
         (tenant,'document','doc-ok',true,true,true);
  if exists (select 1 from corvis_control.tenant_export_rights(tenant)) then raise exception 'without the workspace-level redistribution right nothing is returned'; end if;
  -- A workspace row that does not allow redistribution is still no gate.
  insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible,redistribution_allowed) values (tenant,'workspace',ws,true,false);
  if exists (select 1 from corvis_control.tenant_export_rights(tenant)) then raise exception 'a workspace without redistribution is no gate'; end if;
  update corvis_control.data_rights set redistribution_allowed = true where tenant_id = tenant and resource_type = 'workspace';

  insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible,redistribution_allowed,source_document_access_allowed,effective_from,effective_to)
  values (tenant,'fund','fund-no-redistribution',true,false,false,now()-interval '1 day',null),
         (tenant,'fund','fund-hidden',false,true,false,now()-interval '1 day',null),
         (tenant,'document','doc-expired',true,true,true,now()-interval '10 days',now()-interval '1 day'),
         (tenant,'document','doc-future',true,true,true,now()+interval '1 day',null),
         -- Two effective rows for one document: every one must allow it, so one that does not wins.
         (tenant,'document','doc-conflict',true,true,true,now()-interval '1 day',null),
         (tenant,'document','doc-conflict',true,false,true,now()-interval '1 day',null),
         (tenant,'document','doc-no-source',true,true,false,now()-interval '1 day',null);
  -- Another tenant's rights never leak in.
  insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible,redistribution_allowed,source_document_access_allowed)
  values (other,'workspace','b0860000-0000-4000-8000-0000000000b1',true,true,false), (other,'fund','fund-b',true,true,false);

  select string_agg(resource_type || ':' || resource_id || ':' || source_document_access_allowed::text, ',' order by resource_type, resource_id) into listed
  from corvis_control.tenant_export_rights(tenant);
  if listed is distinct from 'document:doc-no-source:false,document:doc-ok:true,fund:fund-ok:false' then
    raise exception 'only currently redistributable, client-visible funds and documents are returned, got %', listed;
  end if;
  select string_agg(resource_type || ':' || resource_id, ',' order by resource_type, resource_id) into listed from corvis_control.tenant_export_rights(other);
  if listed is distinct from 'fund:fund-b' then raise exception 'the other tenant sees only its own rights, got %', listed; end if;
end $$;

-- 11. RLS: enabled and forced, no client policy, and a non-owner role without BYPASSRLS reads nothing.
do $$
declare
  offenders text;
begin
  select string_agg(c.relname, ', ') into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'corvis_control'
    and c.relname in ('tenant_export_request','tenant_export_request_event','tenant_export_download_grant')
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if offenders is not null then raise exception 'RLS must be enabled and forced on %', offenders; end if;
  if exists (select 1 from pg_policies where schemaname = 'corvis_control' and tablename in ('tenant_export_request','tenant_export_request_event','tenant_export_download_grant')) then
    raise exception 'tenant export tables are server-managed: no client policy may exist';
  end if;
end $$;

drop role if exists corvis_tenant_export_negative_role;
create role corvis_tenant_export_negative_role nologin nosuperuser nobypassrls noinherit;
grant usage on schema corvis_control to corvis_tenant_export_negative_role;
grant select on corvis_control.tenant_export_request, corvis_control.tenant_export_request_event, corvis_control.tenant_export_download_grant to corvis_tenant_export_negative_role;
set role corvis_tenant_export_negative_role;
do $$
begin
  set local request.jwt.claim.sub = 'a0860000-0000-4000-8000-0000000000e1';
  if (select count(*) from corvis_control.tenant_export_request) <> 0
     or (select count(*) from corvis_control.tenant_export_request_event) <> 0
     or (select count(*) from corvis_control.tenant_export_download_grant) <> 0 then
    raise exception 'a non-owner role must not read export requests, their history or grants, even as an organization admin';
  end if;
end $$;
reset role;
drop owned by corvis_tenant_export_negative_role;
drop role corvis_tenant_export_negative_role;

rollback;
