-- Acceptance (F3, #259): assign and discuss review items.
--
-- Proves, against the real SQL functions on an isolated disposable database:
--   * only workspace members with review access can be assigned or mentioned: an active membership in a review role, an
--     active human identity and read entitlement to the item's fund, in that workspace;
--   * a thread can only be opened on an item the caller could already read (fund and document entitlement), never across
--     tenants;
--   * assignment is assign / reassign / unassign with compare-and-set on the thread version, and assigning the current
--     assignee changes nothing;
--   * comments are append-only (no update, delete or truncate), idempotent per author, bounded, and each mention is
--     verified eligible;
--   * discussion is inert: no observation, review event, reconciliation resolution, snapshot, publication, correction or
--     outbox row changes, so a comment can never count toward dual control or decide anything;
--   * thread identity is immutable, tenants are isolated, RLS is enabled and forced with no client policy;
--   * the new notification category is accepted by the outbox and preference tables.
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

-- Tenant A (the one under test) and tenant B (isolation).
insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('a0840000-0000-4000-8000-00000000000a','review-a','Review A'),
       ('b0840000-0000-4000-8000-00000000000b','review-b','Review B');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name)
values ('a0840000-0000-4000-8000-0000000000a1','a0840000-0000-4000-8000-00000000000a','primary','A primary'),
       ('a0840000-0000-4000-8000-0000000000a2','a0840000-0000-4000-8000-00000000000a','secondary','A secondary'),
       ('b0840000-0000-4000-8000-0000000000b1','b0840000-0000-4000-8000-00000000000b','primary','B primary');

-- People in A's primary workspace:
--   e1 reviewer (the usual actor)        e2 reviewer           e3 accountadmin        e4 tenant_admin
--   e5 analyst (no review access)        e6 reviewer, no fund entitlement             e7 reviewer, membership revoked
--   e8 reviewer, identity disabled       e9 reviewer in the SECONDARY workspace only  ea reviewer, membership expired
--   eb service account reviewer (not a human identity)
insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject,status,disabled_at)
values
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000e1','oidc','idp|reviewer-1','active',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000e2','oidc','idp|reviewer-2','active',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000e3','saml','idp|account-admin','active',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000e4','oidc','idp|tenant-admin','active',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000e5','oidc','idp|analyst','active',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000e6','oidc','idp|no-fund','active',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000e7','oidc','idp|revoked','active',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000e8','oidc','idp|disabled','disabled',now()),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000e9','oidc','idp|secondary-only','active',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000ea','oidc','idp|expired','active',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000eb','service_account','svc|reviewer','active',null);
insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name,status,valid_from,valid_until)
values
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a1','a0840000-0000-4000-8000-0000000000e1','reviewer','active',now()-interval '1 day',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a1','a0840000-0000-4000-8000-0000000000e2','reviewer','active',now()-interval '1 day',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a1','a0840000-0000-4000-8000-0000000000e3','accountadmin','active',now()-interval '1 day',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a1','a0840000-0000-4000-8000-0000000000e4','tenant_admin','active',now()-interval '1 day',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a1','a0840000-0000-4000-8000-0000000000e5','analyst','active',now()-interval '1 day',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a1','a0840000-0000-4000-8000-0000000000e6','reviewer','active',now()-interval '1 day',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a1','a0840000-0000-4000-8000-0000000000e7','reviewer','revoked',now()-interval '1 day',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a1','a0840000-0000-4000-8000-0000000000e8','reviewer','active',now()-interval '1 day',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a2','a0840000-0000-4000-8000-0000000000e9','reviewer','active',now()-interval '1 day',null),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a1','a0840000-0000-4000-8000-0000000000ea','reviewer','active',now()-interval '2 days',now()-interval '1 day'),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a1','a0840000-0000-4000-8000-0000000000eb','reviewer','active',now()-interval '1 day',null);
insert into corvis_control.resource_entitlement (tenant_id,workspace_id,subject_user_id,resource_type,resource_id,permission)
select 'a0840000-0000-4000-8000-00000000000a', m.workspace_id, m.user_id, 'fund', 'f3-fund', 'read'
from corvis_control.membership m
where m.tenant_id = 'a0840000-0000-4000-8000-00000000000a'
  and m.user_id <> 'a0840000-0000-4000-8000-0000000000e6';
insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible)
values ('a0840000-0000-4000-8000-00000000000a','fund','f3-fund',true);
insert into corvis_control.notification_recipient (tenant_id,user_id,email,source)
values ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000e2','reviewer.two@example.test','verified_identity_claim');

