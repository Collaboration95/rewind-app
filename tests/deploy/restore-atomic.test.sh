#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
RESTORE="$SCRIPT_DIR/deploy/restore.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rewind-restore-atomic.XXXXXX")"
FAKE_BIN="$TEST_ROOT/bin"
ORIGINAL_PATH="$PATH"
RUNTIME_UID="$(id -u)"
RUNTIME_GID="$(id -g)"
REAL_CHOWN="$(command -v chown)"
export REAL_CHOWN

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -- "$FAKE_BIN"

cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -u
if [[ "${1:-}" == inspect ]]; then
  health="${FAKE_HEALTH:-healthy}"
  if [[ "${FAKE_HEALTH_AFTER_FIRST:-}" == healthy ]]; then
    if [[ -e "${FAKE_HEALTH_STATE:?}" ]]; then
      health=healthy
    else
      : > "$FAKE_HEALTH_STATE"
    fi
  fi
  if [[ "$health" == healthy ]]; then
    printf 'healthy\n'
  else
    printf '%s\n' "$health"
  fi
  exit 0
fi
[[ "${1:-}" == compose ]] || exit 1
case " $* " in
  *' version '*) exit 0 ;;
  *' config '*) exit 0 ;;
  *' ps -q runtime '*) printf 'fake-runtime-container\n'; exit 0 ;;
  *' ps '*) printf 'runtime\n'; exit 0 ;;
  *' stop runtime '*) exit 0 ;;
  *' up -d runtime '*) exit 0 ;;
esac
exit 0
EOF

cat > "$FAKE_BIN/sudo" <<'EOF'
#!/usr/bin/env bash
set -u
[[ "${1:-}" == -n ]] && shift
[[ "${1:-}" == -v ]] && exit 0
if [[ "${1:-}" == -u ]]; then
  shift 2
fi
[[ "${1:-}" == -- ]] && shift
exec "$@"
EOF

cat > "$FAKE_BIN/chown" <<'EOF'
#!/usr/bin/env bash
set -u
[[ "${FAIL_CHOWN:-0}" == 1 ]] && exit 1
exec "$REAL_CHOWN" "$@"
EOF

cat > "$FAKE_BIN/tar" <<'EOF'
#!/usr/bin/env bash
set -u
for argument in "$@"; do
  if [[ "$argument" == -xzf && "${FAIL_TAR:-0}" == 1 ]]; then
    exit 1
  fi
done
exec /usr/bin/tar "$@"
EOF

chmod 0755 "$FAKE_BIN/docker" "$FAKE_BIN/sudo" "$FAKE_BIN/chown" "$FAKE_BIN/tar"

epoch_stamp() {
  local epoch="$1"
  date -u -r "$epoch" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -d "@$epoch" +%Y%m%dT%H%M%SZ
}

write_manifest() {
  local manifest="$1"
  local stamp="$2"
  local db_name="$3"
  local media_name="$4"
  local db_sha="$5"
  local media_sha="$6"
  local db_bytes="$7"
  local media_bytes="$8"
  printf '{"created_at":"%s","database":{"key":"rewind-demo/%s","sha256":"%s","bytes":%s},"media":{"key":"rewind-demo/%s","sha256":"%s","bytes":%s}}\n' \
    "$stamp" "$db_name" "$db_sha" "$db_bytes" "$media_name" "$media_sha" "$media_bytes" > "$manifest"
}

