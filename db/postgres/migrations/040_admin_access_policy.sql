-- Audited, tenant-scoped administration for launch-required resource grants and data rights.
-- Keeps UAT operators out of direct SQL while preserving effective-date semantics.

begin;

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
set search_path = corvis_control, public
as $$
declare
  v_now timestamptz := now();
  v_changed integer := 0;
begin
  if p_operation not in ('grant','revoke') then raise exception 'invalid resource entitlement operation'; end if;
  if p_resource_type not in ('fund','document') then raise exception 'invalid resource type'; end if;
  if p_permission not in ('read','review','publish','admin') then raise exception 'invalid resource permission'; end if;
  if length(trim(coalesce(p_resource_id,''))) = 0 then raise exception 'resource id required'; end if;
  if length(trim(coalesce(p_reason,''))) = 0 then raise exception 'reason required'; end if;
  if p_valid_until is not null and p_valid_until <= p_valid_from then raise exception 'invalid entitlement effective dates'; end if;
  if not exists (select 1 from corvis_control.workspace where tenant_id=p_tenant_id and workspace_id=p_workspace_id) then
    raise exception 'workspace not found';
  end if;
  if not exists (select 1 from corvis_control.identity_subject where tenant_id=p_tenant_id and user_id=p_subject_user_id) then
    raise exception 'subject user not found';
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
    -- Future grants can be removed before they take effect. Active grants are
    -- expired at the command time so prior authorization remains reviewable.
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
set search_path = corvis_control, public
as $$
declare
  v_now timestamptz := now();
  v_rights_id uuid;
  v_changed integer := 0;
  v_updated integer := 0;
begin
  if p_operation not in ('set','revoke') then raise exception 'invalid data-right operation'; end if;
  if p_resource_type not in ('workspace','fund','document') then raise exception 'invalid resource type'; end if;
  if length(trim(coalesce(p_resource_id,''))) = 0 then raise exception 'resource id required'; end if;
  if length(trim(coalesce(p_reason,''))) = 0 then raise exception 'reason required'; end if;
  if p_effective_to is not null and p_effective_to <= p_effective_from then raise exception 'invalid data-right effective dates'; end if;

  if p_operation='set' then
    -- Replace a future record at the same effective instant, then close any
    -- earlier version that would overlap it. Authorization uses all currently
    -- effective rows, so preventing overlap keeps the effective policy singular.
    delete from corvis_control.data_rights
      where tenant_id=p_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from=p_effective_from and effective_from >= v_now;

    update corvis_control.data_rights
      set effective_to=p_effective_from
      where tenant_id=p_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from < p_effective_from
        and (effective_to is null or effective_to > p_effective_from);

    insert into corvis_control.data_rights
      (tenant_id,resource_type,resource_id,client_visible,internal_analytics_allowed,model_training_allowed,
       redistribution_allowed,source_document_access_allowed,effective_from,effective_to,contract_reference)
    values
      (p_tenant_id,p_resource_type,p_resource_id,p_client_visible,p_internal_analytics_allowed,p_model_training_allowed,
       p_redistribution_allowed,p_source_document_access_allowed,p_effective_from,p_effective_to,nullif(trim(p_contract_reference),''))
    returning rights_id into v_rights_id;
    v_changed := 1;
  else
    delete from corvis_control.data_rights
      where tenant_id=p_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from >= v_now;
    get diagnostics v_changed = row_count;

    update corvis_control.data_rights
      set effective_to=v_now
      where tenant_id=p_tenant_id and resource_type=p_resource_type and resource_id=p_resource_id
        and effective_from < v_now and (effective_to is null or effective_to > v_now);
    get diagnostics v_updated = row_count;
    v_changed := v_changed + v_updated;
  end if;

  insert into corvis_control.audit_event
    (tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id,metadata)
  values
    (p_tenant_id,p_actor_workspace_id,p_actor_subject,'access.data_right.'||p_operation,
     'data_right',p_resource_type||':'||p_resource_id,'success',p_correlation_id,
     jsonb_build_object('rightsId',v_rights_id,'resourceType',p_resource_type,'resourceId',p_resource_id,
       'clientVisible',p_client_visible,'internalAnalyticsAllowed',p_internal_analytics_allowed,
       'modelTrainingAllowed',p_model_training_allowed,'redistributionAllowed',p_redistribution_allowed,
       'sourceDocumentAccessAllowed',p_source_document_access_allowed,'effectiveFrom',p_effective_from,
       'effectiveTo',p_effective_to,'contractReference',nullif(trim(p_contract_reference),''),'reason',p_reason,'changed',v_changed));

  return jsonb_build_object('operation',p_operation,'changed',v_changed,'rightsId',v_rights_id,
    'resourceType',p_resource_type,'resourceId',p_resource_id);
end;
$$;

commit;
