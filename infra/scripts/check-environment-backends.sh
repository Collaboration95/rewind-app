#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/infra/terraform/environments/backend"
DEMO_BACKEND="$REPO_ROOT/infra/terraform/demo/backend.hcl.example"

read_key() {
  local file="$1"
  local keys key_count
  keys="$(awk '$1 == "key" && $2 == "=" { gsub(/"/, "", $3); print $3 }' "$file")"
  key_count="$(printf '%s\n' "$keys" | awk 'NF { count++ } END { print count + 0 }')"
  [[ "$key_count" -eq 1 ]] || {
    printf 'Expected exactly one backend key in %s.\n' "${file#"$REPO_ROOT"/}" >&2
    return 1
  }
  printf '%s' "$keys"
}

dev_key="$(read_key "$BACKEND_DIR/dev.hcl.example")"
prod_key="$(read_key "$BACKEND_DIR/prod.hcl.example")"
demo_key="$(read_key "$DEMO_BACKEND")"

[[ "$dev_key" == "rewind/dev/terraform.tfstate" ]] || {
  printf 'The dev backend key must remain in the dev namespace.\n' >&2
  exit 1
}
[[ "$prod_key" == "rewind/prod/terraform.tfstate" ]] || {
  printf 'The prod backend key must remain in the prod namespace.\n' >&2
  exit 1
}
[[ "$dev_key" != "$prod_key" && "$dev_key" != "$demo_key" && "$prod_key" != "$demo_key" ]] || {
  printf 'Environment backend keys must be distinct from each other and the Demo key.\n' >&2
  exit 1
}

printf 'Environment backend key contract passed; remote key existence was not checked.\n'
