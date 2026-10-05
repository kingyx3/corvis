-- Acceptance for migrations 087 and 091 (F7 #263, F7d #337): organization session policy, "sign out everywhere" and housekeeping.
--
-- Proves, against the real SQL functions on an isolated disposable database:
--   * the policy is bounded by CHECK constraints (idle 15 min to 8 h, session 1 h to 7 days, idle never above the
--     session length), so even a direct write cannot store a value outside the Corvis bounds;
--   * only an active Organization Admin (tenant_admin membership on an active human identity) can change the policy
--     or sign a user out: another role, a disabled admin, another tenant's admin and a service identity are refused;
--   * a change is compare-and-set on the version, the same values change nothing, and an admin can clear a limit;
--   * enforcement: with no limit a session is only recorded; the idle timeout and the maximum session length end a
--     session for good (an expired session is not revived by retrying); a session id that is not stable is refused
--     while a limit is set; service identities and other tenants are unaffected; relaxing the policy restores access;
--   * "sign out everywhere" revokes every session recorded for every identity of the named user (and only theirs),
--     it is idempotent, refuses the caller themself, a user outside the tenant and a missing reason;
--   * the application's authoritative lookup (session_revocation) really excludes the revoked sessions;
--   * (091) the housekeeping purge removes only session records not seen for the whole retention (never below the longest
--     allowed session plus a day), in every tenant, a bounded batch at a time, never touches session revocations, and leaves
--     enforcement and sign-out-everywhere working;
--   * (099, F7a #334) Require SSO: only an OIDC session whose verified issuer and audience equal the tenant's bound record passes
--     (SAML, gateway assertions and wrong claims are refused; service identities and other tenants are unaffected); enabling it needs
--     a bound OIDC record and a session that would itself pass (lock-out safeguard); NULL keeps it; disabling always works; and the
--     per-session MFA evidence is stored (NULL = not reported, never overwritten by NULL);
--   * (099, F7c #336) back-channel logout: tenant scope per provider, single-use token ids, session/subject revocation through
--     session_revocation, counts-only audit, a per-issuer rate bound and ledger housekeeping;
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
values ('a0870000-0000-4000-8000-00000000000a','session-policy-a','Session Policy A'),
       ('b0870000-0000-4000-8000-00000000000b','session-policy-b','Session Policy B');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name)
values ('a0870000-0000-4000-8000-0000000000a1','a0870000-0000-4000-8000-00000000000a','primary','A primary'),
       ('b0870000-0000-4000-8000-0000000000b1','b0870000-0000-4000-8000-00000000000b','primary','B primary');
-- e1 and e2 are Organization Admins, e3 is a member with two identities, e4 an analyst, e5 a disabled admin, e6 a
-- workspace admin; the service identity has no user in the policy sense. b-owner is another tenant's admin.
insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject,status)
values ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000e1','oidc','idp|admin-1','active'),
       ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000e2','oidc','idp|admin-2','active'),
       ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000e3','oidc','idp|member','active'),
       ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000e3','saml','saml|member','active'),
       ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000e4','oidc','idp|analyst','active'),
       ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000e5','oidc','idp|disabled-admin','disabled'),
       ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000e6','oidc','idp|workspace-admin','active'),
       ('b0870000-0000-4000-8000-00000000000b','b0870000-0000-4000-8000-0000000000e7','oidc','idp|b-owner','active');
insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name)
values ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000a1','a0870000-0000-4000-8000-0000000000e1','tenant_admin'),
       ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000a1','a0870000-0000-4000-8000-0000000000e2','tenant_admin'),
       ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000a1','a0870000-0000-4000-8000-0000000000e3','analyst'),
       ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000a1','a0870000-0000-4000-8000-0000000000e4','analyst'),
       ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000a1','a0870000-0000-4000-8000-0000000000e5','tenant_admin'),
       ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000a1','a0870000-0000-4000-8000-0000000000e6','accountadmin'),
       ('b0870000-0000-4000-8000-00000000000b','b0870000-0000-4000-8000-0000000000b1','b0870000-0000-4000-8000-0000000000e7','tenant_admin');

-- ---------------------------------------------------------------- bounds are table constraints
select pg_temp.expect_error($f$insert into corvis_control.tenant_session_policy (tenant_id,idle_timeout_minutes,updated_by_auth_method,updated_by_subject) values ('a0870000-0000-4000-8000-00000000000a',14,'oidc','x')$f$, 'tenant_session_policy_idle_timeout_minutes_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_session_policy (tenant_id,idle_timeout_minutes,updated_by_auth_method,updated_by_subject) values ('a0870000-0000-4000-8000-00000000000a',481,'oidc','x')$f$, 'tenant_session_policy_idle_timeout_minutes_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_session_policy (tenant_id,max_session_minutes,updated_by_auth_method,updated_by_subject) values ('a0870000-0000-4000-8000-00000000000a',59,'oidc','x')$f$, 'tenant_session_policy_max_session_minutes_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_session_policy (tenant_id,max_session_minutes,updated_by_auth_method,updated_by_subject) values ('a0870000-0000-4000-8000-00000000000a',10081,'oidc','x')$f$, 'tenant_session_policy_max_session_minutes_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_session_policy (tenant_id,idle_timeout_minutes,max_session_minutes,updated_by_auth_method,updated_by_subject) values ('a0870000-0000-4000-8000-00000000000a',120,60,'oidc','x')$f$, 'tenant_session_policy_check');

-- ---------------------------------------------------------------- who may change the policy
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|analyst',30,480,0)$f$, 'session policy requires an active organization admin');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|workspace-admin',30,480,0)$f$, 'session policy requires an active organization admin');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|disabled-admin',30,480,0)$f$, 'session policy requires an active organization admin');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|b-owner',30,480,0)$f$, 'session policy requires an active organization admin');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','service_account','idp|admin-1',30,480,0)$f$, 'session policy requires an active organization admin');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|nobody',30,480,0)$f$, 'session policy requires an active organization admin');

-- ---------------------------------------------------------------- bounds in the function, whatever the caller sends
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1',14,480,0)$f$, 'session policy bounds exceeded');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1',481,null,0)$f$, 'session policy bounds exceeded');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1',null,59,0)$f$, 'session policy bounds exceeded');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1',null,10081,0)$f$, 'session policy bounds exceeded');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1',120,60,0)$f$, 'session policy bounds exceeded');
do $$
begin
  if exists (select 1 from corvis_control.tenant_session_policy) then raise exception 'a refused change must store nothing'; end if;
end $$;

