#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/srv/rewind/deploy/compose.yaml}"
ENV_FILE="${ENV_FILE:-/srv/rewind/rewind.env}"
DATA_DIR="${DATA_DIR:-/srv/rewind/data}"
MEDIA_DIR="${MEDIA_DIR:-/srv/rewind/media}"
BACKUP_DIR="${BACKUP_DIR:-/srv/rewind/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE; copy deploy/rewind.env.example and configure it." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${REWIND_BACKUP_BUCKET:?REWIND_BACKUP_BUCKET must be set in $ENV_FILE}"
: "${REWIND_BACKUP_PREFIX:=rewind-demo}"
: "${AWS_PROFILE:=default}"

command -v docker >/dev/null || { echo 'docker is required.' >&2; exit 1; }
command -v aws >/dev/null || { echo 'aws CLI is required for S3 backups.' >&2; exit 1; }
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot_name=".rewind-backup-${stamp}.sqlite"
archive_name="rewind-${stamp}.sqlite.gz"
media_archive_name="rewind-${stamp}.media.tar.gz"
manifest_name="rewind-${stamp}.manifest.json"
snapshot_path="$DATA_DIR/$snapshot_name"
archive_path="$BACKUP_DIR/$archive_name"
media_archive_path="$BACKUP_DIR/$media_archive_name"
manifest_path="$BACKUP_DIR/$manifest_name"

cleanup() {
  rm -f "$snapshot_path"
}
trap cleanup EXIT

# VACUUM INTO creates a consistent SQLite snapshot while the service remains
# online, including any pending WAL changes. The target is on the persistent
# host bind mount, but the command executes inside the non-root runtime.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e "REWIND_SNAPSHOT_PATH=/var/lib/rewind/$snapshot_name" runtime \
  node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const target = process.env.REWIND_SNAPSHOT_PATH; const escaped = target.replaceAll(String.fromCharCode(39), String.fromCharCode(39, 39)); const db = new DatabaseSync('/var/lib/rewind/rewind.sqlite', { readOnly: true }); db.exec('VACUUM INTO ' + String.fromCharCode(39) + escaped + String.fromCharCode(39)); db.close();"

gzip -9 -c "$snapshot_path" > "$archive_path"
tar -C "$MEDIA_DIR" -czf "$media_archive_path" .

db_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
media_sha256="$(sha256sum "$media_archive_path" | awk '{print $1}')"
db_bytes="$(wc -c < "$archive_path" | tr -d ' ')"
media_bytes="$(wc -c < "$media_archive_path" | tr -d ' ')"
printf '{"created_at":"%s","database":{"key":"%s/%s","sha256":"%s","bytes":%s},"media":{"key":"%s/%s","sha256":"%s","bytes":%s}}\n' \
  "$stamp" "$REWIND_BACKUP_PREFIX" "$archive_name" "$db_sha256" "$db_bytes" \
  "$REWIND_BACKUP_PREFIX" "$media_archive_name" "$media_sha256" "$media_bytes" \
  > "$manifest_path"

AWS_PROFILE="$AWS_PROFILE" aws s3 cp "$archive_path" \
  "s3://${REWIND_BACKUP_BUCKET}/${REWIND_BACKUP_PREFIX}/${archive_name}" \
  --sse AES256 --only-show-errors
AWS_PROFILE="$AWS_PROFILE" aws s3 cp "$media_archive_path" \
  "s3://${REWIND_BACKUP_BUCKET}/${REWIND_BACKUP_PREFIX}/${media_archive_name}" \
  --sse AES256 --only-show-errors
AWS_PROFILE="$AWS_PROFILE" aws s3 cp "$manifest_path" \
  "s3://${REWIND_BACKUP_BUCKET}/${REWIND_BACKUP_PREFIX}/${manifest_name}" \
  --sse AES256 --only-show-errors

# Keep only a short local recovery window; S3 lifecycle handles the remote
# demo retention policy.
find "$BACKUP_DIR" -type f -name 'rewind-*' \
  -mtime "+$RETENTION_DAYS" -delete
echo "Uploaded manifest s3://${REWIND_BACKUP_BUCKET}/${REWIND_BACKUP_PREFIX}/${manifest_name}"