create_fixture() {
  local name="$1"
  local now stamp db_name media_name
  CASE_ROOT="$TEST_ROOT/$name"
  DATA_DIR="$CASE_ROOT/data"
  MEDIA_DIR="$CASE_ROOT/media"
  BACKUP_DIR="$CASE_ROOT/backups"
  ENV_FILE="$CASE_ROOT/rewind.env"
  COMPOSE_FILE="$CASE_ROOT/compose.yaml"
  mkdir -p "$DATA_DIR" "$MEDIA_DIR" "$BACKUP_DIR"
  chmod 0750 "$DATA_DIR" "$MEDIA_DIR"
  printf 'REWIND_BACKUP_PREFIX=rewind-demo\n' > "$ENV_FILE"
  printf 'services: {}\n' > "$COMPOSE_FILE"

  sqlite3 "$DATA_DIR/rewind.sqlite" <<'SQL'
CREATE TABLE state (value TEXT NOT NULL);
INSERT INTO state VALUES ('healthy-before');
SQL
  printf 'old-media\n' > "$MEDIA_DIR/old.txt"

  now="$(date -u +%s)"
  stamp="$(epoch_stamp "$now")"
  db_name="rewind-${stamp}.sqlite.gz"
  media_name="rewind-${stamp}.media.tar.gz"
  MANIFEST="$BACKUP_DIR/rewind-${stamp}.manifest.json"
  sqlite3 "$CASE_ROOT/new.sqlite" <<'SQL'
CREATE TABLE state (value TEXT NOT NULL);
INSERT INTO state VALUES ('healthy-after');
SQL
  gzip -c "$CASE_ROOT/new.sqlite" > "$BACKUP_DIR/$db_name"
  mkdir -- "$CASE_ROOT/new-media"
  printf 'new-media\n' > "$CASE_ROOT/new-media/new.txt"
  tar -C "$CASE_ROOT/new-media" -czf "$BACKUP_DIR/$media_name" .
  DB_BYTES="$(wc -c < "$BACKUP_DIR/$db_name" | tr -d '[:space:]')"
  MEDIA_BYTES="$(wc -c < "$BACKUP_DIR/$media_name" | tr -d '[:space:]')"
  DB_SHA="$(shasum -a 256 "$BACKUP_DIR/$db_name" | awk '{print $1}')"
  MEDIA_SHA="$(shasum -a 256 "$BACKUP_DIR/$media_name" | awk '{print $1}')"
  write_manifest "$MANIFEST" "$stamp" "$db_name" "$media_name" "$DB_SHA" "$MEDIA_SHA" "$DB_BYTES" "$MEDIA_BYTES"
}

run_restore_failure() {
  local output status
  set +e
  output="$(
    PATH="$FAKE_BIN:$ORIGINAL_PATH" \
      DATA_DIR="$DATA_DIR" MEDIA_DIR="$MEDIA_DIR" BACKUP_DIR="$BACKUP_DIR" \
      ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" \
      RUNTIME_UID="$RUNTIME_UID" RUNTIME_GID="$RUNTIME_GID" \
      BACKUP_VALIDATION_NOW="$(date -u +%s)" RESTORE_READINESS_TIMEOUT_SECONDS=0 \
      FAKE_HEALTH_STATE="$CASE_ROOT/health.state" FAKE_HEALTH_AFTER_FIRST="${FAKE_HEALTH_AFTER_FIRST:-}" \
      FAKE_HEALTH="${FAKE_HEALTH:-healthy}" FAIL_CHOWN="${FAIL_CHOWN:-0}" FAIL_TAR="${FAIL_TAR:-0}" \
      "$RESTORE" --confirm "$MANIFEST" 2>&1
  )"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || {
    printf 'Expected restore failure, got success:\n%s\n' "$output" >&2
    exit 1
  }
  printf '%s\n' "$output"
}

assert_previous_state() {
  [[ "$(sqlite3 "$DATA_DIR/rewind.sqlite" 'SELECT value FROM state;')" == healthy-before ]]
  [[ -f "$MEDIA_DIR/old.txt" && ! -e "$MEDIA_DIR/new.txt" ]]
  [[ -z "$(find "$BACKUP_DIR" -maxdepth 1 -name '.rewind-*' -print -quit)" ]]
}

assert_replaced_state() {
  [[ "$(sqlite3 "$DATA_DIR/rewind.sqlite" 'SELECT value FROM state;')" == healthy-after ]]
  [[ -f "$MEDIA_DIR/new.txt" && ! -e "$MEDIA_DIR/old.txt" ]]
  [[ -z "$(find "$BACKUP_DIR" -maxdepth 1 -name '.rewind-*' -print -quit)" ]]
}

