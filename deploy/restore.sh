#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/operator-common.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/backup-manifest.sh"

ENV_FILE="${ENV_FILE:-/srv/rewind/rewind.env}"
COMPOSE_FILE="${COMPOSE_FILE:-/srv/rewind/deploy/compose.yaml}"
DATA_DIR="${DATA_DIR:-/srv/rewind/data}"
MEDIA_DIR="${MEDIA_DIR:-/srv/rewind/media}"
BACKUP_DIR="${BACKUP_DIR:-/srv/rewind/backups}"
RUNTIME_UID="${RUNTIME_UID:-10001}"
RUNTIME_GID="${RUNTIME_GID:-10001}"

usage() {
  printf 'Usage: %s --confirm /absolute/path/to/rewind-<timestamp>.manifest.json\n' "$(basename "$0")" >&2
  printf '%s\n' 'Verify, stage, and readiness-check a local database/media backup before replacing live data.' >&2
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
require_regular_file "ENV_FILE" "$ENV_FILE"
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${REWIND_BACKUP_PREFIX:=rewind-demo}"
validate_backup_prefix "$REWIND_BACKUP_PREFIX" || exit 1

MANIFEST_DIR="$(cd -- "$(dirname -- "$MANIFEST")" && pwd -P)"
MANIFEST_NAME="$(basename -- "$MANIFEST")"
[[ "$MANIFEST_DIR" == "$BACKUP_DIR" ]] || die "The manifest must be directly inside BACKUP_DIR; copy the complete local artifact there first."
[[ "$MANIFEST_NAME" == rewind-*.manifest.json ]] || die "Manifest name must be rewind-<timestamp>.manifest.json."

require_command gzip
require_command tar
require_command awk
require_command sqlite3
require_command mv
require_command rm
require_command chown
require_compose_prerequisites

# The shared validator checks both archive metadata and the local bytes before
# the runtime is stopped or a live file is moved.
validate_backup_manifest "$MANIFEST" "$REWIND_BACKUP_PREFIX" || exit 1
verify_backup_manifest_archives "$MANIFEST_DIR" || exit 1

database_name="$BACKUP_MANIFEST_DATABASE_NAME"
media_name="$BACKUP_MANIFEST_MEDIA_NAME"
DATABASE_ARCHIVE="$MANIFEST_DIR/$database_name"
MEDIA_ARCHIVE="$MANIFEST_DIR/$media_name"
gzip -t -- "$DATABASE_ARCHIVE" || die "Database archive is not a valid gzip stream."

# The backup producer writes ordinary relative media paths. Reject absolute,
# parent-traversing, symlink, hard-link, and device entries before extraction.
tar -tzf "$MEDIA_ARCHIVE" | awk '
  $0 ~ /^\// || $0 ~ /(^|\/)\.\.(\/|$)/ { bad = 1 }
  END { exit bad }
' || die "Media archive contains an unsafe path."
tar -tvzf "$MEDIA_ARCHIVE" | awk '
  { type = substr($1, 1, 1); if (type != "-" && type != "d") bad = 1 }
  END { exit bad }
' || die "Media archive contains a non-regular or non-directory entry."

if [[ "$(id -u)" != 0 ]]; then
  require_command sudo
  sudo -n -v >/dev/null 2>&1 || die 'Restore requires the approved host privilege for the persistent ownership contract.'
fi

restore_tmp="$(mktemp -d "$BACKUP_DIR/.rewind-restore.XXXXXX")"
stage_media="$restore_tmp/media"
rollback_dir=""
restore_started=0
replacement_started=0
runtime_stopped=0
runtime_start_attempted=0
restore_applied=0
restore_complete=0

restore_failure_cleanup() {
  local status=$?
  local rollback_ok=1
  local rollback_note=''
  set +e

  if [[ "$restore_complete" == 1 ]]; then
    rm -rf -- "$restore_tmp" || true
    exit "$status"
  fi

  if [[ "$restore_applied" == 1 ]]; then
    # The live restore passed readiness. Do not stop or roll it back merely
    # because cleanup failed; retain and report whichever private material is
    # still present for a later operator cleanup.
    if [[ -n "$rollback_dir" && -e "$rollback_dir" ]]; then
      printf 'Restore applied, but rollback cleanup failed; recovery copy: %s\n' "$rollback_dir" >&2
    elif [[ -e "$restore_tmp" ]]; then
      printf 'Restore applied, but staging cleanup failed; staging copy: %s\n' "$restore_tmp" >&2
    else
      printf 'Restore applied, but temporary cleanup failed; inspect the backup directory.\n' >&2
    fi
    exit "$status"
  fi

  # A failed readiness or permission check can occur after the new files are
  # visible. Stop the new runtime before removing those files.
  if [[ "$runtime_start_attempted" == 1 ]]; then
    compose stop runtime >/dev/null 2>&1 || {
      rollback_ok=0
      rollback_note='could not stop the runtime before rollback'
    }
  fi

  if [[ "$replacement_started" == 1 ]]; then
    remove_children "$MEDIA_DIR" || {
      rollback_ok=0
      rollback_note='could not remove partial restored media'
    }
    rm -f -- "$DATA_DIR/rewind.sqlite" "$DATA_DIR/rewind.sqlite-wal" "$DATA_DIR/rewind.sqlite-shm" || {
      rollback_ok=0
      rollback_note='could not remove partial restored database files'
    }
  fi

  if [[ "$restore_started" == 1 && -n "$rollback_dir" ]]; then
    move_children "$rollback_dir/data" "$DATA_DIR" || {
      rollback_ok=0
      rollback_note='could not restore the previous database files'
    }
    move_children "$rollback_dir/media" "$MEDIA_DIR" || {
      rollback_ok=0
      rollback_note='could not restore the previous media tree'
    }
    if [[ "$rollback_ok" == 1 ]] && ! directory_empty "$rollback_dir/data"; then
      rollback_ok=0
      rollback_note='database rollback directory is not empty'
    fi
    if [[ "$rollback_ok" == 1 ]] && ! directory_empty "$rollback_dir/media"; then
      rollback_ok=0
      rollback_note='media rollback directory is not empty'
    fi
  fi

  # A readiness failure happened after the replacement was exposed. Once the
  # old files are back, bring the previously healthy runtime back as well; a
  # successful rollback must leave the fixture usable, not merely intact.
  if [[ "$rollback_ok" == 1 && "$runtime_stopped" == 1 ]]; then
    compose up -d runtime >/dev/null 2>&1 || {
      rollback_ok=0
      rollback_note='could not restart the previous runtime'
    }
    if [[ "$rollback_ok" == 1 ]] && ! wait_for_runtime_readiness >/dev/null 2>&1; then
      rollback_ok=0
      rollback_note='the previous runtime did not become healthy after rollback'
    fi
  fi

  rm -rf -- "$restore_tmp" || {
    rollback_ok=0
    rollback_note='could not remove the staging directory'
  }

  if [[ "$rollback_ok" == 1 && -n "$rollback_dir" ]]; then
    rm -rf -- "$rollback_dir" || {
      rollback_ok=0
      rollback_note='could not remove the empty rollback directory'
    }
  fi

  if [[ "$rollback_ok" == 1 ]]; then
    printf 'Restore failed; the previous SQLite/media state was restored and staging was cleaned.\n' >&2
  else
    printf 'Restore failed and rollback needs operator attention (%s); recovery copy: %s\n' \
      "${rollback_note:-inspect the recovery directory}" "$rollback_dir" >&2
  fi
  exit "$status"
}
trap restore_failure_cleanup EXIT

mkdir -- "$stage_media"
gzip -dc -- "$DATABASE_ARCHIVE" > "$restore_tmp/rewind.sqlite"
[[ -s "$restore_tmp/rewind.sqlite" ]] || die "Restored database archive is empty."

# SQLite's header is not enough: integrity_check catches corrupt pages and
# foreign_key_check catches a damaged relational snapshot before any swap.
database_integrity="$(sqlite3 -batch -noheader -readonly "$restore_tmp/rewind.sqlite" 'PRAGMA integrity_check;' 2>/dev/null)" || \
  die "Restored database could not be opened for integrity validation."
[[ "$database_integrity" == 'ok' ]] || die "Restored database integrity validation failed."
foreign_key_errors="$(sqlite3 -batch -noheader -readonly "$restore_tmp/rewind.sqlite" 'PRAGMA foreign_key_check;' 2>/dev/null)" || \
  die "Restored database foreign-key validation failed."
[[ -z "$foreign_key_errors" ]] || die "Restored database contains foreign-key violations."

tar -xzf "$MEDIA_ARCHIVE" -C "$stage_media" --no-same-owner --no-same-permissions || \
  die "Media archive extraction failed; live media was not changed."
unsupported_entry="$(find "$stage_media" \( -type l -o -type b -o -type c -o -type p \) -print -quit)"
if [[ -n "$unsupported_entry" ]]; then
  die "Extracted media contains an unsupported filesystem entry."
fi

# Permissions are prepared entirely in staging. A chown/chmod failure therefore
# cannot expose a half-owned live tree.
prepare_restore_tree "$restore_tmp/rewind.sqlite" || die "Could not set restored database ownership or permissions."
prepare_restore_tree "$stage_media" || die "Could not set restored media ownership or permissions."
run_as_runtime test -r "$restore_tmp/rewind.sqlite" || die "Restored database is not readable by the runtime UID."
run_as_runtime test -r "$stage_media" || die "Restored media directory is not readable by the runtime UID."
run_as_runtime test -w "$stage_media" || die "Restored media directory is not writable by the runtime UID."

# No live mutation occurs until both archives, SQLite, extraction, and staged
# ownership/access checks have passed.
compose stop runtime || die "Could not stop the runtime before restore."
runtime_stopped=1
restore_tmp_rollback="$(mktemp -d "$BACKUP_DIR/.rewind-rollback.XXXXXX")"
rollback_dir="$restore_tmp_rollback"
mkdir -- "$rollback_dir/data" "$rollback_dir/media"
restore_started=1

move_path_if_present "$DATA_DIR/rewind.sqlite" "$rollback_dir/data" || die "Could not stage the previous database."
move_path_if_present "$DATA_DIR/rewind.sqlite-wal" "$rollback_dir/data" || die "Could not stage the previous database WAL."
move_path_if_present "$DATA_DIR/rewind.sqlite-shm" "$rollback_dir/data" || die "Could not stage the previous database shared memory file."
move_children "$MEDIA_DIR" "$rollback_dir/media" || die "Could not stage the previous media tree."

replacement_started=1
mv -- "$restore_tmp/rewind.sqlite" "$DATA_DIR/rewind.sqlite" || die "Could not install the staged database."
move_children "$stage_media" "$MEDIA_DIR" || die "Could not install the staged media tree."

run_as_runtime test -r "$DATA_DIR/rewind.sqlite" || die "Restored database readiness failed after replacement."
run_as_runtime test -w "$DATA_DIR" || die "Restored database directory is not writable by the runtime."
run_as_runtime test -r "$MEDIA_DIR" || die "Restored media readiness failed after replacement."
run_as_runtime test -w "$MEDIA_DIR" || die "Restored media write readiness failed after replacement."
assert_persistent_tree_contract "$DATA_DIR" 'SQLite data' || die 'Restored SQLite ownership contract failed.'
assert_persistent_tree_contract "$MEDIA_DIR" 'media' || die 'Restored media ownership contract failed.'

runtime_start_attempted=1
compose up -d runtime || die "Could not start the runtime for the restore readiness check."
wait_for_runtime_readiness || die "Restored runtime readiness check failed."

restore_applied=1
if ! rm -rf -- "$rollback_dir"; then
  printf 'Restore is healthy, but rollback cleanup failed; recovery copy: %s\n' "$rollback_dir" >&2
  exit 1
fi
rollback_dir=''
if ! rm -rf -- "$restore_tmp"; then
  printf 'Restore is healthy, but staging cleanup failed; staging copy: %s\n' "$restore_tmp" >&2
  exit 1
fi
restore_complete=1
printf 'Restore verified and installed atomically for the stopped-and-restarted runtime; previous state and staging were cleaned.\n'
