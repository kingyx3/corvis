#!/usr/bin/env bash
set -euo pipefail

CONVEX_BACKEND_IMAGE="${CONVEX_BACKEND_IMAGE:-ghcr.io/get-convex/convex-backend:c449d75382dafa006f431521da4623d74edbad1a}"
CONVEX_POSTGRES_URL="${CONVEX_POSTGRES_URL:-}"
CONVEX_POSTGRES_REQUIRE_TLS="${CONVEX_POSTGRES_REQUIRE_TLS:-true}"
# Optional: a client DSN for the database Convex persists into. When set, the
# run proves documents really landed in PostgreSQL rather than a silent SQLite
# fallback. Requires psql on PATH.
CONVEX_POSTGRES_VERIFY_DSN="${CONVEX_POSTGRES_VERIFY_DSN:-}"
CONTAINER="corvis-convex-conformance-${RANDOM}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT_DIR="$(mktemp -d)"

cleanup() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "::group::Convex backend logs (last 200 lines)" >&2
    docker logs --tail 200 "$CONTAINER" >&2 || true
    echo "::endgroup::" >&2
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$RESULT_DIR"
}
trap cleanup EXIT

cd "$SCRIPT_DIR"
export NO_COLOR=1

# package.json is the single source of truth for the pinned CLI, so a Dependabot
# bump of it is exactly what CI then exercises. The scheduled canary overrides
# CONVEX_CLI_VERSION with `latest`.
PINNED_CLI_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).dependencies.convex")"
CONVEX_CLI_VERSION="${CONVEX_CLI_VERSION:-$PINNED_CLI_VERSION}"

# Keep Convex isolated from Corvis's production dependency graph.
npm install --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "convex@${CONVEX_CLI_VERSION}"
installed_cli="$(node -p "JSON.parse(require('fs').readFileSync('node_modules/convex/package.json','utf8')).version")"
if [[ "$CONVEX_CLI_VERSION" != "latest" && "$installed_cli" != "$CONVEX_CLI_VERSION" ]]; then
  echo "Installed convex@${installed_cli}, expected ${CONVEX_CLI_VERSION}" >&2
  exit 1
fi
echo "Convex CLI ${installed_cli}; backend image ${CONVEX_BACKEND_IMAGE}"

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
  # Managed providers should keep Convex's TLS requirement enabled. The GitHub
  # Actions PostgreSQL service is an isolated disposable server without TLS, so
  # its workflow sets this to false and we use Convex's own supported flag.
  if [[ "$CONVEX_POSTGRES_REQUIRE_TLS" == "false" ]]; then
    docker_args+=(-e DO_NOT_REQUIRE_SSL=1)
  fi
fi

docker run "${docker_args[@]}" "$CONVEX_BACKEND_IMAGE" >/dev/null

for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3210/version >"$RESULT_DIR/version.json"; then
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    echo "Convex backend did not become healthy" >&2
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

# All contention is generated from one process (conformance.mjs) so the
# mutations genuinely overlap at the backend: single winner, no lost updates,
# and atomic rollback of failed mutations.
node conformance.mjs

persistence="default (SQLite)"
if [[ -n "$CONVEX_POSTGRES_URL" ]]; then
  persistence="PostgreSQL"
  if [[ -n "$CONVEX_POSTGRES_VERIFY_DSN" ]]; then
    stored="$(psql "$CONVEX_POSTGRES_VERIFY_DSN" -X -tA -c 'select count(*) from documents' | tr -d '[:space:]')"
    if ! [[ "$stored" =~ ^[0-9]+$ ]] || [[ "$stored" -eq 0 ]]; then
      echo "Convex was configured for PostgreSQL but no documents were persisted there (count: ${stored:-none})" >&2
      exit 1
    fi
    echo "Verified ${stored} Convex documents persisted in PostgreSQL."
  fi
fi
echo "Convex upstream conformance passed on ${persistence} persistence."
