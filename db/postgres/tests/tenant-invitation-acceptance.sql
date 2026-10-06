-- Acceptance: a pending invitation is
-- accepted exactly once through corvis_control.accept_tenant_invitation,
-- which creates the identity subject and membership and marks the invitation
-- accepted. A replay and a mismatched verified email are refused with the
-- stable error codes the API maps to 409/403. Run after the full migration
-- chain on an isolated disposable database. Rolled back.

\set ON_ERROR_STOP on

begin;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('a0560000-0000-4000-8000-000000000001','invite-accept-ci','Invite Accept CI');
insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name)
values ('a0560000-0000-4000-8000-000000000002','a0560000-0000-4000-8000-000000000001','ws','Workspace');
insert into corvis_control.tenant_invitation
  (tenant_id,workspace_id,email,role_name,token_sha256,invited_by_subject,expires_at)
values
  ('a0560000-0000-4000-8000-000000000001','a0560000-0000-4000-8000-000000000002',
   'invitee@example.com','viewer',repeat('a',64),'admin-subject',now() + interval '1 day'),
  ('a0560000-0000-4000-8000-000000000001','a0560000-0000-4000-8000-000000000002',
   'other@example.com','viewer',repeat('b',64),'admin-subject',now() + interval '1 day');

do $$
declare
  accepted record;
  failure text;
begin
  select * into accepted from corvis_control.accept_tenant_invitation(
    repeat('a',64),'oidc','invitee-subject','invitee@example.com',true,'corr-accept');
  if accepted.role_name <> 'viewer' or accepted.user_id is null then
    raise exception 'acceptance must return the granted role and user';
  end if;
  if not exists (
    select 1 from corvis_control.membership
    where tenant_id='a0560000-0000-4000-8000-000000000001'
      and workspace_id='a0560000-0000-4000-8000-000000000002'
      and user_id=accepted.user_id and role_name='viewer' and status='active'
  ) then raise exception 'acceptance must create an active membership'; end if;
  if (select status from corvis_control.tenant_invitation where token_sha256=repeat('a',64)) <> 'accepted' then
    raise exception 'acceptance must mark the invitation accepted';
  end if;

  begin
    perform corvis_control.accept_tenant_invitation(
      repeat('a',64),'oidc','invitee-subject','invitee@example.com',true,'corr-replay');
    raise exception 'a replayed invitation must be refused';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'invitation_not_pending' then raise exception 'unexpected replay failure: %', failure; end if;
  end;

  begin
    perform corvis_control.accept_tenant_invitation(
      repeat('b',64),'oidc','someone-else','invitee@example.com',true,'corr-mismatch');
    raise exception 'a mismatched verified email must be refused';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'invitation_email_mismatch' then raise exception 'unexpected mismatch failure: %', failure; end if;
  end;
end;
$$;

rollback;