-- Two observations (one on the entitled fund, one on a fund nobody is entitled to), and one reconciliation exception.
insert into corvis_source.document (tenant_id,document_id,display_name,media_type,status,created_by)
values ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000d1','Report.pdf','application/pdf','published','fixture');
insert into corvis_source.document_artifact_version
  (tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,size_bytes,storage_generation,malware_scan_status,quarantine_status)
values ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000d2','a0840000-0000-4000-8000-0000000000d1','f3-fixture','gs://test/f3',1,'42','clean','released');
insert into corvis_source.source_reference (tenant_id,source_reference_id,document_id,document_artifact_version_id)
values ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000d3','a0840000-0000-4000-8000-0000000000d1','a0840000-0000-4000-8000-0000000000d2');
insert into corvis_facts.observation
  (tenant_id,observation_id,fund_id,company_id,metric_code,value_number,currency,economic_period,review_state,source_reference_id,schema_version)
values
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000f1','f3-fund','company-1','revenue',100,'USD','Q2 2026','review_required','a0840000-0000-4000-8000-0000000000d3','v1'),
  ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000f2','f3-hidden-fund','company-2','revenue',200,'USD','Q2 2026','review_required','a0840000-0000-4000-8000-0000000000d3','v1');
insert into corvis_consolidated.fund_period_snapshot
  (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version)
values ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000c1','f3-fund','Q2 2026',1,'blocked','1','1');
insert into corvis_consolidated.reconciliation_exception
  (tenant_id,exception_id,snapshot_id,snapshot_version,exception_key,fund_id,report_period,exception_type,subject_type,subject_id,metric_code,summary,created_by)
values ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000f3','a0840000-0000-4000-8000-0000000000c1',1,'f3-key','f3-fund','Q2 2026','source_authority','company','company-1','revenue','Competing revenue values','fixture');

create temporary table f3_before on commit drop as
select
  (select count(*) from corvis_facts.observation) as observations,
  (select md5(string_agg(o::text, '|' order by o.observation_id)) from corvis_facts.observation o) as observation_digest,
  (select count(*) from corvis_facts.review_event) as review_events,
  (select count(*) from corvis_consolidated.reconciliation_exception) as exceptions,
  (select md5(string_agg(e::text, '|' order by e.exception_id)) from corvis_consolidated.reconciliation_exception e) as exception_digest,
  (select count(*) from corvis_consolidated.reconciliation_resolution_event) as resolutions,
  (select count(*) from corvis_consolidated.fund_period_snapshot) as snapshots,
  (select count(*) from corvis_consolidated.snapshot_publication_event) as publication_events,
  (select count(*) from corvis_control.data_correction_incident) as incidents,
  (select count(*) from corvis_control.outbox_event) as outbox_events,
  (select count(*) from corvis_control.email_outbox) as emails;

-- 1. Who is eligible.
do $$
declare
  tenant uuid := 'a0840000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0840000-0000-4000-8000-0000000000a1';
  members record;
  labelled record;
