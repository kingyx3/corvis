-- Acceptance for migration 098 (F10e, #325): an Organization Admin's own deletion request, with dual approval, on top of
-- the operator deletion lifecycle (migrations 003, 017, 066).
--
-- Proves, against the real SQL functions on an isolated disposable database:
--   * only an active human Organization Admin can request or decide; a scope is 1 to 20 distinct data classes that each
--     have a retention policy in effect, and anything else is refused;
--   * a request is recorded pending, with its scope normalized, and tells every OTHER active human Organization Admin
--     (the mandatory deletion_request_approval notice, words only), never blocking the request if the outbox refuses it;
--   * one request is pending per tenant, and one nobody approved within the window lapses (audited) so it cannot block a new one;
--   * the requester can never approve or reject their own request, by subject, by a second identity of the same user,
--     or by writing the row directly (the table's own CHECK constraints refuse it);
--   * a customer request cannot reach any state the operator flow executes from (approved, executing, completed, ...)
--     without a decision by a different admin, so Corvis operations cannot run it first, even by writing the row;
--   * the approve / reject / cancel machine and its guards (note on reject, requester-only cancel, approval window,
--     expected status, terminal states are final), and request content and the decision are immutable;
--   * a legal hold (on the class, tenant-wide or a retention-policy flag) refuses the request and the approval, a released
--     hold does not, and rejecting stays possible;
--   * operator requests are unchanged (the same states and updates as before, never a customer-only state, origin immutable)
--     and are invisible to the customer decision function; tenants are isolated.
--
-- Run after supabase-auth-fixture.sql and the full migration chain. Everything is rolled back.

\set ON_ERROR_STOP on

begin;

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
values ('d0980000-0000-4000-8000-00000000000a','deletion-a','Deletion A'),
       ('d0980000-0000-4000-8000-00000000000b','deletion-b','Deletion B');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name)
values ('d0980000-0000-4000-8000-0000000000a1','d0980000-0000-4000-8000-00000000000a','primary','A primary'),
       ('d0980000-0000-4000-8000-0000000000b1','d0980000-0000-4000-8000-00000000000b','primary','B primary');
-- Tenant A: two Organization Admins (the first also has a SAML identity of the same user), a third admin, an analyst, a
-- revoked admin and a service account. Tenant B has its own admin.
insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject,status)
values ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000e1','oidc','idp|admin-one','active'),
       ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000e1','saml','saml|admin-one','active'),
       ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000e2','oidc','idp|admin-two','active'),
       ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000e3','oidc','idp|analyst','active'),
       ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000e4','oidc','idp|revoked-admin','active'),
       ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000e5','service_account','svc|robot','active'),
       ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000e6','oidc','idp|admin-three','active'),
       ('d0980000-0000-4000-8000-00000000000b','d0980000-0000-4000-8000-0000000000f1','oidc','idp|admin-b','active');
insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name,status)
values ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000a1','d0980000-0000-4000-8000-0000000000e1','tenant_admin','active'),
       ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000a1','d0980000-0000-4000-8000-0000000000e2','tenant_admin','active'),
       ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000a1','d0980000-0000-4000-8000-0000000000e3','analyst','active'),
       ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000a1','d0980000-0000-4000-8000-0000000000e4','tenant_admin','revoked'),
       ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000a1','d0980000-0000-4000-8000-0000000000e5','tenant_admin','active'),
       ('d0980000-0000-4000-8000-00000000000a','d0980000-0000-4000-8000-0000000000a1','d0980000-0000-4000-8000-0000000000e6','tenant_admin','active'),
       ('d0980000-0000-4000-8000-00000000000b','d0980000-0000-4000-8000-0000000000b1','d0980000-0000-4000-8000-0000000000f1','tenant_admin','active');
-- Retention: tenant A has policies in effect for financials, source_documents and audit, and one that only takes effect
-- in the future. Tenant B has its own financials policy.
insert into corvis_control.retention_policy (tenant_id,data_class,retention_days,policy_version,effective_from)
values ('d0980000-0000-4000-8000-00000000000a','financials',2555,'2026-01',now() - interval '30 days'),
       ('d0980000-0000-4000-8000-00000000000a','source_documents',3650,'2026-01',now() - interval '30 days'),
       ('d0980000-0000-4000-8000-00000000000a','audit',1825,'2026-01',now() - interval '30 days'),
       ('d0980000-0000-4000-8000-00000000000a','future_class',365,'2099-01',now() + interval '30 days'),
       ('d0980000-0000-4000-8000-00000000000b','financials',2555,'2026-01',now() - interval '30 days');

