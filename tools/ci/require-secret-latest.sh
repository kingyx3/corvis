#!/usr/bin/env bash
# Read metadata only. `latest` is the newest version, not the newest ENABLED one.
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
if (( $# == 0 )); then
  echo "Usage: require-secret-latest.sh SECRET_ID [SECRET_ID ...]" >&2
  exit 1
fi

for secret_id in "$@"; do
  state="$(gcloud secrets versions describe latest \
    --project="${GCP_PROJECT_ID}" --secret="${secret_id}" --format='value(state)')"
  if [[ "${state}" != "ENABLED" ]]; then
    echo "::error::${secret_id}: latest version is not ENABLED. Activate or restore the required provider credential before deployment."
    exit 1
  fi
  echo "${secret_id}: latest version is ENABLED; value was not accessed."
done
