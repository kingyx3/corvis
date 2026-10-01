-- Invitations for the workspace-admin role could never be accepted.
-- Migration 048 renamed the membership role 'workspace_admin' to 'accountadmin'
-- and narrowed corvis_control.membership.role_name to
-- ('tenant_admin','accountadmin','reviewer','analyst','viewer'), but
-- tenant_invitation (056) still allowed 'workspace_admin' and not
-- 'accountadmin'. accept_tenant_invitation copies the invited role into
-- membership, so accepting such an invitation raised a check violation (a 500).
--
-- Re-point pending/historical invitations at the new name, then give
-- tenant_invitation the same role set as membership. The function itself is
-- unchanged: it only copies role_name through, which is now always valid.
-- Depends on migrations 001-073.

begin;

update corvis_control.tenant_invitation set role_name='accountadmin' where role_name='workspace_admin';

-- The constraint was declared inline on the column in 056, so Postgres named it
-- tenant_invitation_role_name_check.
alter table corvis_control.tenant_invitation drop constraint tenant_invitation_role_name_check;
alter table corvis_control.tenant_invitation add constraint tenant_invitation_role_name_check
  check (role_name in ('tenant_admin','accountadmin','reviewer','analyst','viewer'));

commit;
