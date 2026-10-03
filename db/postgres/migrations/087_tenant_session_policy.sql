-- F7 (#263): organization session policy and "sign out everywhere".
-- Depends on migrations 001-086 (008 session revocation, 060 SCIM, 071/083/086 for the notification category checks).
--
-- Corvis does not run the sign-in: users authenticate at the identity provider and Corvis verifies the token it
-- issues. What an Organization Admin can govern is how long a Corvis *session* (the identity provider's session id,
-- the `sid` claim) may stay idle, how long it may live in total, and ending a named user's sessions at once. This
-- migration adds
--   * tenant_session_policy      one row per tenant: an optional idle timeout and an optional maximum session length,
--                                bounded by CHECK constraints (the Corvis-defined bounds), so no code path, including
--                                an Organization Admin's, can store a value outside them;
--   * tenant_session_activity    the sessions Corvis has seen: when each was first and last used. This is what the
--                                two limits are measured against, and what "sign out everywhere" enumerates;
--   * enforce_session_policy     called on every authoritative request after membership resolves: records the session,
--                                refuses it (idle_timeout, max_session, untracked_session) or returns 'ok';
--   * set_tenant_session_policy  an Organization-Admin-only, compare-and-set change of the policy;
--   * sign_out_user_everywhere   an Organization-Admin-only revocation of every session Corvis has seen for one user,
--                                written to the existing corvis_control.session_revocation (008), which every
--                                authoritative request already consults, so it takes effect on the next request.
--
-- Fail closed: a session whose id is not stable (the `token-<hash>` fallback the OIDC verifier synthesises when the
-- identity provider sends neither `sid` nor `jti`) cannot be measured, so while a limit is set it is refused.
-- Service identities are never subject to this policy (it governs people).
--
-- Access model (mirrors 060/084): both tables are server-managed. There is deliberately no client-facing policy: the
-- application service role reads and writes with explicit tenant predicates after request authorization has
-- succeeded. RLS is enabled and forced so a role without BYPASSRLS sees nothing. The functions are security invoker.

begin;

create table if not exists corvis_control.tenant_session_policy (
  tenant_id uuid primary key references corvis_control.tenant(tenant_id),
  -- null: the organization sets no limit. The bounds are the Corvis-defined ones (core/session-policy.ts).
  idle_timeout_minutes integer check (idle_timeout_minutes between 15 and 480),
  max_session_minutes integer check (max_session_minutes between 60 and 10080),
  version integer not null default 1 check (version >= 1),
  updated_by_auth_method text not null check (updated_by_auth_method in ('oidc','saml')),
  updated_by_subject text not null check (length(updated_by_subject) between 1 and 1024),
  updated_at timestamptz not null default now(),
  check (idle_timeout_minutes is null or max_session_minutes is null or idle_timeout_minutes <= max_session_minutes)
);
alter table corvis_control.tenant_session_policy enable row level security;
alter table corvis_control.tenant_session_policy force row level security;

create table if not exists corvis_control.tenant_session_activity (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  auth_method text not null check (auth_method in ('oidc','saml')),
  subject text not null check (length(subject) between 1 and 1024),
  session_id text not null check (length(session_id) between 1 and 1024),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (tenant_id, auth_method, subject, session_id),
  check (last_seen_at >= first_seen_at)
);
create index if not exists tenant_session_activity_subject_idx
  on corvis_control.tenant_session_activity (tenant_id, auth_method, subject, last_seen_at desc);
alter table corvis_control.tenant_session_activity enable row level security;
alter table corvis_control.tenant_session_activity force row level security;

-- The user behind an active human identity that holds an active Organization Admin (`tenant_admin`) membership in the
-- tenant, or null. A demoted or disabled admin cannot change the policy or sign anyone out.
create or replace function corvis_control.session_policy_admin_user(
  p_tenant_id uuid,
  p_auth_method text,
  p_subject text
)
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select s.user_id
  from corvis_control.identity_subject s
  where s.tenant_id = p_tenant_id
    and s.auth_method = p_auth_method
    and p_auth_method in ('oidc','saml')
    and s.subject = p_subject
    and s.status = 'active'
    and exists (
      select 1 from corvis_control.membership m
      where m.tenant_id = s.tenant_id and m.user_id = s.user_id
        and m.role_name = 'tenant_admin' and m.status = 'active'
        and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    )
  limit 1
$$;

-- Records that a session made a request and decides whether the tenant's policy still allows it. Returns
--   'ok'                 the session may continue (its last-seen time is refreshed at most every 30 seconds);
--   'idle_timeout'       it was last used longer ago than the idle timeout;
--   'max_session'        it was first seen longer ago than the maximum session length;
--   'untracked_session'  a limit is set and the session id is not a stable identifier.
-- An expired session is never refreshed, so it cannot be revived by retrying: it ends for good (until the policy is
-- relaxed) and the person must sign in again. With no limit set it only records activity.
create or replace function corvis_control.enforce_session_policy(
  p_tenant_id uuid,
  p_auth_method text,
  p_subject text,
  p_session_id text
)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_idle integer;
  v_max integer;
  v_first timestamptz;
  v_last timestamptz;
begin
  -- The policy governs people. Service identities are controlled by their grants (service_identity_grant).
  if p_auth_method not in ('oidc','saml') then
    return 'ok';
  end if;

  select p.idle_timeout_minutes, p.max_session_minutes into v_idle, v_max
  from corvis_control.tenant_session_policy p
  where p.tenant_id = p_tenant_id;

  if p_session_id like 'token-%' then
    -- No stable session id: neither limit can be measured and "sign out everywhere" could not name it.
    if v_idle is not null or v_max is not null then
      return 'untracked_session';
    end if;
    return 'ok';
  end if;

  insert into corvis_control.tenant_session_activity (tenant_id, auth_method, subject, session_id)
  values (p_tenant_id, p_auth_method, p_subject, p_session_id)
  on conflict (tenant_id, auth_method, subject, session_id) do nothing;

  select a.first_seen_at, a.last_seen_at into v_first, v_last
  from corvis_control.tenant_session_activity a
  where a.tenant_id = p_tenant_id and a.auth_method = p_auth_method
    and a.subject = p_subject and a.session_id = p_session_id;

  if v_max is not null and v_first + make_interval(mins => v_max) <= now() then
    return 'max_session';
  end if;
  if v_idle is not null and v_last + make_interval(mins => v_idle) <= now() then
    return 'idle_timeout';
  end if;

  if v_last < now() - interval '30 seconds' then
    update corvis_control.tenant_session_activity a
       set last_seen_at = now()
     where a.tenant_id = p_tenant_id and a.auth_method = p_auth_method
       and a.subject = p_subject and a.session_id = p_session_id;
  end if;
  return 'ok';
end;
$$;

-- Sets the tenant's policy. Compare-and-set on `version` (0 means "no policy yet") so two Organization Admins cannot
-- overwrite each other unseen; the tenant row is locked so the first-ever insert cannot race either. Setting the
-- values the policy already has changes nothing and returns the current row unchanged (the caller sees the same
-- version it sent and records no audit event).
create or replace function corvis_control.set_tenant_session_policy(
  p_tenant_id uuid,
  p_auth_method text,
  p_subject text,
  p_idle_timeout_minutes integer,
  p_max_session_minutes integer,
  p_expected_version integer
)
returns setof corvis_control.tenant_session_policy
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_current corvis_control.tenant_session_policy%rowtype;
begin
  if corvis_control.session_policy_admin_user(p_tenant_id, p_auth_method, p_subject) is null then
    raise exception 'session policy requires an active organization admin';
  end if;
  if (p_idle_timeout_minutes is not null and p_idle_timeout_minutes not between 15 and 480)
     or (p_max_session_minutes is not null and p_max_session_minutes not between 60 and 10080)
     or (p_idle_timeout_minutes is not null and p_max_session_minutes is not null and p_idle_timeout_minutes > p_max_session_minutes) then
    raise exception 'session policy bounds exceeded';
  end if;

  perform 1 from corvis_control.tenant t where t.tenant_id = p_tenant_id for update;

  select * into v_current from corvis_control.tenant_session_policy p where p.tenant_id = p_tenant_id;
  if not found then
    if p_expected_version <> 0 then
      raise exception 'session policy version conflict';
    end if;
    if p_idle_timeout_minutes is null and p_max_session_minutes is null then
      -- Nothing is set and nothing was asked for: there is no row to create.
      return;
    end if;
    return query
      insert into corvis_control.tenant_session_policy
        (tenant_id, idle_timeout_minutes, max_session_minutes, updated_by_auth_method, updated_by_subject)
      values (p_tenant_id, p_idle_timeout_minutes, p_max_session_minutes, p_auth_method, p_subject)
      returning *;
    return;
  end if;

  if v_current.version <> p_expected_version then
    raise exception 'session policy version conflict';
  end if;
  if v_current.idle_timeout_minutes is not distinct from p_idle_timeout_minutes
     and v_current.max_session_minutes is not distinct from p_max_session_minutes then
    return next v_current;
    return;
  end if;
  return query
    update corvis_control.tenant_session_policy p
       set idle_timeout_minutes = p_idle_timeout_minutes,
           max_session_minutes = p_max_session_minutes,
           version = p.version + 1,
           updated_by_auth_method = p_auth_method,
           updated_by_subject = p_subject,
           updated_at = now()
     where p.tenant_id = p_tenant_id
    returning p.*;
end;
$$;

-- Ends every session Corvis has seen for one user of the tenant (across all of that user's identities) by writing
-- them to session_revocation; returns how many sessions that newly ended. A person's sign-in is not removed: they can
-- sign in again and get a new session. The caller cannot sign themselves out here (that would end the very session
-- making the request; their identity provider's own sign-out does that).
create or replace function corvis_control.sign_out_user_everywhere(
  p_tenant_id uuid,
  p_auth_method text,
  p_subject text,
  p_user_id uuid,
  p_reason text
)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_actor uuid;
  v_count integer;
begin
  v_actor := corvis_control.session_policy_admin_user(p_tenant_id, p_auth_method, p_subject);
  if v_actor is null then
    raise exception 'session policy requires an active organization admin';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 1000 then
    raise exception 'session sign-out needs a stated reason';
  end if;
  if p_user_id = v_actor then
    raise exception 'session sign-out cannot target current user';
  end if;
  if not exists (
    select 1 from corvis_control.identity_subject s
    where s.tenant_id = p_tenant_id and s.user_id = p_user_id
      and s.status = 'active' and s.auth_method in ('oidc','saml')
  ) then
    raise exception 'session sign-out target not found';
  end if;

  insert into corvis_control.session_revocation
    (tenant_id, auth_method, subject, session_id, revoked_by_subject, reason)
  select a.tenant_id, a.auth_method, a.subject, a.session_id, p_subject, btrim(p_reason)
  from corvis_control.tenant_session_activity a
  join corvis_control.identity_subject s
    on s.tenant_id = a.tenant_id and s.auth_method = a.auth_method and s.subject = a.subject
  where a.tenant_id = p_tenant_id and s.user_id = p_user_id
  on conflict (tenant_id, auth_method, subject, session_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The F7 notification category (docs/NOTIFICATIONS.md): outbox rows may now name it. It is a mandatory security
-- notice to Organization Admins, so it is deliberately not a preference category.
alter table corvis_control.email_outbox drop constraint if exists email_outbox_category_check;
alter table corvis_control.email_outbox add constraint email_outbox_category_check check (category in (
  'invitation','export_ready','pinned_fund_published','source_attention',
  'support_access','role_changed','digest','data_issue_update','review_discussion','security_policy'
));

commit;
