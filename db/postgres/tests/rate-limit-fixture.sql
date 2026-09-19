-- Disposable database only. Minimal parent schema for isolated migration checks.
create schema corvis_control;
create role authenticated;
create role service_role bypassrls;
grant usage on schema corvis_control to service_role;
create table corvis_control.tenant (tenant_id uuid primary key);
insert into corvis_control.tenant values
 ('11111111-1111-1111-1111-111111111111'),
 ('22222222-2222-2222-2222-222222222222');
