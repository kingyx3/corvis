-- F7a (#334) and F7c (#336): Require SSO, the IdP-reported MFA display, and OIDC Back-Channel Logout.
-- Depends on migrations 001-098 (008 session revocation, 087 session policy, 095 identity records).
--
-- Corvis verifies bearer tokens from the identity provider and is told nothing about HOW a person signed in beyond what the
-- verified token claims (the standard `amr` claim). This migration adds, without claiming more than that evidence shows:
--   * tenant_session_policy.require_sso
--                                 an Organization-Admin-set flag. While on, an interactive human session is accepted only
--                                 if it authenticated through the tenant's recorded, active OpenID Connect provider with
--                                 token binding (a verified token whose issuer and audience equal the record). A SAML
--                                 sign-in and a signed gateway assertion carry no such token, so they are refused. Service
--                                 identities and queued background work are unaffected (they are governed by grants and
--                                 never present a bearer token). sso_session_allowed is the one predicate;
--   * set_tenant_session_policy    gains `require_sso` (NULL keeps the stored value, so a caller that does not know the
--                                 flag can never weaken it). Enabling it needs a recorded active OIDC provider with
--                                 binding on, and is refused from a session that would itself be refused (lock-out
--                                 safeguard). Disabling is always allowed;
--   * tenant_identity_provider     gains `idp_enforces_mfa` (operator-recorded: true, false or NULL = not reported) and
--                                 `end_session_endpoint` (operator-recorded OIDC RP-initiated logout endpoint). While
--                                 require_sso is on, the record cannot be changed in a way that stops SSO working;
--   * tenant_session_activity.mfa_used
--                                 whether the session's token reported more than one factor in `amr`: true, false (an
--                                 `amr` was reported without a second factor) or NULL (not reported);
--   * oidc_logout_token_use and apply_backchannel_logout
--                                 OIDC Back-Channel Logout 1.0: the single-use `jti` ledger (replay protection) and the
--                                 function that turns a verified logout token into session_revocation rows (008). The
--                                 application verifies the signed token; this function applies it atomically, bounded to
--                                 the tenants the issuer and audience legitimately belong to, audited per tenant.
--
-- Access model (mirrors 087/095): server-managed table with RLS enabled and forced and no client policy; the functions are
-- security invoker.

begin;

alter table corvis_control.tenant_session_policy
  add column if not exists require_sso boolean not null default false;

alter table corvis_control.tenant_session_activity
  add column if not exists mfa_used boolean;

alter table corvis_control.tenant_identity_provider
  add column if not exists idp_enforces_mfa boolean,
  add column if not exists end_session_endpoint text;
alter table corvis_control.tenant_identity_provider
  drop constraint if exists tenant_identity_provider_end_session_endpoint_check;
alter table corvis_control.tenant_identity_provider
  add constraint tenant_identity_provider_end_session_endpoint_check check (
    end_session_endpoint is null
    or (length(end_session_endpoint) between 1 and 2048
        and end_session_endpoint ~ '^https://[^/?#@[:space:][:cntrl:]]+(/[^?#[:space:][:cntrl:]]*)?(\?[^#[:space:][:cntrl:]]*)?$')
  );

