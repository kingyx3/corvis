-- Renames the 'workspace_admin' membership role to 'accountadmin' and closes
-- a privilege-escalation gap: 'workspace_admin' mapped to the exact same
-- application permission tier as 'tenant_admin' (see authorization.ts
-- ROLE_MAP), so a workspace admin could grant themselves (or anyone else)
-- the tenant_admin role through identity lifecycle sync/reactivate, or
-- through a time-bounded support-access grant, with nothing to stop it.
--
-- The rename is cosmetic; the fix that actually matters is the new guard in
-- both apply_identity_lifecycle and apply_support_access_admin below:
-- granting the tenant_admin role to *anyone* now requires the acting subject
-- to already hold an active tenant_admin membership somewhere in the tenant.
-- This is checked here in SQL (the authoritative, defense-in-depth layer);
-- the identity-lifecycle and support-access routes also pre-check it so a
-- non-tenant-admin gets a clean 403 instead of a raised database exception.
--
-- Both function bodies below are otherwise byte-for-byte the latest prior
-- definition (043 for apply_identity_lifecycle, 045 for
-- apply_support_access_admin), with only the role-name string and the new
-- guard block added.

begin;

update corvis_control.membership set role_name='accountadmin' where role_name='workspace_admin';
update corvis_control.support_access_grant set role_name='accountadmin' where role_name='workspace_admin';

alter table corvis_control.membership drop constraint membership_role_name_check;
alter table corvis_control.membership add constraint membership_role_name_check
  check (role_name in ('tenant_admin','accountadmin','reviewer','analyst','viewer'));

alter table corvis_control.support_access_grant drop constraint support_access_grant_role_name_check;
alter table corvis_control.support_access_grant add constraint support_access_grant_role_name_check
  check (role_name in ('tenant_admin','accountadmin','reviewer','analyst','viewer'));

