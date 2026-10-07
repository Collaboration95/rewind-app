#!/usr/bin/env bash
# Print the hosted PostgreSQL database's readiness and row counts as JSON
# (#261, #172), using the read-only role.
#
#   database-status.sh [--endpoint HOST:PORT]
#
# --endpoint checks another server with the same logins, such as a
# point-in-time restore rehearsal; by default the live database is checked.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/operator-common.sh"

HOST_ROOT="${HOST_ROOT:-/srv/rewind}"
ENV_FILE="${ENV_FILE:-$HOST_ROOT/rewind.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$HOST_ROOT/deploy/compose.yaml}"
DATA_DIR="${DATA_DIR:-$HOST_ROOT/data}"
MEDIA_DIR="${MEDIA_DIR:-$HOST_ROOT/media}"
export REWIND_RELEASE_SHA="${REWIND_RELEASE_SHA:-$(cat "$HOST_ROOT/current-release")}"

endpoint=''
if [[ "${1:-}" == --endpoint ]]; then
  endpoint="${2:-}"
  [[ "$endpoint" =~ ^[A-Za-z0-9.-]+:[0-9]+$ ]] || die 'The endpoint must be HOST:PORT.'
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${REWIND_DATABASE_READONLY_URL:?REWIND_DATABASE_READONLY_URL must be set (Terraform hosted settings)}"
url="$REWIND_DATABASE_READONLY_URL"
if [[ -n "$endpoint" ]]; then
  # postgres://user:password@HOST:PORT/db -> same login, other server.
  url="$(sed -E "s#@[^/]+/#@${endpoint}/#" <<<"$url")"
fi
export REWIND_DATABASE_URL="$url"
compose run --rm --no-deps -T -e REWIND_DATABASE_URL -e REWIND_DATABASE_ENVIRONMENT \
  runtime database-status --json