-- ---------------------------------------------------------------- compare-and-set
-- Nothing set and nothing asked for: no row to create.
do $$
begin
  if exists (select 1 from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1',null,null,0)) then
    raise exception 'clearing a policy that does not exist must return no row';
  end if;
  if exists (select 1 from corvis_control.tenant_session_policy) then raise exception 'and must create none'; end if;
end $$;
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1',30,480,1)$f$, 'session policy version conflict');

do $$
declare
  r corvis_control.tenant_session_policy%rowtype;
begin
  select * into r from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1',30,480,0);
  if r.version <> 1 or r.idle_timeout_minutes <> 30 or r.max_session_minutes <> 480 or r.updated_by_subject <> 'idp|admin-1' then
    raise exception 'first policy: unexpected row %', r;
  end if;
  -- A stale writer (still on version 0) is refused instead of overwriting.
  begin
    perform * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-2',60,null,0);
    raise exception 'a stale version must be refused';
  exception when others then
    if position('session policy version conflict' in sqlerrm) = 0 then raise; end if;
  end;
  -- The same values change nothing: same version, same author, same timestamp.
  select * into r from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-2',30,480,1);
  if r.version <> 1 or r.updated_by_subject <> 'idp|admin-1' then raise exception 'an unchanged policy must stay as it was: %', r; end if;
  -- A real change bumps the version and records who made it.
  select * into r from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-2',60,null,1);
  if r.version <> 2 or r.idle_timeout_minutes <> 60 or r.max_session_minutes is not null or r.updated_by_subject <> 'idp|admin-2' then
    raise exception 'second policy: unexpected row %', r;
  end if;
  -- Another tenant is untouched.
  if exists (select 1 from corvis_control.tenant_session_policy where tenant_id = 'b0870000-0000-4000-8000-00000000000b') then
    raise exception 'a change must stay inside the caller''s tenant';
  end if;
end $$;

-- ---------------------------------------------------------------- enforcement: idle timeout (60 min, no maximum)
do $$
declare
  t constant uuid := 'a0870000-0000-4000-8000-00000000000a';
begin
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','sid-idle') <> 'ok' then raise exception 'a fresh session is allowed'; end if;
  if (select count(*) from corvis_control.tenant_session_activity where tenant_id = t and session_id = 'sid-idle') <> 1 then
    raise exception 'the session must be recorded';
  end if;
  -- Within the idle window.
  update corvis_control.tenant_session_activity set first_seen_at = now() - interval '3 hours', last_seen_at = now() - interval '59 minutes' where tenant_id = t and session_id = 'sid-idle';
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','sid-idle') <> 'ok' then raise exception 'inside the idle window: allowed'; end if;
  if (select last_seen_at from corvis_control.tenant_session_activity where tenant_id = t and session_id = 'sid-idle') < now() - interval '1 minute' then
    raise exception 'an allowed request must refresh last-seen';
  end if;
  -- Past it: refused, and retrying does not revive the session.
  update corvis_control.tenant_session_activity set last_seen_at = now() - interval '61 minutes' where tenant_id = t and session_id = 'sid-idle';
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','sid-idle') <> 'idle_timeout' then raise exception 'past the idle timeout: refused'; end if;
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','sid-idle') <> 'idle_timeout' then raise exception 'an expired session must stay expired'; end if;
  if (select last_seen_at from corvis_control.tenant_session_activity where tenant_id = t and session_id = 'sid-idle') > now() - interval '60 minutes' then
    raise exception 'a refused request must not refresh last-seen';
  end if;
  -- A different session of the same person is unaffected.
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','sid-other') <> 'ok' then raise exception 'sessions are independent'; end if;
end $$;

-- Relaxing the policy lets the session continue (it was never revoked).
do $$
begin
  perform * from corvis_control.set_tenant_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1',null,null,2);
  if corvis_control.enforce_session_policy('a0870000-0000-4000-8000-00000000000a','oidc','idp|member','sid-idle') <> 'ok' then
    raise exception 'with no limits the idle session is allowed again';
  end if;
  if (select idle_timeout_minutes is null and max_session_minutes is null and version = 3 from corvis_control.tenant_session_policy where tenant_id = 'a0870000-0000-4000-8000-00000000000a') is not true then
    raise exception 'limits can be cleared, and clearing is a versioned change';
  end if;
end $$;

-- ---------------------------------------------------------------- enforcement: maximum session length (8 h, idle 4 h)
do $$
declare
  t constant uuid := 'a0870000-0000-4000-8000-00000000000a';
begin
  perform * from corvis_control.set_tenant_session_policy(t,'oidc','idp|admin-1',240,480,3);
  update corvis_control.tenant_session_activity set first_seen_at = now() - interval '7 hours 59 minutes', last_seen_at = now() - interval '1 minute' where tenant_id = t and session_id = 'sid-idle';
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','sid-idle') <> 'ok' then raise exception 'just inside the maximum: allowed'; end if;
  update corvis_control.tenant_session_activity set first_seen_at = now() - interval '8 hours 1 minute', last_seen_at = now() where tenant_id = t and session_id = 'sid-idle';
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','sid-idle') <> 'max_session' then raise exception 'past the maximum, however active: refused'; end if;
  -- The maximum is reported before the idle limit when both have passed.
  update corvis_control.tenant_session_activity set last_seen_at = now() - interval '5 hours' where tenant_id = t and session_id = 'sid-idle';
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','sid-idle') <> 'max_session' then raise exception 'maximum first'; end if;
  -- A session id that is not stable cannot be measured: refused while a limit is set.
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','token-0123abcd') <> 'untracked_session' then raise exception 'unstable session ids fail closed under a limit'; end if;
  if exists (select 1 from corvis_control.tenant_session_activity where session_id like 'token-%') then raise exception 'an unstable session must not be recorded'; end if;
  -- Service identities are not governed by this policy.
  if corvis_control.enforce_session_policy(t,'service_account','svc-1','sid-svc') <> 'ok' then raise exception 'service identities are exempt'; end if;
  if exists (select 1 from corvis_control.tenant_session_activity where subject = 'svc-1') then raise exception 'and are not recorded'; end if;
  -- Another tenant (no policy) is unaffected by this tenant's limits.
  if corvis_control.enforce_session_policy('b0870000-0000-4000-8000-00000000000b','oidc','idp|b-owner','sid-idle') <> 'ok' then raise exception 'no policy, no limit'; end if;
  -- Without a limit an unstable session id is allowed (and still not recorded).
  perform * from corvis_control.set_tenant_session_policy(t,'oidc','idp|admin-1',null,null,4);
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','token-0123abcd') <> 'ok' then raise exception 'no limit: unstable ids are allowed'; end if;
  if exists (select 1 from corvis_control.tenant_session_activity where session_id like 'token-%') then raise exception 'still not recorded'; end if;
end $$;

-- ---------------------------------------------------------------- sign out everywhere
do $$
declare
  t constant uuid := 'a0870000-0000-4000-8000-00000000000a';
  n integer;
begin
  -- The member has two identities and three sessions between them; the analyst has one; an admin one.
  perform corvis_control.enforce_session_policy(t,'oidc','idp|member','sid-m1');
  perform corvis_control.enforce_session_policy(t,'oidc','idp|member','sid-m2');
  perform corvis_control.enforce_session_policy(t,'saml','saml|member','sid-m3');
  perform corvis_control.enforce_session_policy(t,'oidc','idp|analyst','sid-a1');
  perform corvis_control.enforce_session_policy(t,'oidc','idp|admin-2','sid-admin2');
  -- sid-idle and sid-other (from the tests above) are also the member's: five recorded sessions across both identities.
  n := corvis_control.sign_out_user_everywhere(t,'oidc','idp|admin-1','a0870000-0000-4000-8000-0000000000e3','Left the firm');
  if n <> 5 then raise exception 'expected 5 revoked sessions for the member, got %', n; end if;
  if (select count(*) from corvis_control.session_revocation where tenant_id = t) <> 5 then raise exception 'only the member''s sessions are revoked'; end if;
  if exists (select 1 from corvis_control.session_revocation where tenant_id = t and subject in ('idp|analyst','idp|admin-2','idp|admin-1')) then
    raise exception 'nobody else is touched';
  end if;
  if (select count(*) from corvis_control.session_revocation where tenant_id = t and auth_method = 'saml' and subject = 'saml|member' and session_id = 'sid-m3') <> 1 then
    raise exception 'every identity of the user is covered';
  end if;
  if exists (select 1 from corvis_control.session_revocation where tenant_id = t and (revoked_by_subject <> 'idp|admin-1' or reason <> 'Left the firm')) then
    raise exception 'who and why are recorded';
  end if;
  -- Idempotent: nothing new to revoke the second time.
  if corvis_control.sign_out_user_everywhere(t,'oidc','idp|admin-2','a0870000-0000-4000-8000-0000000000e3','Again') <> 0 then raise exception 'a repeat revokes nothing new'; end if;
  -- A later session (a fresh sign-in) is not revoked.
  perform corvis_control.enforce_session_policy(t,'oidc','idp|member','sid-m-new');
  if exists (select 1 from corvis_control.session_revocation where session_id = 'sid-m-new') then raise exception 'a new sign-in gets a new session'; end if;
  -- A user with no recorded sessions: nothing to revoke, not an error.
  if corvis_control.sign_out_user_everywhere(t,'oidc','idp|admin-1','a0870000-0000-4000-8000-0000000000e6','Precaution') <> 0 then raise exception 'no sessions, no revocations'; end if;
end $$;

-- The application's authoritative lookup excludes revoked sessions (the same predicate as authorization.ts).
do $$
declare
  t constant uuid := 'a0870000-0000-4000-8000-00000000000a';
begin
  if exists (
    select 1 from corvis_control.identity_subject s
    where s.tenant_id = t and s.subject = 'idp|member' and s.auth_method = 'oidc'
      and not exists (select 1 from corvis_control.session_revocation r
        where r.tenant_id = s.tenant_id and r.auth_method = s.auth_method and r.subject = s.subject and r.session_id = 'sid-m1')
  ) then raise exception 'a signed-out session must not resolve'; end if;
  if not exists (
    select 1 from corvis_control.identity_subject s
    where s.tenant_id = t and s.subject = 'idp|member' and s.auth_method = 'oidc'
      and not exists (select 1 from corvis_control.session_revocation r
        where r.tenant_id = s.tenant_id and r.auth_method = s.auth_method and r.subject = s.subject and r.session_id = 'sid-m-new')
  ) then raise exception 'the new session must still resolve'; end if;
end $$;

select pg_temp.expect_error($f$select corvis_control.sign_out_user_everywhere('a0870000-0000-4000-8000-00000000000a','oidc','idp|analyst','a0870000-0000-4000-8000-0000000000e3','Not an admin')$f$, 'session policy requires an active organization admin');
select pg_temp.expect_error($f$select corvis_control.sign_out_user_everywhere('a0870000-0000-4000-8000-00000000000a','oidc','idp|b-owner','a0870000-0000-4000-8000-0000000000e3','Other tenant admin')$f$, 'session policy requires an active organization admin');
select pg_temp.expect_error($f$select corvis_control.sign_out_user_everywhere('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1','a0870000-0000-4000-8000-0000000000e1','Myself')$f$, 'session sign-out cannot target current user');
select pg_temp.expect_error($f$select corvis_control.sign_out_user_everywhere('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1','a0870000-0000-4000-8000-0000000000e7','Other tenant user')$f$, 'session sign-out target not found');
select pg_temp.expect_error($f$select corvis_control.sign_out_user_everywhere('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1','a0870000-0000-4000-8000-0000000000e5','Disabled user')$f$, 'session sign-out target not found');
select pg_temp.expect_error($f$select corvis_control.sign_out_user_everywhere('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1','a0870000-0000-4000-8000-0000000000e3','  ')$f$, 'session sign-out needs a stated reason');
select pg_temp.expect_error($f$select corvis_control.sign_out_user_everywhere('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1','a0870000-0000-4000-8000-0000000000e3',null)$f$, 'session sign-out needs a stated reason');
select pg_temp.expect_error($f$select corvis_control.sign_out_user_everywhere('a0870000-0000-4000-8000-00000000000a','oidc','idp|admin-1','a0870000-0000-4000-8000-0000000000e3',repeat('x',1001))$f$, 'session sign-out needs a stated reason');

-- The notification category is accepted by the outbox (a mandatory notice, so not a preference category).
do $$
begin
  insert into corvis_control.email_outbox (tenant_id,category,recipient_user_id,required_roles,template_params,dedupe_key)
  values ('a0870000-0000-4000-8000-00000000000a','security_policy','a0870000-0000-4000-8000-0000000000e1',array['tenant_admin'],'{"event":"policy_changed"}'::jsonb,'security_policy:test');
  begin
    insert into corvis_control.notification_preference (tenant_id,user_id,category,enabled,delivery)
    values ('a0870000-0000-4000-8000-00000000000a','a0870000-0000-4000-8000-0000000000e1','security_policy',false,'immediate');
    raise exception 'a mandatory security notice must not be a preference category';
  exception when check_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------- housekeeping (migration 091, F7d #337)
do $$
declare
  t constant uuid := 'a0870000-0000-4000-8000-00000000000a';
  other constant uuid := 'b0870000-0000-4000-8000-00000000000b';
  removed integer;
  revocations_before integer;
begin
  -- The longest allowed maximum session is 10080 minutes; the purge refuses any retention that does not outlast it by a day.
  perform pg_temp.expect_error($f$select corvis_control.purge_tenant_session_activity(11519)$f$, 'session activity retention is shorter than the longest session');
  perform pg_temp.expect_error($f$select corvis_control.purge_tenant_session_activity(10080)$f$, 'session activity retention is shorter than the longest session');
  perform pg_temp.expect_error($f$select corvis_control.purge_tenant_session_activity(0)$f$, 'session activity retention is shorter than the longest session');
  perform pg_temp.expect_error($f$select corvis_control.purge_tenant_session_activity(null)$f$, 'session activity retention is shorter than the longest session');
  perform pg_temp.expect_error($f$select corvis_control.purge_tenant_session_activity(129600, 0)$f$, 'session activity purge limit is out of range');
  perform pg_temp.expect_error($f$select corvis_control.purge_tenant_session_activity(129600, 10001)$f$, 'session activity purge limit is out of range');
  perform pg_temp.expect_error($f$select corvis_control.purge_tenant_session_activity(129600, null)$f$, 'session activity purge limit is out of range');

  -- A policy with both limits at their longest, so every session below is one a limit may still be measuring.
  perform * from corvis_control.set_tenant_session_policy(t,'oidc','idp|admin-1',480,10080,(select version from corvis_control.tenant_session_policy where tenant_id = t));

  insert into corvis_control.tenant_session_activity (tenant_id, auth_method, subject, session_id, first_seen_at, last_seen_at) values
    (t,     'oidc', 'idp|member',  'hk-active',    now() - interval '6 days',   now() - interval '1 minute'),
    (t,     'oidc', 'idp|member',  'hk-quiet',     now() - interval '5 days',   now() - interval '4 days'),
    (t,     'oidc', 'idp|member',  'hk-edge',      now() - interval '12 days',  now() - interval '11519 minutes'),
    (t,     'oidc', 'idp|member',  'hk-old-1',     now() - interval '120 days', now() - interval '100 days'),
    (t,     'saml', 'saml|member', 'hk-old-2',     now() - interval '120 days', now() - interval '95 days'),
    (t,     'oidc', 'idp|analyst', 'hk-revoked',   now() - interval '120 days', now() - interval '99 days'),
    (other, 'oidc', 'idp|b-owner', 'hk-old-other', now() - interval '110 days', now() - interval '91 days');
  insert into corvis_control.session_revocation (tenant_id, auth_method, subject, session_id, revoked_by_subject, reason)
  values (t, 'oidc', 'idp|analyst', 'hk-revoked', 'idp|admin-1', 'Housekeeping test');
  select count(*) into revocations_before from corvis_control.session_revocation;

  -- Retention 129600 (90 days): only sessions not seen for 90 days go, in every tenant, oldest first, at most p_limit per call.
  removed := corvis_control.purge_tenant_session_activity(129600, 2);
  if removed <> 2 then raise exception 'the batch limit bounds one call, removed %', removed; end if;
  if exists (select 1 from corvis_control.tenant_session_activity where session_id in ('hk-old-1', 'hk-revoked')) then raise exception 'the oldest are removed first'; end if;
  removed := corvis_control.purge_tenant_session_activity(129600);
  if removed <> 2 then raise exception 'the rest of the old records go on the next call, removed %', removed; end if;
  if exists (select 1 from corvis_control.tenant_session_activity where session_id like 'hk-old%') then raise exception 'every session unseen for 90 days is purged, in every tenant'; end if;
  if (select count(*) from corvis_control.tenant_session_activity where session_id in ('hk-active', 'hk-quiet', 'hk-edge')) <> 3 then raise exception 'recent sessions are never purged'; end if;
  if corvis_control.purge_tenant_session_activity(129600) <> 0 then raise exception 'purging is idempotent'; end if;

  -- Even the shortest retention allowed (11520 minutes) removes nothing a limit can still be measuring: the longest maximum
  -- session is 10080 minutes, so a record not seen for 11520 minutes was first seen longer ago than any maximum.
  if corvis_control.purge_tenant_session_activity(11520) <> 0 then raise exception 'at the floor, nothing a limit still measures is purged (hk-edge was seen 11519 minutes ago)'; end if;
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','hk-active') <> 'ok' then raise exception 'an active session survives the purge and is still allowed'; end if;
  update corvis_control.tenant_session_activity set first_seen_at = now() - interval '8 days', last_seen_at = now() - interval '1 minute' where tenant_id = t and session_id = 'hk-active';
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','hk-active') <> 'max_session' then raise exception 'a session past the maximum is still refused after a purge'; end if;
  update corvis_control.tenant_session_activity set last_seen_at = now() - interval '12000 minutes' where tenant_id = t and session_id = 'hk-edge';
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','hk-edge') <> 'max_session' then raise exception 'a session first seen 12 days ago is past the maximum'; end if;
  update corvis_control.tenant_session_activity set first_seen_at = now() - interval '13000 minutes', last_seen_at = now() - interval '12000 minutes' where tenant_id = t and session_id = 'hk-quiet';
  if corvis_control.purge_tenant_session_activity(11520) <> 2 then raise exception 'at the floor, a session unseen for over 11520 minutes is purged'; end if;
  if exists (select 1 from corvis_control.tenant_session_activity where session_id in ('hk-edge', 'hk-quiet')) then raise exception 'those two are gone'; end if;
  -- A session that comes back after its record was purged is simply a new session: it is recorded again and measured from now.
  if corvis_control.enforce_session_policy(t,'oidc','idp|member','hk-edge') <> 'ok' then raise exception 'a purged session that returns is recorded as new'; end if;

  -- Revoked sessions keep working as revoked: the revocation table is not touched, so the authoritative lookup still excludes them.
  if (select count(*) from corvis_control.session_revocation) <> revocations_before then raise exception 'the purge never touches session revocations'; end if;
  if exists (
    select 1 from corvis_control.identity_subject s
    where s.tenant_id = t and s.subject = 'idp|analyst' and s.auth_method = 'oidc'
      and not exists (select 1 from corvis_control.session_revocation r
        where r.tenant_id = s.tenant_id and r.auth_method = s.auth_method and r.subject = s.subject and r.session_id = 'hk-revoked')
  ) then raise exception 'a revoked session must not resolve, though its activity record was purged'; end if;
  if (select count(*) from corvis_control.tenant_session_activity where session_id = 'hk-revoked') <> 0 then raise exception 'the revoked session''s activity record was purged'; end if;

  -- Sign-out-everywhere still works on what remains, and the revocations it writes are not purged either.
  perform corvis_control.enforce_session_policy(t,'oidc','idp|analyst','hk-live');
  if corvis_control.sign_out_user_everywhere(t,'oidc','idp|admin-1','a0870000-0000-4000-8000-0000000000e4','Housekeeping check') < 1 then raise exception 'sign out everywhere still finds the live sessions'; end if;
  if not exists (select 1 from corvis_control.session_revocation where tenant_id = t and session_id = 'hk-live') then raise exception 'and revokes them'; end if;
  perform corvis_control.purge_tenant_session_activity(11520);
  if not exists (select 1 from corvis_control.session_revocation where tenant_id = t and session_id = 'hk-live') then raise exception 'a purge never removes a revocation'; end if;
end $$;

-- ---------------------------------------------------------------- Require SSO, MFA evidence and back-channel logout (migration 099, F7a #334, F7c #336)
-- C: an organization with its own bound OIDC provider; D: an organization on the shared provider (no record); E: bound to ANOTHER provider.
insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('c0990000-0000-4000-8000-00000000000c','sso-c','SSO C'),
       ('d0990000-0000-4000-8000-00000000000d','sso-d','SSO D'),
       ('e0990000-0000-4000-8000-00000000000e','sso-e','SSO E');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name)
values ('c0990000-0000-4000-8000-0000000000c1','c0990000-0000-4000-8000-00000000000c','primary','C primary'),
       ('d0990000-0000-4000-8000-0000000000d1','d0990000-0000-4000-8000-00000000000d','primary','D primary'),
       ('e0990000-0000-4000-8000-0000000000e1','e0990000-0000-4000-8000-00000000000e','primary','E primary');
insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject,status)
values ('c0990000-0000-4000-8000-00000000000c','c0990000-0000-4000-8000-0000000000f1','oidc','idp|sso-admin','active'),
       ('c0990000-0000-4000-8000-00000000000c','c0990000-0000-4000-8000-0000000000f1','saml','saml|sso-admin','active'),
       ('c0990000-0000-4000-8000-00000000000c','c0990000-0000-4000-8000-0000000000f2','oidc','idp|sso-member','active'),
       ('d0990000-0000-4000-8000-00000000000d','d0990000-0000-4000-8000-0000000000f3','oidc','idp|d-admin','active'),
       ('d0990000-0000-4000-8000-00000000000d','d0990000-0000-4000-8000-0000000000f4','oidc','idp|shared-user','active'),
       ('d0990000-0000-4000-8000-00000000000d','d0990000-0000-4000-8000-0000000000f5','oidc','idp|other-user','active'),
       ('e0990000-0000-4000-8000-00000000000e','e0990000-0000-4000-8000-0000000000f6','oidc','idp|e-admin','active'),
       ('e0990000-0000-4000-8000-00000000000e','e0990000-0000-4000-8000-0000000000f7','oidc','idp|shared-user','active');
insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name)
values ('c0990000-0000-4000-8000-00000000000c','c0990000-0000-4000-8000-0000000000c1','c0990000-0000-4000-8000-0000000000f1','tenant_admin'),
       ('c0990000-0000-4000-8000-00000000000c','c0990000-0000-4000-8000-0000000000c1','c0990000-0000-4000-8000-0000000000f2','analyst'),
       ('d0990000-0000-4000-8000-00000000000d','d0990000-0000-4000-8000-0000000000d1','d0990000-0000-4000-8000-0000000000f3','tenant_admin'),
       ('d0990000-0000-4000-8000-00000000000d','d0990000-0000-4000-8000-0000000000d1','d0990000-0000-4000-8000-0000000000f4','analyst'),
       ('d0990000-0000-4000-8000-00000000000d','d0990000-0000-4000-8000-0000000000d1','d0990000-0000-4000-8000-0000000000f5','analyst'),
       ('e0990000-0000-4000-8000-00000000000e','e0990000-0000-4000-8000-0000000000e1','e0990000-0000-4000-8000-0000000000f6','tenant_admin'),
       ('e0990000-0000-4000-8000-00000000000e','e0990000-0000-4000-8000-0000000000e1','e0990000-0000-4000-8000-0000000000f7','analyst');
