#!/usr/bin/env bash
# Run inside the protected release deployment job. Terraform remains the only
# writer of hosted settings; activation waits for the reviewed cutover apply.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $# == 1 && ( "$1" == reconcile || "$1" == activate ) ]] || die 'usage: release-cutover.sh reconcile|activate'
export TARGET_ENVIRONMENT=release OPERATION=bootstrap
bash "$SCRIPT_DIR/database-target.sh"
[[ "${REWIND_HOSTED_ENV_URI:-}" == s3://rewind-release-media-330599756236/_config/release.env ]] || die 'release hosted settings URI is required'
: "${REWIND_SSH_OPTS:?missing deployment SSH options}"
[[ "${REWIND_HOST_IP:-}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die 'missing release host address'

run_ssh() {
  # Matches the deployment workflow's SSH options, including its private key
  # and pinned known_hosts file. No new authentication path is introduced.
  # shellcheck disable=SC2086,SC2029
  ssh $REWIND_SSH_OPTS "ubuntu@$REWIND_HOST_IP" "$@"
}

read_settings() {
  settings="$(python3 - "${1:-60}" "$REWIND_HOSTED_ENV_URI" <<'PY'
import subprocess, sys
try:
    result = subprocess.run(['aws', 's3', 'cp', sys.argv[2], '-', '--only-show-errors'], timeout=int(sys.argv[1]))
except subprocess.TimeoutExpired:
    sys.exit('hosted settings read timed out')
sys.exit(result.returncode)
PY
  )" || die 'hosted settings download failed or timed out; no activation was attempted'
  for required in REWIND_AUTH_PASSWORD=false REWIND_MEDIA_ENVIRONMENT=release REWIND_DATABASE_ENVIRONMENT=release REWIND_BACKUP_BUCKET=rewind-release-backups-330599756236 REWIND_BACKUP_PREFIX=rewind-release; do
    grep -Fqx "$required" <<<"$settings" || die 'hosted settings do not match the isolated Cognito-only release'
  done
  selected="$(sed -n 's/^REWIND_DATABASE_URL=//p' <<<"$settings")"
  app="$(sed -n 's/^REWIND_DATABASE_APP_URL=//p' <<<"$settings")"
  [[ "$app" == postgres://* || "$app" == postgresql://* ]] || die 'release PostgreSQL app URL is missing'
  [[ -z "$selected" || "$selected" == "$app" ]] || die 'selected database differs from the release app database'
  grep -q '^REWIND_DATABASE_URL=' <<<"$settings" || die 'release database selection is missing'
}

if [[ "$1" == reconcile ]]; then
  read_settings
  [[ -z "$selected" ]] || die 'cutover is already selected; use the normal install operation'
  [[ "${REWIND_RELEASE_BUNDLE_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || die 'missing verified bundle checksum'
  printf '%s\n' "$settings" | run_ssh 'bash /tmp/release-host.sh configure'
  run_ssh "set -Eeuo pipefail; test \"\$(sha256sum /tmp/rewind-release.tar | cut -d ' ' -f 1)\" = '$REWIND_RELEASE_BUNDLE_SHA256'; bash /tmp/release-host.sh install /tmp/rewind-release.tar"
  bootstrap="$(aws s3 cp "$REWIND_DATABASE_BOOTSTRAP_URI" - --only-show-errors)"
  printf '%s\n' "$bootstrap" | run_ssh 'REWIND_OPERATION_ENVIRONMENT=release bash /srv/rewind/deploy/database-bootstrap.sh'
  unset bootstrap
  run_ssh 'bash -s' <<'REMOTE'
set -Eeuo pipefail
export REWIND_OPERATION_ENVIRONMENT=release
bash /srv/rewind/deploy/database-maintenance.sh quiesce
fresh=$(mktemp /srv/rewind/backups/.final-manifest.XXXXXX)
trap 'rm -f -- "$fresh"' EXIT
REWIND_BACKUP_QUIESCED=1 REWIND_BACKUP_MANIFEST_OUTPUT="$fresh" bash /srv/rewind/deploy/backup.sh
export REWIND_FINAL_IMPORT_MANIFEST=$(cat "$fresh")
[[ "$REWIND_FINAL_IMPORT_MANIFEST" =~ ^rewind-[0-9]{8}T[0-9]{6}Z\.manifest\.json$ ]]
bash /srv/rewind/deploy/database-import.sh --confirm --manifest "$REWIND_FINAL_IMPORT_MANIFEST"
python3 /srv/rewind/deploy/release.py check-maintenance /srv/rewind
cat /srv/rewind/database-reconciled.json
REMOTE
  printf 'RELEASE_CUTOVER_RECONCILED: inspect the receipt above, then apply the reviewed release-only Terraform cutover plan. Writers remain stopped.\n'
else
  wait_seconds="${REWIND_RELEASE_CUTOVER_WAIT_SECONDS:-1500}"
  [[ "$wait_seconds" =~ ^[0-9]+$ && "$wait_seconds" -gt 0 && "$wait_seconds" -le 1500 ]] || die 'cutover wait must be 1–1500 seconds'
  deadline=$((SECONDS + wait_seconds))
  expired() { die 'Terraform cutover was not applied in time; writers remain stopped. Inspect the receipt and explicitly resume SQLite or rerun install after the reviewed apply.'; }
  while :; do
    remaining=$((deadline - SECONDS))
    [[ "$remaining" -gt 0 ]] || expired
    read_settings "$remaining"
    [[ "$SECONDS" -lt "$deadline" ]] || expired
    [[ -z "$selected" ]] || break
    printf 'Waiting for the reviewed release-only Terraform cutover apply; writers remain stopped.\n'
    remaining=$((deadline - SECONDS))
    [[ "$remaining" -le 10 ]] || remaining=10
    sleep "$remaining"
  done
  printf '%s\n' "$settings" | run_ssh 'bash /tmp/release-host.sh configure'
  unset settings app selected
  run_ssh 'bash /tmp/release-host.sh install /tmp/rewind-release.tar'
  status="$(run_ssh 'REWIND_OPERATION_ENVIRONMENT=release bash /srv/rewind/deploy/database-status.sh')"
  printf '%s\n' "$status"
  jq -e '.engine == "postgresql" and .ready == true and .environment == "release"' <<<"$status" >/dev/null
  run_ssh 'REWIND_OPERATION_ENVIRONMENT=release bash /srv/rewind/deploy/backup.sh'
fi
