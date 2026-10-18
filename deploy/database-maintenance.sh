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
set -a
source "$ENV_FILE"
set +a
require_database_target
resolve_installed_release
require_compose_prerequisites
case "${1:-}" in
  quiesce|quiesce-recovery)
    mode=import
    if [[ "$1" == quiesce-recovery ]]; then
      [[ -n "${REWIND_DATABASE_URL:-}" ]] || die 'recovery comparison requires PostgreSQL'
      mode=recovery
    else
      [[ -z "${REWIND_DATABASE_URL:-}" ]] || die 'import requires SQLite to remain authoritative'
    fi
    printf '%s\n' "$REWIND_MEDIA_ENVIRONMENT" > "$HOST_ROOT/database-maintenance"
    printf '%s\n' "$mode" > "$HOST_ROOT/database-maintenance-mode"
    rm -f -- "$HOST_ROOT/database-reconciled.json"
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
    rm -f -- "$HOST_ROOT/database-maintenance-mode" "$HOST_ROOT/database-reconciled.json"
    ;;
  *) die 'usage: database-maintenance.sh quiesce|resume' ;;
esac
