-- Acceptance for migration 087 (F7, #263): organization session policy and "sign out everywhere".
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

-- ---------------------------------------------------------------- RLS: enabled, forced, no client policy
do $$
declare
  offenders text;
begin
  select string_agg(c.relname, ', ') into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'corvis_control' and c.relname in ('tenant_session_policy','tenant_session_activity') and not (c.relrowsecurity and c.relforcerowsecurity);
  if offenders is not null then raise exception 'RLS must be enabled and forced on %', offenders; end if;
  if exists (select 1 from pg_policies where schemaname = 'corvis_control' and tablename in ('tenant_session_policy','tenant_session_activity')) then
    raise exception 'session policy tables are server-managed: no client policy may exist';
  end if;
end $$;

drop role if exists corvis_session_policy_negative_role;
create role corvis_session_policy_negative_role nologin nosuperuser nobypassrls noinherit;
grant usage on schema corvis_control to corvis_session_policy_negative_role;
grant select on corvis_control.tenant_session_policy, corvis_control.tenant_session_activity to corvis_session_policy_negative_role;
set role corvis_session_policy_negative_role;
do $$
begin
  set local request.jwt.claim.sub = 'a0870000-0000-4000-8000-0000000000e1';
  if (select count(*) from corvis_control.tenant_session_policy) <> 0 or (select count(*) from corvis_control.tenant_session_activity) <> 0 then
    raise exception 'a non-owner role must not read the policy or session activity, even as an admin';
  end if;
end $$;
reset role;
drop owned by corvis_session_policy_negative_role;
drop role corvis_session_policy_negative_role;

rollback;
