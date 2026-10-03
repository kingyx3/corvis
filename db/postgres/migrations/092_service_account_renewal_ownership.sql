-- F6b (#341): service account renewal and ownership. Forward-only; builds on 088 (service accounts) and 009 (service
-- identity lifecycle grant).
--
-- Renewal. An account's expiry used to be immutable ("not renewed in place"). An Organization Admin can now extend it:
-- `extend_service_account` moves the account's expiry at least a day later (never earlier), within the documented
-- 365-day maximum from the moment of the extension (366 days of grace, as at creation), and brings the rows that enforce it along in the same
-- statement - the account's membership (`valid_until`) and its 009 lifecycle grant (`valid_until`, and `next_review_at`
-- with a fresh `reviewed_at`/`reviewed_by_subject`, because an extension is a review). A credential keeps its own
-- expiry (it was clamped to the account's at issue time): an extended account issues a new one. Only an account that is
-- not deactivated can be extended, and only while it has an owner (below), so renewal never perpetuates an account
-- nobody answers for.
--
-- Ownership. Every account has an owner: an active Organization Admin who answers for it. The creating admin is the
-- first owner (backfilled for accounts that already exist), and `transfer_service_account_owner` hands it to another
-- active Organization Admin. If the owner is later deactivated or loses the Organization Admin role the account is NOT
-- silently orphaned and NOT disabled (its credentials keep working): `service_account_owner_active` turns false, the
-- application surfaces the account as needing a new owner, and extending it is refused until an active admin takes it
-- over. Deactivating the account itself stays available.
--
-- Both writers require an active human Organization Admin, exactly like the 088 functions. The guard trigger now lets
-- the expiry move only through `extend_service_account` (a transaction-local switch it sets itself) and only forward,
-- and the owner change only through `transfer_service_account_owner`, so nothing else can renew or hand over an account.

begin;

alter table corvis_control.service_account add column if not exists owner_subject text;
alter table corvis_control.service_account add column if not exists owner_user_id uuid;
alter table corvis_control.service_account add column if not exists owner_assigned_at timestamptz;

-- Existing accounts are owned by their creator (the old guard does not look at these columns).
update corvis_control.service_account
set owner_subject = created_by_subject, owner_user_id = created_by_user_id, owner_assigned_at = created_at
where owner_subject is null;

alter table corvis_control.service_account alter column owner_subject set not null;
alter table corvis_control.service_account alter column owner_user_id set not null;
alter table corvis_control.service_account alter column owner_assigned_at set not null;
alter table corvis_control.service_account alter column owner_assigned_at set default now();
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'service_account_owner_subject_length' and conrelid = 'corvis_control.service_account'::regclass) then
    alter table corvis_control.service_account
      add constraint service_account_owner_subject_length check (length(owner_subject) between 1 and 1024);
  end if;
end $$;

