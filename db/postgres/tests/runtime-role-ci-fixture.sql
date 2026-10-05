-- CI-ONLY harness roles for run-as-runtime.sh (#227). NEVER create these in a real environment.
--
--   corvis_runtime_ci_strict         login role, member of corvis_runtime and nothing else: exactly what a deployment's
--                                    application login role gets. Suites that pass as this role are proven on the runtime
--                                    role's own privileges.
--   corvis_runtime_ci_fixture_login  login role, member of corvis_runtime AND corvis_runtime_ci_fixture. Some existing suites
--                                    seed or clean up with statements the application itself never issues (it writes those
--                                    tables only through SECURITY DEFINER functions, or never): the fixture group adds
--                                    exactly those test-only privileges, each justified below, so the suite's APPLICATION
--                                    paths still run on the runtime role's privileges.
--
-- Run as the owner role with `-v pw=<password>` after the full migration chain.

\set ON_ERROR_STOP on

select format('%s role %I login password %L nosuperuser nobypassrls nocreaterole nocreatedb noreplication',
  case when exists (select from pg_roles where rolname = r) then 'alter' else 'create' end, r, :'pw')
from (values ('corvis_runtime_ci_strict'), ('corvis_runtime_ci_fixture_login')) as t(r) \gexec

select 'create role corvis_runtime_ci_fixture nologin nosuperuser nobypassrls nocreaterole nocreatedb noreplication'
where not exists (select from pg_roles where rolname = 'corvis_runtime_ci_fixture') \gexec

grant corvis_runtime to corvis_runtime_ci_strict;
grant corvis_runtime to corvis_runtime_ci_fixture_login;
grant corvis_runtime_ci_fixture to corvis_runtime_ci_fixture_login;

-- Fixture seeding (tables the application reads, or writes only through SECURITY DEFINER functions).
grant select, insert, update, delete on corvis_control.data_rights to corvis_runtime_ci_fixture;   -- apply_data_right_admin_authorized is SECURITY DEFINER
grant select, insert, update on corvis_semantic.metric_definition to corvis_runtime_ci_fixture;   -- governed global taxonomy; read-only for the application
grant insert on corvis_facts.client_portfolio, corvis_facts.client_portfolio_fund_position to corvis_runtime_ci_fixture;  -- the application only reads portfolios
grant select on corvis_identity.tenant_entity_revision, corvis_identity.tenant_lifecycle_revision to corvis_runtime_ci_fixture;  -- write-only for the application; suites verify by reading
grant update on corvis_control.workspace to corvis_runtime_ci_fixture;                           -- a suite suspends a workspace to prove the guards
-- Fixture cleanup of scratch tenants (the application never deletes these rows).
grant delete on
  corvis_control.notification_preference, corvis_control.session_revocation, corvis_control.export_schedule_run,
  corvis_control.export_schedule, corvis_control.outbox_event, corvis_serving.export_job, corvis_control.audit_event,
  corvis_consolidated.fund_period_snapshot, corvis_control.resource_entitlement, corvis_control.membership,
  corvis_control.identity_subject, corvis_control.workspace, corvis_control.tenant,
  corvis_control.processing_stage_effect, corvis_control.processing_job
  to corvis_runtime_ci_fixture;
-- Suites clean up committed scratch data in replica mode, skipping the append-only and FK triggers for their own tenant.
grant set on parameter session_replication_role to corvis_runtime_ci_fixture;
