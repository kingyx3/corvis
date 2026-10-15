#!/usr/bin/env bash
# Hermetic bootstrap behavior tests; never touches a real database or secret.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/psql" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"select current_database()"*) printf 'corvis|127.0.0.1|5432\n';;
  *"select current_user"*) printf '%s\n' "${MOCK_LOGIN:-runtime_app}";;
  *"live-runtime-login-attestation.sql"*)
    if [[ "${MOCK_ATTEST:-pass}" == fail ]]; then exit 1; fi;;
  *)
    [[ "${MOCK_SQL_FAIL:-0}" != 1 ]] || exit 1
    cat > /dev/null
    printf 'mutation\n' >> "$MOCK_LOG";;
esac
MOCK
chmod +x "$tmp/psql"
export PATH="$tmp:$PATH" MOCK_LOG="$tmp/changes" CORVIS_RUNTIME_DSN=runtime CORVIS_MIGRATION_DSN=migration
: > "$MOCK_LOG"
bash "$root/tools/ci/bootstrap-runtime-login.sh" > /dev/null
[[ ! -s "$MOCK_LOG" ]] || { echo 'No-op rerun unexpectedly changed grants'; exit 1; }
export MOCK_ATTEST=fail
bash "$root/tools/ci/bootstrap-runtime-login.sh" > /dev/null 2>&1 && { echo 'Failed attestation was accepted'; exit 1; }
# With mock failing attestation, grant path must run and final attestation must reject.
[[ "$(wc -l < "$MOCK_LOG")" -eq 1 ]] || { echo 'Expected exactly one grant attempt'; exit 1; }
export MOCK_SQL_FAIL=1
bash "$root/tools/ci/bootstrap-runtime-login.sh" > /dev/null 2>&1 && { echo 'SQL failure was accepted'; exit 1; }
export MOCK_SQL_FAIL=0 MOCK_LOGIN='invalid-role!'
bash "$root/tools/ci/bootstrap-runtime-login.sh" > /dev/null 2>&1 && { echo 'Invalid login was accepted'; exit 1; }
echo 'Runtime bootstrap mock regression checks passed'
