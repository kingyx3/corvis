#!/usr/bin/env bash
set -euo pipefail

CONVEX_BACKEND_IMAGE="${CONVEX_BACKEND_IMAGE:-ghcr.io/get-convex/convex-backend:c449d75382dafa006f431521da4623d74edbad1a}"
CONVEX_CLI_VERSION="${CONVEX_CLI_VERSION:-1.46.0}"
CONVEX_POSTGRES_URL="${CONVEX_POSTGRES_URL:-}"
CONTAINER="corvis-convex-conformance-${RANDOM}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT_DIR="$(mktemp -d)"

cleanup() {
  docker logs "$CONTAINER" >"$RESULT_DIR/backend.log" 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$RESULT_DIR"
}
trap cleanup EXIT

cd "$SCRIPT_DIR"
export NO_COLOR=1

# Keep Convex isolated from Corvis's production dependency graph. The exact
# version is pinned for PR CI; the scheduled upstream canary overrides it with
# `latest` to detect changes in the supported Convex CLI/backend contract.
npm install --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "convex@${CONVEX_CLI_VERSION}"

docker pull "$CONVEX_BACKEND_IMAGE"
docker_args=(
  -d
  --name "$CONTAINER"
  -p 3210:3210
  -p 3211:3211
  -e DISABLE_BEACON=1
  -e DISABLE_METRICS_ENDPOINT=true
)

# Upstream Convex supports PostgreSQL as its persistence engine. CI points this
# at a disposable PostgreSQL service so we exercise the exact deployment shape
# that could later use Supabase, Cloud SQL, RDS, Azure PostgreSQL or self-hosted
# PostgreSQL underneath Convex. host.docker.internal is explicitly mapped for
# Linux GitHub runners.
if [[ -n "$CONVEX_POSTGRES_URL" ]]; then
  docker_args+=(
    --add-host=host.docker.internal:host-gateway
    -e "POSTGRES_URL=$CONVEX_POSTGRES_URL"
  )
fi

docker run "${docker_args[@]}" "$CONVEX_BACKEND_IMAGE" >/dev/null

for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3210/version >"$RESULT_DIR/version.json"; then
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    echo "Convex backend did not become healthy" >&2
    docker logs "$CONTAINER" >&2 || true
    exit 1
  fi
  sleep 1
done

export CONVEX_SELF_HOSTED_URL="http://127.0.0.1:3210"
export CONVEX_SELF_HOSTED_ADMIN_KEY="$(docker exec "$CONTAINER" ./generate_admin_key.sh | tail -n 1)"
test -n "$CONVEX_SELF_HOSTED_ADMIN_KEY"

# Push the small reference model to the official backend. This is deliberately
# not a Corvis persistence implementation: it is an executable oracle for the
# atomicity/concurrency semantics Corvis requires from every database adapter.
npx --no-install convex dev --once

npx --no-install convex run conformance:reset '{"key":"race"}' >/dev/null

pids=()
for i in $(seq 1 8); do
  npx --no-install convex run conformance:compareAndSet \
    '{"key":"race","expected":0,"next":1}' \
    >"$RESULT_DIR/race-${i}.out" 2>"$RESULT_DIR/race-${i}.err" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do
  wait "$pid"
done

successes=0
for i in $(seq 1 8); do
  result="$(tail -n 1 "$RESULT_DIR/race-${i}.out" | tr -d '\r')"
  case "$result" in
    true) successes=$((successes + 1)) ;;
    false) ;;
    *)
      echo "Unexpected Convex compare-and-set result: $result" >&2
      cat "$RESULT_DIR/race-${i}.err" >&2 || true
      exit 1
      ;;
  esac
done

test "$successes" -eq 1
summary="$(npx --no-install convex run conformance:summary '{"key":"race"}' | tail -n 1 | tr -d '\r')"
test "$summary" = '"1:1"'

# Convex mutations are all-or-nothing: the event inserted before the intentional
# throw must not remain visible after the failed mutation.
if npx --no-install convex run conformance:writeThenFail '{"key":"rollback"}' \
  >"$RESULT_DIR/rollback.out" 2>"$RESULT_DIR/rollback.err"; then
  echo "Intentional Convex rollback mutation unexpectedly succeeded" >&2
  exit 1
fi
rollback_count="$(npx --no-install convex run conformance:eventCount '{"key":"rollback"}' | tail -n 1 | tr -d '\r')"
test "$rollback_count" = "0"

echo "Convex upstream conformance passed: PostgreSQL persistence, one CAS winner, one event, failed mutation rolled back."
