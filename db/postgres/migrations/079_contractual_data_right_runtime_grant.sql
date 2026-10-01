-- Explicit runtime execution for the provider-controlled contractual-right path.
-- Depends on migration 078.
--
-- 078 removes PUBLIC execution from the SECURITY DEFINER function. Supabase
-- installations may use the internal service_role as the application database
-- principal, so grant only that known internal role when it exists. The HTTP
-- route still requires tenant_admin plus the configured operationsTenantId, and
-- the function independently validates the active actor membership.

begin;

do $$
begin
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute 'grant execute on function corvis_control.apply_data_right_admin_authorized(uuid,uuid,text,uuid,text,text,text,text,boolean,boolean,boolean,boolean,boolean,timestamptz,timestamptz,text,text) to service_role';
  end if;
end;
$$;

commit;
