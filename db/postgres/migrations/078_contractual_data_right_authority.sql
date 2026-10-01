-- Contractual data-right authority and access-policy resource ownership guards.
-- Depends on migrations 001-077.
--
-- Customer tenant admins may continue to administer user resource entitlements,
-- but they must never manufacture access to another tenant's fund/document.
-- Contractual data rights are provider-controlled authority: the legacy
-- tenant-local mutation function is disabled and a narrowly-scoped Corvis
-- Operations path applies rights to an explicit target tenant with contract
-- provenance and target-tenant audit evidence.

begin;

create or replace function corvis_control.access_policy_resource_belongs_to_tenant(
  p_tenant_id uuid,
  p_resource_type text,
  p_resource_id text
) returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_resource_type='workspace' then
    if p_resource_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return false;
    end if;
    return exists (
      select 1
      from corvis_control.workspace w
      where w.tenant_id=p_tenant_id
        and w.workspace_id=p_resource_id::uuid
    );
  end if;

  if p_resource_type='document' then
    if p_resource_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return false;
    end if;
    return exists (
      select 1
      from corvis_source.document d
      where d.tenant_id=p_tenant_id
        and d.document_id=p_resource_id::uuid
    );
  end if;

  if p_resource_type='fund' then
    -- Fund identity is global, but customer authority is not. Accept only a
    -- fund that has tenant-private identity evidence, a portfolio position, or
    -- tenant-owned facts/snapshots. Merely existing in the global fund directory
    -- is deliberately insufficient.
    return exists (
      select 1
      from corvis_identity.tenant_entity_name n
      where n.tenant_id=p_tenant_id and n.fund_id=p_resource_id
    ) or exists (
      select 1
      from corvis_facts.client_portfolio_fund_position p
      where p.tenant_id=p_tenant_id and p.fund_id=p_resource_id
    ) or exists (
      select 1
      from corvis_facts.observation o
      where o.tenant_id=p_tenant_id and o.fund_id=p_resource_id
    ) or exists (
      select 1
      from corvis_consolidated.consolidated_fact f
      where f.tenant_id=p_tenant_id and f.fund_id=p_resource_id
    ) or exists (
      select 1
      from corvis_consolidated.fund_period_snapshot s
      where s.tenant_id=p_tenant_id and s.fund_id=p_resource_id
    );
  end if;

  return false;
end;
$$;

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
    do update set valid_from=excluded.valid_from, valid_until=excluded.valid_until;
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

