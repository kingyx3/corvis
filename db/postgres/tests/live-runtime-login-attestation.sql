-- Live rollout gate for #358. Run with the application runtime DSN, never the migration DSN.
-- Intentionally emits no role name, credential, or connection string.
DO $attest$
DECLARE
  login_name name := current_user;
  attributes record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
    INTO attributes FROM pg_roles WHERE rolname = login_name;
  IF NOT FOUND OR NOT attributes.rolcanlogin THEN
    RAISE EXCEPTION 'runtime login attestation failed: connection is not a login role';
  END IF;
  IF login_name = 'corvis_runtime' OR attributes.rolsuper OR attributes.rolbypassrls
     OR attributes.rolcreaterole OR attributes.rolcreatedb OR attributes.rolreplication THEN
    RAISE EXCEPTION 'runtime login attestation failed: unsafe login privileges';
  END IF;
  IF NOT pg_has_role(login_name, 'corvis_runtime', 'member') THEN
    RAISE EXCEPTION 'runtime login attestation failed: missing corvis_runtime membership';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles parent ON parent.oid = m.roleid
    JOIN pg_roles child ON child.oid = m.member
    WHERE child.rolname = login_name AND parent.rolname <> 'corvis_runtime'
  ) THEN
    RAISE EXCEPTION 'runtime login attestation failed: unexpected additional role membership';
  END IF;
  IF has_database_privilege(login_name, current_database(), 'CREATE')
     OR has_schema_privilege(login_name, 'corvis_control', 'CREATE')
     OR has_schema_privilege(login_name, 'corvis_migration', 'USAGE')
     OR has_table_privilege(login_name, 'corvis_control.audit_event', 'TRUNCATE') THEN
    RAISE EXCEPTION 'runtime login attestation failed: forbidden privileges';
  END IF;
  RAISE NOTICE 'runtime login attestation passed';
END
$attest$;
