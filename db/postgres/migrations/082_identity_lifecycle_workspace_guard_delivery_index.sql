-- 082: webhook delivery diagnostics index, and an unknown-workspace guard for identity lifecycle sync.
-- Depends on migrations 001-079 (081 is independent).
--
-- 1. The deliveries diagnostics endpoint now lists a subscription's deliveries newest first, ordered and
--    keyset-paged by (created_at desc, delivery_id desc) instead of by the random v4 delivery_id
--    (lib/server/webhook-subscriptions.ts). This index covers exactly that predicate and order so a page
--    request reads one page of the subscription's deliveries rather than sorting all of them.
--
-- 2. apply_identity_lifecycle (latest prior definition: 048) let a 'sync' whose memberships name a
--    well-formed workspace UUID that is not a workspace of this tenant fall through to the membership
--    foreign key, which surfaced as an unclassified 23503 and an HTTP 500. The function now checks that
--    every membership workspace exists within p_tenant_id and raises the allowlisted, already-classified
--    'workspace not found' (HTTP 404 workspace_not_found), the same contract apply_resource_entitlement_admin
--    uses (040). The check is scoped to p_tenant_id, so another tenant's workspace id is indistinguishable
--    from a nonexistent one. reactivate_identity_admin (041) delegates to this function, so reactivation gets
--    the same guard, and because it runs in one statement the identity_subject reactivation rolls back with it.
--
-- The function body below is byte-for-byte the 048 definition except for the new guard block.

begin;

create index if not exists webhook_delivery_diagnostics_idx
  on corvis_control.webhook_delivery (tenant_id, webhook_id, created_at desc, delivery_id desc);

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

  -- Every membership must name a workspace of this tenant. Without this, a well-formed UUID that is not one
  -- of the tenant's workspaces reached the membership foreign key and surfaced as an unclassified 23503 (HTTP
  -- 500). Scoped to p_tenant_id: another tenant's workspace id is indistinguishable from a nonexistent one.
  if exists (
    select 1
    from jsonb_array_elements(p_memberships) item
    where not exists (
      select 1
      from corvis_control.workspace w
      where w.tenant_id=p_tenant_id and w.workspace_id=(item->>'workspaceId')::uuid
    )
  ) then
    raise exception 'workspace not found';
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

commit;
