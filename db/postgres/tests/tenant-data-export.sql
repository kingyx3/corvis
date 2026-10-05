-- Acceptance for migration 084 (F10, #266): full tenant data export with dual approval, plus the contractual
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
--   * RLS is enabled and forced with no client policy, so a role without BYPASSRLS reads nothing;
--   * migration 089 (F10d): the history trigger queues the mandatory approval notice to every other active human
--     Organization Admin and the optional outcome notice (approved, rejected, ready, failed, including a build failed by
--     the lease reclaim) to the requester only, in words-only parameters, once per step, never blocking the step if the
--     outbox refuses it; the approval notice cannot be a stored preference;
--   * migration 089 (F10f): expired artifacts are listed, marked deleted once (history, audit, grants removed) and a live
--     one is never touched; expired download grants are swept past their retention, bounded and audited;
--   * Migration 094 (F10b, F10c): a build's progress report is stored and extends its lease only for the claiming attempt (a
--     build that keeps reporting is not reclaimed, one that stops is, and a reclaimed attempt is told it lost the lease), and
--     the rights re-check runs in SQL against the scope recorded with the archive, including the source document files
--     (redistribution for every fund and document, source-file access for each file in it, the workspace gate, tenant scope).
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

-- 11. Migration 089 (F10d, F10f). A fresh tenant with three Organization Admins, an analyst, a revoked admin and a service account.
insert into corvis_control.tenant (tenant_id,slug,display_name) values ('c0890000-0000-4000-8000-00000000000c','export-c','Export C');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ('c0890000-0000-4000-8000-0000000000c1','c0890000-0000-4000-8000-00000000000c','primary','C primary');
insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject,status)
values ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000e1','oidc','idp|c-one','active'),
       ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000e2','oidc','idp|c-two','active'),
       ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000e3','oidc','idp|c-three','active'),
       ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000e5','oidc','idp|c-analyst','active'),
       ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000e6','oidc','idp|c-revoked','active'),
       ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000e7','service_account','svc|c-robot','active');
insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name,status)
values ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000c1','c0890000-0000-4000-8000-0000000000e1','tenant_admin','active'),
       ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000c1','c0890000-0000-4000-8000-0000000000e2','tenant_admin','active'),
       ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000c1','c0890000-0000-4000-8000-0000000000e3','tenant_admin','active'),
       ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000c1','c0890000-0000-4000-8000-0000000000e5','analyst','active'),
       ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000c1','c0890000-0000-4000-8000-0000000000e6','tenant_admin','revoked'),
       ('c0890000-0000-4000-8000-00000000000c','c0890000-0000-4000-8000-0000000000c1','c0890000-0000-4000-8000-0000000000e7','tenant_admin','active');

-- 11a. Notices are queued by the history trigger: the approval notice to every OTHER active human Organization Admin,
-- the outcome notice to the requester only, in words-only parameters, once per step.
do $$
declare
  tenant uuid := 'c0890000-0000-4000-8000-00000000000c';
  workspace uuid := 'c0890000-0000-4000-8000-0000000000c1';
  one uuid := 'c0890000-0000-4000-8000-0000000000e1';
  two uuid := 'c0890000-0000-4000-8000-0000000000e2';
  three uuid := 'c0890000-0000-4000-8000-0000000000e3';
  req corvis_control.tenant_export_request%rowtype;
  claimed corvis_control.tenant_export_request%rowtype;
  who text;
