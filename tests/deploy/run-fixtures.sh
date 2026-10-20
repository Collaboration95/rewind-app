#!/usr/bin/env bash
# Run every offline deploy fixture: tests/deploy/*.test.sh and deploy/tests/*.test.sh.
# Quality CI, the pre-push hook and `npm run test:deploy` all call this one list.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
shopt -s nullglob
fixtures=(tests/deploy/*.test.sh deploy/tests/*.test.sh)
(( ${#fixtures[@]} > 0 )) || { echo 'No deploy fixtures found.' >&2; exit 1; }
for fixture in "${fixtures[@]}"; do
  echo "--- $fixture"
  bash "$fixture"
done
