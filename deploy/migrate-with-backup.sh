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

usage() {
  printf 'Usage: %s --confirm\n' "$(basename "$0")" >&2
  printf '%s\n' 'Back up an existing data set, stop the runtime, and run the server additive migration.' >&2
}

[[ $# -eq 1 ]] || { usage; exit 2; }
require_confirmation --confirm "$1"

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
require_regular_file "SQLite database" "$DATA_DIR/rewind.sqlite"
require_compose_prerequisites
require_runtime_running

ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" DATA_DIR="$DATA_DIR" \
  MEDIA_DIR="$MEDIA_DIR" BACKUP_DIR="$BACKUP_DIR" "$SCRIPT_DIR/backup.sh"

compose stop runtime
compose run --rm runtime migrate
printf '%s\n' 'Migration finished successfully. The runtime is still stopped; inspect the result and start it explicitly with compose up -d.'
