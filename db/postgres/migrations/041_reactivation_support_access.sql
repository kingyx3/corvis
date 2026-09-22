-- Explicit human reactivation and time-bounded privileged/support access.
-- Ordinary identity sync continues to refuse disabled identities.

begin;

create table if not exists corvis_control.support_access_grant (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  support_grant_id uuid primary key default gen_random_uuid(),
  auth_method text not null check (auth_method in ('oidc','saml')),
  subject text not null check (length(subject) between 1 and 1024),
  user_id uuid not null,
  workspace_id uuid not null,
  role_name text not null check (role_name in ('tenant_admin','workspace_admin','reviewer','analyst','viewer')),
  purpose text not null check (length(trim(purpose)) between 1 and 1000),
  approval_reference text not null check (length(trim(approval_reference)) between 1 and 1000),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  status text not null default 'active' check (status in ('active','revoked')),
  approved_by_subject text not null check (length(approved_by_subject) between 1 and 1024),
  revoked_at timestamptz,
  revoked_by_subject text,
  revoke_reason text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id,auth_method,subject)
    references corvis_control.identity_subject(tenant_id,auth_method,subject) on delete cascade,
  foreign key (tenant_id,workspace_id)
    references corvis_control.workspace(tenant_id,workspace_id),
  check (valid_until > valid_from),
  check ((status='active' and revoked_at is null) or status='revoked')
);

create index if not exists support_access_grant_active_expiry_idx
  on corvis_control.support_access_grant (tenant_id,valid_until,workspace_id)
  where status='active';

alter table corvis_control.support_access_grant enable row level security;
alter table corvis_control.support_access_grant force row level security;
-- No client policy: grants are administered only through the privileged server path.

