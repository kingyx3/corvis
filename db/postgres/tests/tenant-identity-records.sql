-- Acceptance for migration 095 (F7b #335, F7e #338): verified email domains and the per-tenant identity-provider record.
--
-- Proves, against the real SQL functions on an isolated disposable database:
--   * only an active Organization Admin (an active human identity with an active tenant_admin membership in the ACTOR's
--     tenant) can add or remove a verified domain or set an identity-provider record: an analyst, a workspace admin, a
--     disabled admin, a service identity and a stranger are refused, and a stated reason is required;
--   * a domain is verified for one tenant only (a second claim is refused until the first is removed), is lower-case
--     ASCII with at least two labels (no wildcard, address, path or single label), and a tenant holds at most 20;
--   * adding a domain twice changes and audits nothing; removing a missing domain is refused;
--   * email_domain_allowed is OFF (true for everyone) with no verified domain, and with one only that exact domain
--     passes (case-insensitively, no subdomain, no look-alike), per tenant;
--   * the identity-provider record is compare-and-set on its version, an OpenID Connect issuer must be an https URL
--     without query, fragment or trailing slash, token binding defaults off and can only be on for an active OIDC
--     record, the same values change and audit nothing;
--   * every change is audited for the TARGET tenant in the same transaction, with the actor's tenant in the metadata;
--   * both tables have RLS enabled and forced with no client policy, so a role without BYPASSRLS reads nothing.
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

-- Tenant OPS is the Corvis operations tenant, A and B are customers.
insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('c0950000-0000-4000-8000-0000000000f0','identity-records-ops','Operations'),
       ('a0950000-0000-4000-8000-00000000000a','identity-records-a','Identity Records A'),
       ('b0950000-0000-4000-8000-00000000000b','identity-records-b','Identity Records B');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name)
values ('c0950000-0000-4000-8000-0000000000f1','c0950000-0000-4000-8000-0000000000f0','primary','Ops primary'),
       ('a0950000-0000-4000-8000-0000000000a1','a0950000-0000-4000-8000-00000000000a','primary','A primary'),
       ('b0950000-0000-4000-8000-0000000000b1','b0950000-0000-4000-8000-00000000000b','primary','B primary');
insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject,status)
values ('c0950000-0000-4000-8000-0000000000f0','c0950000-0000-4000-8000-0000000000e1','oidc','idp|ops-admin','active'),
       ('c0950000-0000-4000-8000-0000000000f0','c0950000-0000-4000-8000-0000000000e2','oidc','idp|ops-analyst','active'),
       ('c0950000-0000-4000-8000-0000000000f0','c0950000-0000-4000-8000-0000000000e3','oidc','idp|ops-disabled','disabled'),
       ('c0950000-0000-4000-8000-0000000000f0','c0950000-0000-4000-8000-0000000000e4','oidc','idp|ops-workspace-admin','active'),
       ('a0950000-0000-4000-8000-00000000000a','a0950000-0000-4000-8000-0000000000e5','oidc','idp|a-admin','active');
insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name)
values ('c0950000-0000-4000-8000-0000000000f0','c0950000-0000-4000-8000-0000000000f1','c0950000-0000-4000-8000-0000000000e1','tenant_admin'),
       ('c0950000-0000-4000-8000-0000000000f0','c0950000-0000-4000-8000-0000000000f1','c0950000-0000-4000-8000-0000000000e2','analyst'),
       ('c0950000-0000-4000-8000-0000000000f0','c0950000-0000-4000-8000-0000000000f1','c0950000-0000-4000-8000-0000000000e3','tenant_admin'),
       ('c0950000-0000-4000-8000-0000000000f0','c0950000-0000-4000-8000-0000000000f1','c0950000-0000-4000-8000-0000000000e4','accountadmin'),
       ('a0950000-0000-4000-8000-00000000000a','a0950000-0000-4000-8000-0000000000a1','a0950000-0000-4000-8000-0000000000e5','tenant_admin');

