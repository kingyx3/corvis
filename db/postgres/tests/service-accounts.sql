-- Acceptance for migration 088 (F6, #262): customer self-service service accounts and their credential records.
--
-- Proves, against the real SQL functions on an isolated disposable database:
--   * only an active Organization Admin (tenant_admin) acts, by human identity: an analyst, a revoked admin, a service
--     account, an unknown subject and another tenant's admin are all refused, and nothing is left behind;
--   * creation validates its input (name, purpose, role, expiry, workspace) and refuses every administrator role, so a
--     machine is never an administrator; names are unique among active accounts and the quota holds;
--   * creating an account writes exactly the rows the existing authorization lookup resolves (identity subject,
--     membership, 009 lifecycle grant) and stores only the SHA-256 of the credential secret;
--   * issue / rotate / revoke: one current credential, a rotation overlap that never exceeds a day and ends any earlier
--     overlap, an expired current credential making way for a new one, revocation effective at once, and a credential
--     never outliving its account;
--   * disabling deactivates the account everywhere (identity, lifecycle grant, memberships, entitlements, credentials)
--     and is final;
--   * the guard triggers: a credential's hash and lifetime are immutable, a revoked credential stays revoked, an end
--     date can only be brought forward, and an account's identity never changes;
--   * renewal and ownership (F6b, migration 092): the creating admin is the first owner; extending moves the expiry at least
--     a day later (never earlier, never past the maximum from now) together with the membership and the 009 lifecycle grant
--     (valid_until, next_review_at, a fresh review), leaves credentials alone, and is refused for anyone but an active
--     Organization Admin; the owner changes only by transfer to another active Organization Admin; an owner who is
--     deactivated or demoted leaves the account working but ownerless, so it is not extended until it has a new owner;
--     a deactivated account can be neither extended nor handed over; an expired account can be renewed;
--   * tenants are isolated, and RLS is enabled and forced with no client policy on both tables.
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

-- A 64-hex digest distinct per label, standing in for the SHA-256 of a secret.
create function pg_temp.digest_of(label text) returns text language sql as $$ select encode(digest(label, 'sha256'), 'hex') $$;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('a0880000-0000-4000-8000-00000000000a','sa-a','SA A'),
       ('b0880000-0000-4000-8000-00000000000b','sa-b','SA B');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name,status)
values ('a0880000-0000-4000-8000-0000000000a1','a0880000-0000-4000-8000-00000000000a','primary','A primary','active'),
       ('a0880000-0000-4000-8000-0000000000a2','a0880000-0000-4000-8000-00000000000a','research','A research','active'),
       ('a0880000-0000-4000-8000-0000000000a3','a0880000-0000-4000-8000-00000000000a','paused','A paused','suspended'),
       ('b0880000-0000-4000-8000-0000000000b1','b0880000-0000-4000-8000-00000000000b','primary','B primary','active');
insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject,status)
values ('a0880000-0000-4000-8000-00000000000a','a0880000-0000-4000-8000-0000000000e1','oidc','idp|admin-one','active'),
       ('a0880000-0000-4000-8000-00000000000a','a0880000-0000-4000-8000-0000000000e3','oidc','idp|analyst','active'),
       ('a0880000-0000-4000-8000-00000000000a','a0880000-0000-4000-8000-0000000000e4','oidc','idp|revoked-admin','active'),
       ('a0880000-0000-4000-8000-00000000000a','a0880000-0000-4000-8000-0000000000e5','service_account','svc|robot','active'),
       ('b0880000-0000-4000-8000-00000000000b','b0880000-0000-4000-8000-0000000000f1','oidc','idp|admin-b','active');
insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name,status)
values ('a0880000-0000-4000-8000-00000000000a','a0880000-0000-4000-8000-0000000000a1','a0880000-0000-4000-8000-0000000000e1','tenant_admin','active'),
       ('a0880000-0000-4000-8000-00000000000a','a0880000-0000-4000-8000-0000000000a1','a0880000-0000-4000-8000-0000000000e3','analyst','active'),
       ('a0880000-0000-4000-8000-00000000000a','a0880000-0000-4000-8000-0000000000a1','a0880000-0000-4000-8000-0000000000e4','tenant_admin','revoked'),
       ('a0880000-0000-4000-8000-00000000000a','a0880000-0000-4000-8000-0000000000a1','a0880000-0000-4000-8000-0000000000e5','tenant_admin','active'),
       ('b0880000-0000-4000-8000-00000000000b','b0880000-0000-4000-8000-0000000000b1','b0880000-0000-4000-8000-0000000000f1','tenant_admin','active');

-- 1. Who may act, and what a refused call leaves behind.
do $$
declare
  tenant uuid := 'a0880000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0880000-0000-4000-8000-0000000000a1';
begin
  if corvis_control.service_account_admin_user(tenant,'oidc','idp|admin-one') <> 'a0880000-0000-4000-8000-0000000000e1' then raise exception 'an active admin resolves to its user'; end if;
  if corvis_control.service_account_admin_user(tenant,'oidc','idp|analyst') is not null then raise exception 'an analyst is not an organization admin'; end if;
  if corvis_control.service_account_admin_user(tenant,'oidc','idp|revoked-admin') is not null then raise exception 'a revoked admin membership does not count'; end if;
  if corvis_control.service_account_admin_user(tenant,'service_account','svc|robot') is not null then raise exception 'a service account never acts as an organization admin, even holding the role'; end if;
  if corvis_control.service_account_admin_user(tenant,'oidc','idp|nobody') is not null then raise exception 'an unknown subject is not an admin'; end if;
  if corvis_control.service_account_admin_user(tenant,'oidc','idp|admin-b') is not null then raise exception 'an admin of another tenant is not an admin here'; end if;

  perform pg_temp.expect_error(format($f$select * from corvis_control.create_service_account(%L,gen_random_uuid(),gen_random_uuid(),%L,%L,'Reporting sync','Nightly reporting',%L,'analyst',now()+interval '30 days',now()+interval '10 days',pg_temp.digest_of('x'),100)$f$,
    tenant,'oidc','idp|analyst',workspace), 'service account requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_service_account(%L,gen_random_uuid(),gen_random_uuid(),%L,%L,'Reporting sync','Nightly reporting',%L,'analyst',now()+interval '30 days',now()+interval '10 days',pg_temp.digest_of('x'),100)$f$,
    tenant,'oidc','idp|revoked-admin',workspace), 'service account requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_service_account(%L,gen_random_uuid(),gen_random_uuid(),%L,%L,'Reporting sync','Nightly reporting',%L,'analyst',now()+interval '30 days',now()+interval '10 days',pg_temp.digest_of('x'),100)$f$,
    tenant,'service_account','svc|robot',workspace), 'service account requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_service_account(%L,gen_random_uuid(),gen_random_uuid(),%L,%L,'Reporting sync','Nightly reporting',%L,'analyst',now()+interval '30 days',now()+interval '10 days',pg_temp.digest_of('x'),100)$f$,
    tenant,'oidc','idp|admin-b',workspace), 'service account requires an active organization admin');
  if (select count(*) from corvis_control.service_account) <> 0
     or (select count(*) from corvis_control.service_account_credential) <> 0
     or exists (select 1 from corvis_control.identity_subject where auth_method = 'service_account' and subject like 'service-account:%') then
    raise exception 'a refused call leaves nothing behind';
  end if;