-- 1. Who may act, and what a scope may be.
do $$
declare
  tenant uuid := 'd0980000-0000-4000-8000-00000000000a';
  workspace uuid := 'd0980000-0000-4000-8000-0000000000a1';
  rid uuid := 'd0980000-0000-4000-8000-0000000000d0';
begin
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|analyst','["financials"]'::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace),
    'customer deletion requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|revoked-admin','["financials"]'::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace),
    'customer deletion requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'service_account','svc|robot','["financials"]'::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace),
    'customer deletion requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-b','["financials"]'::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace),
    'customer deletion requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-one','["financials"]'::jsonb,'  ab  ',168)$f$, tenant, rid, workspace),
    'customer deletion purpose required');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-one','["financials"]'::jsonb,%L,168)$f$, tenant, rid, workspace, repeat('x', 1001)),
    'customer deletion purpose required');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,'d0980000-0000-4000-8000-0000000000b1','oidc','idp|admin-one','["financials"]'::jsonb,'Leaving the platform',168)$f$, tenant, rid),
    'workspace not found');
  -- Scope: not a list, empty, too many, a non-string, blank, too long, a class with no policy, one whose policy is not in effect yet.
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-one',null,'Leaving the platform',168)$f$, tenant, rid, workspace), 'customer deletion scope invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-one','{"dataClasses":["financials"]}'::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace), 'customer deletion scope invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-one','[]'::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace), 'customer deletion scope invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-one',%L::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace,
    (select jsonb_agg('class' || n)::text from generate_series(1, 21) n)), 'customer deletion scope invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-one','[7]'::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace), 'customer deletion scope invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-one','["financials","  "]'::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace), 'customer deletion scope invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-one',%L::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace,
    jsonb_build_array(repeat('x', 101))::text), 'customer deletion scope invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-one','["no_such_class"]'::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace), 'customer deletion scope invalid');
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,%L,%L,'oidc','idp|admin-one','["financials","future_class"]'::jsonb,'Leaving the platform',168)$f$, tenant, rid, workspace), 'customer deletion scope invalid');
  -- Tenant B's policy does not cover tenant A's class of the same name the other way round: B has no source_documents.
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion('d0980000-0000-4000-8000-00000000000b',%L,'d0980000-0000-4000-8000-0000000000b1','oidc','idp|admin-b','["source_documents"]'::jsonb,'Leaving the platform',168)$f$, rid),
    'customer deletion scope invalid');
  if (select count(*) from corvis_control.deletion_request) <> 0 then raise exception 'a refused request leaves nothing behind'; end if;
  if (select count(*) from corvis_control.email_outbox where category = 'deletion_request_approval') <> 0 then raise exception 'a refused request notifies nobody'; end if;
end $$;

-- 2. A request is recorded pending, scope normalized; the other admins are told, in words only; one at a time.
do $$
declare
  tenant uuid := 'd0980000-0000-4000-8000-00000000000a';
  workspace uuid := 'd0980000-0000-4000-8000-0000000000a1';
  req corvis_control.deletion_request%rowtype;
  who text;
