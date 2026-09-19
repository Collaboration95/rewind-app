#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
PREFLIGHT="$REPO_ROOT/deploy/preflight.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rewind-host-preflight.XXXXXX")"
FAKE_BIN="$TEST_ROOT/bin"
HOST_DEPLOY="$TEST_ROOT/deploy"
ORIGINAL_PATH="$PATH"

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN" "$HOST_DEPLOY" "$TEST_ROOT/data" "$TEST_ROOT/media" "$TEST_ROOT/backups"
cp "$REPO_ROOT/deploy/compose.yaml" "$TEST_ROOT/compose.yaml"
cp "$REPO_ROOT/deploy/rewind.env.example" "$TEST_ROOT/rewind.env"
for artifact in backup.sh backup-manifest.sh restore.sh pause-host.sh rewind-backup.service rewind-backup.timer; do
  cp "$REPO_ROOT/deploy/$artifact" "$HOST_DEPLOY/$artifact"
done
chmod 0750 "$HOST_DEPLOY/backup.sh" "$HOST_DEPLOY/backup-manifest.sh" "$HOST_DEPLOY/restore.sh" "$HOST_DEPLOY/pause-host.sh"

cat > "$FAKE_BIN/docker" <<'EOF'
#!/bin/sh
mode=
for argument in "$@"; do
  case "$argument" in
    config) mode=config ;;
    ps) mode=ps ;;
  esac
done
case "$mode" in
  config) exit 0 ;;
  ps) printf 'runtime\n' ; exit 0 ;;
  *) exit 1 ;;
esac
EOF

cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/sh
output=
for argument in "$@"; do
  if [ "${previous:-}" = '--output' ]; then
    output=$argument
  fi
  previous=$argument
done
[ -n "$output" ] || exit 2
case "${PREFLIGHT_HEALTH_MODE:-ready}" in
  unreachable) exit 7 ;;
  failed)
    printf '%s\n' '{"ok":false,"ready":false,"checks":{"schema":{"ready":false,"missingMigrationKeys":["fixture-migration"]}}}' > "$output"
    printf '503'
    ;;
  *)
    printf '%s\n' '{"ok":true,"ready":true,"checks":{"schema":{"ready":true,"missingMigrationKeys":[]}}}' > "$output"
    printf '200'
    ;;
esac
EOF

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/bin/sh
case "$1" in
  is-enabled)
    [ "${PREFLIGHT_TIMER_MODE:-ready}" != missing ]
    ;;
  is-active)
    [ "${PREFLIGHT_TIMER_MODE:-ready}" = ready ]
    ;;
  *) exit 1 ;;
esac
EOF

# The production contract is UID 10001. The fake stat keeps this fixture
# independent of the developer's host UID while exercising owner rejection.
cat > "$FAKE_BIN/stat" <<'EOF'
#!/bin/sh
format=$2
case "$format" in
  %u)
    if [ "${PREFLIGHT_OWNER_MODE:-ready}" = wrong ]; then
      printf '501\n'
    else
      printf '10001\n'
    fi
    ;;
  %a) printf '750\n' ;;
  *) exit 1 ;;
esac
EOF
chmod 0755 "$FAKE_BIN/docker" "$FAKE_BIN/curl" "$FAKE_BIN/systemctl" "$FAKE_BIN/stat"

run_preflight() {
  local env_file="${ENV_FILE:-$TEST_ROOT/rewind.env}"
  ENV_FILE="$env_file" \
    COMPOSE_FILE="$TEST_ROOT/compose.yaml" \
    DEPLOY_DIR="$HOST_DEPLOY" \
    DATA_DIR="$TEST_ROOT/data" \
    MEDIA_DIR="$TEST_ROOT/media" \
    BACKUP_DIR="$TEST_ROOT/backups" \
    PATH="$FAKE_BIN:$ORIGINAL_PATH" \
    "$PREFLIGHT" "$@"
}

assert_json_check() {
  local json=$1
  local id=$2
  local expected=$3
  local reason=$4
  jq -e --arg id "$id" --argjson expected "$expected" --arg reason "$reason" \
    '(.checks[] | select(.id == $id) | .ok == $expected and .reason == $reason)' <<<"$json" >/dev/null
}

healthy_json="$(run_preflight --json)"
jq -e '.version == 1 and .ok == true and (.checks | length == 7)' <<<"$healthy_json" >/dev/null
for check in config persistent_paths runtime migration backup_tooling pause_script backup_timer; do
  assert_json_check "$healthy_json" "$check" true ok
done
[[ "$healthy_json" != *"$TEST_ROOT"* ]]
[[ "$healthy_json" != *"rewind-demo-backups-330599756236"* ]]

healthy_human="$(run_preflight)"
grep -Fxq 'Rewind hosted-runtime preflight v1' <<<"$healthy_human"
grep -Fxq 'READY: host is eligible for backup, pause, or recovery.' <<<"$healthy_human"

set +e
absent_env_json="$(ENV_FILE="$TEST_ROOT/missing.env" run_preflight --json 2>/dev/null)"
absent_env_status=$?
set -e
[[ "$absent_env_status" -ne 0 ]]
jq -e '.ok == false' <<<"$absent_env_json" >/dev/null
assert_json_check "$absent_env_json" config false missing

set +e
stale_timer_json="$(PREFLIGHT_TIMER_MODE=missing run_preflight --json 2>/dev/null)"
stale_timer_status=$?
set -e
[[ "$stale_timer_status" -ne 0 ]]
assert_json_check "$stale_timer_json" backup_timer false not_enabled

set +e
inactive_timer_json="$(PREFLIGHT_TIMER_MODE=stale run_preflight --json 2>/dev/null)"
inactive_timer_status=$?
set -e
[[ "$inactive_timer_status" -ne 0 ]]
assert_json_check "$inactive_timer_json" backup_timer false not_active

set +e
failed_health_json="$(PREFLIGHT_HEALTH_MODE=failed run_preflight --json 2>/dev/null)"
failed_health_status=$?
set -e
[[ "$failed_health_status" -ne 0 ]]
assert_json_check "$failed_health_json" runtime false unhealthy
assert_json_check "$failed_health_json" migration false not_ready

set +e
wrong_owner_json="$(PREFLIGHT_OWNER_MODE=wrong run_preflight --json 2>/dev/null)"
wrong_owner_status=$?
set -e
[[ "$wrong_owner_status" -ne 0 ]]
assert_json_check "$wrong_owner_json" persistent_paths false wrong_owner

printf 'host preflight fixture tests passed\n'