-- True while the user is an active human identity holding an active Organization Admin (`tenant_admin`) membership in
-- the tenant: the same test `service_account_admin_user` applies to whoever acts, by user instead of by subject.
create or replace function corvis_control.service_account_owner_active(
  p_tenant_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select exists (
    select 1
    from corvis_control.identity_subject s
    where s.tenant_id = p_tenant_id
      and s.user_id = p_user_id
      and s.auth_method in ('oidc','saml')
      and s.status = 'active'
      and exists (
        select 1 from corvis_control.membership m
        where m.tenant_id = s.tenant_id and m.user_id = s.user_id
          and m.role_name = 'tenant_admin' and m.status = 'active'
          and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
      )
  )
$$;

-- The identity of an account never changes, a deactivated account stays deactivated, the expiry moves only forward and
-- only through extend_service_account, and the owner changes only through transfer_service_account_owner.
create or replace function corvis_control.guard_service_account_update()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  if (new.tenant_id, new.service_account_id, new.user_id, new.auth_method, new.subject, new.display_name, new.purpose,
      new.workspace_id, new.role_name, new.created_by_subject, new.created_by_user_id, new.created_at)
    is distinct from
     (old.tenant_id, old.service_account_id, old.user_id, old.auth_method, old.subject, old.display_name, old.purpose,
      old.workspace_id, old.role_name, old.created_by_subject, old.created_by_user_id, old.created_at) then
    raise exception 'service account identity is immutable';
  end if;
  if new.expires_at is distinct from old.expires_at then
    if coalesce(current_setting('corvis.service_account_renewal', true), 'off') <> 'on' then
      raise exception 'service account identity is immutable';
    end if;
    if new.expires_at < old.expires_at then
      raise exception 'service account expiry cannot be shortened';
    end if;
  end if;
  if (new.owner_subject, new.owner_user_id, new.owner_assigned_at) is distinct from (old.owner_subject, old.owner_user_id, old.owner_assigned_at)
     and coalesce(current_setting('corvis.service_account_owner_transfer', true), 'off') <> 'on' then
    raise exception 'service account owner is changed by transfer only';
  end if;
  if old.status = 'disabled' and new.status is distinct from 'disabled' then
    raise exception 'service account is disabled';
  end if;
  return new;
end;
$$;

-- Creates the account, its authorization rows and its first credential in one statement. The creating admin is the
-- first owner. (088's function with the owner columns written.)
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
     created_by_subject, created_by_user_id, expires_at, owner_subject, owner_user_id, owner_assigned_at)
  values
    (p_tenant_id, p_service_account_id, v_user, v_subject, btrim(p_display_name), btrim(p_purpose), p_workspace_id, p_role_name,
     p_actor_subject, v_admin, p_expires_at, p_actor_subject, v_admin, now())
  returning * into v_row;

  insert into corvis_control.service_account_credential
    (tenant_id, credential_id, service_account_id, secret_sha256, created_by_subject, expires_at)
  values
    (p_tenant_id, p_credential_id, p_service_account_id, p_secret_sha256, p_actor_subject, least(p_credential_expires_at, p_expires_at));

  return next v_row;
end;
$$;

-- Moves the account's expiry later and brings its membership and lifecycle grant along; returns the previous expiry (for
-- the audit event). The new expiry must be at least a day later than the current one, later than now, and at most 366 days from now.
create or replace function corvis_control.extend_service_account(
  p_tenant_id uuid,
  p_service_account_id uuid,
  p_actor_auth_method text,
  p_actor_subject text,
  p_expires_at timestamptz
)
returns timestamptz
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_account corvis_control.service_account%rowtype;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  if v_account.status <> 'active' then
    raise exception 'service account is not active';
  end if;
  if not corvis_control.service_account_owner_active(p_tenant_id, v_account.owner_user_id) then
    raise exception 'service account needs an owner';
  end if;
  if p_expires_at is null or p_expires_at < v_account.expires_at + interval '1 day' or p_expires_at <= now() or p_expires_at > now() + interval '366 days' then
    raise exception 'service account expiry invalid';
  end if;

  perform set_config('corvis.service_account_renewal', 'on', true);
  update corvis_control.service_account a
  set expires_at = p_expires_at
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id;
  perform set_config('corvis.service_account_renewal', 'off', true);

  update corvis_control.membership m
  set valid_until = p_expires_at
  where m.tenant_id = p_tenant_id and m.user_id = v_account.user_id and m.status = 'active';

  update corvis_control.service_identity_grant g
  set valid_until = p_expires_at, next_review_at = p_expires_at, reviewed_at = now(), reviewed_by_subject = p_actor_subject
  where g.tenant_id = p_tenant_id and g.auth_method = 'service_account' and g.subject = v_account.subject and g.status = 'active';

  return v_account.expires_at;
end;
$$;

-- Hands the account to another active Organization Admin; returns the previous owner's subject (for the audit event).
create or replace function corvis_control.transfer_service_account_owner(
  p_tenant_id uuid,
  p_service_account_id uuid,
  p_actor_auth_method text,
  p_actor_subject text,
  p_owner_subject text
)
returns text
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_account corvis_control.service_account%rowtype;
  v_owner_user uuid;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  if v_account.status <> 'active' then
    raise exception 'service account is not active';
  end if;

  select s.user_id into v_owner_user
  from corvis_control.identity_subject s
  where s.tenant_id = p_tenant_id and s.subject = p_owner_subject and s.auth_method in ('oidc','saml')
    and corvis_control.service_account_owner_active(p_tenant_id, s.user_id)
  limit 1;
  if v_owner_user is null then
    raise exception 'service account owner must be an active organization admin';
  end if;
  if v_owner_user = v_account.owner_user_id then
    raise exception 'service account owner unchanged';
  end if;

  perform set_config('corvis.service_account_owner_transfer', 'on', true);
  update corvis_control.service_account a
  set owner_subject = p_owner_subject, owner_user_id = v_owner_user, owner_assigned_at = now()
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id;
  perform set_config('corvis.service_account_owner_transfer', 'off', true);

  return v_account.owner_subject;
end;
$$;

commit;
