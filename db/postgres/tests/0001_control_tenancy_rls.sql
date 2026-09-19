begin;

-- This test is intended for a disposable migration-test database. It proves the
-- request-scoped RLS helpers fail closed and do not widen tenant visibility.

insert into control.tenants (tenant_id, name) values
  ('00000000-0000-0000-0000-000000000001', 'Tenant A'),
  ('00000000-0000-0000-0000-000000000002', 'Tenant B');

insert into control.workspaces (workspace_id, tenant_id, name) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Workspace A'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'Workspace B');

insert into control.memberships (tenant_id, workspace_id, subject_id, role) values
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'subject-a', 'viewer'),
  ('00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'subject-b', 'viewer');

-- Migration/bootstrap owners bypass RLS in many Postgres configurations, so the
-- assertions exercise the same predicates used by policies directly. UAT must
-- additionally execute these policies through the pooled application role.
select set_config('corvis.tenant_id', '00000000-0000-0000-0000-000000000001', true);
select set_config('corvis.subject_id', 'subject-a', true);

do $$
begin
  if not control.has_workspace_access(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'expected authorized workspace access';
  end if;

  if control.has_workspace_access(
    '00000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002'
  ) then
    raise exception 'cross-tenant workspace access must fail';
  end if;
end $$;

select set_config('corvis.tenant_id', '', true);
select set_config('corvis.subject_id', '', true);

do $$
begin
  if control.has_workspace_access(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'missing request context must fail closed';
  end if;
end $$;

rollback;
