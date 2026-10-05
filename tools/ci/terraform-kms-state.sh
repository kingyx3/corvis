#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"
: "${TF_ROOT:?TF_ROOT is required}"
: "${CORVIS_ENVIRONMENT:?CORVIS_ENVIRONMENT is required}"

keyring="corvis-${CORVIS_ENVIRONMENT}"
key="source-artifacts"
keyring_id="projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/keyRings/${keyring}"
key_id="${keyring_id}/cryptoKeys/${key}"
keyring_address="module.foundation.google_kms_key_ring.corvis"
key_address="module.foundation.google_kms_crypto_key.source"

case "${action}" in
  adopt)
    if gcloud kms keyrings describe "${keyring}" \
      --project="${GCP_PROJECT_ID}" \
      --location="${GCP_REGION}" >/dev/null 2>&1; then
      if ! terraform -chdir="${TF_ROOT}" state show "${keyring_address}" >/dev/null 2>&1; then
        terraform -chdir="${TF_ROOT}" import "${keyring_address}" "${keyring_id}"
      fi
    fi

    if gcloud kms keys describe "${key}" \
      --project="${GCP_PROJECT_ID}" \
      --location="${GCP_REGION}" \
      --keyring="${keyring}" >/dev/null 2>&1; then
      if ! terraform -chdir="${TF_ROOT}" state show "${key_address}" >/dev/null 2>&1; then
        terraform -chdir="${TF_ROOT}" import "${key_address}" "${key_id}"
      fi

      primary_name="$(gcloud kms keys describe "${key}" \
        --project="${GCP_PROJECT_ID}" \
        --location="${GCP_REGION}" \
        --keyring="${keyring}" \
        --format='value(primary.name)')"
      if [[ -n "${primary_name}" ]]; then
        primary_version="${primary_name##*/}"
        primary_state="$(gcloud kms keys versions describe "${primary_version}" \
          --project="${GCP_PROJECT_ID}" \
          --location="${GCP_REGION}" \
          --keyring="${keyring}" \
          --key="${key}" \
          --format='value(state)')"
        if [[ "${primary_state}" == "DISABLED" ]]; then
          gcloud kms keys versions enable "${primary_version}" \
            --project="${GCP_PROJECT_ID}" \
            --location="${GCP_REGION}" \
            --keyring="${keyring}" \
            --key="${key}"
        fi
      fi
    fi
    ;;
  hibernate)
    if gcloud kms keys describe "${key}" \
      --project="${GCP_PROJECT_ID}" \
      --location="${GCP_REGION}" \
      --keyring="${keyring}" >/dev/null 2>&1; then
      gcloud kms keys update "${key}" \
        --project="${GCP_PROJECT_ID}" \
        --location="${GCP_REGION}" \
        --keyring="${keyring}" \
        --remove-rotation-schedule

      mapfile -t enabled_versions < <(
        gcloud kms keys versions list \
          --project="${GCP_PROJECT_ID}" \
          --location="${GCP_REGION}" \
          --keyring="${keyring}" \
          --key="${key}" \
          --filter='state=ENABLED' \
          --format='value(name)'
      )
      for version_name in "${enabled_versions[@]}"; do
        [[ -z "${version_name}" ]] && continue
        version="${version_name##*/}"
        gcloud kms keys versions disable "${version}" \
          --project="${GCP_PROJECT_ID}" \
          --location="${GCP_REGION}" \
          --keyring="${keyring}" \
          --key="${key}"
      done
    fi
    ;;
  *)
    echo "Usage: $0 <adopt|hibernate>"
    exit 2
    ;;
esac
