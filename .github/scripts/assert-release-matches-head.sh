#!/usr/bin/env bash
# Fail when the deployment checkout (HEAD) carries different db/ or infra/
# content than the release commit whose images are being promoted.
#
# Migrations and Terraform are applied from the checked-out tree, while the
# image comes from the release SHA. If db/ or infra/ moved between the two, the
# environment would receive schema or infrastructure that the accepted release
# never ran with.
#
# Usage: assert-release-matches-head.sh <release_sha>
# Run from inside a checkout that has full history (fetch-depth: 0).
set -euo pipefail

release_sha="${1:?usage: assert-release-matches-head.sh <release_sha>}"
guarded_paths=(db infra)

if [[ ! "${release_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "release_sha must be a full 40-character lowercase Git commit SHA."
  exit 1
fi

if [[ "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
  echo "The checkout is shallow, so the release commit cannot be compared reliably. Check out with fetch-depth: 0."
  exit 1
fi

if ! git cat-file -e "${release_sha}^{commit}" 2>/dev/null; then
  echo "Release commit ${release_sha} is not present in this checkout. It must be a commit reachable from the repository history."
  exit 1
fi

head_sha="$(git rev-parse HEAD)"
changed="$(git diff --name-only "${release_sha}" "${head_sha}" -- "${guarded_paths[@]}")"

if [[ -z "${changed}" ]]; then
  echo "db/ and infra/ at HEAD (${head_sha}) match release ${release_sha}."
  exit 0
fi

echo "Refusing to deploy: db/ or infra/ differ between HEAD (${head_sha}) and release ${release_sha}."
echo "Migrations and Terraform would run from HEAD against an image built from the release, so the environment"
echo "would receive schema or infrastructure the release never ran with. Differing paths:"
while IFS= read -r path; do
  echo "  - ${path}"
done <<< "${changed}"
echo
echo "Deploy from the release SHA's commit, or build, accept and re-promote a release from the current HEAD."
exit 1