-- Fail closed for the legacy tenant-local contractual-right mutation contract.
-- This is deliberately retained with its original signature so rolling deploys
-- cannot silently keep the former customer-admin behavior after the migration.
create or replace function corvis_control.apply_data_right_admin(
  p_tenant_id uuid,
  p_actor_subject text,
  p_actor_workspace_id uuid,
  p_correlation_id text,
  p_operation text,
  p_resource_type text,
  p_resource_id text,
  p_client_visible boolean,
  p_internal_analytics_allowed boolean,
  p_model_training_allowed boolean,
  p_redistribution_allowed boolean,
  p_source_document_access_allowed boolean,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_contract_reference text,
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'contractual data-right mutations require Corvis operations authority';
end;
$$;

create or replace function corvis_control.apply_data_right_admin_authorized(
  p_target_tenant_id uuid,
  p_actor_tenant_id uuid,
  p_actor_subject text,
  p_actor_workspace_id uuid,
  p_correlation_id text,
  p_operation text,
  p_resource_type text,
  p_resource_id text,
  p_client_visible boolean,
  p_internal_analytics_allowed boolean,
  p_model_training_allowed boolean,
  p_redistribution_allowed boolean,
  p_source_document_access_allowed boolean,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_contract_reference text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_rights_id uuid;
  v_changed integer := 0;
  v_updated integer := 0;
  v_existing boolean := false;
begin
  if p_operation not in ('set','revoke') then raise exception 'invalid data-right operation'; end if;
  if p_resource_type not in ('workspace','fund','document') then raise exception 'invalid resource type'; end if;
  if length(trim(coalesce(p_resource_id,''))) = 0 then raise exception 'resource id required'; end if;
  if length(trim(coalesce(p_reason,''))) = 0 then raise exception 'reason required'; end if;
  if p_operation='set' and length(trim(coalesce(p_contract_reference,''))) = 0 then
    raise exception 'contract reference required';
  end if;
  if p_effective_to is not null and p_effective_to <= p_effective_from then
    raise exception 'invalid data-right effective dates';
  end if;

  if not exists (
    select 1 from corvis_control.tenant t where t.tenant_id=p_target_tenant_id
  ) then raise exception 'target tenant not found'; end if;

  -- Defense in depth for this privileged cross-tenant procedure. The route also
  -- requires the configured operationsTenantId; SQL independently proves the
  -- supplied actor is an active tenant admin in the supplied actor workspace.
  if not exists (
    select 1
    from corvis_control.identity_subject i
    join corvis_control.membership m
      on m.tenant_id=i.tenant_id and m.user_id=i.user_id
    where i.tenant_id=p_actor_tenant_id
      and i.subject=p_actor_subject
      and i.status='active'
      and m.workspace_id=p_actor_workspace_id
      and m.role_name='tenant_admin'
      and m.status='active'
      and m.valid_from<=v_now
      and (m.valid_until is null or m.valid_until>v_now)
  ) then raise exception 'operations actor not authorized'; end if;

  select exists (
    select 1
    from corvis_control.data_rights r
    where r.tenant_id=p_target_tenant_id
      and r.resource_type=p_resource_type
      and r.resource_id=p_resource_id
  ) into v_existing;

  if not corvis_control.access_policy_resource_belongs_to_tenant(p_target_tenant_id,p_resource_type,p_resource_id)
     and not (p_operation='revoke' and v_existing) then
    raise exception 'resource not owned by target tenant';
  end if;

  if p_operation='set' then
    delete from corvis_control.data_rights
      where tenant_id=p_target_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from=p_effective_from and effective_from >= v_now;

    update corvis_control.data_rights
      set effective_to=p_effective_from
      where tenant_id=p_target_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from < p_effective_from
        and (effective_to is null or effective_to > p_effective_from);

    insert into corvis_control.data_rights
      (tenant_id,resource_type,resource_id,client_visible,internal_analytics_allowed,model_training_allowed,
       redistribution_allowed,source_document_access_allowed,effective_from,effective_to,contract_reference)
    values
      (p_target_tenant_id,p_resource_type,p_resource_id,p_client_visible,p_internal_analytics_allowed,p_model_training_allowed,
       p_redistribution_allowed,p_source_document_access_allowed,p_effective_from,p_effective_to,trim(p_contract_reference))
    returning rights_id into v_rights_id;
    v_changed := 1;
  else
    delete from corvis_control.data_rights
      where tenant_id=p_target_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from >= v_now;
    get diagnostics v_changed = row_count;

    update corvis_control.data_rights
      set effective_to=v_now
      where tenant_id=p_target_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from < v_now and (effective_to is null or effective_to > v_now);
    get diagnostics v_updated = row_count;
    v_changed := v_changed + v_updated;
  end if;

  -- The audit event belongs to the customer whose contractual authority changed.
  -- The Corvis operations workspace is carried as metadata rather than written
  -- into the customer's workspace_id column.
  insert into corvis_control.audit_event
    (tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values
    (p_target_tenant_id,null,p_actor_subject,'access.data_right.'||p_operation,
     'data_right',p_resource_type||':'||p_resource_id,'success',p_correlation_id,
     jsonb_build_object('rightsId',v_rights_id,'actorTenantId',p_actor_tenant_id,
       'actorWorkspaceId',p_actor_workspace_id,'resourceType',p_resource_type,'resourceId',p_resource_id,
       'clientVisible',p_client_visible,'internalAnalyticsAllowed',p_internal_analytics_allowed,
       'modelTrainingAllowed',p_model_training_allowed,'redistributionAllowed',p_redistribution_allowed,
       'sourceDocumentAccessAllowed',p_source_document_access_allowed,'effectiveFrom',p_effective_from,
       'effectiveTo',p_effective_to,'contractReference',nullif(trim(p_contract_reference),''),
       'reason',p_reason,'changed',v_changed));

  return jsonb_build_object('operation',p_operation,'changed',v_changed,'rightsId',v_rights_id,
    'tenantId',p_target_tenant_id,'resourceType',p_resource_type,'resourceId',p_resource_id);
end;
$$;

-- This cross-tenant function must never become a directly callable default RPC.
-- The application database principal/owner invokes it only after the route-level
-- operations-tenant check. A future least-privilege runtime role must receive an
-- explicit EXECUTE grant as part of #227 rather than inheriting PUBLIC access.
revoke all on function corvis_control.apply_data_right_admin_authorized(
  uuid,uuid,text,uuid,text,text,text,text,boolean,boolean,boolean,boolean,boolean,timestamptz,timestamptz,text,text
) from public;

commit;
