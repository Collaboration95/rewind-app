# Lightsail prepends its own /bin/sh user-data wrapper, so keep this fragment
# POSIX-compatible instead of relying on a second interpreter shebang.
set -eu

# The first cloud-init pass runs before the repository is copied to the host.
# wake-demo.sh invokes this same file with --complete after it has transferred
# the checked-in bundle. The REWIND_* overrides keep the whole flow testable
# against a disposable local fixture without touching /srv or /etc.
HOST_ROOT=${REWIND_HOST_ROOT:-/srv/rewind}
BUNDLE_SOURCE=${REWIND_BUNDLE_SOURCE:-$HOST_ROOT}
SYSTEMD_DIR=${REWIND_SYSTEMD_DIR:-/etc/systemd/system}
HOST_USER=${REWIND_HOST_USER:-ubuntu}
HOST_OWNER=${REWIND_HOST_OWNER:-ubuntu}
HOST_GROUP=${REWIND_HOST_GROUP:-ubuntu}
SYSTEMD_OWNER=${REWIND_SYSTEMD_OWNER:-root}
SYSTEMD_GROUP=${REWIND_SYSTEMD_GROUP:-root}
RUNTIME_OWNER=${REWIND_RUNTIME_OWNER:-10001}
RUNTIME_GROUP=${REWIND_RUNTIME_GROUP:-10001}
RUNTIME_USER=${REWIND_RUNTIME_USER:-rewind}
RUNTIME_IDENTITY_SETUP=${REWIND_RUNTIME_IDENTITY_SETUP:-1}
SKIP_APT=${REWIND_BOOTSTRAP_SKIP_APT:-0}
READY_MARKER=${REWIND_READY_MARKER:-$HOST_ROOT/.host-bootstrap-complete}
PREREQUISITE_MARKER=${REWIND_PREREQUISITE_MARKER:-$HOST_ROOT/.host-bootstrap-prerequisites}
ENV_FILE=${REWIND_ENV_FILE:-$HOST_ROOT/rewind.env}
COMPLETE=0
BOOTSTRAP_SUCCESS=0

if [ "$#" -gt 1 ]; then
  printf 'Usage: %s [--complete]\n' "$0" >&2
  exit 2
fi
if [ "$#" -eq 1 ]; then
  [ "$1" = '--complete' ] || {
    printf 'Usage: %s [--complete]\n' "$0" >&2
    exit 2
  }
  COMPLETE=1
fi

fail() {
  printf 'ERROR: host bootstrap failed: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  status=$?
  if [ "$BOOTSTRAP_SUCCESS" -ne 1 ]; then
    rm -f -- "$READY_MARKER" "$PREREQUISITE_MARKER" \
      "${READY_MARKER}.tmp.$$" "${PREREQUISITE_MARKER}.tmp.$$"
  fi
  exit "$status"
}
trap cleanup 0

# A stale ready marker must never survive a new attempt. Both marker writes
# below use a same-directory temporary file followed by rename, so readers see
# either no marker or a complete marker.
rm -f -- "$READY_MARKER" "$PREREQUISITE_MARKER" \
  "${READY_MARKER}.tmp.$$" "${PREREQUISITE_MARKER}.tmp.$$"

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    fail "required command '$1' is missing; install the host prerequisites and retry"
}

run_step() {
  label=$1
  shift
  if ! "$@"; then
    fail "$label failed; inspect the command output and retry bootstrap"
  fi
}

write_marker() {
  marker=$1
  marker_tmp="${marker}.tmp.$$"
  : > "$marker_tmp" || fail "cannot create marker '$marker'; check host-root permissions"
  chmod 0644 "$marker_tmp" || fail "cannot set marker mode for '$marker'"
  mv -f -- "$marker_tmp" "$marker" || fail "cannot publish marker '$marker'"
}

require_command install
require_command rm
require_command mv
require_command chmod

if [ "$RUNTIME_IDENTITY_SETUP" = 1 ]; then
  require_command getent
  require_command groupadd
  require_command useradd
fi

if [ "$SKIP_APT" != 1 ]; then
  require_command apt-get
  run_step 'apt-get update' apt-get update
  if ! DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    ca-certificates curl docker.io docker-compose-v2 jq rsync sqlite3; then
    fail 'installing ca-certificates, curl, docker.io, docker-compose-v2, jq, rsync, and sqlite3 failed; fix apt sources or network access and retry'
  fi
fi

for command_name in curl docker jq rsync sqlite3 usermod systemctl; do
  require_command "$command_name"
done
if ! docker compose version >/dev/null 2>&1; then
  fail 'Docker Compose is unavailable; install the docker-compose-v2 package and retry'
fi

if [ "$RUNTIME_IDENTITY_SETUP" = 1 ]; then
  if ! getent group "$RUNTIME_GROUP" >/dev/null 2>&1; then
    groupadd --system --gid "$RUNTIME_GROUP" "$RUNTIME_USER" ||
      fail "could not create the runtime group with GID '$RUNTIME_GROUP'; fix the host identity configuration and retry"
  fi
  if ! getent passwd "$RUNTIME_OWNER" >/dev/null 2>&1; then
    useradd --system --uid "$RUNTIME_OWNER" --gid "$RUNTIME_GROUP" \
      --home-dir /nonexistent --shell /usr/sbin/nologin "$RUNTIME_USER" ||
      fail "could not create the runtime user with UID '$RUNTIME_OWNER'; fix the host identity configuration and retry"
  fi
fi

if ! id "$HOST_USER" >/dev/null 2>&1; then
  fail "host user '$HOST_USER' is missing; create the expected Ubuntu user before retrying"
