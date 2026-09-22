#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_WIF_PROVIDER:?GCP_WIF_PROVIDER is required}"
: "${GCP_DEPLOY_SERVICE_ACCOUNT:?GCP_DEPLOY_SERVICE_ACCOUNT is required}"
: "${CORVIS_ENVIRONMENT:?CORVIS_ENVIRONMENT is required}"

EXPECTED_REPOSITORY="kingyx3/corvis"

if [[ ! "${CORVIS_ENVIRONMENT}" =~ ^(dev|uat|prod)$ ]]; then
  echo "CORVIS_ENVIRONMENT must be dev, uat, or prod."
  exit 1
fi

if [[ ! "${GCP_WIF_PROVIDER}" =~ ^projects/([0-9]+)/locations/global/workloadIdentityPools/([^/]+)/providers/([^/]+)$ ]]; then
  echo "GCP_WIF_PROVIDER must be the full Google Workload Identity Provider resource name."
  exit 1
fi

provider_project_number="${BASH_REMATCH[1]}"
pool_id="${BASH_REMATCH[2]}"
provider_id="${BASH_REMATCH[3]}"

actual_project_number="$(gcloud projects describe "${GCP_PROJECT_ID}" --format='value(projectNumber)')"
if [[ "${provider_project_number}" != "${actual_project_number}" ]]; then
  echo "GCP_WIF_PROVIDER belongs to a different GCP project."
  exit 1
fi

provider_json="$(mktemp)"
policy_json="$(mktemp)"
trap 'rm -f "${provider_json}" "${policy_json}"' EXIT

gcloud iam workload-identity-pools providers describe "${provider_id}" \
  --workload-identity-pool="${pool_id}" \
  --location=global \
  --project="${GCP_PROJECT_ID}" \
  --format=json > "${provider_json}"

gcloud iam service-accounts get-iam-policy "${GCP_DEPLOY_SERVICE_ACCOUNT}" \
  --project="${GCP_PROJECT_ID}" \
  --format=json > "${policy_json}"

python3 - "${provider_json}" "${policy_json}" "${actual_project_number}" "${pool_id}" "${CORVIS_ENVIRONMENT}" "${EXPECTED_REPOSITORY}" <<'PY'
import json
import sys

provider_path, policy_path, project_number, pool_id, environment, repository = sys.argv[1:]
with open(provider_path, encoding="utf-8") as handle:
    provider = json.load(handle)
with open(policy_path, encoding="utf-8") as handle:
    policy = json.load(handle)

mapping = provider.get("attributeMapping") or {}
if mapping.get("google.subject") != "assertion.sub":
    raise SystemExit("WIF provider must map google.subject to assertion.sub.")

condition = provider.get("attributeCondition") or ""
repo_scoped = repository in condition and (
    "assertion.repository" in condition or "assertion.sub" in condition
)
environment_scoped = (
    (f"environment:{environment}" in condition and "assertion.sub" in condition)
    or (environment in condition and "assertion.environment" in condition)
)
if not repo_scoped or not environment_scoped:
    raise SystemExit(
        "WIF provider attributeCondition must restrict GitHub OIDC to "
        f"repository {repository!r} and environment {environment!r}."
    )

role_members = []
for binding in policy.get("bindings", []):
    if binding.get("role") == "roles/iam.workloadIdentityUser":
        role_members.extend(binding.get("members", []))

prefix = (
    "principalSet://iam.googleapis.com/projects/"
    f"{project_number}/locations/global/workloadIdentityPools/{pool_id}/"
)
subject_prefix = (
    "principal://iam.googleapis.com/projects/"
    f"{project_number}/locations/global/workloadIdentityPools/{pool_id}/subject/"
)
expected_subject = f"repo:{repository}:environment:{environment}"
repo_member_suffix = f"attribute.repository/{repository}"

scoped_member = any(
    member == f"{subject_prefix}{expected_subject}"
    or (member.startswith(prefix) and member.endswith(repo_member_suffix))
    for member in role_members
)
if not scoped_member:
    raise SystemExit(
        "corvis-deploy must grant roles/iam.workloadIdentityUser to either the exact "
        f"GitHub environment subject {expected_subject!r} or the repository-scoped principalSet "
        f"for {repository!r} in the configured pool."
    )

print(
    "Verified WIF trust anchor: provider is project/repository/environment scoped and "
    "corvis-deploy impersonation is repository scoped."
)
PY