begin
  select * into req from corvis_control.request_customer_deletion(tenant,'d0980000-0000-4000-8000-0000000000d1',workspace,'oidc','idp|admin-one',
    '["source_documents"," financials ","financials"]'::jsonb,'  Closing the account  ',168);
  if req.state <> 'pending_customer_approval' or req.origin <> 'customer' then raise exception 'a customer request starts pending, got % / %', req.state, req.origin; end if;
  if req.scope <> '{"dataClasses":["financials","source_documents"]}'::jsonb then raise exception 'scope is trimmed, deduplicated and sorted, got %', req.scope; end if;
  if req.reason <> 'Closing the account' or req.requested_by <> 'idp|admin-one' or req.requested_by_auth_method <> 'oidc'
     or req.requested_by_user_id <> 'd0980000-0000-4000-8000-0000000000e1' or req.workspace_id <> workspace then raise exception 'the requester is recorded'; end if;
  if req.approved_by is not null or req.customer_decided_by_subject is not null or req.completed_at is not null then raise exception 'nothing is decided yet'; end if;
  if req.approval_expires_at < now() + interval '167 hours' or req.approval_expires_at > now() + interval '169 hours' then raise exception 'the approval window is the one asked for'; end if;

  select string_agg(recipient_user_id::text, ',' order by recipient_user_id) into who
  from corvis_control.email_outbox where tenant_id = tenant and category = 'deletion_request_approval';
  if who is distinct from 'd0980000-0000-4000-8000-0000000000e2,d0980000-0000-4000-8000-0000000000e6' then
    raise exception 'the approval notice goes to the other active human Organization Admins only, got %', who;
  end if;
  if exists (select 1 from corvis_control.email_outbox where tenant_id = tenant and category = 'deletion_request_approval'
             and (template_params <> '{"event":"approval_needed"}'::jsonb or required_roles <> array['tenant_admin']::text[] or workspace_id is not null or fund_id is not null or status <> 'queued')) then
    raise exception 'the approval notice carries only the event, the role to re-check and no scope';
  end if;
  if exists (select 1 from corvis_control.email_outbox where tenant_id = tenant and (template_params::text like '%financials%' or template_params::text like '%Closing%' or template_params::text like '%idp|%')) then
    raise exception 'no reason, scope or name ever enters an outbox row';
  end if;

  -- One pending request per tenant; the unique index backs the function's own check.
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,'d0980000-0000-4000-8000-0000000000d2',%L,'oidc','idp|admin-two','["audit"]'::jsonb,'A second one',168)$f$, tenant, workspace),
    'customer deletion already pending');
  perform pg_temp.expect_error(format($f$insert into corvis_control.deletion_request (tenant_id,deletion_request_id,requested_by,scope,reason,state,origin,workspace_id,requested_by_auth_method,requested_by_user_id,approval_expires_at)
    values (%L,'d0980000-0000-4000-8000-0000000000d2','idp|admin-two','{"dataClasses":["audit"]}','A second one','pending_customer_approval','customer',%L,'oidc','d0980000-0000-4000-8000-0000000000e2',now()+interval '1 day')$f$, tenant, workspace),
    'deletion_request_customer_pending_idx');
  -- Another tenant is not blocked.
  perform corvis_control.request_customer_deletion('d0980000-0000-4000-8000-00000000000b','d0980000-0000-4000-8000-0000000000d3','d0980000-0000-4000-8000-0000000000b1','oidc','idp|admin-b','["financials"]'::jsonb,'Tenant B request',168);
  -- The notice is queued once per recipient.
  if (select count(*) from corvis_control.email_outbox where tenant_id = tenant and category = 'deletion_request_approval') <> 2 then raise exception 'one notice per recipient'; end if;
end $$;

-- 3. Four eyes: nobody decides their own request, and nobody else without being an admin.
do $$
declare
  tenant uuid := 'd0980000-0000-4000-8000-00000000000a';
  rid uuid := 'd0980000-0000-4000-8000-0000000000d1';
  each_state text;
