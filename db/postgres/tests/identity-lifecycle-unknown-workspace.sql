-- Acceptance: an identity lifecycle sync (or reactivation) whose memberships name a
-- well-formed workspace UUID that is not a workspace of the tenant is refused with the allowlisted
-- 'workspace not found' (HTTP 404 workspace_not_found) instead of reaching the membership foreign key
-- (SQLSTATE 23503, HTTP 500). The check is tenant-scoped, refusal applies nothing, and valid syncs, replays,
-- disables and reactivations are unchanged. Run after the full migration chain on an isolated disposable
-- database. Everything is rolled back.

\set ON_ERROR_STOP on

begin;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values
  ('a0820000-0000-4000-8000-000000000001','lifecycle-ws-a-ci','Lifecycle Workspace A CI'),
  ('a0820000-0000-4000-8000-000000000002','lifecycle-ws-b-ci','Lifecycle Workspace B CI');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name)
values
  ('a0820000-0000-4000-8000-0000000000a1','a0820000-0000-4000-8000-000000000001','ws-a','Tenant A workspace'),
  ('a0820000-0000-4000-8000-0000000000b1','a0820000-0000-4000-8000-000000000002','ws-b','Tenant B workspace');

do $$
declare
  tenant_a constant uuid := 'a0820000-0000-4000-8000-000000000001';
  ws_a constant uuid := 'a0820000-0000-4000-8000-0000000000a1';
  ws_b constant uuid := 'a0820000-0000-4000-8000-0000000000b1';
  ws_missing constant uuid := 'a0820000-0000-4000-8000-0000000000ff';
  user_1 constant uuid := 'a0820000-0000-4000-8000-0000000000c1';
  user_2 constant uuid := 'a0820000-0000-4000-8000-0000000000c2';
  failure text;
  failure_state text;
  result jsonb;
  replayed jsonb;