begin
  select * into req from corvis_control.request_tenant_export(tenant,'c0890000-0000-4000-8000-0000000000d1',workspace,'oidc','idp|c-one','Notice flow',168);
  select string_agg(recipient_user_id::text, ',' order by recipient_user_id) into who
  from corvis_control.email_outbox where tenant_id = tenant and category = 'tenant_export_approval';
  if who is distinct from two::text || ',' || three::text then
    raise exception 'the approval notice goes to the other active human Organization Admins only, got %', who;
  end if;
  if exists (select 1 from corvis_control.email_outbox where tenant_id = tenant and category = 'tenant_export_approval'
             and (template_params <> '{"event":"approval_needed"}'::jsonb or required_roles <> array['tenant_admin']::text[] or workspace_id is not null or fund_id is not null or status <> 'queued')) then
    raise exception 'the approval notice carries only the event, the role to re-check and no scope';
  end if;
  if (select count(*) from corvis_control.email_outbox where tenant_id = tenant and category = 'tenant_export_outcome') <> 0 then raise exception 'a request is not an outcome'; end if;

  -- Approving tells the requester, and only the requester.
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'approve','oidc','idp|c-two',null,null);
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,5);
  perform corvis_control.complete_tenant_export_build(tenant,req.request_id,claimed.build_attempts,'gs://bucket/exports/c/x.zip',now()+interval '1 day',repeat('d',64),10,'{}'::jsonb);
  select string_agg(template_params ->> 'event', ',' order by template_params ->> 'event') into who
  from corvis_control.email_outbox where tenant_id = tenant and category = 'tenant_export_outcome' and recipient_user_id = one;
  if who is distinct from 'approved,ready' then raise exception 'the requester is told of approval and readiness, got %', who; end if;
  if exists (select 1 from corvis_control.email_outbox where tenant_id = tenant and category = 'tenant_export_outcome' and recipient_user_id <> one) then raise exception 'nobody but the requester gets an outcome'; end if;

  -- A rejection says so without the note; a cancellation by the requester is their own action and tells no one.
  select * into req from corvis_control.request_tenant_export(tenant,'c0890000-0000-4000-8000-0000000000d2',workspace,'oidc','idp|c-two','Second flow',168);
  if (select count(*) from corvis_control.email_outbox where tenant_id = tenant and category = 'tenant_export_approval') <> 4 then raise exception 'each request tells the other admins once (2 + 2)'; end if;
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'reject','oidc','idp|c-one','SECRET NOTE',null);
  if not exists (select 1 from corvis_control.email_outbox where tenant_id = tenant and category = 'tenant_export_outcome' and recipient_user_id = two and template_params = '{"event":"rejected"}'::jsonb) then
    raise exception 'the requester is told of a rejection';
  end if;
  if exists (select 1 from corvis_control.email_outbox where tenant_id = tenant and (template_params::text like '%SECRET%' or template_params::text like '%Second flow%' or template_params::text like '%idp|%')) then
    raise exception 'no note, reason or name ever enters an outbox row';
  end if;
  select * into req from corvis_control.request_tenant_export(tenant,'c0890000-0000-4000-8000-0000000000d3',workspace,'oidc','idp|c-three','Withdrawn flow',168);
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'cancel','oidc','idp|c-three',null,null);
  if exists (select 1 from corvis_control.email_outbox where tenant_id = tenant and category = 'tenant_export_outcome' and recipient_user_id = three) then raise exception 'withdrawing your own request is not an outcome'; end if;

  -- A permanent failure, and a build abandoned past its attempts (failed inside the claim function), both tell the requester.
  select * into req from corvis_control.request_tenant_export(tenant,'c0890000-0000-4000-8000-0000000000d4',workspace,'oidc','idp|c-three','Failing flow',168);
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'approve','oidc','idp|c-one',null,null);
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,5);
  perform corvis_control.fail_tenant_export_build(tenant,req.request_id,claimed.build_attempts,'boom',false,now()+interval '1 minute',5);
  if exists (select 1 from corvis_control.email_outbox where tenant_id = tenant and recipient_user_id = three and category = 'tenant_export_outcome' and template_params ->> 'event' = 'failed') then
    raise exception 'a build that will be retried is not a failure yet';
  end if;
  update corvis_control.tenant_export_request set build_next_attempt_at = now() where request_id = req.request_id;
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,5);
  perform corvis_control.fail_tenant_export_build(tenant,req.request_id,claimed.build_attempts,'boom again',true,null,5);
  if (select count(*) from corvis_control.email_outbox where tenant_id = tenant and recipient_user_id = three and category = 'tenant_export_outcome' and template_params ->> 'event' = 'failed') <> 1 then
    raise exception 'the requester is told when the build gives up';
  end if;
  select * into req from corvis_control.request_tenant_export(tenant,'c0890000-0000-4000-8000-0000000000d5',workspace,'oidc','idp|c-two','Abandoned flow',168);
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'approve','oidc','idp|c-one',null,null);
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,1);
  update corvis_control.tenant_export_request set build_lease_expires_at = now() - interval '1 minute' where request_id = req.request_id;
  perform corvis_control.claim_next_tenant_export_build(10,1);
  if (select state from corvis_control.tenant_export_request where request_id = req.request_id) <> 'failed' then raise exception 'the exhausted abandoned build failed'; end if;
  if not exists (select 1 from corvis_control.email_outbox where tenant_id = tenant and recipient_user_id = two and category = 'tenant_export_outcome' and template_params ->> 'event' = 'failed') then
    raise exception 'a build failed by the lease reclaim also tells the requester';
  end if;
  if exists (select 1 from corvis_control.email_outbox where tenant_id = tenant and category in ('tenant_export_approval','tenant_export_outcome')
             group by dedupe_key having count(*) > 1) then raise exception 'dedupe keys are unique per notice'; end if;
