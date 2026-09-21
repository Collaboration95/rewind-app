#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/operator-common.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/backup-manifest.sh"

LOCAL_ONLY=0
if [[ "$#" -gt 1 || ( "$#" -eq 1 && "${1:-}" != "--local-only" ) ]]; then
  printf 'Usage: %s [--local-only]\n' "$(basename "$0")" >&2
  exit 2
fi
if [[ "${1:-}" == "--local-only" ]]; then
  LOCAL_ONLY=1
fi

COMPOSE_FILE="${COMPOSE_FILE:-/srv/rewind/deploy/compose.yaml}"
ENV_FILE="${ENV_FILE:-/srv/rewind/rewind.env}"
DATA_DIR="${DATA_DIR:-/srv/rewind/data}"
MEDIA_DIR="${MEDIA_DIR:-/srv/rewind/media}"
BACKUP_DIR="${BACKUP_DIR:-/srv/rewind/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "RETENTION_DAYS must be a non-negative integer."

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE; copy deploy/rewind.env.example and configure it." >&2
  exit 1
fi
require_safe_mutable_path "DATA_DIR" "$DATA_DIR"
require_safe_mutable_path "MEDIA_DIR" "$MEDIA_DIR"
require_directory DATA_DIR "$DATA_DIR"
require_directory MEDIA_DIR "$MEDIA_DIR"
DATA_DIR="$(canonical_directory DATA_DIR "$DATA_DIR")"
MEDIA_DIR="$(canonical_directory MEDIA_DIR "$MEDIA_DIR")"
require_safe_mutable_path "DATA_DIR" "$DATA_DIR"
require_safe_mutable_path "MEDIA_DIR" "$MEDIA_DIR"
ensure_distinct_paths DATA_DIR "$DATA_DIR" MEDIA_DIR "$MEDIA_DIR"
ensure_backup_directory "$BACKUP_DIR"
BACKUP_DIR="$(canonical_directory BACKUP_DIR "$BACKUP_DIR")"
require_regular_file "COMPOSE_FILE" "$COMPOSE_FILE"
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${REWIND_BACKUP_BUCKET:?REWIND_BACKUP_BUCKET must be set in $ENV_FILE}"
: "${REWIND_BACKUP_PREFIX:=rewind-demo}"
: "${AWS_PROFILE:=default}"
validate_backup_prefix "$REWIND_BACKUP_PREFIX" || exit 1

require_compose_prerequisites
if [[ "$LOCAL_ONLY" == 0 ]]; then
  require_command aws
fi
require_runtime_running
require_regular_file "SQLite database" "$DATA_DIR/rewind.sqlite"
assert_persistent_tree_contract "$DATA_DIR" 'SQLite data' "$DATA_DIR/media" || exit 1
assert_persistent_tree_contract "$MEDIA_DIR" 'media' || exit 1

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot_name=".rewind-backup-${stamp}.sqlite"
archive_name="rewind-${stamp}.sqlite.gz"
media_archive_name="rewind-${stamp}.media.tar.gz"
manifest_name="rewind-${stamp}.manifest.json"
snapshot_path="$BACKUP_DIR/$snapshot_name"
archive_path="$BACKUP_DIR/$archive_name"
media_archive_path="$BACKUP_DIR/$media_archive_name"
manifest_path="$BACKUP_DIR/$manifest_name"

cleanup() {
  rm -f "$snapshot_path"
}
trap cleanup EXIT

# VACUUM INTO creates a consistent SQLite snapshot while the service remains
# online, including any pending WAL changes. The runtime writes only to its
# temporary filesystem, then streams the snapshot to a host-owned backup file;
# this avoids assuming the host operator can read files owned by the runtime
# identity on the persistent data mount. Media is streamed through the runtime
# below for the same reason: the approved backup operation must not weaken the
# persistent tree's private mode contract just to read an archive.
compose exec -T \
  -e "REWIND_SNAPSHOT_PATH=/tmp/$snapshot_name" runtime \
  node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; import { readFileSync, rmSync } from 'node:fs'; const target = process.env.REWIND_SNAPSHOT_PATH; const escaped = target.replaceAll(String.fromCharCode(39), String.fromCharCode(39, 39)); const db = new DatabaseSync('/var/lib/rewind/rewind.sqlite', { readOnly: true }); db.exec('VACUUM INTO ' + String.fromCharCode(39) + escaped + String.fromCharCode(39)); db.close(); process.stdout.write(readFileSync(target)); rmSync(target);" \
  > "$snapshot_path"

gzip -9 -c "$snapshot_path" > "$archive_path"
archive_runtime_media "$media_archive_path"
assert_private_backup_file "$archive_path" 'database backup archive'

db_sha256="$(sha256_file "$archive_path")"
media_sha256="$(sha256_file "$media_archive_path")"
db_bytes="$(file_bytes "$archive_path")"
media_bytes="$(file_bytes "$media_archive_path")"
printf '{"created_at":"%s","database":{"key":"%s/%s","sha256":"%s","bytes":%s},"media":{"key":"%s/%s","sha256":"%s","bytes":%s}}\n' \
  "$stamp" "$REWIND_BACKUP_PREFIX" "$archive_name" "$db_sha256" "$db_bytes" \
  "$REWIND_BACKUP_PREFIX" "$media_archive_name" "$media_sha256" "$media_bytes" \
  > "$manifest_path"
assert_private_backup_file "$manifest_path" 'backup manifest'

# Validate the artifact as a complete recovery point before any remote upload.
# This keeps a producer bug from publishing a manifest that restore or wake
# would correctly reject later.
validate_backup_manifest "$manifest_path" "$REWIND_BACKUP_PREFIX" || exit 1
verify_backup_manifest_archives "$BACKUP_DIR" || exit 1

if [[ "$LOCAL_ONLY" == 0 ]]; then
  AWS_PROFILE="$AWS_PROFILE" aws s3 cp "$archive_path" \
    "s3://${REWIND_BACKUP_BUCKET}/${REWIND_BACKUP_PREFIX}/${archive_name}" \
    --sse AES256 --only-show-errors
  AWS_PROFILE="$AWS_PROFILE" aws s3 cp "$media_archive_path" \
    "s3://${REWIND_BACKUP_BUCKET}/${REWIND_BACKUP_PREFIX}/${media_archive_name}" \
    --sse AES256 --only-show-errors
  AWS_PROFILE="$AWS_PROFILE" aws s3 cp "$manifest_path" \
    "s3://${REWIND_BACKUP_BUCKET}/${REWIND_BACKUP_PREFIX}/${manifest_name}" \
    --sse AES256 --only-show-errors
fi

# Keep only a short local recovery window; S3 lifecycle handles the remote
# demo retention policy.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'rewind-*' \
  -mtime "+$RETENTION_DAYS" -delete
if [[ "$LOCAL_ONLY" == 1 ]]; then
  printf 'Local backup ready %s %s %s\n' "$manifest_path" "$archive_path" "$media_archive_path"
else
  echo "Uploaded manifest s3://${REWIND_BACKUP_BUCKET}/${REWIND_BACKUP_PREFIX}/${manifest_name}"
fi