insert into corvis_control.tenant_identity_provider (tenant_id,protocol,issuer,audience,status,enforce_token_binding,updated_by_subject)
values ('c0990000-0000-4000-8000-00000000000c','oidc','https://idp.sso-c.example','corvis-sso-c','active',true,'ops'),
       ('e0990000-0000-4000-8000-00000000000e','oidc','https://idp.sso-e.example','corvis-sso-e','active',true,'ops');

-- Require SSO needs a recorded, active OIDC provider with token binding: none, or binding off, is refused and stores nothing.
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('d0990000-0000-4000-8000-00000000000d','oidc','idp|d-admin',null,null,0,true,'https://login.global.example','global-aud')$f$, 'session policy sso needs token binding');
update corvis_control.tenant_identity_provider set enforce_token_binding = false where tenant_id = 'e0990000-0000-4000-8000-00000000000e';
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('e0990000-0000-4000-8000-00000000000e','oidc','idp|e-admin',null,null,0,true,'https://idp.sso-e.example','corvis-sso-e')$f$, 'session policy sso needs token binding');
update corvis_control.tenant_identity_provider set enforce_token_binding = true where tenant_id = 'e0990000-0000-4000-8000-00000000000e';

-- Lock-out safeguard: refused from a session that would itself be refused (a SAML sign-in, another issuer or audience, no verified token).
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('c0990000-0000-4000-8000-00000000000c','saml','saml|sso-admin',null,null,0,true,'https://idp.sso-c.example','corvis-sso-c')$f$, 'session policy sso would lock out current session');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('c0990000-0000-4000-8000-00000000000c','oidc','idp|sso-admin',null,null,0,true,'https://login.global.example','corvis-sso-c')$f$, 'session policy sso would lock out current session');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('c0990000-0000-4000-8000-00000000000c','oidc','idp|sso-admin',null,null,0,true,'https://idp.sso-c.example','global-aud')$f$, 'session policy sso would lock out current session');
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('c0990000-0000-4000-8000-00000000000c','oidc','idp|sso-admin',null,null,0,true,null,null)$f$, 'session policy sso would lock out current session');
-- It is an admin-only change like the rest.
select pg_temp.expect_error($f$select * from corvis_control.set_tenant_session_policy('c0990000-0000-4000-8000-00000000000c','oidc','idp|sso-member',null,null,0,true,'https://idp.sso-c.example','corvis-sso-c')$f$, 'session policy requires an active organization admin');
do $$
begin
  if exists (select 1 from corvis_control.tenant_session_policy where tenant_id in ('c0990000-0000-4000-8000-00000000000c','d0990000-0000-4000-8000-00000000000d','e0990000-0000-4000-8000-00000000000e')) then
    raise exception 'a refused Require SSO change must store nothing';
  end if;
  -- With the flag off (no policy row at all) every sign-in passes the SSO predicate.
  if not (corvis_control.sso_session_allowed('c0990000-0000-4000-8000-00000000000c','saml',null,null)
      and corvis_control.sso_session_allowed('c0990000-0000-4000-8000-00000000000c','oidc',null,null)) then
    raise exception 'with Require SSO off nothing is refused';
  end if;
