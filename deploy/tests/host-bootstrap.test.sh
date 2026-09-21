#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
BOOTSTRAP="$REPO_ROOT/infra/terraform/demo/cloud-init.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rewind-host-bootstrap.XXXXXX")"
FAKE_BIN="$TEST_ROOT/bin"
SYSTEMD_DIR="$TEST_ROOT/etc/systemd/system"
ORIGINAL_PATH="$PATH"
TEST_USER="$(id -un)"
TEST_GROUP="$(id -gn)"
TEST_UID="$(id -u)"
TEST_GID="$(id -g)"
SYSTEMCTL_LOG="$TEST_ROOT/systemctl.log"

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN" "$SYSTEMD_DIR"
grep -Fq 'docker-compose-v2 jq rsync sqlite3' "$BOOTSTRAP"
grep -Fq 'groupadd --system --gid' "$BOOTSTRAP"
grep -Fq 'useradd --system --uid' "$BOOTSTRAP"
cat > "$FAKE_BIN/usermod" <<'EOF'
#!/bin/sh
printf 'usermod %s\n' "$*" >> "$REWIND_SYSTEMCTL_LOG"
EOF
cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$REWIND_SYSTEMCTL_LOG"
if [ "${FAKE_SYSTEMCTL_STATUS:-0}" -ne 0 ]; then
  exit "$FAKE_SYSTEMCTL_STATUS"
fi
EOF
chmod 0755 "$FAKE_BIN/usermod" "$FAKE_BIN/systemctl"

bootstrap() {
  local host_root=$1
  local source_root=$2
  local mode=${3:-complete}
  if [[ "$mode" == complete ]]; then
    REWIND_HOST_ROOT="$host_root" \
      REWIND_BUNDLE_SOURCE="$source_root" \
      REWIND_SYSTEMD_DIR="$SYSTEMD_DIR" \
      REWIND_ENV_FILE="$host_root/rewind.env" \
      REWIND_HOST_USER="$TEST_USER" \
      REWIND_HOST_OWNER="$TEST_UID" \
      REWIND_HOST_GROUP="$TEST_GID" \
      REWIND_SYSTEMD_OWNER="$TEST_UID" \
      REWIND_SYSTEMD_GROUP="$TEST_GID" \
      REWIND_RUNTIME_OWNER="$TEST_UID" \
      REWIND_RUNTIME_GROUP="$TEST_GID" \
      REWIND_RUNTIME_IDENTITY_SETUP=0 \
      REWIND_BOOTSTRAP_SKIP_APT=1 \
      REWIND_SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
      PATH="$FAKE_BIN:$ORIGINAL_PATH" \
      sh "$BOOTSTRAP" --complete
  else
    REWIND_HOST_ROOT="$host_root" \
      REWIND_BUNDLE_SOURCE="$source_root" \
      REWIND_SYSTEMD_DIR="$SYSTEMD_DIR" \
      REWIND_ENV_FILE="$host_root/rewind.env" \
      REWIND_HOST_USER="$TEST_USER" \
      REWIND_HOST_OWNER="$TEST_UID" \
      REWIND_HOST_GROUP="$TEST_GID" \
      REWIND_SYSTEMD_OWNER="$TEST_UID" \
      REWIND_SYSTEMD_GROUP="$TEST_GID" \
      REWIND_RUNTIME_OWNER="$TEST_UID" \
      REWIND_RUNTIME_GROUP="$TEST_GID" \
      REWIND_RUNTIME_IDENTITY_SETUP=0 \
      REWIND_BOOTSTRAP_SKIP_APT=1 \
      REWIND_SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
      PATH="$FAKE_BIN:$ORIGINAL_PATH" \
      sh "$BOOTSTRAP"
  fi
}

assert_file() {
  [[ -f "$1" ]] || {
    printf 'Expected file is missing: %s\n' "$1" >&2
    exit 1
  }
}

assert_mode() {
  local expected=$1
  local path=$2
  local actual
  if stat -c '%a' "$path" >/dev/null 2>&1; then
    actual="$(stat -c '%a' "$path")"
  else
    actual="$(stat -f '%Lp' "$path")"
  fi
  [[ "$actual" == "$expected" ]] || {
    printf 'Expected mode %s for %s, got %s\n' "$expected" "$path" "$actual" >&2
    exit 1
  }
}

initial_root="$TEST_ROOT/initial"
bootstrap "$initial_root" "$TEST_ROOT/no-bundle" initial
assert_file "$initial_root/.host-bootstrap-prerequisites"
[[ ! -e "$initial_root/.host-bootstrap-complete" ]]

fixture_root="$TEST_ROOT/fixture"
bootstrap "$fixture_root" "$REPO_ROOT"
assert_file "$fixture_root/.host-bootstrap-complete"
assert_file "$fixture_root/.host-bootstrap-prerequisites"
assert_file "$fixture_root/rewind.env"
assert_mode 600 "$fixture_root/rewind.env"

for artifact in Dockerfile README.md compose.yaml operator-common.sh backup-manifest.sh backup.sh pause-host.sh preflight.sh migrate-with-backup.sh nginx.conf reset-with-backup.sh restore.sh rewind.env.example rewind-backup.service rewind-backup.timer web.Dockerfile; do
  assert_file "$fixture_root/deploy/$artifact"
done
for executable in operator-common.sh backup-manifest.sh backup.sh restore.sh pause-host.sh preflight.sh migrate-with-backup.sh reset-with-backup.sh; do
  [[ -x "$fixture_root/deploy/$executable" ]]
done
assert_file "$SYSTEMD_DIR/rewind-backup.service"
assert_file "$SYSTEMD_DIR/rewind-backup.timer"
assert_mode 644 "$SYSTEMD_DIR/rewind-backup.service"
assert_mode 644 "$SYSTEMD_DIR/rewind-backup.timer"

same_root="$TEST_ROOT/same-root"
rsync -a --exclude '.git/' --exclude 'node_modules/' --exclude 'rewind.env' \
  "$REPO_ROOT/" "$same_root/"
bootstrap "$same_root" "$same_root"
assert_file "$same_root/.host-bootstrap-complete"
assert_file "$same_root/deploy/pause-host.sh"

printf 'persistent fixture data\n' > "$fixture_root/data/sentinel.txt"
printf 'REWIND_BACKUP_BUCKET=fixture-bucket\n' > "$fixture_root/rewind.env"
chmod 0600 "$fixture_root/rewind.env"
before_checksum="$(shasum -a 256 "$fixture_root/deploy/compose.yaml" | awk '{print $1}')"

bootstrap "$fixture_root" "$REPO_ROOT"
[[ "$(cat "$fixture_root/data/sentinel.txt")" == 'persistent fixture data' ]]
grep -Fxq 'REWIND_BACKUP_BUCKET=fixture-bucket' "$fixture_root/rewind.env"
after_checksum="$(shasum -a 256 "$fixture_root/deploy/compose.yaml" | awk '{print $1}')"
[[ "$before_checksum" == "$after_checksum" ]]
assert_file "$fixture_root/.host-bootstrap-complete"

failure_root="$TEST_ROOT/failure"
set +e
failure_output="$(bootstrap "$failure_root" "$TEST_ROOT/missing-bundle" complete 2>&1)"
failure_status=$?
set -e
[[ "$failure_status" -ne 0 ]]
grep -Fq "deployment bundle is missing" <<<"$failure_output"
[[ ! -e "$failure_root/.host-bootstrap-complete" ]]
[[ ! -e "$failure_root/.host-bootstrap-prerequisites" ]]

printf 'host bootstrap fixture tests passed\n'
