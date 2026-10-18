#!/usr/bin/env bash
# Copy a SQLite backup from S3 into the hosted PostgreSQL database (#261).
#
# Downloads one backup set (manifest, database and media archives) from the
# private backup bucket, verifies it against its manifest, and runs the
# runtime's `database-import`, which loads every table in one transaction and
# commits only when each table's row count and content hash match. The live
# SQLite file and the S3 objects are never changed.
#
#   database-import.sh --confirm --manifest rewind-<timestamp>.manifest.json [--replace]
#
# Always name the exact recovery point. The workflow passes the manifest produced
# by its freshly quiesced backup, never a remote latest-object selection.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/operator-common.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/backup-manifest.sh"

HOST_ROOT="${HOST_ROOT:-/srv/rewind}"
ENV_FILE="${ENV_FILE:-$HOST_ROOT/rewind.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$HOST_ROOT/deploy/compose.yaml}"
DATA_DIR="${DATA_DIR:-$HOST_ROOT/data}"
MEDIA_DIR="${MEDIA_DIR:-$HOST_ROOT/media}"
BACKUP_DIR="${BACKUP_DIR:-$HOST_ROOT/backups}"
RUNTIME_GID="${RUNTIME_GID:-10001}"

usage() {
  printf 'Usage: %s --confirm --manifest rewind-<timestamp>.manifest.json [--replace]\n' \
    "$(basename "$0")" >&2
}

[[ $# -ge 1 ]] || { usage; exit 2; }
require_confirmation --confirm "$1"
shift
manifest_name=''
replace=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) manifest_name="${2:-}"; shift 2 ;;
    --replace) replace=(--replace); shift ;;
    *) usage; exit 2 ;;
  esac
done

require_command aws
require_command jq
require_command gzip
require_regular_file ENV_FILE "$ENV_FILE"
selected_release_sha="${REWIND_RELEASE_SHA:-}"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
require_database_target
if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
  unset AWS_PROFILE
fi
export REWIND_RELEASE_SHA="$selected_release_sha"
resolve_installed_release
: "${REWIND_BACKUP_BUCKET:?REWIND_BACKUP_BUCKET must be set in $ENV_FILE}"
: "${REWIND_BACKUP_PREFIX:?REWIND_BACKUP_PREFIX must be explicit for database import}"
: "${REWIND_DATABASE_APP_URL:?REWIND_DATABASE_APP_URL must be set (Terraform hosted settings)}"
validate_backup_prefix "$REWIND_BACKUP_PREFIX" || exit 1
ensure_backup_directory "$BACKUP_DIR"
BACKUP_DIR="$(canonical_directory BACKUP_DIR "$BACKUP_DIR")"

require_runtime_stopped
[[ "$(cat "$HOST_ROOT/database-maintenance")" == "$REWIND_MEDIA_ENVIRONMENT" ]] || die 'import requires matching database maintenance'
[[ "$(cat "$HOST_ROOT/database-maintenance-mode")" == import ]] || die 'not an import maintenance window'
rm -f -- "$HOST_ROOT/database-reconciled.json"

remote="s3://${REWIND_BACKUP_BUCKET}/${REWIND_BACKUP_PREFIX}"
if [[ -z "$manifest_name" ]]; then
  die 'Pass the exact snapshot manifest; remote latest is not a final recovery point.'
fi
[[ "$manifest_name" =~ ^rewind-[0-9]{8}T[0-9]{6}Z\.manifest\.json$ ]] ||
  die 'The manifest must be named rewind-<timestamp>.manifest.json.'

work="$(mktemp -d "$BACKUP_DIR/.database-import.XXXXXX")"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT

aws s3 cp "$remote/$manifest_name" "$work/$manifest_name" --only-show-errors
validate_backup_manifest "$work/$manifest_name" "$REWIND_BACKUP_PREFIX" || exit 1
aws s3 cp "s3://${REWIND_BACKUP_BUCKET}/${BACKUP_MANIFEST_DATABASE_KEY}" \
  "$work/$BACKUP_MANIFEST_DATABASE_NAME" --only-show-errors
aws s3 cp "s3://${REWIND_BACKUP_BUCKET}/${BACKUP_MANIFEST_MEDIA_KEY}" \
  "$work/$BACKUP_MANIFEST_MEDIA_NAME" --only-show-errors
verify_backup_manifest_archives "$work" || exit 1

# The runtime (uid/gid 10001) reads the snapshot through a read-only mount.
mkdir "$work/import"
gzip -dc "$work/$BACKUP_MANIFEST_DATABASE_NAME" > "$work/import/rewind.sqlite"
chgrp "$RUNTIME_GID" "$work" "$work/import" "$work/import/rewind.sqlite"
chmod 0750 "$work" "$work/import"
chmod 0640 "$work/import/rewind.sqlite"

printf 'Importing %s into PostgreSQL...\n' "$manifest_name"
report="$BACKUP_DIR/${manifest_name%.manifest.json}.postgres-import.json"
# -e NAME passes the value from this environment without putting it in argv.
export REWIND_DATABASE_URL="$REWIND_DATABASE_APP_URL"
compose run --rm --no-deps -T \
  -e REWIND_DATABASE_URL -e REWIND_DATABASE_ENVIRONMENT \
  -v "$work/import:/import:ro" \
  runtime database-import --sqlite /import/rewind.sqlite --json ${replace[@]+"${replace[@]}"} > "$report.tmp"
mv "$report.tmp" "$report"
jq -n --arg environment "$REWIND_MEDIA_ENVIRONMENT" --arg manifest "$manifest_name" \
  --arg manifestSha256 "$(sha256_file "$work/$manifest_name")" \
  --arg final "${REWIND_FINAL_IMPORT_MANIFEST:-}" --slurpfile report "$report" \
  '{environment: $environment, manifest: $manifest, manifestSha256: $manifestSha256,
    finalSnapshot: ($final == $manifest), reconciliation: $report[0]}' > "$HOST_ROOT/database-reconciled.json.tmp"
mv "$HOST_ROOT/database-reconciled.json.tmp" "$HOST_ROOT/database-reconciled.json"
jq -r '.tables[] | "\(.table): \(.rows) rows"' "$report"
printf 'Imported and reconciled %s rows. Report: %s\n' "$(jq -r .totalRows "$report")" "$report"