end $$;

-- 2. Input validation.
do $$
declare
  tenant uuid := 'a0880000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0880000-0000-4000-8000-0000000000a1';
  base text := $f$select * from corvis_control.create_service_account(%L,gen_random_uuid(),gen_random_uuid(),'oidc','idp|admin-one',%s,%s,%s,%s,%s,%s,pg_temp.digest_of('x'),100)$f$;
begin
  perform pg_temp.expect_error(format(base, tenant, quote_literal('ab'), quote_literal('Nightly reporting'), quote_literal(workspace), quote_literal('analyst'), $e$now()+interval '30 days'$e$, $e$now()+interval '10 days'$e$), 'service account name required');
  perform pg_temp.expect_error(format(base, tenant, 'null', quote_literal('Nightly reporting'), quote_literal(workspace), quote_literal('analyst'), $e$now()+interval '30 days'$e$, $e$now()+interval '10 days'$e$), 'service account name required');
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('  x '), quote_literal(workspace), quote_literal('analyst'), $e$now()+interval '30 days'$e$, $e$now()+interval '10 days'$e$), 'service account purpose required');
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal(repeat('p',513)), quote_literal(workspace), quote_literal('analyst'), $e$now()+interval '30 days'$e$, $e$now()+interval '10 days'$e$), 'service account purpose required');
  -- A machine is never an administrator: every administrator role, and any unknown role, is refused.
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal(workspace), quote_literal('tenant_admin'), $e$now()+interval '30 days'$e$, $e$now()+interval '10 days'$e$), 'service account role not allowed');
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal(workspace), quote_literal('accountadmin'), $e$now()+interval '30 days'$e$, $e$now()+interval '10 days'$e$), 'service account role not allowed');
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal(workspace), quote_literal('workspace_admin'), $e$now()+interval '30 days'$e$, $e$now()+interval '10 days'$e$), 'service account role not allowed');
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal(workspace), 'null', $e$now()+interval '30 days'$e$, $e$now()+interval '10 days'$e$), 'service account role not allowed');
  -- Finite lifetimes: in the future, at most a year (366 days with the day of grace), and a credential must itself expire in the future.
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal(workspace), quote_literal('analyst'), $e$now()-interval '1 day'$e$, $e$now()+interval '10 days'$e$), 'service account expiry invalid');
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal(workspace), quote_literal('analyst'), $e$now()+interval '400 days'$e$, $e$now()+interval '10 days'$e$), 'service account expiry invalid');
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal(workspace), quote_literal('analyst'), 'null', $e$now()+interval '10 days'$e$), 'service account expiry invalid');
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal(workspace), quote_literal('analyst'), $e$now()+interval '30 days'$e$, $e$now()-interval '1 minute'$e$), 'service account expiry invalid');
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal(workspace), quote_literal('analyst'), $e$now()+interval '30 days'$e$, 'null'), 'service account expiry invalid');
  -- The workspace must be an active workspace of this tenant: another tenant's, a suspended one and an unknown one are the same refusal.
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal('b0880000-0000-4000-8000-0000000000b1'), quote_literal('analyst'), $e$now()+interval '30 days'$e$, $e$now()+interval '10 days'$e$), 'workspace not found');
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal('a0880000-0000-4000-8000-0000000000a3'), quote_literal('analyst'), $e$now()+interval '30 days'$e$, $e$now()+interval '10 days'$e$), 'workspace not found');
  perform pg_temp.expect_error(format(base, tenant, quote_literal('Reporting sync'), quote_literal('Nightly reporting'), quote_literal('a0880000-0000-4000-8000-0000000000ff'), quote_literal('analyst'), $e$now()+interval '30 days'$e$, $e$now()+interval '10 days'$e$), 'workspace not found');
  if (select count(*) from corvis_control.service_account) <> 0 then raise exception 'a refused creation leaves nothing behind'; end if;
end $$;

-- 3. Creation writes the rows the existing authorization lookup resolves, and stores only a hash.
do $$
declare
  tenant uuid := 'a0880000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0880000-0000-4000-8000-0000000000a1';
  account corvis_control.service_account%rowtype;
  grant_row corvis_control.service_identity_grant%rowtype;
  stored corvis_control.service_account_credential%rowtype;
