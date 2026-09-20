#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"
: "${TF_STATE_BUCKET:?TF_STATE_BUCKET is required}"

bucket="gs://${TF_STATE_BUCKET}"

case "${action}" in
  ensure)
    lifecycle_file="$(mktemp)"
    trap 'rm -f "${lifecycle_file}"' EXIT
    cat >"${lifecycle_file}" <<'JSON'
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {"isLive": false, "daysSinceNoncurrentTime": 30}
    },
    {
      "action": {"type": "Delete"},
      "condition": {"isLive": false, "numNewerVersions": 20}
    }
  ]
}
JSON

    if ! gcloud storage buckets describe "${bucket}" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1; then
      gcloud storage buckets create "${bucket}" \
        --project="${GCP_PROJECT_ID}" \
        --location="${GCP_REGION}" \
        --uniform-bucket-level-access \
        --public-access-prevention \
        --soft-delete-duration=0 \
        --lifecycle-file="${lifecycle_file}"
    fi

    gcloud storage buckets update "${bucket}" \
      --versioning \
      --uniform-bucket-level-access \
      --public-access-prevention \
      --soft-delete-duration=0 \
      --lifecycle-file="${lifecycle_file}"
    ;;
  require)
    if ! gcloud storage buckets describe "${bucket}" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1; then
      echo "Terraform state bucket ${bucket} does not exist. Run Bootstrap GCP foundation first."
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 <ensure|require>"
    exit 2
    ;;
esac
