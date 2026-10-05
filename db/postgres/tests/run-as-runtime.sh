#!/usr/bin/env bash
# Runs the Postgres acceptance suites AS the least-privilege runtime role `corvis_runtime` (#227, migration 100) instead
# of the owner, so row level security and the role's real grants apply (the role owns nothing and has no BYPASSRLS).
#
#   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE  the OWNER role and a clean disposable database that already has the
#                                               supabase auth fixture and the full migration chain applied
#   CORVIS_RUNTIME_CI_PASSWORD                  password of the two CI-only login roles (default: ci-disposable-only)
#
# Layers, each failing the run on the first error:
#   1. owner      runtime-role-privileges.sql   the grant manifest (no PUBLIC execute, no DDL/ownership/BYPASSRLS, ...)
#   2. owner      runtime-role-acceptance.sql   tenant-isolation negatives with `set local role corvis_runtime`
#   3. strict     security_acceptance.sql (it hands over to runtime_security_acceptance.sql for a runtime login) and the
#                 existing suites, connected as a login role that is a member of corvis_runtime ONLY
#   4. fixture    existing suites that also need test-only seeding/cleanup privileges (runtime-role-ci-fixture.sql);
#                 their application code paths still run on the runtime role's privileges
#
# NOT run as a non-owner, because they perform owner-only operations the application never does (their application-level
# counterparts above do run): processing-retry-exhaustion.sql (CREATE SCHEMA/ALTER EXTENSION), tenant-data-export.sql and
# export-schedules.sql (ALTER TABLE ... DISABLE TRIGGER), data-issue-reports.sql / review-item-discussion.sql /
# service-accounts.sql / session-policy.sql / tenant-identity-records.sql / tenant-isolation-negative.sql
# (CREATE/DROP ROLE for their own negative-role probes; runtime-role-acceptance.sql carries the same tenant-isolation
# negatives as the runtime role).
set -euo pipefail

cd "$(dirname "$0")/../../.."
: "${PGDATABASE:?PGDATABASE (a clean migrated database) is required}"
password="${CORVIS_RUNTIME_CI_PASSWORD:-ci-disposable-only}"
host="${PGHOST:-localhost}"
port="${PGPORT:-5432}"
tests=db/postgres/tests

strict_sql=(
  processing-stage-recovery-hardening stage-retry-backoff outbox-event-authenticity-guard sector-taxonomy
  tenant-invitation-acceptance identity-lifecycle-unknown-workspace rls-invariant integrity-hardening
  release-clean-artifact-guard
)
strict_mjs=(
  session-policy tenant-identity-records export-grant-redemption authorization-cache-revocation
  migration-073-audit-correction user-preferences
)
fixture_sql=(reviewed-economic-graph processing-stage-pipeline cross-document-conflicts pipeline-durability-066)
fixture_mjs=(
  tenant-data-export data-issue-reports service-accounts export-schedules export-schedule-concurrency
  review-item-discussion email-notifications
)

as_login() { # login, command...
  local login="$1"; shift
  PGUSER="$login" PGPASSWORD="$password" "$@"
}
run_sql() { # login, suite
  echo "[runtime-role] $1: $2.sql"
  as_login "$1" psql -X -q -v ON_ERROR_STOP=1 -f "$tests/$2.sql" > /dev/null
}
run_mjs() { # login, suite
  echo "[runtime-role] $1: $2.mjs"
  CORVIS_POSTGRES_DSN="postgres://$1:${password}@${host}:${port}/${PGDATABASE}?sslmode=disable" node "$tests/$2.mjs" > /dev/null
}

psql -X -q -v ON_ERROR_STOP=1 -v pw="$password" -f "$tests/runtime-role-ci-fixture.sql"

echo "[runtime-role] owner: runtime-role-privileges.sql"
psql -X -q -v ON_ERROR_STOP=1 -f "$tests/runtime-role-privileges.sql" | tee /tmp/runtime-role-privileges.out
grep -q POSTGRES_RUNTIME_ROLE_PRIVILEGES_PASS /tmp/runtime-role-privileges.out
echo "[runtime-role] owner (set role corvis_runtime): runtime-role-acceptance.sql"
psql -X -q -v ON_ERROR_STOP=1 -f "$tests/runtime-role-acceptance.sql" | tee /tmp/runtime-role-acceptance.out
grep -q POSTGRES_RUNTIME_ROLE_ACCEPTANCE_PASS /tmp/runtime-role-acceptance.out

echo "[runtime-role] corvis_runtime_ci_strict: security_acceptance.sql (hands over to runtime_security_acceptance.sql)"
as_login corvis_runtime_ci_strict psql -X -q -v ON_ERROR_STOP=1 -f db/postgres/security_acceptance.sql | tee /tmp/runtime-role-security-acceptance.out
grep -q POSTGRES_RLS_SECURITY_ACCEPTANCE_PASS /tmp/runtime-role-security-acceptance.out

for suite in "${strict_sql[@]}"; do run_sql corvis_runtime_ci_strict "$suite"; done
for suite in "${strict_mjs[@]}"; do run_mjs corvis_runtime_ci_strict "$suite"; done
for suite in "${fixture_sql[@]}"; do run_sql corvis_runtime_ci_fixture_login "$suite"; done
for suite in "${fixture_mjs[@]}"; do run_mjs corvis_runtime_ci_fixture_login "$suite"; done

echo "RUNTIME_ROLE_ACCEPTANCE_PASS"
