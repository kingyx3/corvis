-- Single-use, expiring invitations for first-tenant-admin and tenant-member onboarding.
begin;

create table if not exists corvis_control.tenant_invitation (
  invitation_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  workspace_id uuid not null,
  email text not null check (email = lower(btrim(email)) and length(email) between 3 and 320),
  role_name text not null check (role_name in ('tenant_admin','workspace_admin','reviewer','analyst','viewer')),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  invited_by_subject text not null,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_user_id uuid,
  revoked_at timestamptz,
  foreign key (tenant_id, workspace_id) references corvis_control.workspace(tenant_id, workspace_id),
  check (expires_at > created_at),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'accepted') = (accepted_user_id is not null)),
  check ((status = 'revoked') = (revoked_at is not null))
);

create unique index if not exists tenant_invitation_pending_email_uq
  on corvis_control.tenant_invitation (tenant_id, workspace_id, email)
  where status = 'pending';
create index if not exists tenant_invitation_tenant_created_idx
  on corvis_control.tenant_invitation (tenant_id, created_at desc);
create index if not exists tenant_invitation_pending_expiry_idx
  on corvis_control.tenant_invitation (expires_at)
  where status = 'pending';

alter table corvis_control.tenant_invitation enable row level security;
alter table corvis_control.tenant_invitation force row level security;
-- Invitation tokens and email addresses are server-managed. There are deliberately
-- no client policies; customer APIs use explicit tenant predicates and the
-- production database service identity.

create or replace function corvis_control.accept_tenant_invitation(
  p_token_sha256 text,
  p_auth_method text,
  p_subject text,
  p_email text,
  p_email_verified boolean,
  p_correlation_id text
) returns table(invitation_id uuid, tenant_id uuid, workspace_id uuid, user_id uuid, role_name text)
language plpgsql
security definer
set search_path = corvis_control, public
as $$
declare
  v_invitation corvis_control.tenant_invitation%rowtype;
  v_user_id uuid;
begin
  if p_auth_method is null or p_auth_method not in ('oidc','saml') or p_subject is null or length(p_subject) not between 1 and 1024
    or p_email_verified is distinct from true or p_email is null or length(btrim(p_email)) = 0 then
    raise exception using errcode = '22023', message = 'invalid_invitation_identity';
  end if;
  select * into v_invitation
    from corvis_control.tenant_invitation
    where token_sha256 = p_token_sha256
    for update;
  if not found then raise exception using errcode = 'P0002', message = 'invitation_not_found'; end if;
  if v_invitation.status <> 'pending' then raise exception using errcode = 'P0001', message = 'invitation_not_pending'; end if;
  if lower(btrim(p_email)) <> v_invitation.email then
    raise exception using errcode = '42501', message = 'invitation_email_mismatch';
  end if;
  if v_invitation.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'invitation_expired';
  end if;

  select s.user_id into v_user_id
    from corvis_control.identity_subject s
    where s.tenant_id=v_invitation.tenant_id and s.auth_method=p_auth_method and s.subject=p_subject
    for update;
  if found then
    if exists (
      select 1 from corvis_control.identity_subject s
      where s.tenant_id=v_invitation.tenant_id and s.auth_method=p_auth_method and s.subject=p_subject and s.status <> 'active'
    ) then raise exception using errcode = 'P0001', message = 'invitation_identity_disabled'; end if;
  else
    v_user_id := gen_random_uuid();
    insert into corvis_control.identity_subject(tenant_id,user_id,auth_method,subject)
      values(v_invitation.tenant_id,v_user_id,p_auth_method,p_subject);
  end if;

  if exists (
    select 1 from corvis_control.membership m
    where m.tenant_id=v_invitation.tenant_id and m.workspace_id=v_invitation.workspace_id
      and m.user_id=v_user_id and m.role_name=v_invitation.role_name
      and m.status='active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
  ) then raise exception using errcode = 'P0001', message = 'invitation_membership_exists'; end if;

  insert into corvis_control.membership(tenant_id,workspace_id,user_id,role_name)
    values(v_invitation.tenant_id,v_invitation.workspace_id,v_user_id,v_invitation.role_name)
    on conflict (tenant_id,workspace_id,user_id,role_name) do update
      set status='active', valid_from=now(), valid_until=null;

  update corvis_control.tenant_invitation
    set status='accepted', accepted_at=now(), accepted_user_id=v_user_id
    where invitation_id=v_invitation.invitation_id;

  insert into corvis_control.audit_event(
    tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata
  ) values (
    v_invitation.tenant_id,v_invitation.workspace_id,p_subject,'tenant_invitation.accepted',
    'tenant_invitation',v_invitation.invitation_id::text,'success',p_correlation_id,
    jsonb_build_object('roleName',v_invitation.role_name,'invitedEmail',v_invitation.email,'userId',v_user_id)
  );

  return query select v_invitation.invitation_id,v_invitation.tenant_id,v_invitation.workspace_id,v_user_id,v_invitation.role_name;
end;
$$;

revoke all on function corvis_control.accept_tenant_invitation(text,text,text,text,boolean,text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute 'grant execute on function corvis_control.accept_tenant_invitation(text,text,text,text,boolean,text) to service_role';
  end if;
end;
$$;

commit;