create or replace function corvis_control.apply_identity_lifecycle(
  p_tenant_id uuid,
  p_event_key text,
  p_actor_subject text,
  p_actor_workspace_id uuid,
  p_correlation_id text,
  p_operation text,
  p_auth_method text,
  p_subject text,
  p_user_id uuid,
  p_memberships jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, extensions, public
as $$
declare
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_existing_user_id uuid;
  v_existing_status text;
  v_revoked_memberships integer := 0;
  v_active_memberships integer := 0;
  v_expired_entitlements integer := 0;
  v_disabled_subjects integer := 0;
  v_disabled_service_grants integer := 0;
  v_result jsonb;
begin
  if p_operation not in ('sync','disable') then
    raise exception 'invalid identity lifecycle operation';
  end if;
  if p_auth_method not in ('oidc','saml') then
    raise exception 'human identity lifecycle only supports oidc or saml';
  end if;
  if length(trim(coalesce(p_event_key,''))) not between 1 and 256
     or length(coalesce(p_subject,'')) not between 1 and 1024
     or length(trim(coalesce(p_actor_subject,''))) not between 1 and 1024
     or length(trim(coalesce(p_reason,''))) not between 1 and 1000
     or length(trim(coalesce(p_correlation_id,''))) not between 1 and 256 then
    raise exception 'invalid identity lifecycle fields';
  end if;
  if p_memberships is null or jsonb_typeof(p_memberships) <> 'array' then
    raise exception 'memberships must be an array';
  end if;
  if p_operation='disable' and jsonb_array_length(p_memberships) <> 0 then
    raise exception 'disable must not include memberships';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_memberships) item
    where jsonb_typeof(item) <> 'object'
       or nullif(trim(item->>'workspaceId'),'') is null
       or nullif(trim(item->>'roleName'),'') is null
       or (item->>'roleName') not in ('tenant_admin','accountadmin','reviewer','analyst','viewer')
  ) then
    raise exception 'invalid membership entry';
  end if;
  if (
    select count(*)
    from jsonb_array_elements(p_memberships)
  ) <> (
    select count(distinct ((item->>'workspaceId') || ':' || (item->>'roleName')))
    from jsonb_array_elements(p_memberships) item
  ) then
    raise exception 'duplicate membership entry';
  end if;

  -- Separation of duties: granting the tenant_admin role (to the actor or to
  -- anyone else) requires the actor to already hold an active tenant_admin
  -- membership in this tenant. Without this, an accountadmin (workspace-scoped
  -- admin) could self-promote, or promote another subject, to tenant_admin.
  if exists (select 1 from jsonb_array_elements(p_memberships) item where item->>'roleName'='tenant_admin')
     and not exists (
       select 1
       from corvis_control.identity_subject a
       join corvis_control.membership m on m.tenant_id=a.tenant_id and m.user_id=a.user_id
       where a.tenant_id=p_tenant_id and a.subject=p_actor_subject and a.status='active'
         and m.role_name='tenant_admin' and m.status='active'
         and m.valid_from<=now() and (m.valid_until is null or m.valid_until>now())
     )
  then
    raise exception 'tenant_admin_role_requires_tenant_admin_actor';
  end if;

  v_request_hash := encode(digest(
    concat_ws(E'\n', p_operation, p_auth_method, p_subject, p_user_id::text, p_memberships::text, p_reason),
    'sha256'
  ), 'hex');

  select request_hash, result
    into v_existing_hash, v_existing_result
  from corvis_control.identity_lifecycle_event
  where tenant_id=p_tenant_id and event_key=p_event_key;

  if found then
    if v_existing_hash <> v_request_hash then
      raise exception 'identity lifecycle event replay conflict';
    end if;
    return v_existing_result;
  end if;

  if p_operation='sync' then
    select user_id,status into v_existing_user_id,v_existing_status
    from corvis_control.identity_subject
    where tenant_id=p_tenant_id and auth_method=p_auth_method and subject=p_subject
    for update;

    if found and v_existing_user_id <> p_user_id then
      raise exception 'identity subject is already mapped to a different user';
    end if;
    if found and v_existing_status='disabled' then
      raise exception 'disabled identity requires explicit reactivation';
    end if;

    insert into corvis_control.identity_subject
      (tenant_id,user_id,auth_method,subject,status,created_at,disabled_at)
    values (p_tenant_id,p_user_id,p_auth_method,p_subject,'active',now(),null)
    on conflict (tenant_id,auth_method,subject) do nothing;

    update corvis_control.membership m
    set status='revoked',
        valid_from=least(m.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where m.tenant_id=p_tenant_id
      and m.user_id=p_user_id
      and m.status='active'
      and not exists (
        select 1
        from jsonb_array_elements(p_memberships) item
        where (item->>'workspaceId')::uuid=m.workspace_id
          and item->>'roleName'=m.role_name
      );
    get diagnostics v_revoked_memberships = row_count;

    insert into corvis_control.membership as m
      (tenant_id,workspace_id,user_id,role_name,status,valid_from,valid_until,created_at)
    select p_tenant_id,(item->>'workspaceId')::uuid,p_user_id,item->>'roleName','active',now(),null,now()
    from jsonb_array_elements(p_memberships) item
    on conflict (tenant_id,workspace_id,user_id,role_name) do update
      set status='active',
          valid_from=case when m.status='active' and m.valid_until is null then m.valid_from else now() end,
          valid_until=null;
    get diagnostics v_active_memberships = row_count;

    update corvis_control.resource_entitlement e
    set valid_from=least(e.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where e.tenant_id=p_tenant_id
      and e.subject_user_id=p_user_id
      and (e.valid_until is null or e.valid_until > now())
      and not exists (
        select 1
        from jsonb_array_elements(p_memberships) item
        where (item->>'workspaceId')::uuid=e.workspace_id
      );
    get diagnostics v_expired_entitlements = row_count;
  else
    select user_id into v_existing_user_id
    from corvis_control.identity_subject
    where tenant_id=p_tenant_id and auth_method=p_auth_method and subject=p_subject
    for update;

    if not found or v_existing_user_id <> p_user_id then
      raise exception 'identity subject does not match the requested user';
    end if;

    update corvis_control.service_identity_grant g
    set status='disabled', disabled_at=coalesce(g.disabled_at,now())
    from corvis_control.identity_subject s
    where s.tenant_id=p_tenant_id
      and s.user_id=p_user_id
      and g.tenant_id=s.tenant_id
      and g.auth_method=s.auth_method
      and g.subject=s.subject
      and g.status='active';
    get diagnostics v_disabled_service_grants = row_count;

    update corvis_control.identity_subject s
    set status='disabled', disabled_at=coalesce(s.disabled_at,now())
    where s.tenant_id=p_tenant_id and s.user_id=p_user_id and s.status='active';
    get diagnostics v_disabled_subjects = row_count;

    update corvis_control.membership m
    set status='revoked',
        valid_from=least(m.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where m.tenant_id=p_tenant_id and m.user_id=p_user_id and m.status='active';
    get diagnostics v_revoked_memberships = row_count;

    update corvis_control.resource_entitlement e
    set valid_from=least(e.valid_from, now() - interval '1 microsecond'),
        valid_until=now()
    where e.tenant_id=p_tenant_id
      and e.subject_user_id=p_user_id
      and (e.valid_until is null or e.valid_until > now());
    get diagnostics v_expired_entitlements = row_count;
  end if;

  v_result := jsonb_build_object(
    'eventKey',p_event_key,
    'operation',p_operation,
    'subject',p_subject,
    'userId',p_user_id,
    'activeMemberships',v_active_memberships,
    'revokedMemberships',v_revoked_memberships,
    'expiredEntitlements',v_expired_entitlements,
    'disabledSubjects',v_disabled_subjects,
    'disabledServiceGrants',v_disabled_service_grants
  );

  insert into corvis_control.identity_lifecycle_event
    (tenant_id,event_key,request_hash,operation,auth_method,subject,user_id,actor_subject,actor_workspace_id,reason,desired_memberships,result)
  values
    (p_tenant_id,p_event_key,v_request_hash,p_operation,p_auth_method,p_subject,p_user_id,p_actor_subject,p_actor_workspace_id,p_reason,p_memberships,v_result);

  insert into corvis_control.audit_event
    (tenant_id,audit_event_id,occurred_at,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values (
    p_tenant_id,gen_random_uuid(),now(),p_actor_workspace_id,p_actor_subject,
    'identity.lifecycle.' || p_operation,'identity_subject',p_subject,'success',p_correlation_id,
    jsonb_build_object(
      'eventKey',p_event_key,
      'authMethod',p_auth_method,
      'userId',p_user_id,
      'reason',p_reason,
      'result',v_result
    )
  );

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
    -- Separation of duties: the approving administrator can never grant
    -- support access to their own identity or to another subject mapped to
    -- the same user, which would otherwise be a self-service elevation.
    if p_subject=p_actor_subject or exists (
      select 1 from corvis_control.identity_subject a
      where a.tenant_id=p_tenant_id and a.subject=p_actor_subject and a.user_id=p_user_id
    ) then raise exception 'support access cannot be self-approved'; end if;
    if p_role_name not in ('tenant_admin','accountadmin','reviewer','analyst','viewer') then raise exception 'invalid support role'; end if;
    -- A grant of tenant_admin-tier support access requires the actor to
    -- already hold an active tenant_admin membership: an accountadmin must
    -- not be able to hand out (time-bounded) tenant_admin access either.
    if p_role_name='tenant_admin' and not exists (
      select 1
      from corvis_control.identity_subject a
      join corvis_control.membership m on m.tenant_id=a.tenant_id and m.user_id=a.user_id
      where a.tenant_id=p_tenant_id and a.subject=p_actor_subject and a.status='active'
        and m.role_name='tenant_admin' and m.status='active'
        and m.valid_from<=now() and (m.valid_until is null or m.valid_until>now())
    ) then raise exception 'tenant_admin_role_requires_tenant_admin_actor'; end if;
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