end $$;

-- 11b. The category rules: the approval notice is mandatory (it cannot be a stored preference), the outcome notice is one.
do $$
declare
  tenant uuid := 'c0890000-0000-4000-8000-00000000000c';
  one uuid := 'c0890000-0000-4000-8000-0000000000e1';
begin
  perform pg_temp.expect_error(format($f$insert into corvis_control.notification_preference (tenant_id,user_id,category,enabled,delivery) values (%L,%L,'tenant_export_approval',false,'immediate')$f$, tenant, one),
    'notification_preference_category_check');
  insert into corvis_control.notification_preference (tenant_id,user_id,category,enabled,delivery) values (tenant,one,'tenant_export_outcome',false,'immediate');
  perform pg_temp.expect_error(format($f$insert into corvis_control.email_outbox (tenant_id,category,recipient_user_id,dedupe_key) values (%L,'tenant_export_bogus',%L,'x')$f$, tenant, one),
    'email_outbox_category_check');
end $$;

-- 11c. A notification fault never blocks the step that caused it: the outbox refuses the notice, the approval still happens.
do $$
declare
  tenant uuid := 'c0890000-0000-4000-8000-00000000000c';
  workspace uuid := 'c0890000-0000-4000-8000-0000000000c1';
  req corvis_control.tenant_export_request%rowtype;
  before_rows integer := (select count(*) from corvis_control.email_outbox where tenant_id = 'c0890000-0000-4000-8000-00000000000c');
begin
  alter table corvis_control.email_outbox add constraint f10_block_notices check (category not in ('tenant_export_approval','tenant_export_outcome')) not valid;
  select * into req from corvis_control.request_tenant_export(tenant,'c0890000-0000-4000-8000-0000000000d6',workspace,'oidc','idp|c-one','Faulty outbox',168);
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'approve','oidc','idp|c-two',null,null);
  if (select state from corvis_control.tenant_export_request where request_id = req.request_id) <> 'approved' then raise exception 'the approval stands without its notice'; end if;
  if (select count(*) from corvis_control.email_outbox where tenant_id = tenant) <> before_rows then raise exception 'the refused notices were not queued'; end if;
  alter table corvis_control.email_outbox drop constraint f10_block_notices;
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'cancel','oidc','idp|c-one',null,null);
end $$;

-- 11d. Expired artifacts: only complete exports past their lifetime are listed; marking one stamps it, removes its grants,
-- appends history and writes the audit event once; a repeat or a still-valid artifact changes nothing.
do $$
declare
  tenant uuid := 'c0890000-0000-4000-8000-00000000000c';
  workspace uuid := 'c0890000-0000-4000-8000-0000000000c1';
  req corvis_control.tenant_export_request%rowtype;
  claimed corvis_control.tenant_export_request%rowtype;
  expired_id uuid := 'c0890000-0000-4000-8000-0000000000d7';
  fresh_id uuid := 'c0890000-0000-4000-8000-0000000000d8';
  listed text;