begin
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','oidc','idp|admin-one',null,null)$f$, tenant, rid), 'customer deletion requires an independent approver');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','saml','saml|admin-one',null,null)$f$, tenant, rid), 'customer deletion requires an independent approver');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'reject','oidc','idp|admin-one','No',null)$f$, tenant, rid), 'customer deletion requires an independent approver');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','oidc','idp|analyst',null,null)$f$, tenant, rid), 'customer deletion requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','oidc','idp|revoked-admin',null,null)$f$, tenant, rid), 'customer deletion requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','oidc','idp|admin-b',null,null)$f$, tenant, rid), 'customer deletion requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','service_account','svc|robot',null,null)$f$, tenant, rid), 'customer deletion requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'bogus','oidc','idp|admin-two',null,null)$f$, tenant, rid), 'customer deletion transition not allowed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','oidc','idp|admin-two',null,'approved')$f$, tenant, rid), 'customer deletion status changed');
  -- The table refuses a requester recorded as the decider, by subject or by user, however the row is written.
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='approved', customer_decided_by_subject='idp|admin-one', customer_decided_by_user_id='d0980000-0000-4000-8000-0000000000e2', customer_decided_at=now() where deletion_request_id=%L$f$, rid),
    'deletion_request_customer_four_eyes_check');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='approved', customer_decided_by_subject='saml|admin-one', customer_decided_by_user_id='d0980000-0000-4000-8000-0000000000e1', customer_decided_at=now() where deletion_request_id=%L$f$, rid),
    'deletion_request_customer_four_eyes_check');
  -- A customer request cannot be in any state the operator flow acts from without a decision: not by a transition (the
  -- guard trigger) and not by writing such a row outright (the table's own CHECK), so Corvis operations cannot run it first.
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='approved' where deletion_request_id=%L$f$, rid), 'deletion_request_customer_state_decision_check');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='executing' where deletion_request_id=%L$f$, rid), 'customer deletion transition not allowed');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='completed', completed_at=now() where deletion_request_id=%L$f$, rid), 'customer deletion transition not allowed');
  foreach each_state in array array['requested','approved','executing','completed','blocked','retryable'] loop
    perform pg_temp.expect_error(format($f$insert into corvis_control.deletion_request (tenant_id,requested_by,scope,reason,state,origin,workspace_id,requested_by_auth_method,requested_by_user_id,approval_expires_at)
      values (%L,'idp|admin-one','{"dataClasses":["audit"]}','Direct write',%L,'customer','d0980000-0000-4000-8000-0000000000a1','oidc','d0980000-0000-4000-8000-0000000000e1',now()+interval '1 day')$f$, tenant, each_state),
      'deletion_request_customer_state_decision_check');
  end loop;
  -- A cancellation by a stranger is refused; so is a decision on another tenant's request (no row at all).
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'cancel','oidc','idp|admin-two',null,null)$f$, tenant, rid), 'customer deletion can only be cancelled by its requester');
  if exists (select 1 from corvis_control.decide_customer_deletion('d0980000-0000-4000-8000-00000000000b', rid, 'approve', 'oidc', 'idp|admin-b', null, null)) then raise exception 'another tenant sees nothing of this request'; end if;
  if exists (select 1 from corvis_control.decide_customer_deletion(tenant, 'd0980000-0000-4000-8000-0000000000ff', 'approve', 'oidc', 'idp|admin-two', null, null)) then raise exception 'an unknown request is no row'; end if;
  if (select state from corvis_control.deletion_request where deletion_request_id = rid) <> 'pending_customer_approval' then raise exception 'every refusal left the request pending'; end if;
end $$;

-- 4. Content and the decision are immutable; a customer request only moves along the allowed transitions.
do $$
declare
  tenant uuid := 'd0980000-0000-4000-8000-00000000000a';
  rid uuid := 'd0980000-0000-4000-8000-0000000000d1';
  req corvis_control.deletion_request%rowtype;
