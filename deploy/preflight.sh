#!/usr/bin/env bash
# Read-only eligibility gate for backup, pause, and recovery operations.
#
# The JSON contract intentionally contains only stable identifiers, booleans,
# and reason codes. Never add environment values, host paths, command output,
# or cloud object names to it.
set -Eeuo pipefail
umask 077

ENV_FILE="${ENV_FILE:-/srv/rewind/rewind.env}"
COMPOSE_FILE="${COMPOSE_FILE:-/srv/rewind/deploy/compose.yaml}"
DEPLOY_DIR="${DEPLOY_DIR:-/srv/rewind/deploy}"
DATA_DIR="${DATA_DIR:-/srv/rewind/data}"
MEDIA_DIR="${MEDIA_DIR:-/srv/rewind/media}"
BACKUP_DIR="${BACKUP_DIR:-/srv/rewind/backups}"
RUNTIME_URL="${RUNTIME_URL:-http://127.0.0.1:8787/health}"
EXPECTED_RUNTIME_UID=10001

JSON=0
if [[ "${1:-}" == "--json" ]]; then
  JSON=1
  shift
fi
if [[ "$#" -ne 0 ]]; then
  printf 'Usage: %s [--json]\n' "$(basename "$0")" >&2
  exit 2
fi

CHECK_IDS=()
CHECK_OK=()
CHECK_REASONS=()
CHECK_MESSAGES=()

CHECK_REASON='internal_error'
CHECK_MESSAGE='The check could not be completed.'

record_check() {
  CHECK_IDS+=("$1")
  CHECK_OK+=("$2")
  CHECK_REASONS+=("$3")
  CHECK_MESSAGES+=("$4")
}

run_check() {
  local id="$1"
  shift
  CHECK_REASON='internal_error'
  CHECK_MESSAGE='The check could not be completed.'
  if "$@"; then
    record_check "$id" true ok "$CHECK_MESSAGE"
  else
    record_check "$id" false "$CHECK_REASON" "$CHECK_MESSAGE"
  fi
}

safe_regular_file() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]]
}

safe_directory() {
  local path="$1"
  [[ -d "$path" && ! -L "$path" ]]
}

