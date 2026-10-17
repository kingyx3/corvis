#!/usr/bin/env bash
# Idempotent, fail-closed role membership bootstrap. No passwords or DSNs are logged.
set -euo pipefail
: "${CORVIS_MIGRATION_DSN:?migration DSN required}"
: "${CORVIS_RUNTIME_DSN:?runtime DSN required}"
command -v psql >/dev/null
export PGCONNECT_TIMEOUT=15
# Compare database identity without printing connection strings.
migration_db="$(psql "$CORVIS_MIGRATION_DSN" -XAt -v ON_ERROR_STOP=1 -c "select current_database() || '|' || coalesce(inet_server_addr()::text, '') || '|' || coalesce(inet_server_port()::text, '')")"
runtime_db="$(psql "$CORVIS_RUNTIME_DSN" -XAt -v ON_ERROR_STOP=1 -c "select current_database() || '|' || coalesce(inet_server_addr()::text, '') || '|' || coalesce(inet_server_port()::text, '')")"
[[ -n "$migration_db" && "$migration_db" == "$runtime_db" ]] || { echo 'Database name mismatch'; exit 1; }
# Runtime login must already exist and be provisioned by the controlled secret path.
login="$(psql "$CORVIS_RUNTIME_DSN" -XAt -v ON_ERROR_STOP=1 -c 'select current_user')"
[[ "$login" =~ ^[a-zA-Z_][a-zA-Z_0-9]*$ ]] || { echo 'Invalid login identifier'; exit 1; }
# Verify the existing login is safe before granting anything. Membership is the only
# privilege this bootstrap is authorized to add.
if psql "$CORVIS_RUNTIME_DSN" -X -v ON_ERROR_STOP=1 -f db/postgres/tests/live-runtime-login-attestation.sql >/dev/null 2>&1; then
  echo 'Runtime login already attested; no changes needed'
  exit 0
fi
# One transaction serializes repeated and concurrent runs. Existing unexpected grants fail closed.
psql "$CORVIS_MIGRATION_DSN" -X -v ON_ERROR_STOP=1 -v runtime_login="$login" <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('corvis_runtime_bootstrap_v1'));
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'corvis_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'corvis_runtime group missing or unsafe; apply migration 002 first';
  END IF;
END
$check$;
SELECT set_config('corvis.bootstrap_login', :'runtime_login', true);
DO $validate$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_setting('corvis.bootstrap_login') AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication) THEN
    RAISE EXCEPTION 'missing login or unsafe login attributes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles parent ON parent.oid = m.roleid
    JOIN pg_roles child ON child.oid = m.member
    WHERE child.rolname = current_setting('corvis.bootstrap_login')
      AND parent.rolname <> 'corvis_runtime'
  ) THEN
    RAISE EXCEPTION 'runtime login has unexpected role memberships';
  END IF;
  IF has_database_privilege(current_setting('corvis.bootstrap_login'), current_database(), 'CREATE')
     OR has_schema_privilege(current_setting('corvis.bootstrap_login'), 'corvis_control', 'CREATE')
     OR has_schema_privilege(current_setting('corvis.bootstrap_login'), 'corvis_migration', 'USAGE')
     OR has_table_privilege(current_setting('corvis.bootstrap_login'), 'corvis_control.audit_event', 'TRUNCATE') THEN
    RAISE EXCEPTION 'runtime login has forbidden privileges';
  END IF;
END
$validate$;
SELECT format('GRANT corvis_runtime TO %I', :'runtime_login')
WHERE NOT pg_has_role(:'runtime_login', 'corvis_runtime', 'member') \gexec
COMMIT;
SQL
psql "$CORVIS_RUNTIME_DSN" -X -v ON_ERROR_STOP=1 -f db/postgres/tests/live-runtime-login-attestation.sql
echo 'Runtime membership bootstrap and attestation passed'