begin
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set scope='{"dataClasses":["audit"]}' where deletion_request_id=%L$f$, rid), 'customer deletion request content is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set reason='Something else' where deletion_request_id=%L$f$, rid), 'customer deletion request content is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set requested_by='idp|admin-two' where deletion_request_id=%L$f$, rid), 'customer deletion request content is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set approval_expires_at=now()+interval '99 days' where deletion_request_id=%L$f$, rid), 'customer deletion request content is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set origin='operator' where deletion_request_id=%L$f$, rid), 'deletion request origin is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='blocked' where deletion_request_id=%L$f$, rid), 'customer deletion transition not allowed');

  -- Approval by the second admin hands the request to the operator flow.
  select * into req from corvis_control.decide_customer_deletion(tenant, rid, 'approve', 'oidc', 'idp|admin-two', 'Agreed', 'pending_customer_approval');
  if req.state <> 'approved' or req.customer_decided_by_subject <> 'idp|admin-two' or req.customer_decided_by_user_id <> 'd0980000-0000-4000-8000-0000000000e2'
     or req.customer_decided_at is null or req.customer_decision_note <> 'Agreed' then raise exception 'the decision is recorded'; end if;
  if req.approved_by <> 'idp|admin-two' or req.approved_at is null then raise exception 'approval is recorded where the operator flow reads it'; end if;
  if req.customer_cancelled_at is not null or req.completed_at is not null then raise exception 'nothing else changed'; end if;

  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','oidc','idp|admin-three',null,null)$f$, tenant, rid), 'customer deletion transition not allowed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'cancel','oidc','idp|admin-one',null,null)$f$, tenant, rid), 'customer deletion transition not allowed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'reject','oidc','idp|admin-three','Too late',null)$f$, tenant, rid), 'customer deletion transition not allowed');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set customer_decided_by_subject='idp|admin-three', customer_decided_by_user_id='d0980000-0000-4000-8000-0000000000e6' where deletion_request_id=%L$f$, rid), 'customer deletion decision is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set customer_decision_note='Changed' where deletion_request_id=%L$f$, rid), 'customer deletion decision is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='pending_customer_approval' where deletion_request_id=%L$f$, rid), 'customer deletion transition not allowed');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='rejected' where deletion_request_id=%L$f$, rid), 'customer deletion transition not allowed');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='expired' where deletion_request_id=%L$f$, rid), 'customer deletion transition not allowed');

  -- From here the unchanged operator flow moves it: claim, block, retry, complete.
  update corvis_control.deletion_request set state='executing', execution_attempts=1, execution_lease_expires_at=now()+interval '10 minutes' where deletion_request_id=rid;
  update corvis_control.deletion_request set state='blocked', blocked_reason='legal_hold', execution_lease_expires_at=null where deletion_request_id=rid;
  update corvis_control.deletion_request set state='executing', execution_attempts=2 where deletion_request_id=rid;
  update corvis_control.deletion_request set state='retryable', last_error='adapter down' where deletion_request_id=rid;
  update corvis_control.deletion_request set state='executing', execution_attempts=3 where deletion_request_id=rid;
  update corvis_control.deletion_request set state='completed', completed_at=now(), completion_evidence='{}' where deletion_request_id=rid;
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='cancelled', customer_cancelled_at=now() where deletion_request_id=%L$f$, rid), 'customer deletion transition not allowed');
  if (select approved_by from corvis_control.deletion_request where deletion_request_id = rid) <> 'idp|admin-two' then raise exception 'the executor never overwrites the customer approver'; end if;
end $$;

-- 5. Reject (needs a note), cancel (requester only), the expected-state guard, and terminal states.
do $$
declare
  tenant uuid := 'd0980000-0000-4000-8000-00000000000a';
  workspace uuid := 'd0980000-0000-4000-8000-0000000000a1';
  req corvis_control.deletion_request%rowtype;
begin
  select * into req from corvis_control.request_customer_deletion(tenant,'d0980000-0000-4000-8000-0000000000d4',workspace,'oidc','idp|admin-one','["audit"]'::jsonb,'Audit clean-up',168);
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'reject','oidc','idp|admin-two','   ',null)$f$, tenant, req.deletion_request_id), 'customer deletion decision note required');
  select * into req from corvis_control.decide_customer_deletion(tenant, req.deletion_request_id, 'reject', 'oidc', 'idp|admin-two', ' Not now ', 'pending_customer_approval');
  if req.state <> 'rejected' or req.customer_decision_note <> 'Not now' or req.customer_decided_by_subject <> 'idp|admin-two' or req.approved_by is not null or req.approved_at is not null then
    raise exception 'a rejection records the decision and approves nothing';
  end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','oidc','idp|admin-two',null,null)$f$, tenant, req.deletion_request_id), 'customer deletion transition not allowed');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='approved' where deletion_request_id=%L$f$, req.deletion_request_id), 'customer deletion transition not allowed');

  -- The requester withdraws before anyone approves; that is not a decision.
  select * into req from corvis_control.request_customer_deletion(tenant,'d0980000-0000-4000-8000-0000000000d5',workspace,'oidc','idp|admin-two','["audit"]'::jsonb,'Second thoughts',168);
  select * into req from corvis_control.decide_customer_deletion(tenant, req.deletion_request_id, 'cancel', 'oidc', 'idp|admin-two', 'ignored', null);
  if req.state <> 'cancelled' or req.customer_cancelled_at is null or req.customer_decided_by_subject is not null or req.customer_decision_note is not null or req.approved_by is not null then
    raise exception 'a withdrawal is not a decision';
  end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','oidc','idp|admin-one',null,null)$f$, tenant, req.deletion_request_id), 'customer deletion transition not allowed');
  -- A withdrawn request no longer blocks a new one.
  select * into req from corvis_control.request_customer_deletion(tenant,'d0980000-0000-4000-8000-0000000000d6',workspace,'oidc','idp|admin-two','["audit"]'::jsonb,'Try again',168);
  select * into req from corvis_control.decide_customer_deletion(tenant, req.deletion_request_id, 'cancel', 'oidc', 'idp|admin-two', null, null);