begin
  select * into account from corvis_control.create_service_account(tenant,'a0880000-0000-4000-8000-0000000000c1','a0880000-0000-4000-8000-0000000000d1','oidc','idp|admin-one',
    '  Reporting sync ','  Pulls published data nightly ',workspace,'analyst',now()+interval '30 days',now()+interval '90 days',pg_temp.digest_of('secret-1'),100);
  if account.service_account_id <> 'a0880000-0000-4000-8000-0000000000c1' or account.status <> 'active' then raise exception 'the account is created active'; end if;
  if account.display_name <> 'Reporting sync' or account.purpose <> 'Pulls published data nightly' then raise exception 'name and purpose are trimmed'; end if;
  if account.created_by_subject <> 'idp|admin-one' or account.created_by_user_id <> 'a0880000-0000-4000-8000-0000000000e1' then raise exception 'the creator is recorded'; end if;
  if account.subject <> 'service-account:a0880000-0000-4000-8000-0000000000c1' or account.auth_method <> 'service_account' then raise exception 'the subject is derived from the account id'; end if;
  if account.role_name <> 'analyst' or account.workspace_id <> workspace then raise exception 'role and workspace are recorded'; end if;

  -- The identity subject, membership and 009 lifecycle grant the authorization lookup resolves.
  if not exists (select 1 from corvis_control.identity_subject s where s.tenant_id = tenant and s.auth_method = 'service_account' and s.subject = account.subject
      and s.user_id = account.user_id and s.status = 'active') then raise exception 'an active service_account identity subject exists'; end if;
  if (select count(*) from corvis_control.membership m where m.tenant_id = tenant and m.user_id = account.user_id) <> 1
     or not exists (select 1 from corvis_control.membership m where m.tenant_id = tenant and m.user_id = account.user_id and m.workspace_id = workspace
       and m.role_name = 'analyst' and m.status = 'active' and m.valid_until = account.expires_at) then
    raise exception 'exactly one active membership in the chosen workspace and role, ending with the account';
  end if;
  select * into grant_row from corvis_control.service_identity_grant g where g.tenant_id = tenant and g.auth_method = 'service_account' and g.subject = account.subject;
  if grant_row.status <> 'active' or grant_row.valid_until <> account.expires_at or grant_row.next_review_at <> account.expires_at
     or grant_row.reviewed_by_subject <> 'idp|admin-one' or grant_row.purpose <> 'Pulls published data nightly' then
    raise exception 'an active lifecycle grant, valid until the account expires, reviewed by the creating admin';
  end if;
  if exists (select 1 from corvis_control.resource_entitlement e where e.tenant_id = tenant and e.subject_user_id = account.user_id) then
    raise exception 'creation grants no fund or document entitlement: those stay with the existing entitlement path';
  end if;

  -- Only the hash of the secret is stored; the credential outlives neither its account nor its own expiry.
  select * into stored from corvis_control.service_account_credential c where c.tenant_id = tenant and c.credential_id = 'a0880000-0000-4000-8000-0000000000d1';
  if stored.secret_sha256 <> pg_temp.digest_of('secret-1') or stored.status <> 'active' or stored.ends_at is not null or stored.last_used_at is not null then
    raise exception 'the first credential is current and unused and holds only the hash';
  end if;
  if stored.expires_at <> account.expires_at then raise exception 'a credential is never valid past its account (clamped from 90 to 30 days)'; end if;
  if stored.created_by_subject <> 'idp|admin-one' then raise exception 'the credential records who issued it'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'corvis_control' and table_name = 'service_account_credential'
      and column_name in ('secret','api_key','token','plaintext')) then raise exception 'no column can hold a secret'; end if;
end $$;

-- 4. Names are unique among active accounts (case-insensitively), per tenant, and the quota holds.
do $$
declare
  tenant uuid := 'a0880000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0880000-0000-4000-8000-0000000000a1';
begin
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_service_account(%L,gen_random_uuid(),gen_random_uuid(),'oidc','idp|admin-one','REPORTING SYNC','Another purpose',%L,'viewer',now()+interval '30 days',now()+interval '10 days',pg_temp.digest_of('dup'),100)$f$,
    tenant, workspace), 'service account name already in use');
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_service_account(%L,gen_random_uuid(),gen_random_uuid(),'oidc','idp|admin-one','Second account','Another purpose',%L,'viewer',now()+interval '30 days',now()+interval '10 days',pg_temp.digest_of('quota'),1)$f$,
    tenant, workspace), 'service account limit reached');
  perform corvis_control.create_service_account('b0880000-0000-4000-8000-00000000000b','b0880000-0000-4000-8000-0000000000c1','b0880000-0000-4000-8000-0000000000d1','oidc','idp|admin-b',
    'Reporting sync','Same name, another tenant','b0880000-0000-4000-8000-0000000000b1','viewer',now()+interval '30 days',now()+interval '10 days',pg_temp.digest_of('secret-b'),100);
  -- A credential hash is unique across the platform: the same secret can never identify two accounts.
  perform pg_temp.expect_error(format($f$select * from corvis_control.create_service_account(%L,gen_random_uuid(),gen_random_uuid(),'oidc','idp|admin-one','Third account','Another purpose',%L,'viewer',now()+interval '30 days',now()+interval '10 days',pg_temp.digest_of('secret-1'),100)$f$,
    tenant, workspace), 'duplicate key');
end $$;

-- 5. Issue and rotate.
do $$
declare
  tenant uuid := 'a0880000-0000-4000-8000-00000000000a';
  account uuid := 'a0880000-0000-4000-8000-0000000000c1';
  first_credential uuid := 'a0880000-0000-4000-8000-0000000000d1';
  second_credential uuid := 'a0880000-0000-4000-8000-0000000000d2';
  third_credential uuid := 'a0880000-0000-4000-8000-0000000000d3';
  fourth_credential uuid := 'a0880000-0000-4000-8000-0000000000d4';
  ends timestamptz;