begin
  select * into req from corvis_control.request_tenant_export(tenant,expired_id,workspace,'oidc','idp|c-one','Will expire',168);
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'approve','oidc','idp|c-two',null,null);
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,5);
  perform corvis_control.complete_tenant_export_build(tenant,req.request_id,claimed.build_attempts,'gs://bucket/exports/c/expiring.zip',now()+interval '1 hour',repeat('e',64),10,'{}'::jsonb);
  insert into corvis_control.tenant_export_download_grant (tenant_id,request_id,subject,token_sha256,expires_at)
  values (tenant,expired_id,'idp|c-one',repeat('1',64),now()+interval '5 minutes'), (tenant,expired_id,'idp|c-one',repeat('2',64),now()-interval '1 hour');
  if exists (select 1 from corvis_control.expired_tenant_export_artifacts(10) where request_id = expired_id) then raise exception 'a live artifact is not expired'; end if;
  if corvis_control.mark_tenant_export_artifact_deleted(tenant, expired_id) then raise exception 'a live artifact cannot be marked deleted'; end if;

  select * into req from corvis_control.request_tenant_export(tenant,fresh_id,workspace,'oidc','idp|c-one','Stays valid',168);
  perform corvis_control.decide_tenant_export(tenant,req.request_id,'approve','oidc','idp|c-two',null,null);
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,5);
  perform corvis_control.complete_tenant_export_build(tenant,fresh_id,claimed.build_attempts,'gs://bucket/exports/c/fresh.zip',now()+interval '1 day',repeat('f',64),10,'{}'::jsonb);

  -- The first export's lifetime passes (the guard lets only the build columns change; artifact_expires_at is not guarded).
  update corvis_control.tenant_export_request set artifact_expires_at = now() - interval '1 minute' where request_id = expired_id;
  select string_agg(request_id::text || '=' || object_uri, ',') into listed from corvis_control.expired_tenant_export_artifacts(10);
  if listed is distinct from expired_id::text || '=gs://bucket/exports/c/expiring.zip' then raise exception 'only the expired artifact is listed, got %', listed; end if;
  if (select count(*) from corvis_control.expired_tenant_export_artifacts(0)) <> 1 then raise exception 'the limit is at least one'; end if;

  if not corvis_control.mark_tenant_export_artifact_deleted(tenant, expired_id) then raise exception 'an expired artifact is marked deleted'; end if;
  if corvis_control.mark_tenant_export_artifact_deleted(tenant, expired_id) then raise exception 'marking twice changes nothing'; end if;
  if corvis_control.mark_tenant_export_artifact_deleted(tenant, fresh_id) then raise exception 'a live artifact stays'; end if;
  if exists (select 1 from corvis_control.expired_tenant_export_artifacts(10)) then raise exception 'a swept artifact is no longer listed'; end if;
  if (select artifact_deleted_at is null or state <> 'complete' or object_uri is null from corvis_control.tenant_export_request where request_id = expired_id) then
    raise exception 'the request stays complete and keeps its object uri; only the deletion is recorded';
  end if;
  if exists (select 1 from corvis_control.tenant_export_download_grant where request_id = expired_id) then raise exception 'its grants are removed with the artifact'; end if;
  if (select count(*) from corvis_control.tenant_export_request_event where request_id = expired_id and event_type = 'artifact_deleted' and from_state = 'complete' and to_state = 'complete' and actor_subject = 'system:tenant-export') <> 1 then
    raise exception 'the deletion is in the history once';
  end if;
  if (select count(*) from corvis_control.audit_event where target_id = expired_id::text and action = 'data_export.artifact_deleted' and outcome = 'success'
        and workspace_id = workspace and actor_subject = 'system:tenant-export' and (metadata ->> 'grantsDeleted') = '2') <> 1 then
    raise exception 'the deletion is audited once with the number of grants removed';
  end if;
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set artifact_deleted_at = now() where request_id = %L$f$, 'c0890000-0000-4000-8000-0000000000d5'),
    'violates check constraint');
end $$;

-- 11e. Download grants: only those expired past the retention are deleted, bounded per call, audited once per request.
do $$
declare
  tenant uuid := 'c0890000-0000-4000-8000-00000000000c';
  fresh_id uuid := 'c0890000-0000-4000-8000-0000000000d8';
  swept integer;