create or replace function corvis_control.reactivate_identity_admin(
  p_tenant_id uuid,
  p_event_key text,
  p_actor_subject text,
  p_actor_workspace_id uuid,
  p_correlation_id text,
  p_auth_method text,
  p_subject text,
  p_user_id uuid,
  p_memberships jsonb,
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = corvis_control, public
as $$
declare
  v_existing_user_id uuid;
  v_status text;
  v_result jsonb;
begin
  if exists (select 1 from corvis_control.identity_lifecycle_event where tenant_id=p_tenant_id and event_key=p_event_key) then
    return corvis_control.apply_identity_lifecycle(
      p_tenant_id,p_event_key,p_actor_subject,p_actor_workspace_id,p_correlation_id,
      'sync',p_auth_method,p_subject,p_user_id,p_memberships,p_reason
    );
  end if;

  select user_id,status into v_existing_user_id,v_status
  from corvis_control.identity_subject
  where tenant_id=p_tenant_id and auth_method=p_auth_method and subject=p_subject
  for update;

  if not found or v_existing_user_id<>p_user_id then raise exception 'identity subject does not match requested user'; end if;
  if v_status<>'disabled' then raise exception 'identity is not disabled'; end if;

  update corvis_control.identity_subject
    set status='active',disabled_at=null
    where tenant_id=p_tenant_id and auth_method=p_auth_method and subject=p_subject;

  v_result := corvis_control.apply_identity_lifecycle(
    p_tenant_id,p_event_key,p_actor_subject,p_actor_workspace_id,p_correlation_id,
    'sync',p_auth_method,p_subject,p_user_id,p_memberships,p_reason
  );

  insert into corvis_control.audit_event
    (tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values
    (p_tenant_id,p_actor_workspace_id,p_actor_subject,'identity.lifecycle.reactivate','identity_subject',p_subject,
     'success',p_correlation_id,jsonb_build_object('eventKey',p_event_key,'authMethod',p_auth_method,
       'userId',p_user_id,'reason',p_reason,'memberships',p_memberships));
  return v_result;
end;
$$;

create or replace function corvis_control.apply_support_access_admin(
  p_tenant_id uuid,
  p_actor_subject text,
  p_actor_workspace_id uuid,
  p_correlation_id text,
  p_operation text,
  p_support_grant_id uuid,
  p_auth_method text,
  p_subject text,
  p_user_id uuid,
  p_workspace_id uuid,
  p_role_name text,
  p_purpose text,
  p_approval_reference text,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = corvis_control, public
as $$
declare
  v_grant_id uuid;
  v_grant corvis_control.support_access_grant%rowtype;
begin
  if p_operation not in ('grant','revoke') then raise exception 'invalid support access operation'; end if;
  if length(trim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'reason required'; end if;

  if p_operation='grant' then
    if p_auth_method not in ('oidc','saml') then raise exception 'invalid support auth method'; end if;
    if p_role_name not in ('tenant_admin','workspace_admin','reviewer','analyst','viewer') then raise exception 'invalid support role'; end if;
    if length(trim(coalesce(p_purpose,''))) not between 1 and 1000 then raise exception 'support purpose required'; end if;
    if length(trim(coalesce(p_approval_reference,''))) not between 1 and 1000 then raise exception 'approval reference required'; end if;
    if p_valid_from is null or p_valid_until is null or p_valid_until<=p_valid_from or p_valid_until<=now() then
      raise exception 'support access requires a future expiry';
    end if;
    if not exists (
      select 1 from corvis_control.identity_subject s
      where s.tenant_id=p_tenant_id and s.auth_method=p_auth_method and s.subject=p_subject
        and s.user_id=p_user_id and s.status='active'
    ) then raise exception 'active support identity not found'; end if;
    if not exists (
      select 1 from corvis_control.workspace w
      where w.tenant_id=p_tenant_id and w.workspace_id=p_workspace_id and w.status='active'
    ) then raise exception 'active support workspace not found'; end if;
    if exists (
      select 1 from corvis_control.membership m
      where m.tenant_id=p_tenant_id and m.workspace_id=p_workspace_id and m.user_id=p_user_id and m.role_name=p_role_name
        and m.status='active' and m.valid_from<=now() and (m.valid_until is null or m.valid_until>now())
    ) then raise exception 'requested support role is already active outside this grant'; end if;

    v_grant_id := coalesce(p_support_grant_id,gen_random_uuid());
    insert into corvis_control.support_access_grant
      (tenant_id,support_grant_id,auth_method,subject,user_id,workspace_id,role_name,purpose,approval_reference,
       valid_from,valid_until,status,approved_by_subject)
    values
      (p_tenant_id,v_grant_id,p_auth_method,p_subject,p_user_id,p_workspace_id,p_role_name,p_purpose,p_approval_reference,
       p_valid_from,p_valid_until,'active',p_actor_subject);

    insert into corvis_control.membership
      (tenant_id,workspace_id,user_id,role_name,status,valid_from,valid_until,created_at)
    values
      (p_tenant_id,p_workspace_id,p_user_id,p_role_name,'active',p_valid_from,p_valid_until,now())
    on conflict (tenant_id,workspace_id,user_id,role_name) do update
      set status='active',valid_from=excluded.valid_from,valid_until=excluded.valid_until;
  else
    if p_support_grant_id is null then raise exception 'support grant id required'; end if;
    select * into v_grant from corvis_control.support_access_grant
      where tenant_id=p_tenant_id and support_grant_id=p_support_grant_id
      for update;
    if not found then raise exception 'support grant not found'; end if;
    v_grant_id := v_grant.support_grant_id;

    update corvis_control.support_access_grant
      set status='revoked',revoked_at=coalesce(revoked_at,now()),revoked_by_subject=p_actor_subject,revoke_reason=p_reason
      where tenant_id=p_tenant_id and support_grant_id=v_grant_id and status='active';

    if v_grant.valid_from>=now() then
      delete from corvis_control.membership
        where tenant_id=p_tenant_id and workspace_id=v_grant.workspace_id and user_id=v_grant.user_id
          and role_name=v_grant.role_name and valid_from=v_grant.valid_from and valid_until=v_grant.valid_until;
    else
      update corvis_control.membership
        set valid_until=now(),status='revoked'
        where tenant_id=p_tenant_id and workspace_id=v_grant.workspace_id and user_id=v_grant.user_id
          and role_name=v_grant.role_name and status='active'
          and valid_from=v_grant.valid_from and valid_until=v_grant.valid_until;
    end if;
  end if;

  insert into corvis_control.audit_event
    (tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values
    (p_tenant_id,p_actor_workspace_id,p_actor_subject,'access.support.'||p_operation,'support_access_grant',v_grant_id::text,
     'success',p_correlation_id,jsonb_build_object('supportGrantId',v_grant_id,'subject',coalesce(p_subject,v_grant.subject),
       'workspaceId',coalesce(p_workspace_id,v_grant.workspace_id),'roleName',coalesce(p_role_name,v_grant.role_name),
       'purpose',coalesce(p_purpose,v_grant.purpose),'approvalReference',coalesce(p_approval_reference,v_grant.approval_reference),
       'validFrom',coalesce(p_valid_from,v_grant.valid_from),'validUntil',coalesce(p_valid_until,v_grant.valid_until),'reason',p_reason));

  return jsonb_build_object('operation',p_operation,'supportGrantId',v_grant_id);
end;
$$;

commit;