end $$;

-- 6. The approval window: a lapsed request cannot be decided, and the next request lapses it (audited) instead of being blocked by it.
do $$
declare
  tenant uuid := 'd0980000-0000-4000-8000-00000000000a';
  workspace uuid := 'd0980000-0000-4000-8000-0000000000a1';
  stale uuid := 'd0980000-0000-4000-8000-0000000000d7';
  req corvis_control.deletion_request%rowtype;
begin
  insert into corvis_control.deletion_request (tenant_id,deletion_request_id,requested_by,scope,reason,state,origin,workspace_id,requested_at,requested_by_auth_method,requested_by_user_id,approval_expires_at)
  values (tenant,stale,'idp|admin-one','{"dataClasses":["audit"]}','Stale request','pending_customer_approval','customer',workspace,now() - interval '10 days','oidc','d0980000-0000-4000-8000-0000000000e1',now() - interval '3 days');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','oidc','idp|admin-two',null,null)$f$, tenant, stale), 'customer deletion approval window has passed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'reject','oidc','idp|admin-two','No',null)$f$, tenant, stale), 'customer deletion approval window has passed');
  -- Its requester may still withdraw it.
  select * into req from corvis_control.request_customer_deletion(tenant,'d0980000-0000-4000-8000-0000000000d8',workspace,'oidc','idp|admin-two','["audit"]'::jsonb,'After the lapse',168);
  if (select state from corvis_control.deletion_request where deletion_request_id = stale) <> 'expired' then raise exception 'the stale request lapsed'; end if;
  if req.state <> 'pending_customer_approval' then raise exception 'the new request is not blocked by a lapsed one'; end if;
  if (select count(*) from corvis_control.audit_event where tenant_id = tenant and action = 'deletion_request.customer_expired' and target_id = stale::text
        and actor_subject = 'system:customer-deletion' and target_type = 'deletion_request' and workspace_id = workspace and metadata = '{"status":"expired"}'::jsonb) <> 1 then
    raise exception 'the lapse is audited once, by the system, in the transaction that did it';
  end if;
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='pending_customer_approval' where deletion_request_id=%L$f$, stale), 'customer deletion transition not allowed');
  perform corvis_control.decide_customer_deletion(tenant, req.deletion_request_id, 'cancel', 'oidc', 'idp|admin-two', null, null);
end $$;

-- 7. Legal holds block the request and the approval.
do $$
declare
  tenant uuid := 'd0980000-0000-4000-8000-00000000000a';
  workspace uuid := 'd0980000-0000-4000-8000-0000000000a1';
  req corvis_control.deletion_request%rowtype;
  hold uuid;