-- ---------------------------------------------------------------- the table refuses malformed domains directly
select pg_temp.expect_error($f$insert into corvis_control.tenant_verified_domain (tenant_id,domain,verification_method,evidence,verified_by_subject) values ('a0950000-0000-4000-8000-00000000000a','Example.com','dns_txt','ticket-1','x')$f$, 'tenant_verified_domain_domain_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_verified_domain (tenant_id,domain,verification_method,evidence,verified_by_subject) values ('a0950000-0000-4000-8000-00000000000a','localhost','dns_txt','ticket-1','x')$f$, 'tenant_verified_domain_domain_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_verified_domain (tenant_id,domain,verification_method,evidence,verified_by_subject) values ('a0950000-0000-4000-8000-00000000000a','*.example.com','dns_txt','ticket-1','x')$f$, 'tenant_verified_domain_domain_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_verified_domain (tenant_id,domain,verification_method,evidence,verified_by_subject) values ('a0950000-0000-4000-8000-00000000000a','10.0.0.1','dns_txt','ticket-1','x')$f$, 'tenant_verified_domain_domain_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_verified_domain (tenant_id,domain,verification_method,evidence,verified_by_subject) values ('a0950000-0000-4000-8000-00000000000a','example.com','whois','ticket-1','x')$f$, 'tenant_verified_domain_verification_method_check');