begin
  -- Refusals.
  perform pg_temp.expect_error(format($f$select corvis_control.issue_service_account_credential(%L,%L,gen_random_uuid(),'issue','oidc','idp|admin-one',pg_temp.digest_of('i1'),now()+interval '5 days',0)$f$, tenant, account),
    'service account already has a credential');
  perform pg_temp.expect_error(format($f$select corvis_control.issue_service_account_credential(%L,%L,gen_random_uuid(),'rotate','oidc','idp|analyst',pg_temp.digest_of('i2'),now()+interval '5 days',10)$f$, tenant, account),
    'service account requires an active organization admin');
  perform pg_temp.expect_error(format($f$select corvis_control.issue_service_account_credential(%L,%L,gen_random_uuid(),'rotate','oidc','idp|admin-one',pg_temp.digest_of('i3'),now()+interval '5 days',1441)$f$, tenant, account),
    'service account credential request invalid');
  perform pg_temp.expect_error(format($f$select corvis_control.issue_service_account_credential(%L,%L,gen_random_uuid(),'rotate','oidc','idp|admin-one',pg_temp.digest_of('i4'),now()+interval '5 days',-1)$f$, tenant, account),
    'service account credential request invalid');
  perform pg_temp.expect_error(format($f$select corvis_control.issue_service_account_credential(%L,%L,gen_random_uuid(),'replace','oidc','idp|admin-one',pg_temp.digest_of('i5'),now()+interval '5 days',10)$f$, tenant, account),
    'service account credential request invalid');
  perform pg_temp.expect_error(format($f$select corvis_control.issue_service_account_credential(%L,%L,gen_random_uuid(),'rotate','oidc','idp|admin-one',pg_temp.digest_of('i6'),now()-interval '1 day',10)$f$, tenant, account),
    'service account expiry invalid');
  perform pg_temp.expect_error(format($f$select corvis_control.issue_service_account_credential(%L,gen_random_uuid(),gen_random_uuid(),'rotate','oidc','idp|admin-one',pg_temp.digest_of('i7'),now()+interval '5 days',10)$f$, tenant),
    'service account not found');
  perform pg_temp.expect_error(format($f$select corvis_control.issue_service_account_credential('b0880000-0000-4000-8000-00000000000b',%L,gen_random_uuid(),'rotate','oidc','idp|admin-b',pg_temp.digest_of('i8'),now()+interval '5 days',10)$f$, account),
    'service account not found');
  if (select count(*) from corvis_control.service_account_credential where service_account_id = account) <> 1 then raise exception 'refusals leave the credential set unchanged'; end if;

  -- Rotation with a 60 minute overlap: the old credential keeps working until the overlap ends, the new one is current.
  perform corvis_control.issue_service_account_credential(tenant, account, second_credential, 'rotate', 'oidc', 'idp|admin-one', pg_temp.digest_of('secret-2'), now()+interval '20 days', 60);
  select c.ends_at into ends from corvis_control.service_account_credential c where c.credential_id = first_credential;
  if ends is null or ends <= now() + interval '59 minutes' or ends > now() + interval '61 minutes' then raise exception 'the old credential ends after the overlap, got %', ends; end if;
  if (select count(*) from corvis_control.service_account_credential c where c.service_account_id = account and c.status = 'active' and c.ends_at is null) <> 1 then
    raise exception 'exactly one credential is current';
  end if;

  -- A second rotation ends the earlier overlap at once, so at most two credentials are ever valid together.
  perform corvis_control.issue_service_account_credential(tenant, account, third_credential, 'rotate', 'oidc', 'idp|admin-one', pg_temp.digest_of('secret-3'), now()+interval '20 days', 30);
  select c.ends_at into ends from corvis_control.service_account_credential c where c.credential_id = first_credential;
  if ends > now() then raise exception 'the earlier overlap is ended immediately, got %', ends; end if;
  if (select count(*) from corvis_control.service_account_credential c where c.service_account_id = account and c.status = 'active'
        and c.expires_at > now() and (c.ends_at is null or c.ends_at > now())) <> 2 then
    raise exception 'two credentials are valid during an overlap';
  end if;

  -- Overlap 0 ends the old credential now.
  perform corvis_control.issue_service_account_credential(tenant, account, fourth_credential, 'rotate', 'oidc', 'idp|admin-one', pg_temp.digest_of('secret-4'), now()+interval '20 days', 0);
  if (select count(*) from corvis_control.service_account_credential c where c.service_account_id = account and c.status = 'active'
        and c.expires_at > now() and (c.ends_at is null or c.ends_at > now())) <> 1 then
    raise exception 'with no overlap only the new credential is valid';
  end if;
  -- A rotation overlap never outlasts the credential's own expiry.
  perform corvis_control.issue_service_account_credential(tenant, account, 'a0880000-0000-4000-8000-0000000000d5', 'rotate', 'oidc', 'idp|admin-one', pg_temp.digest_of('secret-5'), now()+interval '20 days', 1440);
  select c.ends_at into ends from corvis_control.service_account_credential c where c.credential_id = fourth_credential;
  if ends > now() + interval '1 day' + interval '1 minute' then raise exception 'an overlap is at most a day'; end if;
end $$;

-- 6. Revocation is immediate, final, and refused when there is nothing to revoke.
do $$
declare
  tenant uuid := 'a0880000-0000-4000-8000-00000000000a';
  account uuid := 'a0880000-0000-4000-8000-0000000000c1';
  revoked integer;
begin
  perform pg_temp.expect_error(format($f$select corvis_control.revoke_service_account_credentials(%L,%L,'oidc','idp|analyst')$f$, tenant, account), 'service account requires an active organization admin');
  perform pg_temp.expect_error(format($f$select corvis_control.revoke_service_account_credentials(%L,gen_random_uuid(),'oidc','idp|admin-one')$f$, tenant), 'service account not found');
  perform pg_temp.expect_error(format($f$select corvis_control.revoke_service_account_credentials('b0880000-0000-4000-8000-00000000000b',%L,'oidc','idp|admin-b')$f$, account), 'service account not found');

  -- Two credentials are valid (one rotating out): both are revoked, effective now.
  revoked := corvis_control.revoke_service_account_credentials(tenant, account, 'oidc', 'idp|admin-one');
  if revoked <> 2 then raise exception 'both credentials in use are revoked, got %', revoked; end if;
  if exists (select 1 from corvis_control.service_account_credential c where c.service_account_id = account and c.status = 'active' and c.expires_at > now() and (c.ends_at is null or c.ends_at > now())) then
    raise exception 'no credential is valid after revocation';
  end if;
  if exists (select 1 from corvis_control.service_account_credential c where c.status = 'revoked' and (c.revoked_at is null or c.revoked_by_subject <> 'idp|admin-one' or c.ends_at is null or c.ends_at > now())) then
    raise exception 'revocation is recorded with who and when, and ends the credential now';
  end if;
  perform pg_temp.expect_error(format($f$select corvis_control.revoke_service_account_credentials(%L,%L,'oidc','idp|admin-one')$f$, tenant, account), 'service account has no active credential');

  -- The account stays active, so a new credential can be issued, but not rotated (there is none to rotate).
  perform pg_temp.expect_error(format($f$select corvis_control.issue_service_account_credential(%L,%L,gen_random_uuid(),'rotate','oidc','idp|admin-one',pg_temp.digest_of('r1'),now()+interval '5 days',10)$f$, tenant, account),
    'service account has no active credential');
  perform corvis_control.issue_service_account_credential(tenant, account, 'a0880000-0000-4000-8000-0000000000d6', 'issue', 'oidc', 'idp|admin-one', pg_temp.digest_of('secret-6'), now()+interval '20 days', 0);
  if (select count(*) from corvis_control.service_account_credential c where c.service_account_id = account and c.status = 'active' and c.ends_at is null) <> 1 then
    raise exception 'issue after revocation makes one current credential';
  end if;
end $$;

-- 7. An expired current credential no longer counts, so a new one can be issued without a rotation.
do $$
declare
  tenant uuid := 'a0880000-0000-4000-8000-00000000000a';
  account uuid := 'a0880000-0000-4000-8000-0000000000c1';
begin
  -- Time travel the only way a trigger-guarded table allows: as the owner, with triggers off.
  set local session_replication_role = replica;
  update corvis_control.service_account_credential set created_at = now() - interval '10 days', expires_at = now() - interval '1 day'
  where credential_id = 'a0880000-0000-4000-8000-0000000000d6';
  set local session_replication_role = origin;
  perform corvis_control.issue_service_account_credential(tenant, account, 'a0880000-0000-4000-8000-0000000000d7', 'issue', 'oidc', 'idp|admin-one', pg_temp.digest_of('secret-7'), now()+interval '20 days', 0);
  if (select ends_at from corvis_control.service_account_credential where credential_id = 'a0880000-0000-4000-8000-0000000000d6') is null then
    raise exception 'the expired credential is closed off';
  end if;
  if (select count(*) from corvis_control.service_account_credential c where c.service_account_id = account and c.status = 'active' and c.ends_at is null) <> 1 then
    raise exception 'one current credential';
  end if;
end $$;

