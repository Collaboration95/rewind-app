#!/usr/bin/env bash
# Drain all runtime writers for a final SQLite snapshot, or abandon that window.
set -Eeuo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/operator-common.sh"
HOST_ROOT="${HOST_ROOT:-/srv/rewind}"
ENV_FILE="${ENV_FILE:-$HOST_ROOT/rewind.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$HOST_ROOT/deploy/compose.yaml}"
DATA_DIR="${DATA_DIR:-$HOST_ROOT/data}"
MEDIA_DIR="${MEDIA_DIR:-$HOST_ROOT/media}"
export REWIND_RELEASE_SHA="${REWIND_RELEASE_SHA:-$(cat "$HOST_ROOT/current-release")}"
set -a
source "$ENV_FILE"
set +a
require_database_target
require_compose_prerequisites
case "${1:-}" in
  quiesce)
    [[ -z "${REWIND_DATABASE_URL:-}" ]] || die 'import requires SQLite to remain authoritative'
    printf '%s\n' "$REWIND_MEDIA_ENVIRONMENT" > "$HOST_ROOT/database-maintenance"
    sudo -n systemctl stop rewind-backup.timer rewind-backup.service
    compose stop --timeout 120 web runtime
    require_runtime_stopped
    ;;
  resume)
    [[ -f "$HOST_ROOT/database-maintenance" ]] || die 'no database maintenance window to resume'
    [[ "$(cat "$HOST_ROOT/database-maintenance")" == "$REWIND_MEDIA_ENVIRONMENT" ]] || die 'maintenance environment mismatch'
    compose up -d runtime
    wait_for_runtime_readiness || die 'runtime is unhealthy; keep public traffic stopped'
    compose up -d web
    sudo -n systemctl enable --now rewind-backup.timer
    rm "$HOST_ROOT/database-maintenance"
    ;;
  *) die 'usage: database-maintenance.sh quiesce|resume' ;;
esac