begin
  insert into corvis_control.tenant_export_download_grant (tenant_id,request_id,subject,token_sha256,expires_at,consumed_at)
  values (tenant,fresh_id,'idp|c-one',repeat('3',64),now()-interval '3 days',now()-interval '3 days'),
         (tenant,fresh_id,'idp|c-one',repeat('4',64),now()-interval '2 days',null),
         (tenant,fresh_id,'idp|c-one',repeat('5',64),now()-interval '1 hour',null),
         (tenant,fresh_id,'idp|c-one',repeat('6',64),now()+interval '5 minutes',null);
  swept := corvis_control.sweep_tenant_export_grants(24, 1);
  if swept <> 1 then raise exception 'the limit bounds one call, deleted %', swept; end if;
  swept := corvis_control.sweep_tenant_export_grants(24, 100);
  if swept <> 1 then raise exception 'the rest of the expired ones go next, deleted %', swept; end if;
  if (select string_agg(left(token_sha256, 1), ',' order by token_sha256) from corvis_control.tenant_export_download_grant where request_id = fresh_id) is distinct from '5,6' then
    raise exception 'a grant expired less than the retention ago, and a live one, are kept';
  end if;
  if corvis_control.sweep_tenant_export_grants(24, 100) <> 0 then raise exception 'nothing left to sweep'; end if;
  if (select count(*) from corvis_control.audit_event where target_id = fresh_id::text and action = 'data_export.grants_swept' and (metadata ->> 'deleted') = '1') <> 2 then
    raise exception 'each sweep that deleted something is audited with its count; one that deleted nothing is not';
  end if;
  if corvis_control.sweep_tenant_export_grants(0, null) <> 0 then raise exception 'a nonsense retention is floored to an hour, a missing limit has a default'; end if;
end $$;

-- 11f. Migration 094 (F10b, F10c): the build's progress report is also its heartbeat, bound to the claiming attempt; and the rights
-- re-check runs in SQL against the scope recorded with the archive, including its source document files.
do $$
declare
  tenant uuid := 'c0890000-0000-4000-8000-00000000000c';
  workspace uuid := 'c0890000-0000-4000-8000-0000000000c1';
  req corvis_control.tenant_export_request%rowtype;
  claimed corvis_control.tenant_export_request%rowtype;
  progress_id uuid := 'c0930000-0000-4000-8000-0000000000d1';
  report jsonb := '{"phase":"documents","percent":40,"bytesWritten":400,"estimatedBytes":1000}'::jsonb;
  lease timestamptz;