-- 8. Guard triggers.
do $$
begin
  perform pg_temp.expect_error($f$update corvis_control.service_account_credential set secret_sha256 = pg_temp.digest_of('swap') where credential_id = 'a0880000-0000-4000-8000-0000000000d7'$f$, 'service account credential is immutable');
  perform pg_temp.expect_error($f$update corvis_control.service_account_credential set expires_at = expires_at + interval '1 day' where credential_id = 'a0880000-0000-4000-8000-0000000000d7'$f$, 'service account credential is immutable');
  perform pg_temp.expect_error($f$update corvis_control.service_account_credential set status = 'active', revoked_at = null, revoked_by_subject = null where credential_id = 'a0880000-0000-4000-8000-0000000000d5'$f$, 'service account credential is revoked');
  perform pg_temp.expect_error($f$update corvis_control.service_account_credential set ends_at = now() + interval '1 day' where credential_id = 'a0880000-0000-4000-8000-0000000000d5'$f$, 'service account credential is revoked');
  -- A rotation overlap can be shortened but never lengthened or lifted.
  perform corvis_control.issue_service_account_credential('a0880000-0000-4000-8000-00000000000a','a0880000-0000-4000-8000-0000000000c1','a0880000-0000-4000-8000-0000000000d8','rotate','oidc','idp|admin-one',pg_temp.digest_of('secret-8'),now()+interval '20 days',30);
  perform pg_temp.expect_error($f$update corvis_control.service_account_credential set ends_at = now() + interval '5 hours' where credential_id = 'a0880000-0000-4000-8000-0000000000d7'$f$, 'service account credential end date cannot be extended');
  perform pg_temp.expect_error($f$update corvis_control.service_account_credential set ends_at = null where credential_id = 'a0880000-0000-4000-8000-0000000000d7'$f$, 'service account credential end date cannot be extended');
  update corvis_control.service_account_credential set ends_at = now() where credential_id = 'a0880000-0000-4000-8000-0000000000d7';
  -- The table's own constraints: a revoked credential needs who and when, a hash must be a SHA-256.
  perform pg_temp.expect_error($f$update corvis_control.service_account_credential set status = 'revoked' where credential_id = 'a0880000-0000-4000-8000-0000000000d8'$f$, 'violates check constraint');
  perform pg_temp.expect_error($f$insert into corvis_control.service_account_credential (tenant_id, credential_id, service_account_id, secret_sha256, created_by_subject, expires_at)
    values ('a0880000-0000-4000-8000-00000000000a', gen_random_uuid(), 'a0880000-0000-4000-8000-0000000000c1', 'plain-text-secret', 'x', now() + interval '1 day')$f$, 'violates check constraint');
  -- An account's identity never changes.
  perform pg_temp.expect_error($f$update corvis_control.service_account set role_name = 'viewer' where service_account_id = 'a0880000-0000-4000-8000-0000000000c1'$f$, 'service account identity is immutable');
  perform pg_temp.expect_error($f$update corvis_control.service_account set expires_at = expires_at + interval '1 day' where service_account_id = 'a0880000-0000-4000-8000-0000000000c1'$f$, 'service account identity is immutable');
  -- And the table itself refuses an administrator role, whatever function wrote the row.
  perform pg_temp.expect_error($f$insert into corvis_control.service_account (tenant_id, service_account_id, user_id, subject, display_name, purpose, workspace_id, role_name, created_by_subject, created_by_user_id, expires_at, owner_subject, owner_user_id)
    values ('a0880000-0000-4000-8000-00000000000a', gen_random_uuid(), gen_random_uuid(), 'service-account:x', 'Direct insert', 'Direct insert', 'a0880000-0000-4000-8000-0000000000a1', 'tenant_admin', 'x', gen_random_uuid(), now() + interval '1 day', 'x', gen_random_uuid())$f$, 'violates check constraint');
  -- Every account has an owner, whatever function wrote the row.
  perform pg_temp.expect_error($f$insert into corvis_control.service_account (tenant_id, service_account_id, user_id, subject, display_name, purpose, workspace_id, role_name, created_by_subject, created_by_user_id, expires_at)
    values ('a0880000-0000-4000-8000-00000000000a', gen_random_uuid(), gen_random_uuid(), 'service-account:x', 'Direct insert', 'Direct insert', 'a0880000-0000-4000-8000-0000000000a1', 'viewer', 'x', gen_random_uuid(), now() + interval '1 day')$f$, 'violates not-null constraint');
end $$;

-- 9. Disabling deactivates the account everywhere, in one step, and is final.
do $$
declare
  tenant uuid := 'a0880000-0000-4000-8000-00000000000a';
  account uuid := 'a0880000-0000-4000-8000-0000000000c1';
  other_account uuid := 'a0880000-0000-4000-8000-0000000000c2';
  v_user uuid;
  disabled corvis_control.service_account%rowtype;