-- Whether a session may be used by an interactive human under the tenant's Require SSO flag. True when the flag is off, and
-- for service identities (governed by their grants). Otherwise only an OIDC session whose verified token issuer and audience
-- equal the tenant's active, binding-enforced OpenID Connect record: a null issuer or audience (a gateway assertion, a SAML
-- sign-in) compares as not equal, so it fails closed.
create or replace function corvis_control.sso_session_allowed(
  p_tenant_id uuid,
  p_auth_method text,
  p_token_issuer text,
  p_token_audience text
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select p_auth_method not in ('oidc','saml')
    or not exists (select 1 from corvis_control.tenant_session_policy sp where sp.tenant_id = p_tenant_id and sp.require_sso)
    or (
      p_auth_method = 'oidc'
      and exists (
        select 1 from corvis_control.tenant_identity_provider b
        where b.tenant_id = p_tenant_id
          and b.protocol = 'oidc' and b.status = 'active' and b.enforce_token_binding
          and b.issuer = p_token_issuer and b.audience = p_token_audience
      )
    )
$$;

-- Records that a session made a request and decides whether the tenant's policy still allows it (087), now also keeping
-- whether the session's token reported MFA. `p_mfa_used` NULL means "not reported on this request" and never overwrites a
-- value an earlier request reported.
drop function if exists corvis_control.enforce_session_policy(uuid, text, text, text);
create or replace function corvis_control.enforce_session_policy(
  p_tenant_id uuid,
  p_auth_method text,
  p_subject text,
  p_session_id text,
  p_mfa_used boolean default null
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
  v_mfa boolean;
begin
  if p_auth_method not in ('oidc','saml') then
    return 'ok';
  end if;

  select p.idle_timeout_minutes, p.max_session_minutes into v_idle, v_max
  from corvis_control.tenant_session_policy p
  where p.tenant_id = p_tenant_id;

  if p_session_id like 'token-%' then
    if v_idle is not null or v_max is not null then
      return 'untracked_session';
    end if;
    return 'ok';
  end if;

  insert into corvis_control.tenant_session_activity (tenant_id, auth_method, subject, session_id, mfa_used)
  values (p_tenant_id, p_auth_method, p_subject, p_session_id, p_mfa_used)
  on conflict (tenant_id, auth_method, subject, session_id) do nothing;

  select a.first_seen_at, a.last_seen_at, a.mfa_used into v_first, v_last, v_mfa
  from corvis_control.tenant_session_activity a
  where a.tenant_id = p_tenant_id and a.auth_method = p_auth_method
    and a.subject = p_subject and a.session_id = p_session_id;

  if v_max is not null and v_first + make_interval(mins => v_max) <= now() then
    return 'max_session';
  end if;
  if v_idle is not null and v_last + make_interval(mins => v_idle) <= now() then
    return 'idle_timeout';
  end if;

  if v_last < now() - interval '30 seconds' or (p_mfa_used is not null and v_mfa is distinct from p_mfa_used) then
    update corvis_control.tenant_session_activity a
       set last_seen_at = case when v_last < now() - interval '30 seconds' then now() else a.last_seen_at end,
           mfa_used = coalesce(p_mfa_used, a.mfa_used)
     where a.tenant_id = p_tenant_id and a.auth_method = p_auth_method
       and a.subject = p_subject and a.session_id = p_session_id;
  end if;
  return 'ok';
end;
$$;

-- Sets the tenant's policy (087) including Require SSO. Compare-and-set on `version`; `p_require_sso` NULL keeps the stored
-- value. Setting the values the policy already has changes nothing and returns the current row unchanged.
drop function if exists corvis_control.set_tenant_session_policy(uuid, text, text, integer, integer, integer);
create or replace function corvis_control.set_tenant_session_policy(
  p_tenant_id uuid,
  p_auth_method text,
  p_subject text,
  p_idle_timeout_minutes integer,
  p_max_session_minutes integer,
  p_expected_version integer,
  p_require_sso boolean default null,
  p_actor_token_issuer text default null,
  p_actor_token_audience text default null
)
returns setof corvis_control.tenant_session_policy
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_current corvis_control.tenant_session_policy%rowtype;
  v_exists boolean;
  v_require boolean;
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
  v_exists := found;
  if not v_exists then
    if p_expected_version <> 0 then
      raise exception 'session policy version conflict';
    end if;
    v_require := coalesce(p_require_sso, false);
  else
    if v_current.version <> p_expected_version then
      raise exception 'session policy version conflict';
    end if;
    v_require := coalesce(p_require_sso, v_current.require_sso);
  end if;

  -- Turning Require SSO on: the tenant must have a recorded, active OIDC provider with token binding (otherwise nothing could
  -- satisfy it and everyone would be locked out), and the acting session must itself satisfy it (lock-out safeguard).
  if v_require and not (v_exists and v_current.require_sso) then
    if not exists (
      select 1 from corvis_control.tenant_identity_provider b
      where b.tenant_id = p_tenant_id and b.protocol = 'oidc' and b.status = 'active' and b.enforce_token_binding
    ) then
      raise exception 'session policy sso needs token binding';
    end if;
    if p_auth_method <> 'oidc' or not exists (
      select 1 from corvis_control.tenant_identity_provider b
      where b.tenant_id = p_tenant_id and b.protocol = 'oidc' and b.status = 'active' and b.enforce_token_binding
        and b.issuer = p_actor_token_issuer and b.audience = p_actor_token_audience
    ) then
      raise exception 'session policy sso would lock out current session';
    end if;
  end if;

  if not v_exists then
    if p_idle_timeout_minutes is null and p_max_session_minutes is null and not v_require then
      -- Nothing is set and nothing was asked for: there is no row to create.
      return;
    end if;
    return query
      insert into corvis_control.tenant_session_policy
        (tenant_id, idle_timeout_minutes, max_session_minutes, require_sso, updated_by_auth_method, updated_by_subject)
      values (p_tenant_id, p_idle_timeout_minutes, p_max_session_minutes, v_require, p_auth_method, p_subject)
      returning *;
    return;
  end if;

  if v_current.idle_timeout_minutes is not distinct from p_idle_timeout_minutes
     and v_current.max_session_minutes is not distinct from p_max_session_minutes
     and v_current.require_sso = v_require then
    return next v_current;
    return;
  end if;
  return query
    update corvis_control.tenant_session_policy p
       set idle_timeout_minutes = p_idle_timeout_minutes,
           max_session_minutes = p_max_session_minutes,
           require_sso = v_require,
           version = p.version + 1,
           updated_by_auth_method = p_auth_method,
           updated_by_subject = p_subject,
           updated_at = now()
     where p.tenant_id = p_tenant_id
    returning p.*;
end;
$$;

-- The identity-provider record (095) with the IdP-reported MFA enforcement and the RP-initiated logout endpoint. While the
-- tenant's Require SSO flag is on, the record must stay an active OpenID Connect record with token binding on: a change that
-- would stop SSO from working (or silently weaken it) is refused until an Organization Admin turns Require SSO off.
drop function if exists corvis_control.set_tenant_identity_provider(uuid, uuid, text, text, text, text, text, text, boolean, integer, text, text);
create or replace function corvis_control.set_tenant_identity_provider(
  p_target_tenant_id uuid,
  p_actor_tenant_id uuid,
  p_actor_auth_method text,
  p_actor_subject text,
  p_protocol text,
  p_issuer text,
  p_audience text,
  p_status text,
  p_enforce_token_binding boolean,
  p_expected_version integer,
  p_reason text,
  p_correlation_id text,
  p_idp_enforces_mfa boolean default null,
  p_end_session_endpoint text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_current corvis_control.tenant_identity_provider%rowtype;
  v_exists boolean;
  v_version integer;
begin
  if not corvis_control.identity_records_operator(p_actor_tenant_id, p_actor_auth_method, p_actor_subject) then
    raise exception 'identity records require an active operations admin';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 1000 then
    raise exception 'identity record change needs a stated reason';
  end if;
  if p_protocol is null or p_protocol not in ('oidc','saml')
     or p_issuer is null or length(p_issuer) not between 1 and 2048 or p_issuer ~ '[[:space:][:cntrl:]]'
     or p_audience is null or length(p_audience) not between 1 and 1024 or p_audience ~ '[[:space:][:cntrl:]]'
     or p_status is null or p_status not in ('pending','active','disabled')
     or p_enforce_token_binding is null
     or p_expected_version is null or p_expected_version < 0
     or (p_protocol = 'oidc' and (p_issuer !~ '^https://[^/?#]+(/[^?#]*)?$' or p_issuer ~ '/$'))
     or (p_end_session_endpoint is not null and (
       length(p_end_session_endpoint) > 2048
       or p_end_session_endpoint !~ '^https://[^/?#@[:space:][:cntrl:]]+(/[^?#[:space:][:cntrl:]]*)?(\?[^#[:space:][:cntrl:]]*)?$')) then
    raise exception 'identity provider record is invalid';
  end if;
  if p_enforce_token_binding and (p_protocol <> 'oidc' or p_status <> 'active') then
    raise exception 'identity provider binding requires an active oidc record';
  end if;

  perform 1 from corvis_control.tenant t where t.tenant_id = p_target_tenant_id for update;
  if not found then
    raise exception 'identity record tenant not found';
  end if;

  if exists (select 1 from corvis_control.tenant_session_policy sp where sp.tenant_id = p_target_tenant_id and sp.require_sso)
     and not (p_protocol = 'oidc' and p_status = 'active' and p_enforce_token_binding) then
    raise exception 'identity provider change would weaken require sso';
  end if;

  select * into v_current from corvis_control.tenant_identity_provider p where p.tenant_id = p_target_tenant_id;
  v_exists := found;
  if not v_exists then
    if p_expected_version <> 0 then
      raise exception 'identity provider version conflict';
    end if;
    v_version := 1;
    insert into corvis_control.tenant_identity_provider
      (tenant_id, protocol, issuer, audience, status, enforce_token_binding, idp_enforces_mfa, end_session_endpoint, version, updated_by_subject)
    values (p_target_tenant_id, p_protocol, p_issuer, p_audience, p_status, p_enforce_token_binding, p_idp_enforces_mfa, p_end_session_endpoint, v_version, p_actor_subject);
    insert into corvis_control.audit_event
      (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
    values
      (p_target_tenant_id, null, p_actor_subject, 'access.identity_provider.configured', 'identity_provider',
       p_target_tenant_id::text, 'success', p_correlation_id,
       jsonb_build_object('protocol', p_protocol, 'issuer', p_issuer, 'audience', p_audience, 'status', p_status,
         'enforceTokenBinding', p_enforce_token_binding, 'idpEnforcesMfa', p_idp_enforces_mfa,
         'endSessionEndpoint', p_end_session_endpoint, 'version', v_version, 'reason', btrim(p_reason),
         'actorTenantId', p_actor_tenant_id));
    return jsonb_build_object('changed', true, 'version', v_version);
  end if;

  if v_current.version <> p_expected_version then
    raise exception 'identity provider version conflict';
  end if;
  if v_current.protocol = p_protocol and v_current.issuer = p_issuer and v_current.audience = p_audience
     and v_current.status = p_status and v_current.enforce_token_binding = p_enforce_token_binding
     and v_current.idp_enforces_mfa is not distinct from p_idp_enforces_mfa
     and v_current.end_session_endpoint is not distinct from p_end_session_endpoint then
    return jsonb_build_object('changed', false, 'version', v_current.version);
  end if;

  v_version := v_current.version + 1;
  update corvis_control.tenant_identity_provider p
     set protocol = p_protocol, issuer = p_issuer, audience = p_audience, status = p_status,
         enforce_token_binding = p_enforce_token_binding, idp_enforces_mfa = p_idp_enforces_mfa,
         end_session_endpoint = p_end_session_endpoint, version = v_version,
         updated_by_subject = p_actor_subject, updated_at = now()
   where p.tenant_id = p_target_tenant_id;
  insert into corvis_control.audit_event
    (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
  values
    (p_target_tenant_id, null, p_actor_subject, 'access.identity_provider.configured', 'identity_provider',
     p_target_tenant_id::text, 'success', p_correlation_id,
     jsonb_build_object('protocol', p_protocol, 'issuer', p_issuer, 'audience', p_audience, 'status', p_status,
       'enforceTokenBinding', p_enforce_token_binding, 'idpEnforcesMfa', p_idp_enforces_mfa,
       'endSessionEndpoint', p_end_session_endpoint, 'version', v_version, 'reason', btrim(p_reason),
       'previousProtocol', v_current.protocol, 'previousIssuer', v_current.issuer, 'previousAudience', v_current.audience,
       'previousStatus', v_current.status, 'previousEnforceTokenBinding', v_current.enforce_token_binding,
       'previousIdpEnforcesMfa', v_current.idp_enforces_mfa, 'previousEndSessionEndpoint', v_current.end_session_endpoint,
       'actorTenantId', p_actor_tenant_id));
  return jsonb_build_object('changed', true, 'version', v_version);
end;
$$;

-- OIDC Back-Channel Logout 1.0 (F7c, #336) ---------------------------------------------------------------------------------

-- The single-use ledger of logout-token ids (`jti`), per issuer: a token that was applied once is refused if presented again.
-- Rows are only needed while a token could still be fresh (the application accepts an `iat` at most five and a half minutes
-- old), so they are deleted a quarter of an hour after use.
create table if not exists corvis_control.oidc_logout_token_use (
  issuer text not null check (length(issuer) between 1 and 2048),
  jti text not null check (length(jti) between 1 and 256),
  used_at timestamptz not null default now(),
  primary key (issuer, jti)
);
create index if not exists oidc_logout_token_use_used_at_idx on corvis_control.oidc_logout_token_use (used_at);
alter table corvis_control.oidc_logout_token_use enable row level security;
alter table corvis_control.oidc_logout_token_use force row level security;

-- The tenants an identity provider's logout may reach: those whose active OpenID Connect record names exactly this issuer and
-- audience, and, when the issuer and audience are the deployment's shared provider (`p_global`), every tenant that accepts
-- tokens from it (one whose record does not bind tokens to a different provider). A logout from one provider can therefore
-- never end a session that belongs to another provider's users.
create or replace function corvis_control.backchannel_logout_tenants(
  p_issuer text,
  p_audience text,
  p_global boolean
)
returns setof uuid
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select t.tenant_id
  from corvis_control.tenant t
  where exists (
      select 1 from corvis_control.tenant_identity_provider b
      where b.tenant_id = t.tenant_id and b.protocol = 'oidc' and b.status = 'active'
        and b.issuer = p_issuer and b.audience = p_audience
    )
    or (
      p_global
      and not exists (
        select 1 from corvis_control.tenant_identity_provider b
        where b.tenant_id = t.tenant_id and b.enforce_token_binding
          and not (b.issuer = p_issuer and b.audience = p_audience)
      )
    )
$$;

-- Applies one VERIFIED logout token. The application has already validated the signature, issuer, audience, `events`, the
-- absence of `nonce` and the freshness; this function adds the replay ledger, a per-issuer rate bound and the revocations.
-- With a `sid` it revokes that session (for the named `sub` where one is given, otherwise for whichever subject Corvis saw
-- using it); with only a `sub` it revokes every session Corvis has recorded for that subject. It writes
-- session_revocation (008), which every authoritative request consults, so the effect is immediate, and one audit event per
-- affected tenant (counts only: never the token, subject or session id). Returns
--   {status: 'ok', revokedSessions, tenants} | {status: 'replay'} | {status: 'rate_limited'}.
create or replace function corvis_control.apply_backchannel_logout(
  p_issuer text,
  p_audience text,
  p_jti text,
  p_subject text,
  p_session_id text,
  p_global boolean,
  p_correlation_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_inserted integer;
  v_revoked integer := 0;
  v_tenants integer := 0;
begin
  if p_issuer is null or length(p_issuer) not between 1 and 2048
     or p_audience is null or length(p_audience) not between 1 and 1024
     or p_jti is null or length(p_jti) not between 1 and 256
     or p_global is null
     or p_correlation_id is null
     or (p_subject is null and p_session_id is null)
     or (p_subject is not null and length(p_subject) not between 1 and 1024)
     or (p_session_id is not null and length(p_session_id) not between 1 and 1024) then
    raise exception 'backchannel logout request is invalid';
  end if;

  -- Housekeeping: a bounded delete of ledger rows no token could still match.
  delete from corvis_control.oidc_logout_token_use u
   where u.ctid in (select x.ctid from corvis_control.oidc_logout_token_use x where x.used_at < now() - interval '15 minutes' limit 200);

  if (select count(*) from corvis_control.oidc_logout_token_use u where u.issuer = p_issuer and u.used_at > now() - interval '1 minute') >= 600 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  insert into corvis_control.oidc_logout_token_use (issuer, jti) values (p_issuer, p_jti)
  on conflict (issuer, jti) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('status', 'replay');
  end if;

  if p_session_id is not null then
    with scope as (select s as tenant_id from corvis_control.backchannel_logout_tenants(p_issuer, p_audience, p_global) s),
    targets as (
      select i.tenant_id, i.subject
      from corvis_control.identity_subject i join scope on scope.tenant_id = i.tenant_id
      where p_subject is not null and i.auth_method = 'oidc' and i.subject = p_subject
      union
      select a.tenant_id, a.subject
      from corvis_control.tenant_session_activity a join scope on scope.tenant_id = a.tenant_id
      where p_subject is null and a.auth_method = 'oidc' and a.session_id = p_session_id
    ),
    ins as (
      insert into corvis_control.session_revocation (tenant_id, auth_method, subject, session_id, revoked_by_subject, reason)
      select t.tenant_id, 'oidc', t.subject, p_session_id, 'idp:backchannel-logout', 'Signed out by the identity provider (OIDC back-channel logout)'
      from targets t
      on conflict (tenant_id, auth_method, subject, session_id) do nothing
      returning tenant_id
    ),
    aud as (
      insert into corvis_control.audit_event (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
      select i.tenant_id, null, 'idp:backchannel-logout', 'access.session.idp_logout', 'user_sessions', null, 'success', p_correlation_id,
        jsonb_build_object('revokedSessions', count(*), 'scope', 'session', 'issuer', p_issuer)
      from ins i group by i.tenant_id
      returning 1
    )
    select (select count(*) from ins), (select count(*) from aud) into v_revoked, v_tenants;
  else
    with scope as (select s as tenant_id from corvis_control.backchannel_logout_tenants(p_issuer, p_audience, p_global) s),
    ins as (
      insert into corvis_control.session_revocation (tenant_id, auth_method, subject, session_id, revoked_by_subject, reason)
      select a.tenant_id, 'oidc', a.subject, a.session_id, 'idp:backchannel-logout', 'Signed out by the identity provider (OIDC back-channel logout)'
      from corvis_control.tenant_session_activity a join scope on scope.tenant_id = a.tenant_id
      where a.auth_method = 'oidc' and a.subject = p_subject
      on conflict (tenant_id, auth_method, subject, session_id) do nothing
      returning tenant_id
    ),
    aud as (
      insert into corvis_control.audit_event (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
      select i.tenant_id, null, 'idp:backchannel-logout', 'access.session.idp_logout', 'user_sessions', null, 'success', p_correlation_id,
        jsonb_build_object('revokedSessions', count(*), 'scope', 'subject', 'issuer', p_issuer)
      from ins i group by i.tenant_id
      returning 1
    )
    select (select count(*) from ins), (select count(*) from aud) into v_revoked, v_tenants;
  end if;
  return jsonb_build_object('status', 'ok', 'revokedSessions', v_revoked, 'tenants', v_tenants);
end;
$$;

commit;
