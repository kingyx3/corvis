#!/usr/bin/env bash
set -euo pipefail

# Fail closed on file types and generated output that should never be committed to
# this intentionally public repository. This guard checks both the current index
# and every filename retained anywhere in Git history.

is_forbidden_path() {
  local path="$1"

  case "$path" in
    .env.example|*/.env.example)
      return 1
      ;;
    .env|*/.env|.env.*|*/.env.*)
      return 0
      ;;
    *.pem|*.key|*.p12|*.pfx|*.jks|*/id_rsa|*/id_ed25519)
      return 0
      ;;
    *.tfstate|*.tfstate.*|*/.terraform/*)
      return 0
      ;;
    *.sqlite|*.sqlite3|*.db|*.dump|*.bak|*.har|*.log)
      return 0
      ;;
    node_modules/*|*/node_modules/*|.next/*|*/.next/*|out/*|*/out/*|dist/*|*/dist/*|coverage/*|*/coverage/*|playwright-report/*|*/playwright-report/*|test-results/*|*/test-results/*)
      return 0
      ;;
  esac

  return 1
}

check_paths() {
  local source_label="$1"
  local path
  local found=0

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if is_forbidden_path "$path"; then
      printf 'Forbidden public-repository artifact in %s: %s\n' "$source_label" "$path" >&2
      found=1
    fi
  done

  return "$found"
}

current_failed=0
history_failed=0

if ! git ls-files | check_paths "tracked files"; then
  current_failed=1
fi

if ! git rev-list --objects --all | cut -d' ' -f2- | check_paths "Git history"; then
  history_failed=1
fi

if (( current_failed || history_failed )); then
  cat >&2 <<'EOF'
Public repository leak guard failed.

Do not commit credentials, private-key material, Terraform state, local databases,
request captures, logs, or generated build/test output. If sensitive material was
committed at any point, treat it as exposed and rotate/revoke it; removing it from
the latest commit does not make the historical copy private.
EOF
  exit 1
fi

printf 'Public repository artifact/path checks passed.\n'