begin
  -- 1. A workspace that does not exist anywhere is 'workspace not found', not a foreign-key violation.
  begin
    perform corvis_control.apply_identity_lifecycle(
      tenant_a,'ws-missing-1','ci-admin',null,'corr-1','sync','oidc','subject-1',user_1,
      jsonb_build_array(jsonb_build_object('workspaceId',ws_missing,'roleName','viewer')),'unknown workspace');
    raise exception 'sync with an unknown workspace must be refused';
  exception when others then
    get stacked diagnostics failure = message_text, failure_state = returned_sqlstate;
    if failure <> 'workspace not found' then
      raise exception 'unknown workspace must raise workspace not found, got % (SQLSTATE %)', failure, failure_state;
    end if;
  end;

  -- 2. Tenant scoping: another tenant's real workspace is indistinguishable from a nonexistent one.
  begin
    perform corvis_control.apply_identity_lifecycle(
      tenant_a,'ws-cross-tenant-1','ci-admin',null,'corr-2','sync','oidc','subject-1',user_1,
      jsonb_build_array(jsonb_build_object('workspaceId',ws_b,'roleName','viewer')),'cross-tenant workspace');
    raise exception 'sync naming another tenant''s workspace must be refused';
  exception when others then
    get stacked diagnostics failure = message_text, failure_state = returned_sqlstate;
    if failure <> 'workspace not found' then
      raise exception 'cross-tenant workspace must raise workspace not found, got % (SQLSTATE %)', failure, failure_state;
    end if;
  end;

  -- 3. One valid and one unknown workspace: the whole command is refused and nothing is applied.
  begin
    perform corvis_control.apply_identity_lifecycle(
      tenant_a,'ws-mixed-1','ci-admin',null,'corr-3','sync','oidc','subject-1',user_1,
      jsonb_build_array(
        jsonb_build_object('workspaceId',ws_a,'roleName','viewer'),
        jsonb_build_object('workspaceId',ws_missing,'roleName','analyst')),'mixed workspaces');
    raise exception 'sync with one unknown workspace among valid ones must be refused';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'workspace not found' then raise exception 'mixed sync must raise workspace not found, got %', failure; end if;
  end;
  if exists (select 1 from corvis_control.identity_subject where tenant_id=tenant_a and subject='subject-1')
     or exists (select 1 from corvis_control.membership where tenant_id=tenant_a and user_id=user_1)
     or exists (select 1 from corvis_control.identity_lifecycle_event where tenant_id=tenant_a and event_key like 'ws-%')
     or exists (select 1 from corvis_control.audit_event where tenant_id=tenant_a and correlation_id in ('corr-1','corr-2','corr-3')) then
    raise exception 'a refused sync must leave no identity subject, membership, lifecycle event or audit row';
  end if;

  -- 4. A sync naming only the tenant's own workspace still succeeds and is replay-safe.
  result := corvis_control.apply_identity_lifecycle(
    tenant_a,'ws-valid-1','ci-admin',null,'corr-4','sync','oidc','subject-1',user_1,
    jsonb_build_array(jsonb_build_object('workspaceId',ws_a,'roleName','viewer')),'valid workspace');
  if (result->>'activeMemberships')::int <> 1 then raise exception 'valid sync must activate its membership, got %', result; end if;
  if not exists (
    select 1 from corvis_control.membership
    where tenant_id=tenant_a and workspace_id=ws_a and user_id=user_1 and role_name='viewer' and status='active'
  ) then raise exception 'valid sync must create the active membership'; end if;
  replayed := corvis_control.apply_identity_lifecycle(
    tenant_a,'ws-valid-1','ci-admin',null,'corr-4','sync','oidc','subject-1',user_1,
    jsonb_build_array(jsonb_build_object('workspaceId',ws_a,'roleName','viewer')),'valid workspace');
  if replayed is distinct from result then raise exception 'an identical replay must return the stored result'; end if;

  -- 5. An empty membership set (revoke everything) and disable do not depend on any workspace and still work.
  result := corvis_control.apply_identity_lifecycle(
    tenant_a,'ws-empty-1','ci-admin',null,'corr-5','sync','oidc','subject-1',user_1,'[]'::jsonb,'revoke all');
  if (result->>'revokedMemberships')::int <> 1 then raise exception 'empty sync must revoke the membership, got %', result; end if;
  result := corvis_control.apply_identity_lifecycle(
    tenant_a,'ws-disable-1','ci-admin',null,'corr-6','disable','oidc','subject-1',user_1,'[]'::jsonb,'disable');
  if (result->>'disabledSubjects')::int <> 1 then raise exception 'disable must disable the subject, got %', result; end if;

  -- 6. Reactivation delegates to the same function: an unknown workspace is refused and the identity stays disabled.
  begin
    perform corvis_control.reactivate_identity_admin(
      tenant_a,'ws-reactivate-missing-1','ci-admin',null,'corr-7','oidc','subject-1',user_1,
      jsonb_build_array(jsonb_build_object('workspaceId',ws_missing,'roleName','viewer')),'reactivate with unknown workspace');
    raise exception 'reactivation with an unknown workspace must be refused';
  exception when others then
    get stacked diagnostics failure = message_text, failure_state = returned_sqlstate;
    if failure <> 'workspace not found' then
      raise exception 'reactivation must raise workspace not found, got % (SQLSTATE %)', failure, failure_state;
    end if;
  end;
  if (select status from corvis_control.identity_subject where tenant_id=tenant_a and subject='subject-1') <> 'disabled' then
    raise exception 'a refused reactivation must leave the identity disabled';
  end if;
  result := corvis_control.reactivate_identity_admin(
    tenant_a,'ws-reactivate-1','ci-admin',null,'corr-8','oidc','subject-1',user_1,
    jsonb_build_array(jsonb_build_object('workspaceId',ws_a,'roleName','reviewer')),'reactivate');
  if (select status from corvis_control.identity_subject where tenant_id=tenant_a and subject='subject-1') <> 'active' then
    raise exception 'a valid reactivation must reactivate the identity';
  end if;

  -- 7. Tenant B can use its own workspace for the same user ids: the guard is per tenant, not global.
  result := corvis_control.apply_identity_lifecycle(
    'a0820000-0000-4000-8000-000000000002','ws-tenant-b-1','ci-admin',null,'corr-9','sync','oidc','subject-2',user_2,
    jsonb_build_array(jsonb_build_object('workspaceId',ws_b,'roleName','viewer')),'tenant b workspace');
  if (result->>'activeMemberships')::int <> 1 then raise exception 'tenant B sync of its own workspace must succeed, got %', result; end if;
end;
$$;

rollback;