end $$;

do $$
declare
  c constant uuid := 'c0990000-0000-4000-8000-00000000000c';
  r corvis_control.tenant_session_policy%rowtype;
begin
  -- A policy that sets only Require SSO is a policy: the row is created (no limit needed), by a compliant session.
  select * into r from corvis_control.set_tenant_session_policy(c,'oidc','idp|sso-admin',null,null,0,true,'https://idp.sso-c.example','corvis-sso-c');
  if r.version <> 1 or not r.require_sso or r.idle_timeout_minutes is not null then raise exception 'first policy with only Require SSO: %', r; end if;

  -- Left out (NULL) it keeps the stored value, so a limit change from a caller that does not know the flag cannot weaken it.
  select * into r from corvis_control.set_tenant_session_policy(c,'oidc','idp|sso-admin',60,null,1);
  if r.version <> 2 or not r.require_sso or r.idle_timeout_minutes <> 60 then raise exception 'omitting Require SSO must keep it on: %', r; end if;
  -- The same values change nothing (and no lock-out check is needed to stay on: the admin's own request already passed it).
  select * into r from corvis_control.set_tenant_session_policy(c,'oidc','idp|sso-admin',60,null,2,true,null,null);
  if r.version <> 2 then raise exception 'unchanged policy must keep its version: %', r; end if;

  -- The predicate: only an OIDC session whose verified issuer AND audience equal the record passes; SAML never does.
  if not corvis_control.sso_session_allowed(c,'oidc','https://idp.sso-c.example','corvis-sso-c') then raise exception 'the bound OIDC session must pass'; end if;
  if corvis_control.sso_session_allowed(c,'oidc','https://login.global.example','corvis-sso-c') then raise exception 'another issuer must be refused'; end if;
  if corvis_control.sso_session_allowed(c,'oidc','https://idp.sso-c.example','global-aud') then raise exception 'another audience must be refused'; end if;
  if corvis_control.sso_session_allowed(c,'oidc',null,'corvis-sso-c') or corvis_control.sso_session_allowed(c,'oidc','https://idp.sso-c.example',null)
     or corvis_control.sso_session_allowed(c,'oidc',null,null) then raise exception 'a session with no verified token claims (a gateway assertion) must be refused'; end if;
  if corvis_control.sso_session_allowed(c,'saml','https://idp.sso-c.example','corvis-sso-c') or corvis_control.sso_session_allowed(c,'saml',null,null) then raise exception 'a SAML sign-in must be refused'; end if;
  -- Service identities are unaffected; so are tenants that did not turn it on.
  if not corvis_control.sso_session_allowed(c,'service_account',null,null) then raise exception 'service identities are governed by their grants'; end if;
  if not corvis_control.sso_session_allowed('d0990000-0000-4000-8000-00000000000d','saml',null,null) or not corvis_control.sso_session_allowed('e0990000-0000-4000-8000-00000000000e','oidc',null,null) then
    raise exception 'another tenant is never affected';
  end if;
  -- An identity-provider record removed or weakened underneath it fails closed.
  update corvis_control.tenant_identity_provider set enforce_token_binding = false where tenant_id = c;
  if corvis_control.sso_session_allowed(c,'oidc','https://idp.sso-c.example','corvis-sso-c') then raise exception 'a record without binding must refuse everyone'; end if;
  update corvis_control.tenant_identity_provider set enforce_token_binding = true where tenant_id = c;
  delete from corvis_control.tenant_identity_provider where tenant_id = c;
  if corvis_control.sso_session_allowed(c,'oidc','https://idp.sso-c.example','corvis-sso-c') then raise exception 'no record must refuse everyone'; end if;
  insert into corvis_control.tenant_identity_provider (tenant_id,protocol,issuer,audience,status,enforce_token_binding,updated_by_subject)
  values (c,'oidc','https://idp.sso-c.example','corvis-sso-c','active',true,'ops');

  -- Turning it off is always allowed, from any admin session (the safeguard is about turning it on).
  select * into r from corvis_control.set_tenant_session_policy(c,'saml','saml|sso-admin',60,null,2,false,null,null);
  if r.version <> 3 or r.require_sso then raise exception 'disabling must always work: %', r; end if;
  if not corvis_control.sso_session_allowed(c,'saml',null,null) then raise exception 'once off, nobody is refused'; end if;
  -- ... and can be turned on again (a stale writer is still refused).
  begin
    perform * from corvis_control.set_tenant_session_policy(c,'oidc','idp|sso-admin',60,null,2,true,'https://idp.sso-c.example','corvis-sso-c');
    raise exception 'a stale version must be refused';
  exception when others then
    if position('session policy version conflict' in sqlerrm) = 0 then raise; end if;
  end;
  select * into r from corvis_control.set_tenant_session_policy(c,'oidc','idp|sso-admin',60,null,3,true,'https://idp.sso-c.example','corvis-sso-c');
  if r.version <> 4 or not r.require_sso then raise exception 're-enabling: %', r; end if;
end $$;

-- ---------------------------------------------------------------- MFA evidence recorded per session
do $$
declare
  d constant uuid := 'd0990000-0000-4000-8000-00000000000d';
  v boolean;
begin
  -- The old four-argument call still works and records "not reported".
  if corvis_control.enforce_session_policy(d,'oidc','idp|shared-user','mfa-0') <> 'ok' then raise exception 'four-argument call'; end if;
  select mfa_used into v from corvis_control.tenant_session_activity where tenant_id = d and session_id = 'mfa-0';
  if v is not null then raise exception 'no amr reported must be stored as NULL, not false'; end if;

  perform corvis_control.enforce_session_policy(d,'oidc','idp|shared-user','mfa-1',true);
  select mfa_used into v from corvis_control.tenant_session_activity where tenant_id = d and session_id = 'mfa-1';
  if v is distinct from true then raise exception 'a session whose token showed MFA is recorded as such'; end if;
  -- A later request that reports nothing never erases what an earlier one reported.
  perform corvis_control.enforce_session_policy(d,'oidc','idp|shared-user','mfa-1',null);
  select mfa_used into v from corvis_control.tenant_session_activity where tenant_id = d and session_id = 'mfa-1';
  if v is distinct from true then raise exception 'NULL must keep the reported value'; end if;
  -- A report that changes (the provider now says a single factor) is stored, and a first report on a known session fills the gap.
  perform corvis_control.enforce_session_policy(d,'oidc','idp|shared-user','mfa-1',false);
  select mfa_used into v from corvis_control.tenant_session_activity where tenant_id = d and session_id = 'mfa-1';
  if v is distinct from false then raise exception 'a changed report must be stored'; end if;
  perform corvis_control.enforce_session_policy(d,'oidc','idp|shared-user','mfa-0',true);
  select mfa_used into v from corvis_control.tenant_session_activity where tenant_id = d and session_id = 'mfa-0';
  if v is distinct from true then raise exception 'a first report on a session that reported nothing must be stored'; end if;
  -- An unstable session id is not recorded at all, so there is no evidence to keep.
  perform corvis_control.enforce_session_policy(d,'oidc','idp|shared-user','token-abc',true);
  if exists (select 1 from corvis_control.tenant_session_activity where session_id = 'token-abc') then raise exception 'unstable session ids are not recorded'; end if;
end $$;

-- ---------------------------------------------------------------- OIDC back-channel logout
do $$
declare
  d constant uuid := 'd0990000-0000-4000-8000-00000000000d';
  c constant uuid := 'c0990000-0000-4000-8000-00000000000c';
  e constant uuid := 'e0990000-0000-4000-8000-00000000000e';
  r jsonb;
  g constant text := 'https://login.global.example';
  audit_text text;
begin
  -- Sessions the application has seen: the shared user in D and in E, another user in D, and a member of C.
  perform corvis_control.enforce_session_policy(d,'oidc','idp|shared-user','bc-A');
  perform corvis_control.enforce_session_policy(d,'oidc','idp|shared-user','bc-B');
  perform corvis_control.enforce_session_policy(d,'oidc','idp|shared-user','bc-C');
  perform corvis_control.enforce_session_policy(d,'oidc','idp|other-user','bc-X');
  perform corvis_control.enforce_session_policy(e,'oidc','idp|shared-user','bc-A');
  perform corvis_control.enforce_session_policy(c,'oidc','idp|sso-member','bc-A');

  -- Which tenants a provider's logout may reach.
  if (select array_agg(t order by t) from corvis_control.backchannel_logout_tenants(g,'global-aud',true) t where t in (c,d,e)) is distinct from array[d]::uuid[] then
    raise exception 'the shared provider reaches only tenants that accept its tokens (not C or E, which bind another provider)';
  end if;
  if (select array_agg(t) from corvis_control.backchannel_logout_tenants('https://idp.sso-c.example','corvis-sso-c',false) t) is distinct from array[c]::uuid[] then
    raise exception 'a tenant''s provider reaches its own tenant';
  end if;
  if exists (select 1 from corvis_control.backchannel_logout_tenants('https://idp.sso-c.example','wrong-aud',false)) then raise exception 'a recorded issuer needs its recorded audience'; end if;
  if exists (select 1 from corvis_control.backchannel_logout_tenants('https://unknown.example','global-aud',false)) then raise exception 'an unknown issuer reaches nobody'; end if;

  -- A token naming a subject and a session ends that session for that subject, in the tenants of the provider, and nothing else.
  r := corvis_control.apply_backchannel_logout(g,'global-aud','jti-1','idp|shared-user','bc-A',true,'corr-bc-1');
  if r->>'status' <> 'ok' or (r->>'revokedSessions')::int <> 1 or (r->>'tenants')::int <> 1 then raise exception 'unexpected result %', r; end if;
  if not exists (select 1 from corvis_control.session_revocation where tenant_id = d and auth_method = 'oidc' and subject = 'idp|shared-user' and session_id = 'bc-A' and revoked_by_subject = 'idp:backchannel-logout') then
    raise exception 'the session must be revoked in the shared-provider tenant';
  end if;
  if exists (select 1 from corvis_control.session_revocation where tenant_id in (e,c)) or exists (select 1 from corvis_control.session_revocation where session_id in ('bc-B','bc-C','bc-X')) then
    raise exception 'nothing else may be revoked: not the bound tenants, not the other sessions or people';
  end if;
  -- It is audited for the affected tenant with counts only: never the subject, the session id or the token.
  select metadata::text into audit_text from corvis_control.audit_event where tenant_id = d and action = 'access.session.idp_logout' and correlation_id = 'corr-bc-1';
  if audit_text is null then raise exception 'the logout must be audited for the tenant'; end if;
  if audit_text like '%shared-user%' or audit_text like '%bc-A%' or audit_text like '%jti-1%' then raise exception 'the audit event must not name the person, session or token: %', audit_text; end if;
  if (select (metadata->>'revokedSessions')::int from corvis_control.audit_event where tenant_id = d and action = 'access.session.idp_logout' and correlation_id = 'corr-bc-1') <> 1 then raise exception 'audit counts the sessions'; end if;
  if exists (select 1 from corvis_control.audit_event where tenant_id in (c,e) and action = 'access.session.idp_logout') then raise exception 'unaffected tenants are not audited'; end if;

  -- Replay protection: the same token id is refused and changes nothing.
  r := corvis_control.apply_backchannel_logout(g,'global-aud','jti-1','idp|shared-user','bc-B',true,'corr-bc-2');
  if r->>'status' <> 'replay' then raise exception 'a replayed token id must be refused: %', r; end if;
  if exists (select 1 from corvis_control.session_revocation where session_id = 'bc-B') then raise exception 'a replay must revoke nothing'; end if;
  -- The ledger is per issuer: the same token id from another issuer is a different token.
  r := corvis_control.apply_backchannel_logout('https://idp.sso-c.example','corvis-sso-c','jti-1','idp|sso-member','bc-A',false,'corr-bc-3');
  if r->>'status' <> 'ok' or (r->>'revokedSessions')::int <> 1 then raise exception 'the same jti from another issuer is another token: %', r; end if;
  if not exists (select 1 from corvis_control.session_revocation where tenant_id = c and subject = 'idp|sso-member' and session_id = 'bc-A') then raise exception 'the tenant provider revokes in its tenant'; end if;

  -- Already revoked: succeeds, revokes nothing new, and records no empty audit event.
  r := corvis_control.apply_backchannel_logout(g,'global-aud','jti-2','idp|shared-user','bc-A',true,'corr-bc-4');
  if r->>'status' <> 'ok' or (r->>'revokedSessions')::int <> 0 or (r->>'tenants')::int <> 0 then raise exception 'idempotent logout: %', r; end if;
  if exists (select 1 from corvis_control.audit_event where correlation_id = 'corr-bc-4') then raise exception 'no revocation, no audit event'; end if;

  -- A subject alone ends every session recorded for that subject (only in the provider's tenants).
  r := corvis_control.apply_backchannel_logout(g,'global-aud','jti-3','idp|shared-user',null,true,'corr-bc-5');
  if r->>'status' <> 'ok' or (r->>'revokedSessions')::int <> 4 then raise exception 'subject logout must revoke the not-yet-revoked recorded sessions (bc-B, bc-C, mfa-0, mfa-1): %', r; end if;
  if exists (select 1 from corvis_control.session_revocation where tenant_id = e) then raise exception 'the same subject in a tenant bound to another provider is untouched'; end if;
  if exists (select 1 from corvis_control.session_revocation where subject = 'idp|other-user') then raise exception 'another person is untouched'; end if;

  -- A session alone ends that session for whoever it was recorded for.
  r := corvis_control.apply_backchannel_logout(g,'global-aud','jti-4',null,'bc-X',true,'corr-bc-6');
  if r->>'status' <> 'ok' or (r->>'revokedSessions')::int <> 1 then raise exception 'session-only logout: %', r; end if;
  if not exists (select 1 from corvis_control.session_revocation where tenant_id = d and subject = 'idp|other-user' and session_id = 'bc-X') then raise exception 'the session owner is found from the session record'; end if;

  -- An unknown person or session is a success that changes nothing (the endpoint reveals nothing about who exists).
  r := corvis_control.apply_backchannel_logout(g,'global-aud','jti-5','idp|nobody','nope',true,'corr-bc-7');
  if r->>'status' <> 'ok' or (r->>'revokedSessions')::int <> 0 then raise exception 'unknown subject: %', r; end if;
  r := corvis_control.apply_backchannel_logout(g,'global-aud','jti-6',null,'nope',true,'corr-bc-8');
  if r->>'status' <> 'ok' or (r->>'revokedSessions')::int <> 0 then raise exception 'unknown session: %', r; end if;
  -- A provider that is not recorded for any tenant, and not the shared one, reaches nobody.
  r := corvis_control.apply_backchannel_logout('https://unknown.example','global-aud','jti-7','idp|shared-user','bc-C',false,'corr-bc-9');
  if (r->>'revokedSessions')::int <> 0 then raise exception 'an unknown provider must revoke nothing: %', r; end if;

  -- The authoritative lookup consults session_revocation: the revoked session no longer resolves.
  if exists (
    select 1 from corvis_control.identity_subject s
    where s.tenant_id = d and s.subject = 'idp|shared-user' and s.auth_method = 'oidc'
      and not exists (select 1 from corvis_control.session_revocation x where x.tenant_id = s.tenant_id and x.auth_method = s.auth_method and x.subject = s.subject and x.session_id = 'bc-A')
  ) then raise exception 'the revoked session must not resolve'; end if;
end $$;

select pg_temp.expect_error($f$select corvis_control.apply_backchannel_logout('https://login.global.example','global-aud',null,'s','sid',true,'c')$f$, 'backchannel logout request is invalid');
select pg_temp.expect_error($f$select corvis_control.apply_backchannel_logout('https://login.global.example','global-aud','j',null,null,true,'c')$f$, 'backchannel logout request is invalid');
select pg_temp.expect_error($f$select corvis_control.apply_backchannel_logout('https://login.global.example','global-aud',repeat('j',257),'s',null,true,'c')$f$, 'backchannel logout request is invalid');
select pg_temp.expect_error($f$select corvis_control.apply_backchannel_logout('https://login.global.example',null,'j','s',null,true,'c')$f$, 'backchannel logout request is invalid');
select pg_temp.expect_error($f$select corvis_control.apply_backchannel_logout('https://login.global.example','global-aud','j','s',null,null,'c')$f$, 'backchannel logout request is invalid');
select pg_temp.expect_error($f$select corvis_control.apply_backchannel_logout('https://login.global.example','global-aud','j','s',null,true,null)$f$, 'backchannel logout request is invalid');

-- Rate bound per issuer, and housekeeping of the single-use ledger.
do $$
declare
  r jsonb;
begin
  insert into corvis_control.oidc_logout_token_use (issuer, jti, used_at)
  select 'https://flood.example', 'f-' || n, now() from generate_series(1, 600) n;
  r := corvis_control.apply_backchannel_logout('https://flood.example','a','one-more','s',null,false,'corr-flood');
  if r->>'status' <> 'rate_limited' then raise exception 'a flood from one issuer must be limited: %', r; end if;
  if exists (select 1 from corvis_control.oidc_logout_token_use where jti = 'one-more') then raise exception 'a limited token is not consumed'; end if;
  -- Another issuer is unaffected.
  r := corvis_control.apply_backchannel_logout('https://quiet.example','a','one-more','s',null,false,'corr-quiet');
  if r->>'status' <> 'ok' then raise exception 'another issuer is not limited: %', r; end if;
  -- Ledger rows older than a quarter of an hour are deleted by the next call; recent ones are kept.
  insert into corvis_control.oidc_logout_token_use (issuer, jti, used_at) values ('https://old.example','old-1', now() - interval '16 minutes'), ('https://old.example','recent-1', now() - interval '5 minutes');
  perform corvis_control.apply_backchannel_logout('https://quiet.example','a','two-more','s',null,false,'corr-house');
  if exists (select 1 from corvis_control.oidc_logout_token_use where jti = 'old-1') then raise exception 'old ledger rows are removed'; end if;
  if not exists (select 1 from corvis_control.oidc_logout_token_use where jti = 'recent-1') then raise exception 'recent ledger rows are kept'; end if;
end $$;

-- ---------------------------------------------------------------- RLS: enabled, forced, no client policy
do $$
declare
  offenders text;
begin
  select string_agg(c.relname, ', ') into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'corvis_control' and c.relname in ('tenant_session_policy','tenant_session_activity','oidc_logout_token_use') and not (c.relrowsecurity and c.relforcerowsecurity);
  if offenders is not null then raise exception 'RLS must be enabled and forced on %', offenders; end if;
  if exists (select 1 from pg_policies where schemaname = 'corvis_control' and policyname <> 'corvis_runtime_service' and tablename in ('tenant_session_policy','tenant_session_activity','oidc_logout_token_use')) then
    raise exception 'session policy tables are server-managed: no client policy may exist';
  end if;
end $$;

drop role if exists corvis_session_policy_negative_role;
create role corvis_session_policy_negative_role nologin nosuperuser nobypassrls noinherit;
grant usage on schema corvis_control to corvis_session_policy_negative_role;
grant select on corvis_control.tenant_session_policy, corvis_control.tenant_session_activity, corvis_control.oidc_logout_token_use to corvis_session_policy_negative_role;
set role corvis_session_policy_negative_role;
do $$
begin
  set local request.jwt.claim.sub = 'a0870000-0000-4000-8000-0000000000e1';
  if (select count(*) from corvis_control.tenant_session_policy) <> 0 or (select count(*) from corvis_control.tenant_session_activity) <> 0
     or (select count(*) from corvis_control.oidc_logout_token_use) <> 0 then
    raise exception 'a non-owner role must not read the policy or session activity, even as an admin';
  end if;
end $$;
reset role;
drop owned by corvis_session_policy_negative_role;
drop role corvis_session_policy_negative_role;

rollback;