begin
  if corvis_control.deletion_scope_legal_hold(tenant, '["financials"]'::jsonb) then raise exception 'no hold yet'; end if;
  if corvis_control.deletion_scope_legal_hold(tenant, null) or corvis_control.deletion_scope_legal_hold(tenant, '"financials"'::jsonb) or corvis_control.deletion_scope_legal_hold(tenant, '[]'::jsonb) then
    raise exception 'a scope that names no class matches no hold';
  end if;

  -- A hold on the class refuses a request for it, but not for another class.
  insert into corvis_control.legal_hold (tenant_id,data_class,scope,matter_reference,placed_by)
  values (tenant,'financials','{"documentIds":["a"]}','MATTER-1','ops') returning legal_hold_id into hold;
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,'d0980000-0000-4000-8000-0000000000d9',%L,'oidc','idp|admin-one','["financials","audit"]'::jsonb,'Held',168)$f$, tenant, workspace), 'customer deletion blocked by legal hold');
  select * into req from corvis_control.request_customer_deletion(tenant,'d0980000-0000-4000-8000-0000000000da',workspace,'oidc','idp|admin-one','["audit"]'::jsonb,'Audit only',168);
  -- A hold placed after the request stops its approval; rejecting stays possible.
  update corvis_control.legal_hold set released_by='ops', released_at=now() where legal_hold_id = hold;
  insert into corvis_control.legal_hold (tenant_id,data_class,scope,matter_reference,placed_by) values (tenant,null,'{}','MATTER-ALL','ops') returning legal_hold_id into hold;
  perform pg_temp.expect_error(format($f$select * from corvis_control.decide_customer_deletion(%L,%L,'approve','oidc','idp|admin-two',null,null)$f$, tenant, req.deletion_request_id), 'customer deletion blocked by legal hold');
  if (select state from corvis_control.deletion_request where deletion_request_id = req.deletion_request_id) <> 'pending_customer_approval' then raise exception 'a blocked approval changes nothing'; end if;
  select * into req from corvis_control.decide_customer_deletion(tenant, req.deletion_request_id, 'reject', 'oidc', 'idp|admin-two', 'A hold now applies', null);
  if req.state <> 'rejected' then raise exception 'rejecting is allowed under a hold'; end if;
  -- A tenant-wide hold refuses any request; releasing it lifts the block; a released hold never counts.
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,'d0980000-0000-4000-8000-0000000000db',%L,'oidc','idp|admin-one','["audit"]'::jsonb,'Held',168)$f$, tenant, workspace), 'customer deletion blocked by legal hold');
  update corvis_control.legal_hold set released_by='ops', released_at=now() where legal_hold_id = hold;
  if corvis_control.deletion_scope_legal_hold(tenant, '["financials","audit"]'::jsonb) then raise exception 'released holds do not count'; end if;
  -- A hold on another tenant never reaches this one.
  insert into corvis_control.legal_hold (tenant_id,data_class,scope,matter_reference,placed_by) values ('d0980000-0000-4000-8000-00000000000b',null,'{}','MATTER-B','ops');
  if corvis_control.deletion_scope_legal_hold(tenant, '["financials"]'::jsonb) then raise exception 'tenant isolation of holds'; end if;
  -- The retention policy's own legal_hold flag is a hold too (the rule deletion execution applies).
  update corvis_control.retention_policy set legal_hold = true where tenant_id = tenant and data_class = 'source_documents';
  perform pg_temp.expect_error(format($f$select * from corvis_control.request_customer_deletion(%L,'d0980000-0000-4000-8000-0000000000dc',%L,'oidc','idp|admin-one','["source_documents"]'::jsonb,'Flagged',168)$f$, tenant, workspace), 'customer deletion blocked by legal hold');
  if not corvis_control.deletion_scope_legal_hold(tenant, '["audit","source_documents"]'::jsonb) then raise exception 'the policy flag is a hold'; end if;
  update corvis_control.retention_policy set legal_hold = false where tenant_id = tenant and data_class = 'source_documents';
  select * into req from corvis_control.request_customer_deletion(tenant,'d0980000-0000-4000-8000-0000000000dd',workspace,'oidc','idp|admin-one','["source_documents"]'::jsonb,'Released',168);
  perform corvis_control.decide_customer_deletion(tenant, req.deletion_request_id, 'cancel', 'oidc', 'idp|admin-one', null, null);
end $$;

-- 8. Operator requests are unchanged and unreachable through the customer functions.
do $$
declare
  tenant uuid := 'd0980000-0000-4000-8000-00000000000a';
  op uuid := 'd0980000-0000-4000-8000-0000000000e0';