begin
  select a.user_id into v_user from corvis_control.service_account a where a.service_account_id = account;
  -- An entitlement the existing path granted this account.
  insert into corvis_control.resource_entitlement (tenant_id, workspace_id, subject_user_id, resource_type, resource_id, permission)
  values (tenant, 'a0880000-0000-4000-8000-0000000000a1', v_user, 'fund', 'fund-1', 'read');
  perform corvis_control.create_service_account(tenant, other_account, 'a0880000-0000-4000-8000-0000000000d9', 'oidc', 'idp|admin-one',
    'Untouched account', 'Must be unaffected by disabling another', 'a0880000-0000-4000-8000-0000000000a1', 'viewer', now()+interval '30 days', now()+interval '10 days', pg_temp.digest_of('secret-9'), 100);

  perform pg_temp.expect_error(format($f$select * from corvis_control.disable_service_account(%L,%L,'oidc','idp|analyst','Integration retired')$f$, tenant, account), 'service account requires an active organization admin');
  perform pg_temp.expect_error(format($f$select * from corvis_control.disable_service_account(%L,%L,'oidc','idp|admin-one','  ')$f$, tenant, account), 'service account justification required');
  perform pg_temp.expect_error(format($f$select * from corvis_control.disable_service_account(%L,gen_random_uuid(),'oidc','idp|admin-one','Integration retired')$f$, tenant), 'service account not found');
  perform pg_temp.expect_error(format($f$select * from corvis_control.disable_service_account('b0880000-0000-4000-8000-00000000000b',%L,'oidc','idp|admin-b','Integration retired')$f$, account), 'service account not found');

  select * into disabled from corvis_control.disable_service_account(tenant, account, 'oidc', 'idp|admin-one', '  Integration retired  ');
  if disabled.status <> 'disabled' or disabled.disabled_by_subject <> 'idp|admin-one' or disabled.disable_reason <> 'Integration retired' or disabled.disabled_at is null then raise exception 'who, when and why are recorded'; end if;
  if exists (select 1 from corvis_control.identity_subject s where s.tenant_id = tenant and s.subject = disabled.subject and s.status <> 'disabled') then raise exception 'the identity subject is disabled'; end if;
  if exists (select 1 from corvis_control.service_identity_grant g where g.tenant_id = tenant and g.subject = disabled.subject and g.status <> 'disabled') then raise exception 'the lifecycle grant is disabled'; end if;
  if exists (select 1 from corvis_control.membership m where m.tenant_id = tenant and m.user_id = v_user and (m.status <> 'revoked' or m.valid_until > now())) then raise exception 'every membership is revoked'; end if;
  if exists (select 1 from corvis_control.resource_entitlement e where e.tenant_id = tenant and e.subject_user_id = v_user and (e.valid_until is null or e.valid_until > now())) then raise exception 'every entitlement is ended'; end if;
  if exists (select 1 from corvis_control.service_account_credential c where c.service_account_id = account and (c.status <> 'revoked' or c.ends_at is null or c.ends_at > now())) then raise exception 'every credential is revoked'; end if;
  -- The authorization lookup's own conditions for this subject now all fail.
  if exists (
    select 1 from corvis_control.identity_subject s
    join corvis_control.membership m on m.tenant_id = s.tenant_id and m.user_id = s.user_id
    where s.tenant_id = tenant and s.subject = disabled.subject and s.status = 'active' and m.status = 'active'
  ) then raise exception 'nothing resolves for a disabled account'; end if;

  -- The other account is untouched, and so are the humans.
  if (select status from corvis_control.service_account where service_account_id = other_account) <> 'active'
     or not exists (select 1 from corvis_control.service_account_credential c where c.service_account_id = other_account and c.status = 'active') then
    raise exception 'another account is unaffected';
  end if;
  if not exists (select 1 from corvis_control.membership m where m.user_id = 'a0880000-0000-4000-8000-0000000000e1' and m.status = 'active') then raise exception 'humans are unaffected'; end if;

  -- Final: nothing more can be done to a disabled account except to look at it.
  perform pg_temp.expect_error(format($f$select * from corvis_control.disable_service_account(%L,%L,'oidc','idp|admin-one','Integration retired')$f$, tenant, account), 'service account is not active');
  perform pg_temp.expect_error(format($f$select corvis_control.issue_service_account_credential(%L,%L,gen_random_uuid(),'issue','oidc','idp|admin-one',pg_temp.digest_of('d1'),now()+interval '5 days',0)$f$, tenant, account), 'service account is not active');
  perform pg_temp.expect_error(format($f$select corvis_control.revoke_service_account_credentials(%L,%L,'oidc','idp|admin-one')$f$, tenant, account), 'service account has no active credential');
  perform pg_temp.expect_error(format($f$update corvis_control.service_account set status = 'active', disabled_at = null, disabled_by_subject = null, disable_reason = null where service_account_id = %L$f$, account), 'service account is disabled');
  -- A disabled account frees its name for a new one.
  perform corvis_control.create_service_account(tenant, 'a0880000-0000-4000-8000-0000000000c3', 'a0880000-0000-4000-8000-0000000000da', 'oidc', 'idp|admin-one',
    'Reporting sync', 'Replacement', 'a0880000-0000-4000-8000-0000000000a1', 'analyst', now()+interval '30 days', now()+interval '10 days', pg_temp.digest_of('secret-10'), 100);
end $$;

-- 10. An account that expired is not active: its credentials cannot be issued or rotated, whatever its status says.
do $$
declare
  tenant uuid := 'a0880000-0000-4000-8000-00000000000a';
begin
  perform corvis_control.create_service_account(tenant, 'a0880000-0000-4000-8000-0000000000c4', 'a0880000-0000-4000-8000-0000000000db', 'oidc', 'idp|admin-one',
    'Short lived', 'Expires immediately in this test', 'a0880000-0000-4000-8000-0000000000a2', 'reviewer', now()+interval '1 hour', now()+interval '30 minutes', pg_temp.digest_of('secret-11'), 100);
  set local session_replication_role = replica;
  update corvis_control.service_account set created_at = now() - interval '2 days', expires_at = now() - interval '1 minute' where service_account_id = 'a0880000-0000-4000-8000-0000000000c4';
  set local session_replication_role = origin;
  perform pg_temp.expect_error(format($f$select corvis_control.issue_service_account_credential(%L,'a0880000-0000-4000-8000-0000000000c4',gen_random_uuid(),'rotate','oidc','idp|admin-one',pg_temp.digest_of('e1'),now()+interval '5 days',10)$f$, tenant),
    'service account is not active');
end $$;

-- 11. Renewal and ownership (F6b, migration 092).
do $$
declare
  tenant uuid := 'a0880000-0000-4000-8000-00000000000a';
  workspace uuid := 'a0880000-0000-4000-8000-0000000000a1';
  account uuid := 'a0880000-0000-4000-8000-0000000000c5';
  created corvis_control.service_account%rowtype;
  extended corvis_control.service_account%rowtype;
  handed corvis_control.service_account%rowtype;
  previous timestamptz;
  previous_owner text;
  credential_expiry timestamptz;