absolute_nonempty_path() {
  local path="$1"
  [[ "$path" == /* && "$path" != *$'\n'* && "$path" != *$'\r'* ]]
}

configured_key() {
  local key="$1"
  local pattern
  pattern="^[[:space:]]*${key}=[^[:space:]#]+([[:space:]]*#.*)?$"
  grep -Eq "$pattern" "$ENV_FILE"
}

stat_value() {
  local format="$1"
  local path="$2"
  stat -c "$format" "$path" 2>/dev/null || stat -f "$format" "$path" 2>/dev/null
}

check_config() {
  if ! safe_regular_file "$ENV_FILE"; then
    CHECK_REASON='missing'
    CHECK_MESSAGE='The runtime environment file is missing or is not a regular file.'
    return 1
  fi
  if ! safe_regular_file "$COMPOSE_FILE"; then
    CHECK_REASON='missing'
    CHECK_MESSAGE='The Compose definition is missing or is not a regular file.'
    return 1
  fi
  if ! configured_key REWIND_BACKUP_BUCKET; then
    CHECK_REASON='invalid'
    CHECK_MESSAGE='The backup bucket configuration is missing or empty.'
    return 1
  fi
  if ! command -v docker >/dev/null 2>&1; then
    CHECK_REASON='unavailable'
    CHECK_MESSAGE='Docker is not available to validate the Compose definition.'
    return 1
  fi
  if ! docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet >/dev/null 2>&1; then
    CHECK_REASON='invalid'
    CHECK_MESSAGE='The Compose definition could not be validated.'
    return 1
  fi
  CHECK_MESSAGE='Configuration and the Compose definition are valid.'
  return 0
}

check_persistent_paths() {
  local path
  for path in "$DATA_DIR" "$MEDIA_DIR" "$BACKUP_DIR"; do
    if ! absolute_nonempty_path "$path" || ! safe_directory "$path"; then
      CHECK_REASON='missing'
      CHECK_MESSAGE='Required persistent directories are missing or unsafe.'
      return 1
    fi
    local owner
    owner="$(stat_value '%u' "$path" || true)"
    if [[ "$owner" != "$EXPECTED_RUNTIME_UID" ]]; then
      CHECK_REASON='wrong_owner'
      CHECK_MESSAGE='Persistent directories are not owned by the non-root runtime.'
      return 1
    fi
    local mode
    mode="$(stat_value '%a' "$path" || true)"
    if [[ -z "$mode" || "$mode" =~ [2367]$ ]]; then
      CHECK_REASON='unsafe_mode'
      CHECK_MESSAGE='Persistent directories have an unsafe world-writable mode.'
      return 1
    fi
  done
  CHECK_MESSAGE='Persistent data, media, and backup directories are present and owned safely.'
  return 0
}

HEALTH_RESPONSE=''
HEALTH_HTTP_STATUS=''

check_runtime() {
  if ! command -v docker >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    CHECK_REASON='unavailable'
    CHECK_MESSAGE='Docker and curl are required to inspect runtime readiness.'
    return 1
  fi
  local services
  services="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null || true)"
  if ! grep -Fxq runtime <<<"$services"; then
    CHECK_REASON='not_running'
    CHECK_MESSAGE='The runtime service is not running.'
    return 1
  fi
  HEALTH_RESPONSE="$TMP_ROOT/health.json"
  : > "$HEALTH_RESPONSE"
  if ! HEALTH_HTTP_STATUS="$(curl --silent --show-error --connect-timeout 2 --max-time 5 \
    --output "$HEALTH_RESPONSE" --write-out '%{http_code}' "$RUNTIME_URL" 2>/dev/null)"; then
    CHECK_REASON='unreachable'
    CHECK_MESSAGE='The runtime health endpoint could not be reached.'
    return 1
  fi
  if [[ "$HEALTH_HTTP_STATUS" != 200 ]]; then
    CHECK_REASON='unhealthy'
    CHECK_MESSAGE='The runtime health endpoint did not return HTTP 200.'
    return 1
  fi
  CHECK_MESSAGE='The runtime service is running and its health endpoint is reachable.'
  return 0
}

check_migration() {
  if [[ -z "$HEALTH_RESPONSE" || ! -s "$HEALTH_RESPONSE" ]]; then
    CHECK_REASON='unavailable'
    CHECK_MESSAGE='Schema readiness could not be read from the runtime.'
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    CHECK_REASON='unavailable'
    CHECK_MESSAGE='jq is required to inspect the runtime schema readiness response.'
    return 1
  fi
  if ! jq -e '
      .ok == true and
      .ready == true and
      .checks.schema.ready == true and
      (.checks.schema.missingMigrationKeys | type == "array") and
      (.checks.schema.missingMigrationKeys | length == 0)
    ' "$HEALTH_RESPONSE" >/dev/null 2>&1; then
    CHECK_REASON='not_ready'
    CHECK_MESSAGE='The runtime schema is not fully migrated and ready.'
    return 1
  fi
  CHECK_MESSAGE='The runtime reports a complete, ready migration state.'
  return 0
}

check_backup_tooling() {
  local file
  for file in backup.sh backup-manifest.sh restore.sh rewind-backup.service rewind-backup.timer; do
    if ! safe_regular_file "$DEPLOY_DIR/$file"; then
      CHECK_REASON='missing'
      CHECK_MESSAGE='A required backup or restore artifact is missing.'
      return 1
    fi
  done
  for file in backup.sh backup-manifest.sh restore.sh; do
    if [[ ! -x "$DEPLOY_DIR/$file" ]] || ! bash -n "$DEPLOY_DIR/$file" >/dev/null 2>&1; then
      CHECK_REASON='invalid'
      CHECK_MESSAGE='A required backup or restore script is not executable and valid shell.'
      return 1
    fi
  done
  CHECK_MESSAGE='Backup, manifest-validation, restore, and timer artifacts are present.'
  return 0
}

check_pause_script() {
  if [[ ! -x "$DEPLOY_DIR/pause-host.sh" || ! -f "$DEPLOY_DIR/pause-host.sh" ]]; then
    CHECK_REASON='missing'
    CHECK_MESSAGE='The guarded pause script is missing or not executable.'
    return 1
  fi
  if ! bash -n "$DEPLOY_DIR/pause-host.sh" >/dev/null 2>&1; then
    CHECK_REASON='invalid'
    CHECK_MESSAGE='The guarded pause script is not valid shell.'
    return 1
  fi
  if ! grep -Fq 'backup.sh' "$DEPLOY_DIR/pause-host.sh"; then
    CHECK_REASON='invalid'
    CHECK_MESSAGE='The pause script is not connected to the verified backup gate.'
    return 1
  fi
  CHECK_MESSAGE='The guarded pause script is present and backup-gated.'
  return 0
}

check_backup_timer() {
  if ! command -v systemctl >/dev/null 2>&1; then
    CHECK_REASON='unavailable'
    CHECK_MESSAGE='systemctl is required to inspect the backup timer.'
    return 1
  fi
  if ! systemctl is-enabled --quiet rewind-backup.timer >/dev/null 2>&1; then
    CHECK_REASON='not_enabled'
    CHECK_MESSAGE='The backup timer is not enabled.'
    return 1
  fi
  if ! systemctl is-active --quiet rewind-backup.timer >/dev/null 2>&1; then
    CHECK_REASON='not_active'
    CHECK_MESSAGE='The backup timer is not active.'
    return 1
  fi
  CHECK_MESSAGE='The backup timer is enabled and active.'
  return 0
}

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rewind-preflight.XXXXXX")"
cleanup() {
  rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT

run_check config check_config
run_check persistent_paths check_persistent_paths
run_check runtime check_runtime
run_check migration check_migration
run_check backup_tooling check_backup_tooling
run_check pause_script check_pause_script
run_check backup_timer check_backup_timer

overall=true
for ok in "${CHECK_OK[@]}"; do
  if [[ "$ok" != true ]]; then
    overall=false
    break
  fi
done

if [[ "$JSON" == 1 ]]; then
  printf '{"version":1,"ok":%s,"checks":[' "$overall"
  for ((index = 0; index < ${#CHECK_IDS[@]}; index += 1)); do
    (( index > 0 )) && printf ','
    printf '{"id":"%s","ok":%s,"reason":"%s"}' \
      "${CHECK_IDS[$index]}" "${CHECK_OK[$index]}" "${CHECK_REASONS[$index]}"
  done
  printf ']}\n'
else
  printf 'Rewind hosted-runtime preflight v1\n'
  for ((index = 0; index < ${#CHECK_IDS[@]}; index += 1)); do
    if [[ "${CHECK_OK[$index]}" == true ]]; then
      printf 'PASS %s — %s\n' "${CHECK_IDS[$index]}" "${CHECK_MESSAGES[$index]}"
    else
      printf 'FAIL %s — %s\n' "${CHECK_IDS[$index]}" "${CHECK_MESSAGES[$index]}"
    fi
  done
  if [[ "$overall" == true ]]; then
    printf 'READY: host is eligible for backup, pause, or recovery.\n'
  else
    printf 'BLOCKED: host is not eligible for backup, pause, or recovery.\n'
  fi
fi

[[ "$overall" == true ]]
