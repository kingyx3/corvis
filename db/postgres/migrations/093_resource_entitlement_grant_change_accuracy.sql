-- Fixes a precision bug in corvis_control.apply_resource_entitlement_admin (078): the grant branch's
-- `insert ... on conflict (...) do update set valid_from=excluded.valid_from, valid_until=excluded.valid_until`
-- always reports `get diagnostics v_changed = row_count` as 1, even when the upsert re-wrote a row with
-- identical valid_from/valid_until (a repeat grant that changed nothing). That inflated `changed` value is
-- written straight into the audit_event.metadata the admin UI and compliance exports read, so a no-op repeat
-- grant could misleadingly read as a fresh change in the audit trail.
--
-- Adding a WHERE clause to the DO UPDATE makes Postgres skip (and not count) a conflicting row whose values
-- are already identical, so row_count — and the audited `changed` flag — now reflects whether the grant
-- actually changed anything.
create or replace function corvis_control.apply_resource_entitlement_admin(
  p_tenant_id uuid,
  p_actor_subject text,
  p_actor_workspace_id uuid,
  p_correlation_id text,
  p_operation text,
  p_subject_user_id uuid,
  p_workspace_id uuid,
  p_resource_type text,
  p_resource_id text,
  p_permission text,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_changed integer := 0;
  v_existing boolean := false;
begin
  if p_operation not in ('grant','revoke') then raise exception 'invalid resource entitlement operation'; end if;
  if p_resource_type not in ('fund','document') then raise exception 'invalid resource type'; end if;
  if p_permission not in ('read','review','publish','admin') then raise exception 'invalid resource permission'; end if;
  if length(trim(coalesce(p_resource_id,''))) = 0 then raise exception 'resource id required'; end if;
  if length(trim(coalesce(p_reason,''))) = 0 then raise exception 'reason required'; end if;
  if p_valid_until is not null and p_valid_until <= p_valid_from then raise exception 'invalid entitlement effective dates'; end if;
  if not exists (
    select 1 from corvis_control.workspace w
    where w.tenant_id=p_tenant_id and w.workspace_id=p_workspace_id
  ) then raise exception 'workspace not found'; end if;
  if not exists (
    select 1 from corvis_control.identity_subject i
    where i.tenant_id=p_tenant_id and i.user_id=p_subject_user_id
  ) then raise exception 'subject user not found'; end if;

  select exists (
    select 1
    from corvis_control.resource_entitlement e
    where e.tenant_id=p_tenant_id
      and e.workspace_id=p_workspace_id
      and e.subject_user_id=p_subject_user_id
      and e.resource_type=p_resource_type
      and e.resource_id=p_resource_id
      and e.permission=p_permission
  ) into v_existing;

  -- A grant must always point at a resource that is provably owned by the
  -- tenant. Revocation also permits a matching historical grant so access can
  -- still be removed after the underlying resource has been deleted/retired.
  if not corvis_control.access_policy_resource_belongs_to_tenant(p_tenant_id,p_resource_type,p_resource_id)
     and not (p_operation='revoke' and v_existing) then
    raise exception 'resource not owned by tenant';
  end if;

  if p_operation='grant' then
    insert into corvis_control.resource_entitlement
      (tenant_id,workspace_id,subject_user_id,resource_type,resource_id,permission,valid_from,valid_until)
    values
      (p_tenant_id,p_workspace_id,p_subject_user_id,p_resource_type,p_resource_id,p_permission,p_valid_from,p_valid_until)
    on conflict (tenant_id,workspace_id,subject_user_id,resource_type,resource_id,permission)
    do update set valid_from=excluded.valid_from, valid_until=excluded.valid_until
    where corvis_control.resource_entitlement.valid_from is distinct from excluded.valid_from
       or corvis_control.resource_entitlement.valid_until is distinct from excluded.valid_until;
    get diagnostics v_changed = row_count;
  else
    delete from corvis_control.resource_entitlement
      where tenant_id=p_tenant_id and workspace_id=p_workspace_id and subject_user_id=p_subject_user_id
        and resource_type=p_resource_type and resource_id=p_resource_id and permission=p_permission
        and valid_from >= v_now;
    get diagnostics v_changed = row_count;
    if v_changed = 0 then
      update corvis_control.resource_entitlement
        set valid_until = case
          when valid_until is null or valid_until > v_now then v_now
          else valid_until end
        where tenant_id=p_tenant_id and workspace_id=p_workspace_id and subject_user_id=p_subject_user_id
          and resource_type=p_resource_type and resource_id=p_resource_id and permission=p_permission
          and valid_from < v_now and (valid_until is null or valid_until > v_now);
      get diagnostics v_changed = row_count;
    end if;
  end if;

  insert into corvis_control.audit_event
    (tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values
    (p_tenant_id,p_actor_workspace_id,p_actor_subject,'access.resource_entitlement.'||p_operation,
     'resource_entitlement',p_subject_user_id::text,'success',p_correlation_id,
     jsonb_build_object('workspaceId',p_workspace_id,'resourceType',p_resource_type,'resourceId',p_resource_id,
       'permission',p_permission,'validFrom',p_valid_from,'validUntil',p_valid_until,'reason',p_reason,'changed',v_changed));

  return jsonb_build_object('operation',p_operation,'changed',v_changed,'subjectUserId',p_subject_user_id,
    'workspaceId',p_workspace_id,'resourceType',p_resource_type,'resourceId',p_resource_id,'permission',p_permission);
end;
$$;
