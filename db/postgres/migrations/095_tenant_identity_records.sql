-- F7b (#335) and F7e (#338): Corvis-assisted verified email domains and a per-tenant identity-provider record.
-- Depends on migrations 001-094 (087 for session_policy_admin_user, 001 for audit_event and tenant).
--
-- Initial identity-provider and domain setup stays Corvis-assisted (#78): an organization cannot make either claim about
-- itself. This migration adds
--   * tenant_verified_domain      the email domains Corvis operations have verified belong to a tenant. A domain can be
--                                 verified for ONE tenant at a time (unique index), so one organization can never claim
--                                 another's domain. The Organization Admin reads it; only operations change it;
--   * tenant_identity_provider    at most one record per tenant: protocol, issuer, audience, status and an explicit
--                                 `enforce_token_binding` flag. The flag defaults to false: a record is documentation of
--                                 the tenant's setup until an operator turns enforcement on, and a global-issuer
--                                 deployment is untouched while no tenant has it on;
--   * email_domain_allowed        the domain-to-tenant check used when a person is invited or provisioned by SCIM. It is
--                                 OFF (always true) for a tenant with no verified domain, so enabling nothing changes
--                                 nothing and no existing user is ever locked out: it is evaluated only when a NEW
--                                 invitation or SCIM user is created, never at sign-in or acceptance;
--   * set_tenant_verified_domain / remove_tenant_verified_domain / set_tenant_identity_provider
--                                 the operator-only changes. Each requires an active human identity holding an active
--                                 `tenant_admin` membership in the ACTOR's tenant (the route additionally requires that
--                                 tenant to be the configured Corvis operations tenant), a stated reason, and writes its
--                                 audit event for the TARGET tenant in the same transaction as the change.
--
-- Access model (mirrors 060/084/087): both tables are server-managed. There is deliberately no client-facing policy:
-- the application service role reads and writes with explicit tenant predicates after request authorization has
-- succeeded, and an Organization Admin only ever sees a read-only view assembled by the application. RLS is enabled and
-- forced so a role without BYPASSRLS sees nothing. The functions are security invoker, so such a role cannot use them
-- to write either.

begin;

create table if not exists corvis_control.tenant_verified_domain (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  -- Lower-case ASCII (internationalised names are stored as punycode), at least two labels, no wildcard, no address.
  domain text not null check (
    length(domain) between 4 and 253
    and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  verification_method text not null check (verification_method in ('dns_txt','operator_attested')),
  -- The reference an operator holds for the verification (ticket, DNS record check, contract clause); never a secret.
  evidence text not null check (length(btrim(evidence)) between 3 and 1000),
  verified_by_subject text not null check (length(verified_by_subject) between 1 and 1024),
  verified_at timestamptz not null default now(),
  primary key (tenant_id, domain)
);
-- One tenant per domain: a second claim on a verified domain is refused until the first is removed.
create unique index if not exists tenant_verified_domain_domain_key on corvis_control.tenant_verified_domain (domain);
alter table corvis_control.tenant_verified_domain enable row level security;
alter table corvis_control.tenant_verified_domain force row level security;

create table if not exists corvis_control.tenant_identity_provider (
  tenant_id uuid primary key references corvis_control.tenant(tenant_id),
  protocol text not null check (protocol in ('oidc','saml')),
  -- For OIDC the issuer URL in the form the verifier normalises to (https, no query, fragment or trailing slash); for
  -- SAML the identity provider's entity id. The audience is the value tokens are issued for.
  issuer text not null check (length(issuer) between 1 and 2048 and issuer !~ '[[:space:][:cntrl:]]'),
  audience text not null check (length(audience) between 1 and 1024 and audience !~ '[[:space:][:cntrl:]]'),
  status text not null check (status in ('pending','active','disabled')),
  -- Off unless an operator turns it on. When on, a bearer token is accepted for this tenant only if the verified
  -- token's issuer and audience equal this record (see PostgresMembershipAuthorizationRepository).
  enforce_token_binding boolean not null default false,
  version integer not null default 1 check (version >= 1),
  updated_by_subject text not null check (length(updated_by_subject) between 1 and 1024),
  updated_at timestamptz not null default now(),
  check (protocol <> 'oidc' or (issuer ~ '^https://[^/?#]+(/[^?#]*)?$' and issuer !~ '/$')),
  -- Enforcement is only defined for an active OpenID Connect record: anything else would refuse every session.
  check (not enforce_token_binding or (protocol = 'oidc' and status = 'active'))
);
alter table corvis_control.tenant_identity_provider enable row level security;
alter table corvis_control.tenant_identity_provider force row level security;

-- The operator behind an active human identity with an active Organization Admin membership in its own tenant. The
-- application route additionally requires that tenant to be the configured operations tenant; SQL proves the actor is
-- a real, active administrator regardless.
create or replace function corvis_control.identity_records_operator(
  p_actor_tenant_id uuid,
  p_actor_auth_method text,
  p_actor_subject text
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select corvis_control.session_policy_admin_user(p_actor_tenant_id, p_actor_auth_method, p_actor_subject) is not null
$$;

-- Whether an address may be invited or provisioned into the tenant. A tenant with no verified domain has no rule, so
-- the answer is true (the check is off); otherwise only the exact domain of a verified domain passes. Subdomains are
-- not implied and the comparison is case-insensitive. Applied when a NEW invitation or SCIM user is created only.
create or replace function corvis_control.email_domain_allowed(
  p_tenant_id uuid,
  p_email text
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select not exists (select 1 from corvis_control.tenant_verified_domain d where d.tenant_id = p_tenant_id)
    or (
      -- An address needs a local part and an @; anything else cannot match a verified domain.
      position('@' in coalesce(p_email, '')) > 1
      and exists (
        select 1 from corvis_control.tenant_verified_domain d
        where d.tenant_id = p_tenant_id and d.domain = lower(substring(p_email from '[^@]*$'))
      )
    )
$$;

create or replace function corvis_control.set_tenant_verified_domain(
  p_target_tenant_id uuid,
  p_actor_tenant_id uuid,
  p_actor_auth_method text,
  p_actor_subject text,
  p_domain text,
  p_verification_method text,
  p_evidence text,
  p_reason text,
  p_correlation_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_existing corvis_control.tenant_verified_domain%rowtype;
begin
  if not corvis_control.identity_records_operator(p_actor_tenant_id, p_actor_auth_method, p_actor_subject) then
    raise exception 'identity records require an active operations admin';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 1000 then
    raise exception 'identity record change needs a stated reason';
  end if;
  if p_domain is null or length(p_domain) not between 4 and 253
     or p_domain !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
     or p_verification_method is null or p_verification_method not in ('dns_txt','operator_attested')
     or p_evidence is null or length(btrim(p_evidence)) not between 3 and 1000 then
    raise exception 'verified domain is invalid';
  end if;
  -- Locks the tenant row so the per-tenant limit cannot be raced past.
  perform 1 from corvis_control.tenant t where t.tenant_id = p_target_tenant_id for update;
  if not found then
    raise exception 'identity record tenant not found';
  end if;

  select * into v_existing from corvis_control.tenant_verified_domain d where d.domain = p_domain;
  if found then
    if v_existing.tenant_id <> p_target_tenant_id then
      raise exception 'verified domain belongs to another tenant';
    end if;
    -- Already verified for this tenant: nothing changes and nothing is audited.
    return jsonb_build_object('changed', false, 'domain', p_domain);
  end if;
  if (select count(*) from corvis_control.tenant_verified_domain d where d.tenant_id = p_target_tenant_id) >= 20 then
    raise exception 'verified domain limit reached';
  end if;

  begin
    insert into corvis_control.tenant_verified_domain (tenant_id, domain, verification_method, evidence, verified_by_subject)
    values (p_target_tenant_id, p_domain, p_verification_method, btrim(p_evidence), p_actor_subject);
  exception when unique_violation then
    -- Another operator verified the same domain for another tenant between the read and the write.
    raise exception 'verified domain belongs to another tenant';
  end;

  insert into corvis_control.audit_event
    (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
  values
    (p_target_tenant_id, null, p_actor_subject, 'access.verified_domain.added', 'verified_domain', p_domain, 'success',
     p_correlation_id,
     jsonb_build_object('domain', p_domain, 'verificationMethod', p_verification_method, 'evidence', btrim(p_evidence),
       'reason', btrim(p_reason), 'actorTenantId', p_actor_tenant_id));
  return jsonb_build_object('changed', true, 'domain', p_domain);
end;
$$;

create or replace function corvis_control.remove_tenant_verified_domain(
  p_target_tenant_id uuid,
  p_actor_tenant_id uuid,
  p_actor_auth_method text,
  p_actor_subject text,
  p_domain text,
  p_reason text,
  p_correlation_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_removed corvis_control.tenant_verified_domain%rowtype;
begin
  if not corvis_control.identity_records_operator(p_actor_tenant_id, p_actor_auth_method, p_actor_subject) then
    raise exception 'identity records require an active operations admin';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 1000 then
    raise exception 'identity record change needs a stated reason';
  end if;
  perform 1 from corvis_control.tenant t where t.tenant_id = p_target_tenant_id for update;
  if not found then
    raise exception 'identity record tenant not found';
  end if;

  delete from corvis_control.tenant_verified_domain d
   where d.tenant_id = p_target_tenant_id and d.domain = p_domain
  returning * into v_removed;
  if not found then
    raise exception 'verified domain not found';
  end if;

  insert into corvis_control.audit_event
    (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
  values
    (p_target_tenant_id, null, p_actor_subject, 'access.verified_domain.removed', 'verified_domain', p_domain, 'success',
     p_correlation_id,
     jsonb_build_object('domain', p_domain, 'verificationMethod', v_removed.verification_method,
       'reason', btrim(p_reason), 'actorTenantId', p_actor_tenant_id));
  return jsonb_build_object('changed', true, 'domain', p_domain);
end;
$$;

-- Sets the tenant's identity-provider record. Compare-and-set on `version` (0 means "no record yet"); setting the values
-- the record already has changes nothing and is not audited. Turning token binding on requires an active OpenID
-- Connect record, and leaving that state requires turning binding off in the same call (the table refuses the rest).
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
  p_correlation_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_current corvis_control.tenant_identity_provider%rowtype;
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
     or (p_protocol = 'oidc' and (p_issuer !~ '^https://[^/?#]+(/[^?#]*)?$' or p_issuer ~ '/$')) then
    raise exception 'identity provider record is invalid';
  end if;
  if p_enforce_token_binding and (p_protocol <> 'oidc' or p_status <> 'active') then
    raise exception 'identity provider binding requires an active oidc record';
  end if;

  perform 1 from corvis_control.tenant t where t.tenant_id = p_target_tenant_id for update;
  if not found then
    raise exception 'identity record tenant not found';
  end if;

  select * into v_current from corvis_control.tenant_identity_provider p where p.tenant_id = p_target_tenant_id;
  if not found then
    if p_expected_version <> 0 then
      raise exception 'identity provider version conflict';
    end if;
    v_version := 1;
    insert into corvis_control.tenant_identity_provider
      (tenant_id, protocol, issuer, audience, status, enforce_token_binding, version, updated_by_subject)
    values (p_target_tenant_id, p_protocol, p_issuer, p_audience, p_status, p_enforce_token_binding, v_version, p_actor_subject);
    insert into corvis_control.audit_event
      (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
    values
      (p_target_tenant_id, null, p_actor_subject, 'access.identity_provider.configured', 'identity_provider',
       p_target_tenant_id::text, 'success', p_correlation_id,
       jsonb_build_object('protocol', p_protocol, 'issuer', p_issuer, 'audience', p_audience, 'status', p_status,
         'enforceTokenBinding', p_enforce_token_binding, 'version', v_version, 'reason', btrim(p_reason),
         'actorTenantId', p_actor_tenant_id));
    return jsonb_build_object('changed', true, 'version', v_version);
  end if;

  if v_current.version <> p_expected_version then
    raise exception 'identity provider version conflict';
  end if;
  if v_current.protocol = p_protocol and v_current.issuer = p_issuer and v_current.audience = p_audience
     and v_current.status = p_status and v_current.enforce_token_binding = p_enforce_token_binding then
    return jsonb_build_object('changed', false, 'version', v_current.version);
  end if;

  v_version := v_current.version + 1;
  update corvis_control.tenant_identity_provider p
     set protocol = p_protocol, issuer = p_issuer, audience = p_audience, status = p_status,
         enforce_token_binding = p_enforce_token_binding, version = v_version,
         updated_by_subject = p_actor_subject, updated_at = now()
   where p.tenant_id = p_target_tenant_id;
  insert into corvis_control.audit_event
    (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
  values
    (p_target_tenant_id, null, p_actor_subject, 'access.identity_provider.configured', 'identity_provider',
     p_target_tenant_id::text, 'success', p_correlation_id,
     jsonb_build_object('protocol', p_protocol, 'issuer', p_issuer, 'audience', p_audience, 'status', p_status,
       'enforceTokenBinding', p_enforce_token_binding, 'version', v_version, 'reason', btrim(p_reason),
       'previousProtocol', v_current.protocol, 'previousIssuer', v_current.issuer, 'previousAudience', v_current.audience,
       'previousStatus', v_current.status, 'previousEnforceTokenBinding', v_current.enforce_token_binding,
       'actorTenantId', p_actor_tenant_id));
  return jsonb_build_object('changed', true, 'version', v_version);
end;
$$;

commit;
