#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_WIF_PROVIDER:?GCP_WIF_PROVIDER is required}"
: "${GCP_DEPLOY_SERVICE_ACCOUNT:?GCP_DEPLOY_SERVICE_ACCOUNT is required}"
: "${CORVIS_ENVIRONMENT:?CORVIS_ENVIRONMENT is required}"

EXPECTED_REPOSITORY="kingyx3/corvis"
EXPECTED_REF="refs/heads/main"

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

python3 - "${provider_json}" "${policy_json}" "${actual_project_number}" "${pool_id}" "${CORVIS_ENVIRONMENT}" "${EXPECTED_REPOSITORY}" "${EXPECTED_REF}" <<'PY'
import json
import re
import sys

provider_path, policy_path, project_number, pool_id, environment, repository, expected_ref = sys.argv[1:]
with open(provider_path, encoding="utf-8") as handle:
    provider = json.load(handle)
with open(policy_path, encoding="utf-8") as handle:
    policy = json.load(handle)

mapping = provider.get("attributeMapping") or {}
if mapping.get("google.subject") != "assertion.sub":
    raise SystemExit("WIF provider must map google.subject to assertion.sub.")

expected_subject = f"repo:{repository}:environment:{environment}"

# The condition must be a pure conjunction of claim equalities, each of the form
# assertion.<claim> == '<value>'. Substring checks are not enough: a condition
# such as "assertion.ref != 'refs/heads/main'" or "... || assertion.sub == 'x'"
# contains the expected text yet admits other identities. Any clause that is
# not a plain equality (negation, ||, parentheses, extra claims) is rejected.
# Accepted shapes (clause order is irrelevant; each claim appears exactly once):
#   assertion.sub == 'repo:<repository>:environment:<environment>' && assertion.ref == '<ref>'
#   assertion.repository == '<repository>' && assertion.environment == '<environment>' && assertion.ref == '<ref>'
ACCEPTED_CONDITIONS = (
    {"sub": expected_subject, "ref": expected_ref},
    {"repository": repository, "environment": environment, "ref": expected_ref},
)
EQUALITY = re.compile(r"""^assertion\.([a-z_]+) == (?:'([^']*)'|"([^"]*)")$""")


def parse_condition(raw):
    claims = {}
    for clause in raw.split("&&"):
        match = EQUALITY.match(clause.strip())
        if match is None:
            return None
        claim = match.group(1)
        value = match.group(2) if match.group(2) is not None else match.group(3)
        if claim in claims:
            return None
        claims[claim] = value
    return claims


condition = provider.get("attributeCondition") or ""
if parse_condition(condition) not in ACCEPTED_CONDITIONS:
    raise SystemExit(
        "WIF provider attributeCondition must be exactly "
        f"\"assertion.sub == '{expected_subject}' && assertion.ref == '{expected_ref}'\" "
        f"(or equality clauses on assertion.repository == {repository!r}, "
        f"assertion.environment == {environment!r} and assertion.ref == {expected_ref!r}) "
        "with no other clauses, negations or ||."
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
    "Verified WIF trust anchor: provider is project/repository/environment/main-ref scoped and "
    "corvis-deploy impersonation is repository scoped."
)
PY
