#!/usr/bin/env bash
# One-time setup of the hosted PostgreSQL roles (#261).
#
# Reads REWIND_DATABASE_ADMIN_URL, REWIND_DATABASE_APP_PASSWORD and
# REWIND_DATABASE_READONLY_PASSWORD as KEY=VALUE lines on standard input
# (streamed from `terraform output`), so the admin login never lands on disk
# or in a process list. Creates the app role that owns the `rewind` schema and
# the read-only role used by backups and operators. Safe to rerun.
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

allowed=' REWIND_DATABASE_ADMIN_URL REWIND_DATABASE_APP_PASSWORD REWIND_DATABASE_READONLY_PASSWORD '
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  key="${line%%=*}"
  [[ "$line" == *=* && "$allowed" == *" $key "* ]] || die "unexpected setting $key"
  export "$key=${line#*=}"
done
: "${REWIND_DATABASE_ADMIN_URL:?missing on standard input}"
: "${REWIND_DATABASE_APP_PASSWORD:?missing on standard input}"
: "${REWIND_DATABASE_READONLY_PASSWORD:?missing on standard input}"

compose run --rm --no-deps -T \
  -e REWIND_DATABASE_ADMIN_URL -e REWIND_DATABASE_APP_PASSWORD -e REWIND_DATABASE_READONLY_PASSWORD \
  -e REWIND_DATABASE_URL= \
  runtime database-bootstrap