begin
  perform 1;
  if not (corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000e1', 'f3-fund')
      and corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000e3', 'f3-fund')
      and corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000e4', 'f3-fund')) then
    raise exception 'reviewers, account admins and tenant admins holding the fund are eligible';
  end if;
  if corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000e5', 'f3-fund') then raise exception 'an analyst has no review access'; end if;
  if corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000e6', 'f3-fund') then raise exception 'a reviewer without the fund entitlement is not eligible for it'; end if;
  if corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000e7', 'f3-fund') then raise exception 'a revoked membership is not eligible'; end if;
  if corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000e8', 'f3-fund') then raise exception 'a disabled identity is not eligible'; end if;
  if corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000e9', 'f3-fund') then raise exception 'a member of another workspace is not eligible here'; end if;
  if corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000ea', 'f3-fund') then raise exception 'an expired membership is not eligible'; end if;
  if corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000eb', 'f3-fund') then raise exception 'a service account is not a person who can be assigned'; end if;
  if corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000e1', 'f3-other') then raise exception 'eligibility is per fund'; end if;
  if corvis_control.review_member_eligible('b0840000-0000-4000-8000-00000000000b', workspace, 'a0840000-0000-4000-8000-0000000000e1', 'f3-fund') then raise exception 'another tenant cannot make anyone eligible'; end if;
  -- Switching the fund's data right off removes the entitlement for everyone.
  update corvis_control.data_rights set client_visible = false where tenant_id = tenant and resource_id = 'f3-fund';
  if corvis_control.review_member_eligible(tenant, workspace, 'a0840000-0000-4000-8000-0000000000e1', 'f3-fund') then raise exception 'a fund that is not client-visible grants nothing'; end if;
  update corvis_control.data_rights set client_visible = true where tenant_id = tenant and resource_id = 'f3-fund';

  select array_agg(m.member_user_id order by m.member_user_id) as ids, count(*) as total into members
  from corvis_control.review_eligible_members(tenant, workspace, 'f3-fund') m;
  if members.total <> 4 or members.ids <> array['a0840000-0000-4000-8000-0000000000e1','a0840000-0000-4000-8000-0000000000e2','a0840000-0000-4000-8000-0000000000e3','a0840000-0000-4000-8000-0000000000e4']::uuid[] then
    raise exception 'the eligible members are exactly the four reviewers, account admin and tenant admin: %', members;
  end if;
  if (select count(*) from corvis_control.review_eligible_members(tenant, workspace, 'f3-other')) <> 0 then raise exception 'nobody holds the other fund'; end if;

  -- Labels: the verified address first, then the identity subject.
  select max(l.member_label) filter (where l.member_user_id = 'a0840000-0000-4000-8000-0000000000e2') as verified,
         max(l.member_label) filter (where l.member_user_id = 'a0840000-0000-4000-8000-0000000000e1') as fallback
  into labelled from corvis_control.review_member_labels(tenant, array['a0840000-0000-4000-8000-0000000000e1','a0840000-0000-4000-8000-0000000000e2']::uuid[]) l;
  if labelled.verified <> 'reviewer.two@example.test' or labelled.fallback <> 'idp|reviewer-1' then raise exception 'unexpected member labels: %', labelled; end if;
end $$;

-- 2. Which items a caller may open a thread on.
do $$
declare
  tenant uuid := 'a0840000-0000-4000-8000-00000000000a';
begin
  if (select count(*) from corvis_control.resolve_review_subject(tenant, 'observation', 'a0840000-0000-4000-8000-0000000000f1', '["f3-fund"]', '["a0840000-0000-4000-8000-0000000000d1"]')) <> 1 then
    raise exception 'an entitled observation resolves';
  end if;
  if (select subject_fund_id || '/' || subject_report_period from corvis_control.resolve_review_subject(tenant, 'observation', 'a0840000-0000-4000-8000-0000000000f1', '["f3-fund"]', '["A0840000-0000-4000-8000-0000000000D1"]')) <> 'f3-fund/Q2 2026' then
    raise exception 'document ids compare case-insensitively and the fund and period come from the observation';
  end if;
  if exists (select 1 from corvis_control.resolve_review_subject(tenant, 'observation', 'a0840000-0000-4000-8000-0000000000f1', '[]', '["a0840000-0000-4000-8000-0000000000d1"]')) then raise exception 'no fund entitlement, no item'; end if;
  if exists (select 1 from corvis_control.resolve_review_subject(tenant, 'observation', 'a0840000-0000-4000-8000-0000000000f1', '["f3-fund"]', '[]')) then raise exception 'no document entitlement, no item'; end if;
  if exists (select 1 from corvis_control.resolve_review_subject(tenant, 'observation', 'a0840000-0000-4000-8000-0000000000f2', '["f3-fund"]', '["a0840000-0000-4000-8000-0000000000d1"]')) then raise exception 'an observation on another fund is not visible'; end if;
  if exists (select 1 from corvis_control.resolve_review_subject('b0840000-0000-4000-8000-00000000000b', 'observation', 'a0840000-0000-4000-8000-0000000000f1', '["f3-fund"]', '["a0840000-0000-4000-8000-0000000000d1"]')) then raise exception 'another tenant sees nothing'; end if;
  if (select subject_fund_id from corvis_control.resolve_review_subject(tenant, 'reconciliation_exception', 'a0840000-0000-4000-8000-0000000000f3', '["f3-fund"]', '[]')) <> 'f3-fund' then raise exception 'an entitled exception resolves'; end if;
  if exists (select 1 from corvis_control.resolve_review_subject(tenant, 'reconciliation_exception', 'a0840000-0000-4000-8000-0000000000f3', '["other"]', '[]')) then raise exception 'an exception on an unentitled fund is not visible'; end if;
  if exists (select 1 from corvis_control.resolve_review_subject(tenant, 'bogus', 'a0840000-0000-4000-8000-0000000000f3', '["f3-fund"]', '[]')) then raise exception 'an unknown kind resolves nothing'; end if;
end $$;

-- 3. Assignment: assign, no-op, reassign, unassign, compare-and-set and eligibility.
do $$
declare
  tenant uuid := 'a0840000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0840000-0000-4000-8000-0000000000a1';
  funds text := '["f3-fund"]';
  docs text := '["a0840000-0000-4000-8000-0000000000d1"]';
  obs uuid := 'a0840000-0000-4000-8000-0000000000f1';
  exc uuid := 'a0840000-0000-4000-8000-0000000000f3';
  thread corvis_control.review_item_thread%rowtype;
  again corvis_control.review_item_thread%rowtype;
begin
  select * into thread from corvis_control.set_review_item_assignee(tenant, workspace, 'observation', obs, funds::jsonb, docs::jsonb, 'oidc', 'idp|reviewer-1', 'a0840000-0000-4000-8000-0000000000e2', 0);
  if thread.assignee_user_id <> 'a0840000-0000-4000-8000-0000000000e2' or thread.version <> 1 or thread.previous_assignee_user_id is not null
     or thread.assignment_changed_by <> 'idp|reviewer-1' or thread.fund_id <> 'f3-fund' or thread.report_period <> 'Q2 2026' then
    raise exception 'first assignment: %', row_to_json(thread);
  end if;
  select * into again from corvis_control.set_review_item_assignee(tenant, workspace, 'observation', obs, funds::jsonb, docs::jsonb, 'oidc', 'idp|reviewer-1', 'a0840000-0000-4000-8000-0000000000e2', 1);
  if again.version <> 1 or again.assignment_changed_at <> thread.assignment_changed_at then raise exception 'assigning the current assignee changes nothing'; end if;
  select * into thread from corvis_control.set_review_item_assignee(tenant, workspace, 'observation', obs, funds::jsonb, docs::jsonb, 'oidc', 'idp|reviewer-1', 'a0840000-0000-4000-8000-0000000000e3', 1);
  if thread.assignee_user_id <> 'a0840000-0000-4000-8000-0000000000e3' or thread.version <> 2 or thread.previous_assignee_user_id <> 'a0840000-0000-4000-8000-0000000000e2' then
    raise exception 'reassignment keeps the previous assignee and moves the version: %', row_to_json(thread);
  end if;
  select * into thread from corvis_control.set_review_item_assignee(tenant, workspace, 'observation', obs, funds::jsonb, docs::jsonb, 'saml', 'idp|account-admin', null, 2);
  if thread.assignee_user_id is not null or thread.version <> 3 or thread.previous_assignee_user_id <> 'a0840000-0000-4000-8000-0000000000e3' or thread.assignment_changed_by <> 'idp|account-admin' then
    raise exception 'unassignment: %', row_to_json(thread);
  end if;
  select * into again from corvis_control.set_review_item_assignee(tenant, workspace, 'observation', obs, funds::jsonb, docs::jsonb, 'saml', 'idp|account-admin', null, 3);
  if again.version <> 3 then raise exception 'unassigning an unassigned item changes nothing'; end if;

  perform pg_temp.expect_error(format($f$select * from corvis_control.set_review_item_assignee(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,'oidc','idp|reviewer-1',%L,2)$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000e2'), 'review item assignment changed');
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_review_item_assignee(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,'oidc','idp|reviewer-1',%L,0)$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000e2'), 'review item assignment changed');

  -- Only people with review access to this fund in this workspace can be assigned.
  for i in 1..8 loop
    perform pg_temp.expect_error(format($f$select * from corvis_control.set_review_item_assignee(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,'oidc','idp|reviewer-1',%L,3)$f$, tenant, workspace, obs, funds, docs,
      (array['a0840000-0000-4000-8000-0000000000e5','a0840000-0000-4000-8000-0000000000e6','a0840000-0000-4000-8000-0000000000e7','a0840000-0000-4000-8000-0000000000e8',
             'a0840000-0000-4000-8000-0000000000e9','a0840000-0000-4000-8000-0000000000ea','a0840000-0000-4000-8000-0000000000eb','a0840000-0000-4000-8000-0000000000ff'])[i]),
      'review assignee not eligible');
  end loop;
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_review_item_assignee(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,'oidc','idp|reviewer-1',%L,3)$f$, tenant, 'a0840000-0000-4000-8000-0000000000a2', obs, funds, docs, 'a0840000-0000-4000-8000-0000000000e1'), 'review assignee not eligible');
  if (select version from corvis_control.review_item_thread where subject_id = obs and workspace_id = workspace) <> 3 then raise exception 'a refused assignment changes nothing'; end if;

  -- The item and the actor must exist and be visible.
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_review_item_assignee(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,'oidc','idp|reviewer-1',%L,0)$f$, tenant, workspace, 'a0840000-0000-4000-8000-0000000000f2', funds, docs, 'a0840000-0000-4000-8000-0000000000e2'), 'review item not found');
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_review_item_assignee(%L,%L,'observation',%L,'[]'::jsonb,%L::jsonb,'oidc','idp|reviewer-1',%L,3)$f$, tenant, workspace, obs, docs, 'a0840000-0000-4000-8000-0000000000e2'), 'review item not found');
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_review_item_assignee(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,'oidc','idp|nobody',%L,3)$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000e2'), 'review item actor not found');
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_review_item_assignee(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,'service_account','svc|reviewer',%L,3)$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000e2'), 'review item actor not found');
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_review_item_assignee(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,'oidc','idp|disabled',%L,3)$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000e2'), 'review item actor not found');
  perform pg_temp.expect_error(format($f$select * from corvis_control.set_review_item_assignee(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,'oidc','idp|reviewer-1',%L,3)$f$, 'b0840000-0000-4000-8000-00000000000b', workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000e2'), 'review item not found');

  -- A reconciliation exception is assigned the same way, in its own thread.
  select * into thread from corvis_control.set_review_item_assignee(tenant, workspace, 'reconciliation_exception', exc, funds::jsonb, '[]'::jsonb, 'oidc', 'idp|reviewer-1', 'a0840000-0000-4000-8000-0000000000e1', 0);
  if thread.subject_kind <> 'reconciliation_exception' or thread.assignee_user_id <> 'a0840000-0000-4000-8000-0000000000e1' or thread.version <> 1 then raise exception 'exception assignment: %', row_to_json(thread); end if;
  if (select count(*) from corvis_control.review_item_thread where tenant_id = tenant) <> 2 then raise exception 'one thread per item'; end if;
end $$;

-- 4. Comments: append-only, idempotent, bounded, with verified mentions.
do $$
declare
  tenant uuid := 'a0840000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0840000-0000-4000-8000-0000000000a1';
  funds text := '["f3-fund"]';
  docs text := '["a0840000-0000-4000-8000-0000000000d1"]';
  obs uuid := 'a0840000-0000-4000-8000-0000000000f1';
  fresh uuid := 'a0840000-0000-4000-8000-0000000000f1';
  hash text := repeat('a', 64);
  first_comment corvis_control.review_item_comment%rowtype;
  replay corvis_control.review_item_comment%rowtype;
  threads corvis_control.review_item_thread%rowtype;
begin
  select * into first_comment from corvis_control.add_review_item_comment(tenant, workspace, 'observation', obs, funds::jsonb, docs::jsonb,
    'a0840000-0000-4000-8000-0000000000c9', 'oidc', 'idp|reviewer-1', 'c-1', hash, '  Please check the source page.  ', array['a0840000-0000-4000-8000-0000000000e2']::uuid[]);
  if first_comment.body <> 'Please check the source page.' or first_comment.author_user_id <> 'a0840000-0000-4000-8000-0000000000e1'
     or first_comment.mentioned_user_ids <> array['a0840000-0000-4000-8000-0000000000e2']::uuid[] then
    raise exception 'comment: %', row_to_json(first_comment);
  end if;
  select * into threads from corvis_control.review_item_thread where tenant_id = tenant and workspace_id = workspace and subject_id = obs;
  if threads.comment_count <> 1 or threads.last_comment_at is null or threads.version <> 3 then raise exception 'a comment moves the counters and never the assignment version: %', row_to_json(threads); end if;

  select * into replay from corvis_control.add_review_item_comment(tenant, workspace, 'observation', obs, funds::jsonb, docs::jsonb,
    'a0840000-0000-4000-8000-0000000000ca', 'oidc', 'idp|reviewer-1', 'c-1', hash, 'Please check the source page.', array['a0840000-0000-4000-8000-0000000000e2']::uuid[]);
  if replay.comment_id <> first_comment.comment_id then raise exception 'the same key and content returns the original comment'; end if;
  if (select comment_count from corvis_control.review_item_thread where tenant_id = tenant and subject_id = obs) <> 1 then raise exception 'a replay adds nothing'; end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.add_review_item_comment(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,%L,'oidc','idp|reviewer-1','c-1',%L,'different',null)$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000cb', repeat('b', 64)), 'idempotency key reused with different review comment');
  perform pg_temp.expect_error(format($f$select * from corvis_control.add_review_item_comment(%L,%L,'reconciliation_exception',%L,%L::jsonb,'[]'::jsonb,%L,'oidc','idp|reviewer-1','c-1',%L,'x',null)$f$, tenant, workspace, 'a0840000-0000-4000-8000-0000000000f3', funds, 'a0840000-0000-4000-8000-0000000000cb', hash), 'idempotency key reused with different review comment');

  -- Mentions: every one must be eligible for the item; nothing is written when one is not.
  perform pg_temp.expect_error(format($f$select * from corvis_control.add_review_item_comment(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,%L,'oidc','idp|reviewer-1','c-2',%L,'hello @analyst',array[%L]::uuid[])$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000cc', hash, 'a0840000-0000-4000-8000-0000000000e5'), 'review mention not eligible');
  perform pg_temp.expect_error(format($f$select * from corvis_control.add_review_item_comment(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,%L,'oidc','idp|reviewer-1','c-2',%L,'hello',array[%L,%L]::uuid[])$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000cc', hash, 'a0840000-0000-4000-8000-0000000000e2', 'a0840000-0000-4000-8000-0000000000e6'), 'review mention not eligible');
  perform pg_temp.expect_error(format($f$select * from corvis_control.add_review_item_comment(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,%L,'oidc','idp|reviewer-1','c-2',%L,'hello',array[%L]::uuid[])$f$, tenant, 'a0840000-0000-4000-8000-0000000000a2', obs, funds, docs, 'a0840000-0000-4000-8000-0000000000cc', hash, 'a0840000-0000-4000-8000-0000000000e2'), 'review mention not eligible');
  if (select comment_count from corvis_control.review_item_thread where tenant_id = tenant and subject_id = obs) <> 1 then raise exception 'a refused comment writes nothing'; end if;

  -- Body, visibility and actor guards.
  perform pg_temp.expect_error(format($f$select * from corvis_control.add_review_item_comment(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,%L,'oidc','idp|reviewer-1','c-3',%L,'   ',null)$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000cd', hash), 'violates check constraint');
  perform pg_temp.expect_error(format($f$select * from corvis_control.add_review_item_comment(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,%L,'oidc','idp|reviewer-1','c-3',%L,%L,null)$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000cd', hash, repeat('x', 2001)), 'violates check constraint');
  perform pg_temp.expect_error(format($f$select * from corvis_control.add_review_item_comment(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,%L,'oidc','idp|reviewer-1','c-3',%L,'x',null)$f$, tenant, workspace, 'a0840000-0000-4000-8000-0000000000f2', funds, docs, 'a0840000-0000-4000-8000-0000000000cd', hash), 'review item not found');
  perform pg_temp.expect_error(format($f$select * from corvis_control.add_review_item_comment(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,%L,'oidc','idp|nobody','c-3',%L,'x',null)$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000cd', hash), 'review item actor not found');
  perform pg_temp.expect_error(format($f$select * from corvis_control.add_review_item_comment(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,%L,'oidc','idp|reviewer-1','c-3',%L,'x',array_fill(%L::uuid, array[11]))$f$, tenant, workspace, obs, funds, docs, 'a0840000-0000-4000-8000-0000000000cd', hash, 'a0840000-0000-4000-8000-0000000000e2'), 'violates check constraint');

  -- Keys are per author: a colleague may reuse the same key text.
  perform corvis_control.add_review_item_comment(tenant, workspace, 'observation', obs, funds::jsonb, docs::jsonb, 'a0840000-0000-4000-8000-0000000000ce', 'oidc', 'idp|reviewer-2', 'c-1', hash, 'Looking now.', null);
  if (select comment_count from corvis_control.review_item_thread where tenant_id = tenant and subject_id = obs) <> 2 then raise exception 'keys are scoped to the author'; end if;
  if (select array_agg(c.comment_seq order by c.comment_seq) from corvis_control.review_item_comment c where c.tenant_id = tenant and c.subject_id = obs) is null then raise exception 'comments are ordered'; end if;

  -- The thread is bounded: 200 comments, then refused.
  for i in 3..200 loop
    perform corvis_control.add_review_item_comment(tenant, workspace, 'observation', obs, funds::jsonb, docs::jsonb, gen_random_uuid(), 'oidc', 'idp|reviewer-1', 'bulk-' || i, hash, 'Comment ' || i, null);
  end loop;
  if (select comment_count from corvis_control.review_item_thread where tenant_id = tenant and subject_id = obs) <> 200 then raise exception 'two hundred comments fit'; end if;
  perform pg_temp.expect_error(format($f$select * from corvis_control.add_review_item_comment(%L,%L,'observation',%L,%L::jsonb,%L::jsonb,%L,'oidc','idp|reviewer-1','one-too-many',%L,'x',null)$f$, tenant, workspace, obs, funds, docs, gen_random_uuid(), hash), 'review comment limit reached');
end $$;

-- 5. Append-only comments and an immutable thread identity.
do $$
declare
  c uuid := (select comment_id from corvis_control.review_item_comment where idempotency_key = 'c-1' and author_subject = 'idp|reviewer-1');
begin
  perform pg_temp.expect_error(format($f$update corvis_control.review_item_comment set body = 'edited' where comment_id = %L$f$, c), 'review item comments are append-only');
  perform pg_temp.expect_error(format($f$update corvis_control.review_item_comment set mentioned_user_ids = '{}' where comment_id = %L$f$, c), 'review item comments are append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_control.review_item_comment where comment_id = %L$f$, c), 'review item comments are append-only');
  perform pg_temp.expect_error('truncate corvis_control.review_item_comment', 'review item comments are append-only');
  perform pg_temp.expect_error(format($f$update corvis_control.review_item_thread set fund_id = 'other' where subject_id = 'a0840000-0000-4000-8000-0000000000f1'$f$), 'review item thread identity is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.review_item_thread set subject_id = gen_random_uuid() where subject_id = 'a0840000-0000-4000-8000-0000000000f1'$f$), 'review item thread identity is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.review_item_thread set workspace_id = 'a0840000-0000-4000-8000-0000000000a2' where subject_id = 'a0840000-0000-4000-8000-0000000000f1'$f$), 'review item thread identity is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.review_item_thread set comment_count = 1 where subject_id = 'a0840000-0000-4000-8000-0000000000f1'$f$), 'review item thread counters only move forward');
  perform pg_temp.expect_error(format($f$update corvis_control.review_item_thread set version = 0 where subject_id = 'a0840000-0000-4000-8000-0000000000f1'$f$), 'review item thread counters only move forward');
  perform pg_temp.expect_error(format($f$delete from corvis_control.review_item_thread where subject_id = 'a0840000-0000-4000-8000-0000000000f1'$f$), 'review item threads cannot be deleted');
  perform pg_temp.expect_error('truncate corvis_control.review_item_thread', 'cannot truncate');
  perform pg_temp.expect_error('truncate corvis_control.review_item_thread cascade', 'review item threads cannot be deleted');
  perform pg_temp.expect_error($f$update corvis_control.review_item_thread set assignee_user_id = gen_random_uuid(), assignment_changed_at = null where subject_id = 'a0840000-0000-4000-8000-0000000000f1'$f$, 'violates check constraint');
end $$;

-- 6. Tenant isolation: another tenant has no threads, and cannot be given one on tenant A's items.
do $$
begin
  if exists (select 1 from corvis_control.review_item_thread where tenant_id = 'b0840000-0000-4000-8000-00000000000b') then raise exception 'tenant B has no threads'; end if;
  perform pg_temp.expect_error($f$insert into corvis_control.review_item_thread (tenant_id,workspace_id,subject_kind,subject_id,fund_id)
    values ('b0840000-0000-4000-8000-00000000000b','a0840000-0000-4000-8000-0000000000a1','observation',gen_random_uuid(),'f3-fund')$f$, 'violates foreign key constraint');
  perform pg_temp.expect_error($f$insert into corvis_control.review_item_thread (tenant_id,workspace_id,subject_kind,subject_id,fund_id)
    values ('a0840000-0000-4000-8000-00000000000a','a0840000-0000-4000-8000-0000000000a1','not-a-kind',gen_random_uuid(),'f3-fund')$f$, 'violates check constraint');
end $$;

-- 7. Discussion is inert: nothing the review decisions or dual control read has changed.
do $$
declare
  before_state record;
begin
  select * into before_state from f3_before;
  if (select count(*) from corvis_facts.observation) <> before_state.observations
     or (select md5(string_agg(o::text, '|' order by o.observation_id)) from corvis_facts.observation o) <> before_state.observation_digest then
    raise exception 'discussion must not change any observation';
  end if;
  if (select count(*) from corvis_facts.review_event) <> before_state.review_events then raise exception 'discussion must not record a review decision, so it can never count toward dual control'; end if;
  if (select count(*) from corvis_consolidated.reconciliation_exception) <> before_state.exceptions
     or (select md5(string_agg(e::text, '|' order by e.exception_id)) from corvis_consolidated.reconciliation_exception e) <> before_state.exception_digest then
    raise exception 'discussion must not change any reconciliation exception';
  end if;
  if (select count(*) from corvis_consolidated.reconciliation_resolution_event) <> before_state.resolutions then raise exception 'discussion must not resolve an exception'; end if;
  if (select count(*) from corvis_consolidated.fund_period_snapshot) <> before_state.snapshots then raise exception 'discussion must not change snapshots'; end if;
  if (select count(*) from corvis_consolidated.snapshot_publication_event) <> before_state.publication_events then raise exception 'discussion must not publish anything'; end if;
  if (select count(*) from corvis_control.data_correction_incident) <> before_state.incidents then raise exception 'discussion must not open a correction'; end if;
  if (select count(*) from corvis_control.outbox_event) <> before_state.outbox_events then raise exception 'discussion must not publish any event'; end if;
  if (select count(*) from corvis_control.email_outbox) <> before_state.emails then raise exception 'the SQL functions queue no email: notifying is the application''s best-effort step'; end if;
end $$;

-- 8. Notification category: the outbox and preferences accept it, and still refuse anything else.
do $$
declare
  tenant uuid := 'a0840000-0000-4000-8000-00000000000a';
  user_id uuid := 'a0840000-0000-4000-8000-0000000000e1';
begin
  insert into corvis_control.email_outbox (tenant_id,category,recipient_user_id,workspace_id,fund_id,required_roles,template_params,dedupe_key)
  values (tenant,'review_discussion',user_id,'a0840000-0000-4000-8000-0000000000a1','f3-fund',array['tenant_admin','accountadmin','reviewer'],'{"event":"assigned"}'::jsonb,'review_discussion:test');
  insert into corvis_control.notification_preference (tenant_id,user_id,category,enabled,delivery)
  values (tenant,user_id,'review_discussion',false,'daily_digest');
  perform pg_temp.expect_error(format($f$insert into corvis_control.email_outbox (tenant_id,category,recipient_user_id,dedupe_key) values (%L,'not_a_category',%L,'x')$f$, tenant, user_id), 'violates check constraint');
  perform pg_temp.expect_error(format($f$insert into corvis_control.notification_preference (tenant_id,user_id,category,enabled,delivery) values (%L,%L,'not_a_category',true,'immediate')$f$, tenant, user_id), 'violates check constraint');
  -- The earlier categories are still accepted.
  insert into corvis_control.email_outbox (tenant_id,category,recipient_user_id,dedupe_key) values (tenant,'data_issue_update',user_id,'data_issue_update:kept');
end $$;

-- 9. RLS: enabled and forced, no client policy, and a non-owner role without BYPASSRLS reads nothing.
do $$
declare
  offenders text;
begin
  select string_agg(c.relname, ', ') into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'corvis_control' and c.relname in ('review_item_thread','review_item_comment') and not (c.relrowsecurity and c.relforcerowsecurity);
  if offenders is not null then raise exception 'RLS must be enabled and forced on %', offenders; end if;
  if exists (select 1 from pg_policies where schemaname = 'corvis_control' and policyname <> 'corvis_runtime_service' and tablename in ('review_item_thread','review_item_comment')) then
    raise exception 'review discussion tables are server-managed: no client policy may exist';
  end if;
end $$;

drop role if exists corvis_review_discussion_negative_role;
create role corvis_review_discussion_negative_role nologin nosuperuser nobypassrls noinherit;
grant usage on schema corvis_control to corvis_review_discussion_negative_role;
grant select on corvis_control.review_item_thread, corvis_control.review_item_comment to corvis_review_discussion_negative_role;
set role corvis_review_discussion_negative_role;
do $$
begin
  set local request.jwt.claim.sub = 'a0840000-0000-4000-8000-0000000000e1';
  if (select count(*) from corvis_control.review_item_thread) <> 0 or (select count(*) from corvis_control.review_item_comment) <> 0 then
    raise exception 'a non-owner role must not read threads or comments, even as a reviewer';
  end if;
end $$;
reset role;
drop owned by corvis_review_discussion_negative_role;
drop role corvis_review_discussion_negative_role;

rollback;