create_fixture success
PATH="$FAKE_BIN:$ORIGINAL_PATH" DATA_DIR="$DATA_DIR" MEDIA_DIR="$MEDIA_DIR" BACKUP_DIR="$BACKUP_DIR" \
  ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" RUNTIME_UID="$RUNTIME_UID" RUNTIME_GID="$RUNTIME_GID" \
  BACKUP_VALIDATION_NOW="$(date -u +%s)" RESTORE_READINESS_TIMEOUT_SECONDS=0 "$RESTORE" --confirm "$MANIFEST" >/dev/null
assert_replaced_state

create_fixture corrupt-db
printf 'not a sqlite database\n' | gzip -c > "$BACKUP_DIR"/*.sqlite.gz
DB_NAME="$(basename -- "$BACKUP_DIR"/*.sqlite.gz)"
MEDIA_NAME="$(basename -- "$BACKUP_DIR"/*.media.tar.gz)"
DB_BYTES="$(wc -c < "$BACKUP_DIR/$DB_NAME" | tr -d '[:space:]')"
MEDIA_BYTES="$(wc -c < "$BACKUP_DIR/$MEDIA_NAME" | tr -d '[:space:]')"
write_manifest "$MANIFEST" "${MANIFEST##*/}" "$DB_NAME" "$MEDIA_NAME" \
  "$(shasum -a 256 "$BACKUP_DIR/$DB_NAME" | awk '{print $1}')" \
  "$(shasum -a 256 "$BACKUP_DIR/$MEDIA_NAME" | awk '{print $1}')" "$DB_BYTES" "$MEDIA_BYTES"
# Replace the accidental filename-derived timestamp with the real manifest timestamp.
STAMP="$(basename -- "$MANIFEST" | sed 's/^rewind-//; s/\.manifest\.json$//')"
write_manifest "$MANIFEST" "$STAMP" "$DB_NAME" "$MEDIA_NAME" \
  "$(shasum -a 256 "$BACKUP_DIR/$DB_NAME" | awk '{print $1}')" \
  "$(shasum -a 256 "$BACKUP_DIR/$MEDIA_NAME" | awk '{print $1}')" "$DB_BYTES" "$MEDIA_BYTES"
run_restore_failure | grep -q 'integrity validation\|could not be opened'
assert_previous_state

create_fixture corrupt-media
printf 'not a gzip stream\n' > "$BACKUP_DIR"/*.media.tar.gz
MEDIA_NAME="$(basename -- "$BACKUP_DIR"/*.media.tar.gz)"
MEDIA_BYTES="$(wc -c < "$BACKUP_DIR/$MEDIA_NAME" | tr -d '[:space:]')"
STAMP="$(basename -- "$MANIFEST" | sed 's/^rewind-//; s/\.manifest\.json$//')"
write_manifest "$MANIFEST" "$STAMP" "$(basename -- "$BACKUP_DIR"/*.sqlite.gz)" "$MEDIA_NAME" \
  "$(shasum -a 256 "$BACKUP_DIR"/*.sqlite.gz | awk '{print $1}')" \
  "$(shasum -a 256 "$BACKUP_DIR/$MEDIA_NAME" | awk '{print $1}')" \
  "$(wc -c < "$BACKUP_DIR"/*.sqlite.gz | tr -d '[:space:]')" "$MEDIA_BYTES"
run_restore_failure | grep -q 'checksum\|unsafe path\|non-regular\|gzip'
assert_previous_state

create_fixture checksum
printf 'tampered\n' >> "$BACKUP_DIR"/*.sqlite.gz
run_restore_failure | grep -q 'checksum\|byte count'
assert_previous_state

create_fixture extraction
FAIL_TAR=1 run_restore_failure | grep -q 'extraction failed'
assert_previous_state

create_fixture permissions
FAIL_CHOWN=1 run_restore_failure | grep -q 'staging ownership\|ownership or permissions'
assert_previous_state

create_fixture readiness
FAKE_HEALTH=unhealthy FAKE_HEALTH_AFTER_FIRST=healthy run_restore_failure | grep -q 'readiness'
assert_previous_state

printf 'restore atomic failure-injection tests passed\n'