begin
  insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject,status)
  values (tenant,'a0880000-0000-4000-8000-0000000000e6','oidc','idp|admin-two','active'),
         (tenant,'a0880000-0000-4000-8000-0000000000e7','oidc','idp|admin-three','active');
  insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name,status)
  values (tenant,workspace,'a0880000-0000-4000-8000-0000000000e6','tenant_admin','active'),
         (tenant,workspace,'a0880000-0000-4000-8000-0000000000e7','tenant_admin','active');

  -- Who counts as an active owner: an active human identity holding an active Organization Admin membership.
  if not corvis_control.service_account_owner_active(tenant,'a0880000-0000-4000-8000-0000000000e1') then raise exception 'an active admin can own an account'; end if;
  if corvis_control.service_account_owner_active(tenant,'a0880000-0000-4000-8000-0000000000e3') then raise exception 'an analyst cannot own an account'; end if;
  if corvis_control.service_account_owner_active(tenant,'a0880000-0000-4000-8000-0000000000e4') then raise exception 'a revoked admin membership does not count'; end if;
  if corvis_control.service_account_owner_active(tenant,'a0880000-0000-4000-8000-0000000000e5') then raise exception 'a service account never owns an account'; end if;
  if corvis_control.service_account_owner_active(tenant,'a0880000-0000-4000-8000-0000000000ff') then raise exception 'an unknown user cannot own an account'; end if;
  if corvis_control.service_account_owner_active(tenant,'b0880000-0000-4000-8000-0000000000f1') then raise exception 'an admin of another tenant is not an owner here'; end if;

  -- The creating admin is the first owner.
  perform corvis_control.create_service_account(tenant, account, 'a0880000-0000-4000-8000-0000000000dc', 'oidc', 'idp|admin-one',
    'Owned feed', 'Renewed and handed over in this test', workspace, 'viewer', now()+interval '60 days', now()+interval '30 days', pg_temp.digest_of('secret-12'), 100);
  select * into created from corvis_control.service_account where service_account_id = account;
  if created.owner_subject <> 'idp|admin-one' or created.owner_user_id <> 'a0880000-0000-4000-8000-0000000000e1' or created.owner_assigned_at is null then
    raise exception 'the creating admin is the first owner';
  end if;
  select expires_at into credential_expiry from corvis_control.service_account_credential where service_account_id = account;

  -- Extending: the expiry moves later, and the membership and the 009 lifecycle grant move with it; the previous expiry is returned.
  previous := corvis_control.extend_service_account(tenant, account, 'oidc', 'idp|admin-one', now()+interval '200 days');
  if previous <> created.expires_at then raise exception 'the previous expiry is returned for the audit event'; end if;
  select * into extended from corvis_control.service_account where service_account_id = account;
  if abs(extract(epoch from extended.expires_at - (now()+interval '200 days'))) > 5 then raise exception 'the account now expires 200 days from now'; end if;
  if not exists (select 1 from corvis_control.membership m where m.tenant_id = tenant and m.user_id = created.user_id and m.status = 'active' and m.valid_until = extended.expires_at) then
    raise exception 'the membership expires with the account';
  end if;
  if not exists (select 1 from corvis_control.service_identity_grant g where g.tenant_id = tenant and g.subject = created.subject and g.status = 'active'
       and g.valid_until = extended.expires_at and g.next_review_at = extended.expires_at and g.reviewed_by_subject = 'idp|admin-one' and g.reviewed_at > now() - interval '1 minute') then
    raise exception 'the lifecycle grant is renewed and re-reviewed with the extension (next_review_at advances)';
  end if;
  if extended.created_at <> created.created_at or extended.subject <> created.subject or extended.owner_subject <> created.owner_subject then raise exception 'an extension changes nothing else'; end if;
  if (select expires_at from corvis_control.service_account_credential where service_account_id = account) <> credential_expiry then
    raise exception 'a credential keeps its own expiry: an extended account issues a new one';
  end if;
  -- The very same call again, a shorter date, less than a day later, nothing, and past the maximum are all refused.
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|admin-one',%L)$f$, tenant, account, extended.expires_at), 'service account expiry invalid');
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|admin-one',%L)$f$, tenant, account, extended.expires_at + interval '12 hours'), 'service account expiry invalid');
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|admin-one',now()+interval '100 days')$f$, tenant, account), 'service account expiry invalid');
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|admin-one',null)$f$, tenant, account), 'service account expiry invalid');
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|admin-one',now()+interval '400 days')$f$, tenant, account), 'service account expiry invalid');
  -- Only an active Organization Admin acts, and only inside the tenant.
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|analyst',now()+interval '300 days')$f$, tenant, account), 'service account requires an active organization admin');
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|revoked-admin',now()+interval '300 days')$f$, tenant, account), 'service account requires an active organization admin');
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'service_account','svc|robot',now()+interval '300 days')$f$, tenant, account), 'service account requires an active organization admin');
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account('b0880000-0000-4000-8000-00000000000b',%L,'oidc','idp|admin-b',now()+interval '300 days')$f$, account), 'service account not found');
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,gen_random_uuid(),'oidc','idp|admin-one',now()+interval '300 days')$f$, tenant), 'service account not found');
  -- The maximum from now is allowed (365 days), and then there is nothing further to move to.
  perform corvis_control.extend_service_account(tenant, account, 'oidc', 'idp|admin-one', now()+interval '365 days');
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|admin-one',now()+interval '365 days' + interval '1 hour')$f$, tenant, account), 'service account expiry invalid');

  -- The guard: nothing but the function renews or shortens, and nothing but the transfer changes the owner.
  perform pg_temp.expect_error(format($f$update corvis_control.service_account set expires_at = expires_at + interval '1 day' where service_account_id = %L$f$, account), 'service account identity is immutable');
  perform pg_temp.expect_error(format($f$update corvis_control.service_account set owner_subject = 'idp|admin-two' where service_account_id = %L$f$, account), 'service account owner is changed by transfer only');
  set local corvis.service_account_renewal = 'on';
  perform pg_temp.expect_error(format($f$update corvis_control.service_account set expires_at = expires_at - interval '1 day' where service_account_id = %L$f$, account), 'service account expiry cannot be shortened');
  set local corvis.service_account_renewal = 'off';

  -- Transfer: another active Organization Admin; the previous owner is returned; the creator stays what it was.
  previous_owner := corvis_control.transfer_service_account_owner(tenant, account, 'oidc', 'idp|admin-one', 'idp|admin-two');
  if previous_owner <> 'idp|admin-one' then raise exception 'the previous owner is returned for the audit event'; end if;
  select * into handed from corvis_control.service_account where service_account_id = account;
  if handed.owner_subject <> 'idp|admin-two' or handed.owner_user_id <> 'a0880000-0000-4000-8000-0000000000e6' or handed.owner_assigned_at < extended.owner_assigned_at then raise exception 'the owner is admin two'; end if;
  if handed.created_by_subject <> 'idp|admin-one' or handed.created_by_user_id <> 'a0880000-0000-4000-8000-0000000000e1' then raise exception 'who created the account is history and does not change'; end if;
  perform pg_temp.expect_error(format($f$select corvis_control.transfer_service_account_owner(%L,%L,'oidc','idp|admin-one','idp|admin-two')$f$, tenant, account), 'service account owner unchanged');
  perform pg_temp.expect_error(format($f$select corvis_control.transfer_service_account_owner(%L,%L,'oidc','idp|admin-one','idp|analyst')$f$, tenant, account), 'service account owner must be an active organization admin');
  perform pg_temp.expect_error(format($f$select corvis_control.transfer_service_account_owner(%L,%L,'oidc','idp|admin-one','idp|revoked-admin')$f$, tenant, account), 'service account owner must be an active organization admin');
  perform pg_temp.expect_error(format($f$select corvis_control.transfer_service_account_owner(%L,%L,'oidc','idp|admin-one','svc|robot')$f$, tenant, account), 'service account owner must be an active organization admin');
  perform pg_temp.expect_error(format($f$select corvis_control.transfer_service_account_owner(%L,%L,'oidc','idp|admin-one','idp|nobody')$f$, tenant, account), 'service account owner must be an active organization admin');
  perform pg_temp.expect_error(format($f$select corvis_control.transfer_service_account_owner(%L,%L,'oidc','idp|admin-one','idp|admin-b')$f$, tenant, account), 'service account owner must be an active organization admin');
  perform pg_temp.expect_error(format($f$select corvis_control.transfer_service_account_owner(%L,%L,'oidc','idp|analyst','idp|admin-three')$f$, tenant, account), 'service account requires an active organization admin');
  perform pg_temp.expect_error(format($f$select corvis_control.transfer_service_account_owner('b0880000-0000-4000-8000-00000000000b',%L,'oidc','idp|admin-b','idp|admin-b')$f$, account), 'service account not found');

  -- An owner who is deactivated is not silently orphaned: the account keeps working, is reported as ownerless, is not
  -- renewed, and is handed to an active admin by anyone who is one.
  update corvis_control.identity_subject set status = 'disabled', disabled_at = now() where tenant_id = tenant and subject = 'idp|admin-two';
  if corvis_control.service_account_owner_active(tenant,'a0880000-0000-4000-8000-0000000000e6') then raise exception 'a deactivated owner is no longer active'; end if;
  if (select status from corvis_control.service_account where service_account_id = account) <> 'active'
     or not exists (select 1 from corvis_control.service_account_credential c where c.service_account_id = account and c.status = 'active') then
    raise exception 'the account and its credentials keep working';
  end if;
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|admin-one',now()+interval '366 days')$f$, tenant, account), 'service account needs an owner');
  perform corvis_control.transfer_service_account_owner(tenant, account, 'oidc', 'idp|admin-one', 'idp|admin-three');
  -- Losing the Organization Admin role has the same effect as being deactivated.
  update corvis_control.membership set status = 'revoked', valid_until = now(), valid_from = now() - interval '1 microsecond'
  where tenant_id = tenant and user_id = 'a0880000-0000-4000-8000-0000000000e7';
  if corvis_control.service_account_owner_active(tenant,'a0880000-0000-4000-8000-0000000000e7') then raise exception 'a demoted owner is no longer active'; end if;
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|admin-one',now()+interval '366 days')$f$, tenant, account), 'service account needs an owner');
  perform corvis_control.transfer_service_account_owner(tenant, account, 'oidc', 'idp|admin-one', 'idp|admin-one');
  if (select owner_subject from corvis_control.service_account where service_account_id = account) <> 'idp|admin-one' then raise exception 'the acting admin can take an account over'; end if;

  -- A deactivated account is final: it can be neither renewed nor handed over.
  perform corvis_control.disable_service_account(tenant, account, 'oidc', 'idp|admin-one', 'Integration retired');
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|admin-one',now()+interval '300 days')$f$, tenant, account), 'service account is not active');
  perform pg_temp.expect_error(format($f$select corvis_control.transfer_service_account_owner(%L,%L,'oidc','idp|admin-one','idp|admin-two')$f$, tenant, account), 'service account is not active');
