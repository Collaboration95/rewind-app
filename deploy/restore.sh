#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/operator-common.sh"

ENV_FILE="${ENV_FILE:-/srv/rewind/rewind.env}"
COMPOSE_FILE="${COMPOSE_FILE:-/srv/rewind/deploy/compose.yaml}"
DATA_DIR="${DATA_DIR:-/srv/rewind/data}"
MEDIA_DIR="${MEDIA_DIR:-/srv/rewind/media}"
BACKUP_DIR="${BACKUP_DIR:-/srv/rewind/backups}"
RUNTIME_UID="${RUNTIME_UID:-10001}"
RUNTIME_GID="${RUNTIME_GID:-10001}"

usage() {
  printf 'Usage: %s --confirm /absolute/path/to/rewind-<timestamp>.manifest.json\n' "$(basename "$0")" >&2
  printf '%s\n' 'Verify a local database/media backup beside its manifest, then restore it.' >&2
}

[[ $# -eq 2 ]] || { usage; exit 2; }
require_confirmation --confirm "$1"
MANIFEST="$2"

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
require_safe_mutable_path "BACKUP_DIR" "$BACKUP_DIR"
BACKUP_DIR="$(canonical_directory BACKUP_DIR "$BACKUP_DIR")"
require_safe_mutable_path "BACKUP_DIR" "$BACKUP_DIR"
require_absolute_path "manifest path" "$MANIFEST"
require_regular_file "backup manifest" "$MANIFEST"

MANIFEST_DIR="$(cd -- "$(dirname -- "$MANIFEST")" && pwd -P)"
MANIFEST_NAME="$(basename -- "$MANIFEST")"
[[ "$MANIFEST_DIR" == "$BACKUP_DIR" ]] || die "The manifest must be directly inside BACKUP_DIR; copy the complete local artifact there first."
[[ "$MANIFEST_NAME" == rewind-*.manifest.json ]] || die "Manifest name must be rewind-<timestamp>.manifest.json."

require_command jq
require_command gzip
require_command tar
require_command awk
require_command mv
require_command rm
require_command chown
require_compose_prerequisites

MANIFEST_FIELDS="$(jq -er '
  if (.database.key | type) != "string" or
     (.database.sha256 | type) != "string" or
     (.database.bytes | type) != "number" or
     (.media.key | type) != "string" or
     (.media.sha256 | type) != "string" or
     (.media.bytes | type) != "number" then
    error("manifest must contain database/media key, sha256, and bytes fields")
  else
    [.database.key, .database.sha256, (.database.bytes | tostring),
     .media.key, .media.sha256, (.media.bytes | tostring)] | @tsv
  end
' "$MANIFEST")"
IFS=$'\t' read -r DATABASE_KEY DATABASE_SHA256 DATABASE_BYTES MEDIA_KEY MEDIA_SHA256 MEDIA_BYTES <<<"$MANIFEST_FIELDS"

manifest_stem="${MANIFEST_NAME%.manifest.json}"
database_name="${DATABASE_KEY##*/}"
media_name="${MEDIA_KEY##*/}"
[[ "$database_name" == "$manifest_stem.sqlite.gz" ]] || die "Database archive does not match the manifest filename."
[[ "$media_name" == "$manifest_stem.media.tar.gz" ]] || die "Media archive does not match the manifest filename."
[[ "$DATABASE_KEY" != /* && "$MEDIA_KEY" != /* ]] || die "Manifest keys must be relative object keys."
[[ "$DATABASE_KEY" != *..* && "$MEDIA_KEY" != *..* ]] || die "Manifest keys must not contain path traversal."
[[ "$DATABASE_SHA256" =~ ^[[:xdigit:]]{64}$ ]] || die "Manifest database checksum is invalid."
[[ "$MEDIA_SHA256" =~ ^[[:xdigit:]]{64}$ ]] || die "Manifest media checksum is invalid."
[[ "$DATABASE_BYTES" =~ ^[0-9]+$ && "$MEDIA_BYTES" =~ ^[0-9]+$ ]] || die "Manifest byte counts are invalid."

DATABASE_ARCHIVE="$MANIFEST_DIR/$database_name"
MEDIA_ARCHIVE="$MANIFEST_DIR/$media_name"
require_regular_file "database archive" "$DATABASE_ARCHIVE"
require_regular_file "media archive" "$MEDIA_ARCHIVE"
[[ "$(file_bytes "$DATABASE_ARCHIVE")" == "$DATABASE_BYTES" ]] || die "Database archive byte count does not match the manifest."
[[ "$(file_bytes "$MEDIA_ARCHIVE")" == "$MEDIA_BYTES" ]] || die "Media archive byte count does not match the manifest."
database_sha256_normalized="$(printf '%s' "$DATABASE_SHA256" | tr '[:upper:]' '[:lower:]')"
media_sha256_normalized="$(printf '%s' "$MEDIA_SHA256" | tr '[:upper:]' '[:lower:]')"
[[ "$(sha256_file "$DATABASE_ARCHIVE")" == "$database_sha256_normalized" ]] || die "Database archive checksum verification failed."
[[ "$(sha256_file "$MEDIA_ARCHIVE")" == "$media_sha256_normalized" ]] || die "Media archive checksum verification failed."
gzip -t -- "$DATABASE_ARCHIVE" || die "Database archive is not a valid gzip stream."

# The backup producer writes ordinary relative media paths. Reject absolute or
# parent-traversing entries before extraction, even after checksum verification.
tar -tzf "$MEDIA_ARCHIVE" | awk '
  /^\/|(^|\/)\.\.(\/|$)/ { bad = 1 }
  END { exit bad }
' || die "Media archive contains an unsafe path."
tar -tvzf "$MEDIA_ARCHIVE" | awk '
  { type = substr($1, 1, 1); if (type != "-" && type != "d") bad = 1 }
  END { exit bad }
' || die "Media archive contains a non-regular or non-directory entry."

if [[ "$(id -u)" != 0 ]]; then
  require_command sudo
  sudo -n -v >/dev/null 2>&1 || die "Restore must run as root or with passwordless sudo so restored files can be owned by UID:GID ${RUNTIME_UID}:${RUNTIME_GID}."
fi

restore_tmp="$(mktemp -d "$BACKUP_DIR/.rewind-restore.XXXXXX")"
rollback_dir=""
restore_started=0
restore_complete=0
previous_media_moved=0

rollback_restore() {
  local status=$?
  set +e
  if [[ "$restore_started" == 1 && "$restore_complete" == 0 && -n "$rollback_dir" ]]; then
    rm -f -- "$DATA_DIR/rewind.sqlite" "$DATA_DIR/rewind.sqlite-wal" "$DATA_DIR/rewind.sqlite-shm"
    if [[ "$previous_media_moved" == 1 ]]; then
      find "$MEDIA_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null
    fi
    find "$rollback_dir/data" -mindepth 1 -maxdepth 1 -exec mv -- {} "$DATA_DIR/" \; 2>/dev/null
    find "$rollback_dir/media" -mindepth 1 -maxdepth 1 -exec mv -- {} "$MEDIA_DIR/" \; 2>/dev/null
    printf 'Restore failed; previous files were moved back where possible. Recovery copy: %s\n' "$rollback_dir" >&2
  fi
  rm -rf -- "$restore_tmp"
  exit "$status"
}
trap rollback_restore EXIT

gzip -dc -- "$DATABASE_ARCHIVE" > "$restore_tmp/rewind.sqlite"
[[ -s "$restore_tmp/rewind.sqlite" ]] || die "Restored database archive is empty."
mkdir -- "$restore_tmp/media"
tar -xzf "$MEDIA_ARCHIVE" -C "$restore_tmp/media" --no-same-owner --no-same-permissions

compose stop runtime
rollback_dir="$BACKUP_DIR/rewind-pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -- "$rollback_dir" "$rollback_dir/data" "$rollback_dir/media"
restore_started=1

for path in "$DATA_DIR/rewind.sqlite" "$DATA_DIR/rewind.sqlite-wal" "$DATA_DIR/rewind.sqlite-shm"; do
  if [[ -e "$path" || -L "$path" ]]; then
    mv -- "$path" "$rollback_dir/data/"
  fi
done
find "$MEDIA_DIR" -mindepth 1 -maxdepth 1 -exec mv -- {} "$rollback_dir/media/" \;
previous_media_moved=1
mv -- "$restore_tmp/rewind.sqlite" "$DATA_DIR/rewind.sqlite"
find "$restore_tmp/media" -mindepth 1 -maxdepth 1 -exec mv -- {} "$MEDIA_DIR/" \;

if [[ "$(id -u)" == 0 ]]; then
  chown "$RUNTIME_UID:$RUNTIME_GID" "$DATA_DIR/rewind.sqlite"
  chown -R "$RUNTIME_UID:$RUNTIME_GID" "$MEDIA_DIR"
else
  sudo -n chown "$RUNTIME_UID:$RUNTIME_GID" "$DATA_DIR/rewind.sqlite"
  sudo -n chown -R "$RUNTIME_UID:$RUNTIME_GID" "$MEDIA_DIR"
fi

restore_complete=1
printf 'Restore verified and installed. Previous files remain recoverable at %s. The runtime is stopped; run compose up -d after review.\n' "$rollback_dir"