-- ---------------------------------------------------------------- who may change identity records
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-analyst','acme.com','dns_txt','ticket-1','Customer asked','corr')$f$, 'identity records require an active operations admin');
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-workspace-admin','acme.com','dns_txt','ticket-1','Customer asked','corr')$f$, 'identity records require an active operations admin');
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-disabled','acme.com','dns_txt','ticket-1','Customer asked','corr')$f$, 'identity records require an active operations admin');
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','service_account','idp|ops-admin','acme.com','dns_txt','ticket-1','Customer asked','corr')$f$, 'identity records require an active operations admin');
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|nobody','acme.com','dns_txt','ticket-1','Customer asked','corr')$f$, 'identity records require an active operations admin');
-- An admin of the actor tenant named for another tenant is not an admin there.
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','b0950000-0000-4000-8000-00000000000b','oidc','idp|ops-admin','acme.com','dns_txt','ticket-1','Customer asked','corr')$f$, 'identity records require an active operations admin');
select pg_temp.expect_error($f$select corvis_control.remove_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-analyst','acme.com','Customer asked','corr')$f$, 'identity records require an active operations admin');
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-analyst','oidc','https://idp.acme.com','aud','pending',false,0,'Customer asked','corr')$f$, 'identity records require an active operations admin');
do $$
begin
  if exists (select 1 from corvis_control.tenant_verified_domain) or exists (select 1 from corvis_control.tenant_identity_provider) or exists (select 1 from corvis_control.audit_event where action like 'access.verified_domain.%' or action like 'access.identity_provider.%') then
    raise exception 'a refused change must store and audit nothing';
  end if;
end $$;

-- ---------------------------------------------------------------- a stated reason, a valid domain, a real tenant
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','dns_txt','ticket-1','  ','corr')$f$, 'identity record change needs a stated reason');
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','dns_txt','ticket-1',null,'corr')$f$, 'identity record change needs a stated reason');
select pg_temp.expect_error($f$select corvis_control.remove_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','no','corr')$f$, 'identity record change needs a stated reason');
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','Acme.com','dns_txt','ticket-1','Customer asked','corr')$f$, 'verified domain is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','localhost','dns_txt','ticket-1','Customer asked','corr')$f$, 'verified domain is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','a@acme.com','dns_txt','ticket-1','Customer asked','corr')$f$, 'verified domain is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','whois','ticket-1','Customer asked','corr')$f$, 'verified domain is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','dns_txt','x','Customer asked','corr')$f$, 'verified domain is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('d0950000-0000-4000-8000-0000000000dd','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','dns_txt','ticket-1','Customer asked','corr')$f$, 'identity record tenant not found');

-- ---------------------------------------------------------------- the check is OFF until a tenant has a verified domain
do $$
begin
  if not corvis_control.email_domain_allowed('a0950000-0000-4000-8000-00000000000a','anyone@anywhere.org') then
    raise exception 'with no verified domain the domain check is off';
  end if;
end $$;

-- ---------------------------------------------------------------- adding a domain
do $$
declare
  r jsonb;
begin
  r := corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','dns_txt','  DNS TXT checked, ticket-1  ','Customer verified by DNS','corr-add');
  if (r->>'changed')::boolean is not true then raise exception 'a new domain is a change: %', r; end if;
  if not exists (select 1 from corvis_control.tenant_verified_domain where tenant_id='a0950000-0000-4000-8000-00000000000a' and domain='acme.com' and evidence='DNS TXT checked, ticket-1' and verified_by_subject='idp|ops-admin') then
    raise exception 'the domain is stored, trimmed, with the operator as verifier';
  end if;
  -- Audited for the TARGET tenant, with the operator's tenant in the metadata.
  if (select count(*) from corvis_control.audit_event where tenant_id='a0950000-0000-4000-8000-00000000000a' and action='access.verified_domain.added' and target_type='verified_domain' and target_id='acme.com'
        and actor_subject='idp|ops-admin' and correlation_id='corr-add' and metadata->>'actorTenantId'='c0950000-0000-4000-8000-0000000000f0' and metadata->>'reason'='Customer verified by DNS') <> 1 then
    raise exception 'the addition is audited once for the target tenant';
  end if;
  if exists (select 1 from corvis_control.audit_event where tenant_id='c0950000-0000-4000-8000-0000000000f0' and action like 'access.verified_domain.%') then
    raise exception 'the operator tenant must not receive the customer audit event';
  end if;
  -- Again: nothing changes and nothing is audited.
  r := corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','operator_attested','other','Customer verified by DNS','corr-add2');
  if (r->>'changed')::boolean is not false then raise exception 'adding the same domain again changes nothing: %', r; end if;
  if (select count(*) from corvis_control.audit_event where action='access.verified_domain.added') <> 1 then raise exception 'and is not audited again'; end if;
  if (select verification_method from corvis_control.tenant_verified_domain where domain='acme.com') <> 'dns_txt' then raise exception 'the first verification stands'; end if;
end $$;

-- One tenant per domain.
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('b0950000-0000-4000-8000-00000000000b','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','dns_txt','ticket-2','Customer asked','corr')$f$, 'verified domain belongs to another tenant');
select pg_temp.expect_error($f$insert into corvis_control.tenant_verified_domain (tenant_id,domain,verification_method,evidence,verified_by_subject) values ('b0950000-0000-4000-8000-00000000000b','acme.com','dns_txt','ticket-2','x')$f$, 'tenant_verified_domain_domain_key');

-- ---------------------------------------------------------------- the domain check, once a domain is verified
do $$
begin
  if not corvis_control.email_domain_allowed('a0950000-0000-4000-8000-00000000000a','Person@ACME.com') then raise exception 'the verified domain passes, whatever its case'; end if;
  if corvis_control.email_domain_allowed('a0950000-0000-4000-8000-00000000000a','person@evil.org') then raise exception 'another domain is refused'; end if;
  if corvis_control.email_domain_allowed('a0950000-0000-4000-8000-00000000000a','person@mail.acme.com') then raise exception 'a subdomain is not implied'; end if;
  if corvis_control.email_domain_allowed('a0950000-0000-4000-8000-00000000000a','person@notacme.com') then raise exception 'a look-alike is refused'; end if;
  if corvis_control.email_domain_allowed('a0950000-0000-4000-8000-00000000000a','person@acme.com.evil.org') then raise exception 'a suffix trick is refused'; end if;
  if corvis_control.email_domain_allowed('a0950000-0000-4000-8000-00000000000a','acme.com') then raise exception 'a value with no @ is refused'; end if;
  -- Per tenant: tenant B still has no rule.
  if not corvis_control.email_domain_allowed('b0950000-0000-4000-8000-00000000000b','person@evil.org') then raise exception 'the check is off for a tenant with no verified domain'; end if;
