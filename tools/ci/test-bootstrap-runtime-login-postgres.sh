#!/usr/bin/env bash
# Disposable PostgreSQL IAM integration regression. Never use provider credentials.
set -euo pipefail
: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}"
export CORVIS_MIGRATION_DSN="postgresql://postgres:ci-disposable-only@127.0.0.1:5432/postgres"
export CORVIS_RUNTIME_DSN="postgresql://runtime_app:ci-runtime-only@127.0.0.1:5432/postgres"
psql "$CORVIS_MIGRATION_DSN" -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE corvis_runtime NOLOGIN;
CREATE ROLE runtime_app LOGIN PASSWORD 'ci-runtime-only';
CREATE ROLE unexpected_admin NOLOGIN;
CREATE SCHEMA corvis_control;
CREATE SCHEMA corvis_migration;
CREATE TABLE corvis_control.audit_event (id integer);
REVOKE ALL ON SCHEMA corvis_control, corvis_migration FROM PUBLIC;
REVOKE CREATE ON DATABASE postgres FROM PUBLIC;
SQL
# IAM-01 safe missing membership: only the intended grant is applied.
bash tools/ci/bootstrap-runtime-login.sh
psql "$CORVIS_MIGRATION_DSN" -XAt -c "SELECT pg_has_role('runtime_app','corvis_runtime','member')" | grep -qx t
# IAM-05 idempotent rerun.
bash tools/ci/bootstrap-runtime-login.sh
# IAM-02 extra membership must fail before granting runtime role.
psql "$CORVIS_MIGRATION_DSN" -X -v ON_ERROR_STOP=1 <<'SQL'
REVOKE corvis_runtime FROM runtime_app;
GRANT unexpected_admin TO runtime_app;
SQL
if bash tools/ci/bootstrap-runtime-login.sh; then echo 'Unexpected membership accepted' >&2; exit 1; fi
psql "$CORVIS_MIGRATION_DSN" -XAt -c "SELECT pg_has_role('runtime_app','corvis_runtime','member')" | grep -qx f
# IAM-03 direct forbidden privilege must fail without membership mutation.
psql "$CORVIS_MIGRATION_DSN" -X -v ON_ERROR_STOP=1 <<'SQL'
REVOKE unexpected_admin FROM runtime_app;
GRANT CREATE ON DATABASE postgres TO runtime_app;
SQL
if bash tools/ci/bootstrap-runtime-login.sh; then echo 'Forbidden CREATE accepted' >&2; exit 1; fi
psql "$CORVIS_MIGRATION_DSN" -XAt -c "SELECT pg_has_role('runtime_app','corvis_runtime','member')" | grep -qx f
echo 'Disposable PostgreSQL IAM integration checks passed'