fi
if ! usermod -aG docker "$HOST_USER"; then
  fail "could not add '$HOST_USER' to the docker group; verify the docker group and retry"
fi
if ! systemctl enable --now docker; then
  fail 'Docker could not be enabled and started; inspect systemctl status docker and retry'
fi

run_step "create host root '$HOST_ROOT'" \
  install -d -o "$HOST_OWNER" -g "$RUNTIME_GROUP" -m 0750 "$HOST_ROOT"
run_step "create persistent data directory '$HOST_ROOT/data'" \
  install -d -o "$RUNTIME_OWNER" -g "$RUNTIME_GROUP" -m 0750 "$HOST_ROOT/data"
run_step "create persistent media directory '$HOST_ROOT/media'" \
  install -d -o "$RUNTIME_OWNER" -g "$RUNTIME_GROUP" -m 0750 "$HOST_ROOT/media"
run_step "create backup directory '$HOST_ROOT/backups'" \
  install -d -o "$RUNTIME_OWNER" -g "$RUNTIME_GROUP" -m 0770 "$HOST_ROOT/backups"

write_marker "$PREREQUISITE_MARKER"

if [ ! -d "$BUNDLE_SOURCE/deploy" ]; then
  if [ "$COMPLETE" -eq 1 ]; then
    fail "deployment bundle is missing at '$BUNDLE_SOURCE/deploy'; copy the checked-in repository to '$HOST_ROOT' and retry with --complete"
  fi
  BOOTSTRAP_SUCCESS=1
  printf 'Host prerequisites are ready. Copy the deployment bundle to %s, then run cloud-init.sh --complete.\n' "$HOST_ROOT"
  exit 0
fi

if [ "$COMPLETE" -ne 1 ]; then
  BOOTSTRAP_SUCCESS=1
  printf 'Deployment bundle detected at %s; run cloud-init.sh --complete to install it.\n' "$BUNDLE_SOURCE/deploy"
  exit 0
fi

required_bundle_files='Dockerfile README.md compose.yaml operator-common.sh backup-manifest.sh backup.sh restore.sh pause-host.sh preflight.sh migrate-with-backup.sh nginx.conf reset-with-backup.sh rewind.env.example rewind-backup.service rewind-backup.timer web.Dockerfile'
for file_name in $required_bundle_files; do
  [ -f "$BUNDLE_SOURCE/deploy/$file_name" ] ||
    fail "required deployment artifact is missing: $BUNDLE_SOURCE/deploy/$file_name; restore the complete checked-in deploy/ bundle and retry"
done

run_step "create deployment directory '$HOST_ROOT/deploy'" \
  install -d -o "$HOST_OWNER" -g "$HOST_GROUP" -m 0750 "$HOST_ROOT/deploy"

install_bundle_file() {
  file_name=$1
  mode=$2
  source_file="$BUNDLE_SOURCE/deploy/$file_name"
  target_file="$HOST_ROOT/deploy/$file_name"
  if [ "$source_file" = "$target_file" ]; then
    run_step "set mode $mode on '$target_file'" chmod "$mode" "$target_file"
  else
    run_step "install '$file_name'" \
      install -o "$HOST_OWNER" -g "$HOST_GROUP" -m "$mode" "$source_file" "$target_file"
  fi
}

for file_name in $required_bundle_files; do
  case "$file_name" in
    *.sh) install_bundle_file "$file_name" 0750 ;;
    *) install_bundle_file "$file_name" 0644 ;;
  esac
done

if [ -L "$ENV_FILE" ] || { [ -e "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; }; then
  fail "environment file '$ENV_FILE' is not a regular file; refusing to overwrite it"
fi
if [ ! -e "$ENV_FILE" ]; then
  run_step "create non-secret environment template '$ENV_FILE'" \
    install -o "$HOST_OWNER" -g "$HOST_GROUP" -m 0600 "$BUNDLE_SOURCE/deploy/rewind.env.example" "$ENV_FILE"
else
  run_step "protect environment file '$ENV_FILE'" chmod 0600 "$ENV_FILE"
fi

run_step "create systemd unit directory '$SYSTEMD_DIR'" \
  install -d -o "$SYSTEMD_OWNER" -g "$SYSTEMD_GROUP" -m 0755 "$SYSTEMD_DIR"
for unit_name in rewind-backup.service rewind-backup.timer; do
  run_step "install systemd unit '$unit_name'" \
    install -o "$SYSTEMD_OWNER" -g "$SYSTEMD_GROUP" -m 0644 \
      "$BUNDLE_SOURCE/deploy/$unit_name" "$SYSTEMD_DIR/$unit_name"
done
run_step 'reload systemd after installing Rewind units' systemctl daemon-reload
run_step 'enable the Rewind backup timer' systemctl enable --now rewind-backup.timer

[ -x "$HOST_ROOT/deploy/pause-host.sh" ] || fail 'pause-host.sh is not executable after installation'
[ -x "$HOST_ROOT/deploy/preflight.sh" ] || fail 'preflight.sh is not executable after installation'
[ -x "$HOST_ROOT/deploy/backup.sh" ] || fail 'backup.sh is not executable after installation'
[ -f "$HOST_ROOT/deploy/compose.yaml" ] || fail 'compose.yaml is missing after installation'
[ -f "$SYSTEMD_DIR/rewind-backup.service" ] || fail 'rewind-backup.service is missing after installation'
[ -f "$SYSTEMD_DIR/rewind-backup.timer" ] || fail 'rewind-backup.timer is missing after installation'

write_marker "$READY_MARKER"
BOOTSTRAP_SUCCESS=1
printf 'Host bootstrap complete: %s\n' "$READY_MARKER"