end $$;

-- ---------------------------------------------------------------- the per-tenant limit
do $$
declare
  i integer;
begin
  for i in 2..20 loop
    perform corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme'||i||'.com','operator_attested','contract-'||i,'Bulk onboarding','corr-bulk');
  end loop;
end $$;
select pg_temp.expect_error($f$select corvis_control.set_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','one-too-many.com','dns_txt','ticket-3','Bulk onboarding','corr')$f$, 'verified domain limit reached');

-- ---------------------------------------------------------------- removing a domain
select pg_temp.expect_error($f$select corvis_control.remove_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','missing.com','No longer owned','corr')$f$, 'verified domain not found');
-- Another tenant's domain cannot be removed through this tenant.
select pg_temp.expect_error($f$select corvis_control.remove_tenant_verified_domain('b0950000-0000-4000-8000-00000000000b','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','No longer owned','corr')$f$, 'verified domain not found');
select pg_temp.expect_error($f$select corvis_control.remove_tenant_verified_domain('d0950000-0000-4000-8000-0000000000dd','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','No longer owned','corr')$f$, 'identity record tenant not found');
do $$
declare
  r jsonb;
begin
  r := corvis_control.remove_tenant_verified_domain('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','Domain sold','corr-rm');
  if (r->>'changed')::boolean is not true then raise exception 'removal is a change'; end if;
  if exists (select 1 from corvis_control.tenant_verified_domain where domain='acme.com') then raise exception 'the domain is gone'; end if;
  if (select count(*) from corvis_control.audit_event where tenant_id='a0950000-0000-4000-8000-00000000000a' and action='access.verified_domain.removed' and target_id='acme.com' and metadata->>'reason'='Domain sold' and metadata->>'verificationMethod'='dns_txt') <> 1 then
    raise exception 'the removal is audited once for the target tenant';
  end if;
  -- Freed: another tenant can now verify it.
  perform corvis_control.set_tenant_verified_domain('b0950000-0000-4000-8000-00000000000b','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','acme.com','dns_txt','ticket-9','Transferred','corr-b');
  if corvis_control.email_domain_allowed('a0950000-0000-4000-8000-00000000000a','person@acme.com') then raise exception 'tenant A no longer accepts the domain it gave up'; end if;
  if not corvis_control.email_domain_allowed('b0950000-0000-4000-8000-00000000000b','person@acme.com') then raise exception 'tenant B now accepts it'; end if;
end $$;

-- ---------------------------------------------------------------- the identity-provider record: table checks
select pg_temp.expect_error($f$insert into corvis_control.tenant_identity_provider (tenant_id,protocol,issuer,audience,status,updated_by_subject) values ('a0950000-0000-4000-8000-00000000000a','oidc','http://idp.acme.com','aud','pending','x')$f$, 'tenant_identity_provider_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_identity_provider (tenant_id,protocol,issuer,audience,status,updated_by_subject) values ('a0950000-0000-4000-8000-00000000000a','oidc','https://idp.acme.com/','aud','pending','x')$f$, 'tenant_identity_provider_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_identity_provider (tenant_id,protocol,issuer,audience,status,updated_by_subject) values ('a0950000-0000-4000-8000-00000000000a','oidc','https://idp.acme.com/?x=1','aud','pending','x')$f$, 'tenant_identity_provider_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_identity_provider (tenant_id,protocol,issuer,audience,status,updated_by_subject) values ('a0950000-0000-4000-8000-00000000000a','oidc','https://idp.acme.com','aud','pending','x') , ('a0950000-0000-4000-8000-00000000000a','oidc','https://idp.acme.com','aud','pending','x')$f$, 'tenant_identity_provider_pkey');
select pg_temp.expect_error($f$insert into corvis_control.tenant_identity_provider (tenant_id,protocol,issuer,audience,status,updated_by_subject) values ('a0950000-0000-4000-8000-00000000000a','ldap','https://idp.acme.com','aud','pending','x')$f$, 'tenant_identity_provider_protocol_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_identity_provider (tenant_id,protocol,issuer,audience,status,updated_by_subject) values ('a0950000-0000-4000-8000-00000000000a','oidc','https://idp.acme.com','aud','retired','x')$f$, 'tenant_identity_provider_status_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_identity_provider (tenant_id,protocol,issuer,audience,status,updated_by_subject) values ('a0950000-0000-4000-8000-00000000000a','oidc','https://idp.acme.com','a ud','pending','x')$f$, 'tenant_identity_provider_audience_check');
-- Binding is never on for a record that is not an active OIDC one.
select pg_temp.expect_error($f$insert into corvis_control.tenant_identity_provider (tenant_id,protocol,issuer,audience,status,enforce_token_binding,updated_by_subject) values ('a0950000-0000-4000-8000-00000000000a','oidc','https://idp.acme.com','aud','pending',true,'x')$f$, 'tenant_identity_provider_check');
select pg_temp.expect_error($f$insert into corvis_control.tenant_identity_provider (tenant_id,protocol,issuer,audience,status,enforce_token_binding,updated_by_subject) values ('a0950000-0000-4000-8000-00000000000a','saml','urn:acme','aud','active',true,'x')$f$, 'tenant_identity_provider_check');

-- ---------------------------------------------------------------- the identity-provider record: function rules
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com','aud','pending',false,0,'x','corr')$f$, 'identity record change needs a stated reason');
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','http://idp.acme.com','aud','pending',false,0,'Initial setup','corr')$f$, 'identity provider record is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com/','aud','pending',false,0,'Initial setup','corr')$f$, 'identity provider record is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com','a ud','pending',false,0,'Initial setup','corr')$f$, 'identity provider record is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','ldap','https://idp.acme.com','aud','pending',false,0,'Initial setup','corr')$f$, 'identity provider record is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com','aud','retired',false,0,'Initial setup','corr')$f$, 'identity provider record is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com','aud','pending',null,0,'Initial setup','corr')$f$, 'identity provider record is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com','aud','pending',false,-1,'Initial setup','corr')$f$, 'identity provider record is invalid');
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com','aud','pending',true,0,'Initial setup','corr')$f$, 'identity provider binding requires an active oidc record');
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','saml','urn:acme','aud','active',true,0,'Initial setup','corr')$f$, 'identity provider binding requires an active oidc record');
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('d0950000-0000-4000-8000-0000000000dd','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com','aud','pending',false,0,'Initial setup','corr')$f$, 'identity record tenant not found');
-- A first record states version 0.
select pg_temp.expect_error($f$select corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com','aud','pending',false,1,'Initial setup','corr')$f$, 'identity provider version conflict');

do $$
declare
  r jsonb;
begin
  r := corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com/realms/acme','corvis-acme','pending',false,0,'Initial setup','corr-idp1');
  if (r->>'changed')::boolean is not true or (r->>'version')::integer <> 1 then raise exception 'first record is version 1: %', r; end if;
  if (select enforce_token_binding from corvis_control.tenant_identity_provider where tenant_id='a0950000-0000-4000-8000-00000000000a') then raise exception 'binding defaults off'; end if;
  -- The same values: nothing changes, version stays, nothing is audited.
  r := corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com/realms/acme','corvis-acme','pending',false,1,'Initial setup again','corr-idp2');
  if (r->>'changed')::boolean is not false or (r->>'version')::integer <> 1 then raise exception 'the same values change nothing: %', r; end if;
  if (select count(*) from corvis_control.audit_event where action='access.identity_provider.configured') <> 1 then raise exception 'and are not audited'; end if;
  -- Compare-and-set.
  begin
    perform corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com/realms/acme','corvis-acme','active',false,0,'Stale','corr');
    raise exception 'a stale version must be refused';
  exception when others then
    if position('identity provider version conflict' in sqlerrm) = 0 then raise; end if;
  end;
  -- Activate and turn binding on.
  r := corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com/realms/acme','corvis-acme','active',true,1,'Activated with binding','corr-idp3');
  if (r->>'version')::integer <> 2 then raise exception 'a change bumps the version: %', r; end if;
  if (select count(*) from corvis_control.audit_event where tenant_id='a0950000-0000-4000-8000-00000000000a' and action='access.identity_provider.configured' and target_type='identity_provider'
        and metadata->>'previousStatus'='pending' and metadata->>'status'='active' and (metadata->>'enforceTokenBinding')::boolean and metadata->>'actorTenantId'='c0950000-0000-4000-8000-0000000000f0') <> 1 then
    raise exception 'the change is audited with the previous and new values for the target tenant';
  end if;
  -- Leaving the active state must turn binding off in the same call.
  begin
    perform corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com/realms/acme','corvis-acme','disabled',true,2,'Suspend','corr');
    raise exception 'binding on a disabled record must be refused';
  exception when others then
    if position('identity provider binding requires an active oidc record' in sqlerrm) = 0 then raise; end if;
  end;
  r := corvis_control.set_tenant_identity_provider('a0950000-0000-4000-8000-00000000000a','c0950000-0000-4000-8000-0000000000f0','oidc','idp|ops-admin','oidc','https://idp.acme.com/realms/acme','corvis-acme','disabled',false,2,'Suspend','corr-idp4');
  if (r->>'version')::integer <> 3 then raise exception 'turning binding off and disabling is one change'; end if;
  -- Tenant B has no record at all.
  if exists (select 1 from corvis_control.tenant_identity_provider where tenant_id='b0950000-0000-4000-8000-00000000000b') then raise exception 'records are per tenant'; end if;
end $$;

-- ---------------------------------------------------------------- RLS: enabled, forced, no client policy
do $$
declare
  offenders text;
begin
  select string_agg(c.relname, ', ') into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'corvis_control' and c.relname in ('tenant_verified_domain','tenant_identity_provider') and not (c.relrowsecurity and c.relforcerowsecurity);
  if offenders is not null then raise exception 'RLS must be enabled and forced on %', offenders; end if;
  if exists (select 1 from pg_policies where schemaname = 'corvis_control' and tablename in ('tenant_verified_domain','tenant_identity_provider')) then
    raise exception 'identity record tables are server-managed: no client policy may exist';
  end if;
end $$;

drop role if exists corvis_identity_records_negative_role;
create role corvis_identity_records_negative_role nologin nosuperuser nobypassrls noinherit;
grant usage on schema corvis_control to corvis_identity_records_negative_role;
grant select, insert on corvis_control.tenant_verified_domain, corvis_control.tenant_identity_provider to corvis_identity_records_negative_role;
set role corvis_identity_records_negative_role;
do $$
begin
  set local request.jwt.claim.sub = 'a0950000-0000-4000-8000-0000000000e5';
  if (select count(*) from corvis_control.tenant_verified_domain) <> 0 or (select count(*) from corvis_control.tenant_identity_provider) <> 0 then
    raise exception 'a non-owner role must not read the identity records, even as an admin';
  end if;
  begin
    insert into corvis_control.tenant_verified_domain (tenant_id,domain,verification_method,evidence,verified_by_subject)
    values ('a0950000-0000-4000-8000-00000000000a','self-claimed.com','dns_txt','ticket-x','x');
    raise exception 'a non-owner role must not be able to claim a domain';
  exception when insufficient_privilege or others then
    if position('must not be able to claim' in sqlerrm) > 0 then raise; end if;
  end;
end $$;
reset role;
drop owned by corvis_identity_records_negative_role;
drop role corvis_identity_records_negative_role;

rollback;