begin
  insert into corvis_control.deletion_request (tenant_id,deletion_request_id,requested_by,scope,reason,state,requested_at)
  values (tenant,op,'ops-admin','{"dataClasses":["audit"]}','Operator reason','requested',now());
  if (select origin from corvis_control.deletion_request where deletion_request_id = op) <> 'operator' then raise exception 'an operator row keeps the default origin'; end if;
  update corvis_control.deletion_request set state='executing', approved_by='ops-two', approved_at=now(), execution_attempts=1 where deletion_request_id=op;
  update corvis_control.deletion_request set state='blocked', blocked_reason='legal_hold' where deletion_request_id=op;
  update corvis_control.deletion_request set state='retryable' where deletion_request_id=op;
  update corvis_control.deletion_request set state='executing', execution_attempts=2 where deletion_request_id=op;
  update corvis_control.deletion_request set state='completed', completed_at=now() where deletion_request_id=op;
  if exists (select 1 from corvis_control.decide_customer_deletion(tenant, op, 'approve', 'oidc', 'idp|admin-two', null, null)) then raise exception 'the customer function never touches an operator request'; end if;
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set origin='customer' where deletion_request_id=%L$f$, op), 'deletion request origin is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='rejected', customer_decision_note='x' where deletion_request_id=%L$f$, op), 'deletion_request_customer_state_check');
  perform pg_temp.expect_error(format($f$insert into corvis_control.deletion_request (tenant_id,requested_by,scope,reason,state) values (%L,'ops','{"dataClasses":["audit"]}','x','pending_customer_approval')$f$, tenant), 'deletion_request_customer_state_check');
  perform pg_temp.expect_error(format($f$insert into corvis_control.deletion_request (tenant_id,requested_by,scope,reason,state,requested_by_user_id) values (%L,'ops','{"dataClasses":["audit"]}','x','requested','d0980000-0000-4000-8000-0000000000e1')$f$, tenant), 'deletion_request_operator_fields_check');
  -- A customer row must name its requester, workspace and window.
  perform pg_temp.expect_error(format($f$insert into corvis_control.deletion_request (tenant_id,requested_by,scope,reason,state,origin) values (%L,'x','{"dataClasses":["audit"]}','Reason','pending_customer_approval','customer')$f$, tenant), 'deletion_request_customer_fields_check');
  perform pg_temp.expect_error(format($f$insert into corvis_control.deletion_request (tenant_id,requested_by,scope,reason,state,origin) values (%L,'x','{}','Reason','requested','bogus')$f$, tenant), 'deletion_request_origin_check');
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_request set state='rejected' where deletion_request_id=%L$f$, 'd0980000-0000-4000-8000-0000000000d1'), 'customer deletion transition not allowed');
end $$;

-- 9. Category rules: the approval notice is mandatory (never a stored preference); a notification fault never blocks the request.
do $$
declare
  tenant uuid := 'd0980000-0000-4000-8000-00000000000a';
  workspace uuid := 'd0980000-0000-4000-8000-0000000000a1';
  one uuid := 'd0980000-0000-4000-8000-0000000000e1';
  req corvis_control.deletion_request%rowtype;
  before_rows integer;
begin
  perform pg_temp.expect_error(format($f$insert into corvis_control.notification_preference (tenant_id,user_id,category,enabled,delivery) values (%L,%L,'deletion_request_approval',false,'immediate')$f$, tenant, one),
    'notification_preference_category_check');
  perform pg_temp.expect_error(format($f$insert into corvis_control.email_outbox (tenant_id,category,recipient_user_id,dedupe_key) values (%L,'deletion_request_bogus',%L,'x')$f$, tenant, one),
    'email_outbox_category_check');
  select count(*) into before_rows from corvis_control.email_outbox where tenant_id = tenant;
  alter table corvis_control.email_outbox add constraint f10e_block_notices check (category <> 'deletion_request_approval') not valid;
  select * into req from corvis_control.request_customer_deletion(tenant,'d0980000-0000-4000-8000-0000000000de',workspace,'oidc','idp|admin-one','["audit"]'::jsonb,'Faulty outbox',168);
  if req.state <> 'pending_customer_approval' then raise exception 'the request stands without its notice'; end if;
  if (select count(*) from corvis_control.email_outbox where tenant_id = tenant) <> before_rows then raise exception 'the refused notice was not queued'; end if;
  alter table corvis_control.email_outbox drop constraint f10e_block_notices;
  perform corvis_control.decide_customer_deletion(tenant, req.deletion_request_id, 'approve', 'oidc', 'idp|admin-two', null, null);
end $$;

-- 10. Tenant isolation: tenant B sees none of tenant A's requests and has its own pending one.
do $$
begin
  if (select count(*) from corvis_control.deletion_request where tenant_id = 'd0980000-0000-4000-8000-00000000000b') <> 1 then raise exception 'tenant B has exactly its own request'; end if;
  if (select state from corvis_control.deletion_request where deletion_request_id = 'd0980000-0000-4000-8000-0000000000d3') <> 'pending_customer_approval' then raise exception 'tenant A work never touched tenant B'; end if;
end $$;

rollback;