begin
  select * into req from corvis_control.request_tenant_export(tenant,progress_id,workspace,'oidc','idp|c-one','Large export',168);
  perform corvis_control.decide_tenant_export(tenant,progress_id,'approve','oidc','idp|c-two',null,null);
  if corvis_control.record_tenant_export_build_progress(tenant,progress_id,1,report,10) then raise exception 'an approved request that is not building takes no report'; end if;
  select * into claimed from corvis_control.claim_next_tenant_export_build(10,5);
  if claimed.request_id is distinct from progress_id then raise exception 'the request is claimed'; end if;
  if (select build_progress from corvis_control.tenant_export_request where request_id = progress_id) is not null then raise exception 'a claimed build starts with no progress'; end if;

  -- A report from the claiming attempt is stored and extends the lease to ten minutes from now.
  update corvis_control.tenant_export_request set build_lease_expires_at = now() + interval '1 minute' where request_id = progress_id;
  if not corvis_control.record_tenant_export_build_progress(tenant,progress_id,claimed.build_attempts,report,10) then raise exception 'the owning attempt may report'; end if;
  select build_lease_expires_at into lease from corvis_control.tenant_export_request where request_id = progress_id;
  if lease < now() + interval '9 minutes' or lease > now() + interval '11 minutes' then raise exception 'a report extends the lease to the lease length, got %', lease; end if;
  if (select build_progress from corvis_control.tenant_export_request where request_id = progress_id) is distinct from report then raise exception 'the report is stored as given'; end if;
  -- A report never shortens a lease that runs further out, and a nonsense lease length is floored to a minute.
  update corvis_control.tenant_export_request set build_lease_expires_at = now() + interval '1 hour' where request_id = progress_id;
  perform corvis_control.record_tenant_export_build_progress(tenant,progress_id,claimed.build_attempts,report,0);
  select build_lease_expires_at into lease from corvis_control.tenant_export_request where request_id = progress_id;
  if lease < now() + interval '59 minutes' then raise exception 'a report does not shorten the lease'; end if;

  -- Another attempt, another tenant and a malformed report are refused or change nothing.
  if corvis_control.record_tenant_export_build_progress(tenant,progress_id,claimed.build_attempts + 1,'{"phase":"data"}'::jsonb,10) then raise exception 'a stale attempt cannot report'; end if;
  if corvis_control.record_tenant_export_build_progress('a0860000-0000-4000-8000-00000000000a',progress_id,claimed.build_attempts,'{"phase":"data"}'::jsonb,10) then raise exception 'another tenant cannot report'; end if;
  if (select build_progress from corvis_control.tenant_export_request where request_id = progress_id) is distinct from report then raise exception 'refused reports change nothing'; end if;
  perform pg_temp.expect_error(format($f$update corvis_control.tenant_export_request set build_progress = '[1]'::jsonb where request_id = %L$f$, progress_id), 'violates check constraint');

  -- Reporting is the heartbeat: a build that keeps reporting is not reclaimed, one that stops is.
  update corvis_control.tenant_export_request set build_lease_expires_at = now() - interval '1 minute' where request_id = progress_id;
  perform corvis_control.record_tenant_export_build_progress(tenant,progress_id,claimed.build_attempts,report,10);
  if exists (select 1 from corvis_control.claim_next_tenant_export_build(10,5)) then raise exception 'a build whose lease was just extended is not claimed by anyone else'; end if;
  if (select state from corvis_control.tenant_export_request where request_id = progress_id) <> 'building' then raise exception 'still building'; end if;
  update corvis_control.tenant_export_request set build_lease_expires_at = now() - interval '1 minute' where request_id = progress_id;
  if exists (select 1 from corvis_control.claim_next_tenant_export_build(10,5) where request_id <> progress_id) then raise exception 'only this request is up for reclaim'; end if;
  if (select build_attempts from corvis_control.tenant_export_request where request_id = progress_id) <> claimed.build_attempts + 1 then raise exception 'a build that stopped reporting is reclaimed as an attempt of its own'; end if;
  -- The reclaimed attempt owns the request now: the old attempt's reports are refused (it stops), and so is its completion.
  if corvis_control.record_tenant_export_build_progress(tenant,progress_id,claimed.build_attempts,report,10) then raise exception 'the abandoned attempt is told it lost the lease'; end if;
  if not corvis_control.record_tenant_export_build_progress(tenant,progress_id,claimed.build_attempts + 1,report,10) then raise exception 'the new attempt owns the request'; end if;
  -- Finished builds take no more reports.
  perform corvis_control.complete_tenant_export_build(tenant,progress_id,claimed.build_attempts + 1,'gs://bucket/exports/c/progress.zip',now()+interval '1 day',repeat('9',64),10,
    '{"manifestVersion":2,"artifact":{"fundIds":["fund-93"],"documentIds":["doc-93","doc-93b"],"sourceDocumentIds":["doc-93"]}}'::jsonb);
  if corvis_control.record_tenant_export_build_progress(tenant,progress_id,claimed.build_attempts + 1,report,10) then raise exception 'a completed build takes no report'; end if;

  -- The rights re-check: every fund, document and source file the archive holds must still be redistributable, and a source
  -- file also needs source-file access. Nothing is held until rights are granted (the archive cannot be downloaded).
  if not corvis_control.tenant_export_scope_changed(tenant, progress_id) then raise exception 'with no rights at all the archive no longer holds'; end if;
  insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible,redistribution_allowed,source_document_access_allowed)
  values (tenant,'workspace',workspace::text,true,true,false),
         (tenant,'fund','fund-93',true,true,false),
         (tenant,'document','doc-93',true,true,true),
         (tenant,'document','doc-93b',true,true,false);
  if corvis_control.tenant_export_scope_changed(tenant, progress_id) then raise exception 'rights still cover the archive: funds, documents, and source access for the one source file'; end if;
  update corvis_control.data_rights set source_document_access_allowed = false where tenant_id = tenant and resource_id = 'doc-93';
  if not corvis_control.tenant_export_scope_changed(tenant, progress_id) then raise exception 'withdrawing source-file access for a document whose file is in the archive blocks it'; end if;
  update corvis_control.data_rights set source_document_access_allowed = true where tenant_id = tenant and resource_id = 'doc-93';
  update corvis_control.data_rights set source_document_access_allowed = true where tenant_id = tenant and resource_id = 'doc-93b';
  if corvis_control.tenant_export_scope_changed(tenant, progress_id) then raise exception 'source-file access for a document whose file is not in the archive changes nothing'; end if;
  update corvis_control.data_rights set redistribution_allowed = false where tenant_id = tenant and resource_id = 'doc-93b';
  if not corvis_control.tenant_export_scope_changed(tenant, progress_id) then raise exception 'a document without a redistribution right blocks it, even with no file in the archive'; end if;
  update corvis_control.data_rights set redistribution_allowed = true where tenant_id = tenant and resource_id = 'doc-93b';
  update corvis_control.data_rights set client_visible = false where tenant_id = tenant and resource_type = 'fund' and resource_id = 'fund-93';
  if not corvis_control.tenant_export_scope_changed(tenant, progress_id) then raise exception 'a fund that is no longer client-visible blocks it'; end if;
  update corvis_control.data_rights set client_visible = true where tenant_id = tenant and resource_type = 'fund' and resource_id = 'fund-93';
  update corvis_control.data_rights set redistribution_allowed = false where tenant_id = tenant and resource_type = 'workspace';
  if not corvis_control.tenant_export_scope_changed(tenant, progress_id) then raise exception 'withdrawing the workspace-level redistribution right blocks everything'; end if;
  update corvis_control.data_rights set redistribution_allowed = true where tenant_id = tenant and resource_type = 'workspace';
  if corvis_control.tenant_export_scope_changed(tenant, progress_id) then raise exception 'rights restored: covered again'; end if;
  -- The check is scoped to the tenant: another tenant's id finds no such request (the application only ever asks about its own), and an unknown request holds nothing.
  if corvis_control.tenant_export_scope_changed('a0860000-0000-4000-8000-00000000000a', progress_id) then raise exception 'a request of another tenant is not visible here'; end if;
  if corvis_control.tenant_export_scope_changed(tenant, 'c0930000-0000-4000-8000-0000000000ff') then raise exception 'an unknown request holds nothing, so nothing changed'; end if;
  -- Archives built before migration 094 have no source files in their scope and are checked on funds and documents alone; a malformed scope holds nothing.
  update corvis_control.tenant_export_request set manifest = '{"artifact":{"fundIds":["fund-93"],"documentIds":["doc-93"]}}'::jsonb where request_id = progress_id;
  update corvis_control.data_rights set source_document_access_allowed = false where tenant_id = tenant and resource_id = 'doc-93';
  if corvis_control.tenant_export_scope_changed(tenant, progress_id) then raise exception 'an archive without source files does not need source-file access'; end if;
  update corvis_control.tenant_export_request set manifest = '{"artifact":{"fundIds":null,"documentIds":"x","sourceDocumentIds":{"a":1}}}'::jsonb where request_id = progress_id;
  if corvis_control.tenant_export_scope_changed(tenant, progress_id) then raise exception 'a malformed scope holds nothing'; end if;
  update corvis_control.tenant_export_request set manifest = '{}'::jsonb where request_id = progress_id;
  if corvis_control.tenant_export_scope_changed(tenant, progress_id) then raise exception 'a manifest with no scope holds nothing'; end if;
  delete from corvis_control.data_rights where tenant_id = tenant;
end $$;

-- 12. RLS: enabled and forced, no client policy, and a non-owner role without BYPASSRLS reads nothing.
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
  if exists (select 1 from pg_policies where schemaname = 'corvis_control' and policyname <> 'corvis_runtime_service' and tablename in ('tenant_export_request','tenant_export_request_event','tenant_export_download_grant')) then
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
