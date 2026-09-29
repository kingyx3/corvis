#!/usr/bin/env bash
# Fail when a Terraform plan (JSON from `terraform show -json`) would delete or
# replace any managed resource.
#
# Usage: assert-no-runtime-destroy.sh <plan.json>
#
# Environment:
#   CORVIS_ENVIRONMENT  dev | uat | prod (required only when ALLOW_DESTROY=true)
#   ALLOW_DESTROY       "true" acknowledges destroy/replace actions. Refused for prod.
set -euo pipefail

plan_json="${1:?usage: assert-no-runtime-destroy.sh <plan.json>}"
allow_destroy="${ALLOW_DESTROY:-false}"

if [[ ! -f "${plan_json}" ]]; then
  echo "Plan JSON not found: ${plan_json}"
  exit 1
fi

if [[ "${allow_destroy}" == "true" && "${CORVIS_ENVIRONMENT:-}" != "dev" && "${CORVIS_ENVIRONMENT:-}" != "uat" ]]; then
  echo "allow_destroy is refused for environment '${CORVIS_ENVIRONMENT:-unset}'. Use the guarded decommission workflow for intentional teardown."
  exit 1
fi

# A malformed or unexpected plan document must fail closed, never pass.
if ! jq -e 'type == "object"' "${plan_json}" >/dev/null 2>&1; then
  echo "Plan JSON is not a valid Terraform plan document: ${plan_json}"
  exit 1
fi

destroyed="$(jq -r '
  (.resource_changes // [])[]
  | select((.change.actions // []) | index("delete"))
  | "  - \(.address) (\(.change.actions | join("+")))"
' "${plan_json}")"

if [[ -z "${destroyed}" ]]; then
  echo "Plan contains no resource delete or replace actions."
  exit 0
fi

if [[ "${allow_destroy}" == "true" ]]; then
  echo "::warning::allow_destroy=true acknowledged for ${CORVIS_ENVIRONMENT}; plan deletes or replaces:"
  echo "${destroyed}"
  exit 0
fi

echo "Refusing to continue: the plan would delete or replace existing resources:"
echo "${destroyed}"
echo
echo "Bootstrap plans with empty runtime inputs (no API image, no Cloudflare zone) tear down a live runtime."
echo "If this environment already has a runtime, use Terraform deploy with a release. To knowingly accept"
echo "destroy/replace in dev or uat, rerun with allow_destroy=true. It is never accepted for prod."
exit 1