end $$;

-- An account that already expired can be renewed by an admin who owns it, and resolves again afterwards.
do $$
declare
  tenant uuid := 'a0880000-0000-4000-8000-00000000000a';
  account uuid := 'a0880000-0000-4000-8000-0000000000c6';
  created corvis_control.service_account%rowtype;
begin
  perform corvis_control.create_service_account(tenant, account, 'a0880000-0000-4000-8000-0000000000dd', 'oidc', 'idp|admin-one',
    'Lapsed feed', 'Expires in the past in this test', 'a0880000-0000-4000-8000-0000000000a1', 'viewer', now()+interval '1 hour', now()+interval '30 minutes', pg_temp.digest_of('secret-13'), 100);
  select * into created from corvis_control.service_account where service_account_id = account;
  set local session_replication_role = replica;
  update corvis_control.service_account set created_at = now() - interval '3 days', expires_at = now() - interval '1 minute' where service_account_id = account;
  update corvis_control.membership set valid_from = now() - interval '3 days', valid_until = now() - interval '1 minute' where tenant_id = tenant and user_id = created.user_id;
  update corvis_control.service_identity_grant set valid_from = now() - interval '3 days', reviewed_at = now() - interval '3 days', next_review_at = now() - interval '1 minute', valid_until = now() - interval '1 minute'
  where tenant_id = tenant and subject = created.subject;
  set local session_replication_role = origin;
  -- Not later than now: refused. Later than now: the account is renewed.
  perform pg_temp.expect_error(format($f$select corvis_control.extend_service_account(%L,%L,'oidc','idp|admin-one',now()-interval '1 second')$f$, tenant, account), 'service account expiry invalid');
  perform corvis_control.extend_service_account(tenant, account, 'oidc', 'idp|admin-one', now()+interval '30 days');
  if not exists (select 1 from corvis_control.membership m where m.user_id = created.user_id and m.status = 'active' and m.valid_until > now())
     or not exists (select 1 from corvis_control.service_identity_grant g where g.subject = created.subject and g.valid_until > now() and g.next_review_at > now()) then
    raise exception 'a renewed account is current again';
  end if;
  perform corvis_control.issue_service_account_credential(tenant, account, gen_random_uuid(), 'rotate', 'oidc', 'idp|admin-one', pg_temp.digest_of('e2'), now()+interval '10 days', 0);
end $$;

-- 12. RLS: enabled and forced, no client policy, and a non-owner role without BYPASSRLS reads nothing.
do $$
declare
  offenders text;
begin
  select string_agg(c.relname, ', ') into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'corvis_control' and c.relname in ('service_account','service_account_credential')
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if offenders is not null then raise exception 'RLS must be enabled and forced on %', offenders; end if;
  if exists (select 1 from pg_policies where schemaname = 'corvis_control' and tablename in ('service_account','service_account_credential')) then
    raise exception 'service account tables are server-managed and secret-bearing: no client policy may exist';
  end if;
end $$;

drop role if exists corvis_service_account_negative_role;
create role corvis_service_account_negative_role nologin nosuperuser nobypassrls noinherit;
grant usage on schema corvis_control to corvis_service_account_negative_role;
grant select on corvis_control.service_account, corvis_control.service_account_credential to corvis_service_account_negative_role;
set role corvis_service_account_negative_role;
do $$
begin
  set local request.jwt.claim.sub = 'a0880000-0000-4000-8000-0000000000e1';
  if (select count(*) from corvis_control.service_account) <> 0 or (select count(*) from corvis_control.service_account_credential) <> 0 then
    raise exception 'a non-owner role must not read service accounts or their credential records, even as an organization admin';
  end if;
end $$;
reset role;
drop owned by corvis_service_account_negative_role;
drop role corvis_service_account_negative_role;

rollback;
