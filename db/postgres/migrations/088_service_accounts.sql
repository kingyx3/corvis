-- F6 (#262): customer self-service service accounts and their API credential records.
-- Depends on migrations 001-086 (007 identity_subject, 009 service_identity_grant, 001 membership,
-- 040/078 resource_entitlement, 083/084 server-managed case/function template this follows).
--
-- A service account is a non-human identity under the EXISTING authorization model, with no parallel API-scope plane
-- (#11): creating one writes the rows the authorization lookup (lib/server/authorization.ts) already resolves for a
-- `service_account` subject, in one statement -
--   identity_subject (auth_method 'service_account', subject 'service-account:<id>', a fresh user id)
--   membership       (one workspace, one role: reviewer | analyst | viewer; never an administrator role)
--   service_identity_grant (009: purpose, finite validity and review window, reviewer = the creating admin)
-- plus the two tables below, which hold what the Organization Admin manages: the account (name, purpose, creator,
-- expiry) and its credential records.
--
-- Credentials: only a SHA-256 of the secret is stored (the secret is 256 random bits, so a fast hash is appropriate,
-- as for invitation and export-link tokens); the secret itself is returned to the creating admin once and is never
-- stored or readable again. A credential is valid while status='active', before its expires_at, and before its
-- ends_at (set when it is rotated out, so a rotation can leave a short overlap, or when it is revoked, so revocation
-- takes effect immediately). At most one credential per account is "current" (ends_at is null).
--
-- Who may act is enforced here, not only in the application: every function requires an active human identity that
-- holds an active Organization Admin (`tenant_admin`) membership in the tenant.
--
-- Access model (mirrors 071/083/084): both tables are server-managed and secret-bearing, so there is deliberately no
-- client-facing policy. RLS is enabled and forced; the application service role reads and writes with explicit tenant
-- predicates after request authorization has succeeded.
--
-- This migration does NOT define how a presented credential is accepted at the API edge (see
-- docs/SERVICE_ACCOUNTS.md, "Decision needed"): it stores and lifecycles credentials and nothing here authenticates
-- a request.

begin;

create table if not exists corvis_control.service_account (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  service_account_id uuid not null,
  user_id uuid not null,
  auth_method text not null default 'service_account' check (auth_method = 'service_account'),
  subject text not null check (length(subject) between 1 and 1024),
  display_name text not null check (length(btrim(display_name)) between 3 and 120),
  purpose text not null check (length(btrim(purpose)) between 3 and 512),
  workspace_id uuid not null,
  role_name text not null check (role_name in ('reviewer','analyst','viewer')),
  status text not null default 'active' check (status in ('active','disabled')),
  created_by_subject text not null check (length(created_by_subject) between 1 and 1024),
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  disabled_at timestamptz,
  disabled_by_subject text check (disabled_by_subject is null or length(disabled_by_subject) between 1 and 1024),
  disable_reason text check (disable_reason is null or length(btrim(disable_reason)) between 3 and 1000),
  primary key (tenant_id, service_account_id),
  unique (tenant_id, user_id),
  unique (tenant_id, subject),
  foreign key (tenant_id, workspace_id) references corvis_control.workspace(tenant_id, workspace_id),
  foreign key (tenant_id, auth_method, subject)
    references corvis_control.identity_subject(tenant_id, auth_method, subject),
  check (expires_at > created_at),
  check ((status = 'active' and disabled_at is null and disabled_by_subject is null and disable_reason is null)
    or (status = 'disabled' and disabled_at is not null and disabled_by_subject is not null and disable_reason is not null))
);

alter table corvis_control.service_account enable row level security;
alter table corvis_control.service_account force row level security;

create unique index if not exists service_account_active_name_idx
  on corvis_control.service_account (tenant_id, lower(btrim(display_name)))
  where status = 'active';
create index if not exists service_account_tenant_created_idx
  on corvis_control.service_account (tenant_id, created_at desc, service_account_id desc);

create table if not exists corvis_control.service_account_credential (
  tenant_id uuid not null,
  credential_id uuid not null,
  service_account_id uuid not null,
  -- Lower-case hex SHA-256 of the secret. The secret is never stored.
  secret_sha256 text not null check (secret_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'active' check (status in ('active','revoked')),
  created_by_subject text not null check (length(created_by_subject) between 1 and 1024),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- When the credential stops being accepted before its expiry: now() + overlap when rotated out, now() when revoked.
  ends_at timestamptz,
  revoked_at timestamptz,
  revoked_by_subject text check (revoked_by_subject is null or length(revoked_by_subject) between 1 and 1024),
  last_used_at timestamptz,
  primary key (tenant_id, credential_id),
  unique (credential_id),
  unique (secret_sha256),
  foreign key (tenant_id, service_account_id) references corvis_control.service_account(tenant_id, service_account_id),
  check (expires_at > created_at),
  check ((status = 'revoked') = (revoked_at is not null)),
  check ((status = 'revoked') = (revoked_by_subject is not null)),
  check (status <> 'revoked' or ends_at is not null)
);

alter table corvis_control.service_account_credential enable row level security;
alter table corvis_control.service_account_credential force row level security;

-- One current credential per account: rotation moves the old one to ends_at before the new one is current.
create unique index if not exists service_account_credential_current_idx
  on corvis_control.service_account_credential (tenant_id, service_account_id)
  where status = 'active' and ends_at is null;
create index if not exists service_account_credential_account_idx
  on corvis_control.service_account_credential (tenant_id, service_account_id, created_at desc);

-- A service account's identity never changes after creation, and a disabled account stays disabled (a new account is
-- created instead, so the audit trail never has an identity that was revived).
create or replace function corvis_control.guard_service_account_update()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  if (new.tenant_id, new.service_account_id, new.user_id, new.auth_method, new.subject, new.display_name, new.purpose,
      new.workspace_id, new.role_name, new.created_by_subject, new.created_by_user_id, new.created_at, new.expires_at)
    is distinct from
     (old.tenant_id, old.service_account_id, old.user_id, old.auth_method, old.subject, old.display_name, old.purpose,
      old.workspace_id, old.role_name, old.created_by_subject, old.created_by_user_id, old.created_at, old.expires_at) then
    raise exception 'service account identity is immutable';
  end if;
  if old.status = 'disabled' and new.status is distinct from 'disabled' then
    raise exception 'service account is disabled';
  end if;
  return new;
end;
$$;

drop trigger if exists service_account_guard_update on corvis_control.service_account;
create trigger service_account_guard_update
  before update on corvis_control.service_account
  for each row execute function corvis_control.guard_service_account_update();

-- A credential's secret hash and lifetime never change; a revoked credential stays revoked; and an end date can only
-- be brought forward, so no later step can lengthen a rotation overlap or resurrect a credential.
create or replace function corvis_control.guard_service_account_credential_update()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  if (new.tenant_id, new.credential_id, new.service_account_id, new.secret_sha256, new.created_by_subject, new.created_at, new.expires_at)
    is distinct from
     (old.tenant_id, old.credential_id, old.service_account_id, old.secret_sha256, old.created_by_subject, old.created_at, old.expires_at) then
    raise exception 'service account credential is immutable';
  end if;
  if old.status = 'revoked' and (new.status <> 'revoked' or new.ends_at is distinct from old.ends_at
      or new.revoked_at is distinct from old.revoked_at or new.revoked_by_subject is distinct from old.revoked_by_subject) then
    raise exception 'service account credential is revoked';
  end if;
  if old.ends_at is not null and (new.ends_at is null or new.ends_at > old.ends_at) then
    raise exception 'service account credential end date cannot be extended';
  end if;
  return new;
end;
$$;

drop trigger if exists service_account_credential_guard_update on corvis_control.service_account_credential;
create trigger service_account_credential_guard_update
  before update on corvis_control.service_account_credential
  for each row execute function corvis_control.guard_service_account_credential_update();

-- The user behind an active human identity that holds an active Organization Admin (`tenant_admin`) membership in
-- the tenant, or null. Every function below requires it, so a demoted or disabled admin cannot act.
create or replace function corvis_control.service_account_admin_user(
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

-- Creates the account, its authorization rows and its first credential in one statement.
create or replace function corvis_control.create_service_account(
  p_tenant_id uuid,
  p_service_account_id uuid,
  p_credential_id uuid,
  p_actor_auth_method text,
  p_actor_subject text,
  p_display_name text,
  p_purpose text,
  p_workspace_id uuid,
  p_role_name text,
  p_expires_at timestamptz,
  p_credential_expires_at timestamptz,
  p_secret_sha256 text,
  p_max_active integer
)
returns setof corvis_control.service_account
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_admin uuid;
  v_user uuid := gen_random_uuid();
  v_subject text := 'service-account:' || p_service_account_id::text;
  v_row corvis_control.service_account%rowtype;
begin
  v_admin := corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject);
  if v_admin is null then
    raise exception 'service account requires an active organization admin';
  end if;
  if length(btrim(coalesce(p_display_name, ''))) not between 3 and 120 then
    raise exception 'service account name required';
  end if;
  if length(btrim(coalesce(p_purpose, ''))) not between 3 and 512 then
    raise exception 'service account purpose required';
  end if;
  if p_role_name is null or p_role_name not in ('reviewer','analyst','viewer') then
    raise exception 'service account role not allowed';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '366 days'
     or p_credential_expires_at is null or p_credential_expires_at <= now() then
    raise exception 'service account expiry invalid';
  end if;
  if not exists (
    select 1 from corvis_control.workspace w
    where w.tenant_id = p_tenant_id and w.workspace_id = p_workspace_id and w.status = 'active'
  ) then
    raise exception 'workspace not found';
  end if;

  -- Serialise creation within the tenant so the name and the quota checks cannot race.
  perform 1 from corvis_control.tenant t where t.tenant_id = p_tenant_id for update;
  if exists (
    select 1 from corvis_control.service_account a
    where a.tenant_id = p_tenant_id and a.status = 'active' and lower(btrim(a.display_name)) = lower(btrim(p_display_name))
  ) then
    raise exception 'service account name already in use';
  end if;
  if (select count(*) from corvis_control.service_account a where a.tenant_id = p_tenant_id and a.status = 'active') >= p_max_active then
    raise exception 'service account limit reached';
  end if;

  insert into corvis_control.identity_subject (tenant_id, user_id, auth_method, subject, status)
  values (p_tenant_id, v_user, 'service_account', v_subject, 'active');

  insert into corvis_control.membership (tenant_id, workspace_id, user_id, role_name, status, valid_from, valid_until)
  values (p_tenant_id, p_workspace_id, v_user, p_role_name, 'active', now(), p_expires_at);

  insert into corvis_control.service_identity_grant
    (tenant_id, auth_method, subject, purpose, status, valid_from, valid_until, reviewed_at, next_review_at, reviewed_by_subject)
  values
    (p_tenant_id, 'service_account', v_subject, btrim(p_purpose), 'active', now(), p_expires_at, now(), p_expires_at, p_actor_subject);

  insert into corvis_control.service_account
    (tenant_id, service_account_id, user_id, subject, display_name, purpose, workspace_id, role_name,
     created_by_subject, created_by_user_id, expires_at)
  values
    (p_tenant_id, p_service_account_id, v_user, v_subject, btrim(p_display_name), btrim(p_purpose), p_workspace_id, p_role_name,
     p_actor_subject, v_admin, p_expires_at)
  returning * into v_row;

  insert into corvis_control.service_account_credential
    (tenant_id, credential_id, service_account_id, secret_sha256, created_by_subject, expires_at)
  values
    (p_tenant_id, p_credential_id, p_service_account_id, p_secret_sha256, p_actor_subject, least(p_credential_expires_at, p_expires_at));

  return next v_row;
end;
$$;

-- Issues a credential for an account that has none in use ('issue') or replaces the current one ('rotate'). A
-- rotation leaves the old credential valid for p_overlap_minutes (0 ends it now) and ends any credential that was
-- already rotating out, so at most two credentials are ever valid together. Returns the new credential's id.
create or replace function corvis_control.issue_service_account_credential(
  p_tenant_id uuid,
  p_service_account_id uuid,
  p_credential_id uuid,
  p_mode text,
  p_actor_auth_method text,
  p_actor_subject text,
  p_secret_sha256 text,
  p_credential_expires_at timestamptz,
  p_overlap_minutes integer
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_account corvis_control.service_account%rowtype;
  v_current corvis_control.service_account_credential%rowtype;
  v_has_current boolean;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  if p_mode not in ('issue','rotate') or p_overlap_minutes is null or p_overlap_minutes < 0 or p_overlap_minutes > 1440 then
    raise exception 'service account credential request invalid';
  end if;

  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  if v_account.status <> 'active' or v_account.expires_at <= now() then
    raise exception 'service account is not active';
  end if;
  if p_credential_expires_at is null or p_credential_expires_at <= now() then
    raise exception 'service account expiry invalid';
  end if;

  -- A current credential whose own expiry has passed no longer counts and makes way for the new one.
  update corvis_control.service_account_credential c
  set ends_at = c.expires_at
  where c.tenant_id = p_tenant_id and c.service_account_id = p_service_account_id
    and c.status = 'active' and c.ends_at is null and c.expires_at <= now();

  select * into v_current from corvis_control.service_account_credential c
  where c.tenant_id = p_tenant_id and c.service_account_id = p_service_account_id
    and c.status = 'active' and c.ends_at is null
  for update;
  v_has_current := found;

  if p_mode = 'issue' and v_has_current then
    raise exception 'service account already has a credential';
  end if;
  if p_mode = 'rotate' and not v_has_current then
    raise exception 'service account has no active credential';
  end if;

  if v_has_current then
    -- Anything already rotating out is ended now, then the current credential starts its overlap.
    update corvis_control.service_account_credential c
    set ends_at = now()
    where c.tenant_id = p_tenant_id and c.service_account_id = p_service_account_id
      and c.status = 'active' and c.ends_at is not null and c.ends_at > now();
    update corvis_control.service_account_credential c
    set ends_at = least(now() + make_interval(mins => p_overlap_minutes), c.expires_at)
    where c.tenant_id = p_tenant_id and c.credential_id = v_current.credential_id;
  end if;

  insert into corvis_control.service_account_credential
    (tenant_id, credential_id, service_account_id, secret_sha256, created_by_subject, expires_at)
  values
    (p_tenant_id, p_credential_id, p_service_account_id, p_secret_sha256, p_actor_subject, least(p_credential_expires_at, v_account.expires_at));

  return p_credential_id;
end;
$$;

-- Revokes every credential of the account that is still in use, effective immediately. Returns how many.
create or replace function corvis_control.revoke_service_account_credentials(
  p_tenant_id uuid,
  p_service_account_id uuid,
  p_actor_auth_method text,
  p_actor_subject text
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_status text;
  v_count integer;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  select a.status into v_status from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  update corvis_control.service_account_credential c
  set status = 'revoked', revoked_at = now(), revoked_by_subject = p_actor_subject, ends_at = now()
  where c.tenant_id = p_tenant_id and c.service_account_id = p_service_account_id
    and c.status = 'active' and c.expires_at > now() and (c.ends_at is null or c.ends_at > now());
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'service account has no active credential';
  end if;
  return v_count;
end;
$$;

-- Deactivates the account everywhere (the service-account counterpart of the C14 member deactivation): the identity
-- and its lifecycle grant are disabled, every membership is revoked, every entitlement is ended, and every credential
-- is revoked, in one transaction. The account's own row remains as the audit record.
create or replace function corvis_control.disable_service_account(
  p_tenant_id uuid,
  p_service_account_id uuid,
  p_actor_auth_method text,
  p_actor_subject text,
  p_reason text
)
returns setof corvis_control.service_account
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_account corvis_control.service_account%rowtype;
  v_row corvis_control.service_account%rowtype;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  if length(btrim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'service account justification required';
  end if;
  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  if v_account.status = 'disabled' then
    raise exception 'service account is not active';
  end if;

  update corvis_control.service_identity_grant g
  set status = 'disabled', disabled_at = coalesce(g.disabled_at, now())
  where g.tenant_id = p_tenant_id and g.auth_method = 'service_account' and g.subject = v_account.subject and g.status = 'active';

  update corvis_control.identity_subject s
  set status = 'disabled', disabled_at = coalesce(s.disabled_at, now())
  where s.tenant_id = p_tenant_id and s.auth_method = 'service_account' and s.subject = v_account.subject and s.status = 'active';

  update corvis_control.membership m
  set status = 'revoked', valid_from = least(m.valid_from, now() - interval '1 microsecond'), valid_until = now()
  where m.tenant_id = p_tenant_id and m.user_id = v_account.user_id and m.status = 'active';

  update corvis_control.resource_entitlement e
  set valid_from = least(e.valid_from, now() - interval '1 microsecond'), valid_until = now()
  where e.tenant_id = p_tenant_id and e.subject_user_id = v_account.user_id and (e.valid_until is null or e.valid_until > now());

  update corvis_control.service_account_credential c
  set status = 'revoked', revoked_at = now(), revoked_by_subject = p_actor_subject, ends_at = least(now(), coalesce(c.ends_at, now()))
  where c.tenant_id = p_tenant_id and c.service_account_id = p_service_account_id and c.status = 'active';

  update corvis_control.service_account a
  set status = 'disabled', disabled_at = now(), disabled_by_subject = p_actor_subject, disable_reason = btrim(p_reason)
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  returning * into v_row;

  return next v_row;
end;
$$;

commit;
