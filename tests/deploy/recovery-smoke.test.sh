#!/usr/bin/env bash
set -Eeuo pipefail

# This is a full orchestration fixture, not a unit test of individual shell
# branches. The wake script is run unchanged. Its AWS, Terraform, SSH, SCP,
# rsync, and Docker boundaries are replaced with local fakes, while the real
# deploy/restore.sh runs against a disposable fixture host.

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rewind-recovery-smoke.XXXXXX")"
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
RELEASE_BUNDLE="$TEST_ROOT/release.tar"
python3 "$REPO_ROOT/tests/deploy/make-release-fixture.py" "$(git -C "$REPO_ROOT" rev-parse HEAD)" "$RELEASE_BUNDLE"
RELEASE_BUNDLE_SHA256="$(sha256sum "$RELEASE_BUNDLE" | cut -d ' ' -f 1)"
WAKE_SCRIPT="$REPO_ROOT/infra/scripts/wake-demo.sh"
RESTORE_SCRIPT="$REPO_ROOT/deploy/restore.sh"
FAKE_BIN="$TEST_ROOT/bin"
ORIGINAL_PATH="$PATH"
COMMAND_LOG="$TEST_ROOT/redacted-transcript.log"
OUTPUT_FILE="$TEST_ROOT/wake-output.log"
RUNTIME_UID="$(id -u)"
RUNTIME_GID="$(id -g)"

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -- "$FAKE_BIN"

log_event() {
  # Event names are deliberately the complete transcript. They contain no
  # paths, bucket names, profiles, hostnames, credentials, or command output.
  printf '%s\n' "$1" >> "$COMMAND_LOG"
}

cat > "$FAKE_BIN/aws" <<'FAKE_AWS'
#!/usr/bin/env bash
set -Eeuo pipefail
log_event() { printf '%s\n' "$1" >> "$COMMAND_LOG"; }

case "${1:-} ${2:-}" in
  'sts get-caller-identity')
    if [[ "${AWS_PROFILE:-}" == "$TF_AWS_PROFILE" ]]; then
      log_event 'terraform.aws.identity'
    else
      log_event 'recovery.aws.identity'
    fi
    printf '%s\n' "$EXPECTED_AWS_ACCOUNT_ID"
    ;;
  'lightsail get-instances'|'lightsail get-static-ips')
    log_event 'terraform.lifecycle.inventory'
    if [[ "${2:-}" == get-instances ]]; then
      printf '%s\n' '{"instances":[]}'
    else
      printf '%s\n' '{"staticIps":[]}'
    fi
    ;;
  's3api list-objects-v2')
    log_event 'recovery.validate.list'
    cat "$LISTING_FILE"
    ;;
  's3api head-object')
    log_event 'recovery.validate.archive-metadata'
    key=''
    previous=''
    for argument in "$@"; do
      if [[ "$previous" == --key ]]; then
        key="$argument"
        break
      fi
      previous="$argument"
    done
    wc -c < "$OBJECT_ROOT/$key" | tr -d '[:space:]'
    ;;
  's3 cp')
    uri="${3:-}"
    destination="${4:-}"
    key="${uri#s3://$BACKUP_BUCKET/}"
    if [[ "$key" == *.manifest.json ]]; then
      log_event 'recovery.validate.manifest-download'
    else
      log_event 'recovery.validate.archive-download'
    fi
    mkdir -p -- "$(dirname -- "$destination")"
    cp -- "$OBJECT_ROOT/$key" "$destination"
    ;;
  *)
    printf 'unexpected fake AWS invocation\n' >&2
    exit 2
    ;;
esac
FAKE_AWS

cat > "$FAKE_BIN/terraform" <<'FAKE_TERRAFORM'
#!/usr/bin/env bash
set -Eeuo pipefail
log_event() { printf '%s\n' "$1" >> "$COMMAND_LOG"; }

case "${2:-}" in
  plan)
    log_event 'terraform.plan'
    if [[ "${FAIL_STAGE:-}" == plan ]]; then
      log_event 'terraform.plan.failed'
      exit 1
    fi
    for argument in "$@"; do
      case "$argument" in
        -out=*) : > "${argument#-out=}" ;;
      esac
    done
    ;;
  show)
    log_event 'terraform.show'
    cat "$PLAN_JSON"
    ;;
  apply)
    log_event 'terraform.apply'
    if [[ "${FAIL_STAGE:-}" == apply ]]; then
      log_event 'terraform.apply.failed'
      exit 1
    fi
    ;;
  output)
    log_event 'terraform.output'
    printf '198.51.100.20\n'
    ;;
  *)
    printf 'unexpected fake Terraform invocation\n' >&2
    exit 2
    ;;
esac
FAKE_TERRAFORM

cat > "$FAKE_BIN/rsync" <<'FAKE_RSYNC'
#!/usr/bin/env bash
set -Eeuo pipefail
log_event() { printf '%s\n' "$1" >> "$COMMAND_LOG"; }
log_event 'transfer.bundle'
FAKE_RSYNC

cat > "$FAKE_BIN/scp" <<'FAKE_SCP'
#!/usr/bin/env bash
set -Eeuo pipefail
log_event() { printf '%s\n' "$1" >> "$COMMAND_LOG"; }

recovery_transfer=0
for argument in "$@"; do
  if [[ "$argument" == *.manifest.json ]]; then
    recovery_transfer=1
  fi
done

if [[ "$recovery_transfer" == 1 ]]; then
  log_event 'transfer.recovery'
  if [[ "${FAIL_STAGE:-}" == transfer ]]; then
    log_event 'transfer.recovery.failed'
    exit 1
  fi
else
  if [[ " $* " == *'rewind-release.tar'* ]]; then
    log_event 'transfer.bundle'
  elif [[ " $* " == *'release-host.sh'* ]]; then
    log_event 'transfer.verifier'
  else
    log_event 'transfer.env'
  fi
fi

# Copy only fixture files into a disposable local stand-in for /tmp on the
# mocked host. No real SSH transport or key is involved.
for argument in "$@"; do
  if [[ -f "$argument" ]]; then
    cp -- "$argument" "$REMOTE_ROOT/tmp/$(basename -- "$argument")"
  fi
done
FAKE_SCP

cat > "$FAKE_BIN/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
log_event() { printf '%s\n' "$1" >> "$COMMAND_LOG"; }

if [[ "${1:-}" == compose ]]; then
  joined="$*"
  case "$joined" in
    *' version '*) exit 0 ;;
    *' config --quiet '*) exit 0 ;;
    *' ps -q runtime'*) printf 'fixture-runtime-container\n'; exit 0 ;;
    *' stop runtime'*) log_event 'restore.runtime.stop'; exit 0 ;;
    *' up -d runtime'*)
      log_event 'restore.runtime.start'
      if [[ "${FAIL_STAGE:-}" == restore ]]; then
        log_event 'restore.runtime.start.failed'
        exit 1
      fi
      exit 0
      ;;
    *) exit 0 ;;
  esac
fi

if [[ "${1:-}" == inspect ]]; then
  log_event 'restore.runtime.health'
  printf 'healthy\n'
  exit 0
fi

printf 'unexpected fake Docker invocation\n' >&2
exit 2
FAKE_DOCKER

cat > "$FAKE_BIN/sudo" <<'FAKE_SUDO'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == -n ]]; then
  shift
fi
if [[ "${1:-}" == -v ]]; then
  exit 0
fi
if [[ "${1:-}" == -u ]]; then
  shift 2
fi
if [[ "${1:-}" == -- ]]; then
  shift
fi
exec "$@"
FAKE_SUDO

chmod 0755 "$FAKE_BIN/aws" "$FAKE_BIN/terraform" "$FAKE_BIN/rsync" \
  "$FAKE_BIN/scp" "$FAKE_BIN/docker" "$FAKE_BIN/sudo"

cat > "$FAKE_BIN/ssh" <<'FAKE_SSH'
#!/usr/bin/env bash
set -Eeuo pipefail
log_event() { printf '%s\n' "$1" >> "$COMMAND_LOG"; }

remote_command="${!#}"
if [[ "$remote_command" == *'test -f /srv/rewind/.host-bootstrap-prerequisites'* ]]; then
  log_event 'host.bootstrap.health'
  exit 0
fi

if [[ "$remote_command" == *'release-host.sh install'* ]]; then
  log_event 'host.bundle.install'
  exit 0
fi

if [[ "$remote_command" == *'./deploy/restore.sh'* ]]; then
  log_event 'host.restore'

  manifest_name="$(basename -- "$REMOTE_ROOT"/tmp/*.manifest.json)"
  mkdir -p -- "$REMOTE_ROOT/backups"
  for artifact in "$REMOTE_ROOT"/tmp/*.manifest.json "$REMOTE_ROOT"/tmp/*.sqlite.gz "$REMOTE_ROOT"/tmp/*.media.tar.gz; do
    cp -- "$artifact" "$REMOTE_ROOT/backups/"
  done

  if ! PATH="$FAKE_BIN:$ORIGINAL_PATH" \
    ENV_FILE="$REMOTE_ROOT/rewind.env" \
    COMPOSE_FILE="$REMOTE_ROOT/compose.yaml" \
    DATA_DIR="$REMOTE_ROOT/data" \
    MEDIA_DIR="$REMOTE_ROOT/media" \
    BACKUP_DIR="$REMOTE_ROOT/backups" \
    RUNTIME_UID="$RUNTIME_UID" \
    RUNTIME_GID="$RUNTIME_GID" \
    BACKUP_VALIDATION_NOW="$BACKUP_VALIDATION_NOW" \
    BACKUP_MAX_AGE_SECONDS=3600 \
    BACKUP_TIMESTAMP_FUTURE_SKEW_SECONDS=300 \
    RESTORE_READINESS_TIMEOUT_SECONDS=0 \
    "$RESTORE_SCRIPT" --confirm "$REMOTE_ROOT/backups/$manifest_name" \
    >"$RESTORE_OUTPUT" 2>&1; then
    log_event 'restore.failed'
    exit 1
  fi

  log_event 'host.runtime.start'
  if [[ "${FAIL_STAGE:-}" == health ]]; then
    log_event 'host.final.health.failed'
    exit 1
  fi
  log_event 'host.final.health'
  exit 0
fi

printf 'unexpected fake SSH invocation\n' >&2
exit 2
FAKE_SSH
chmod 0755 "$FAKE_BIN/ssh"

epoch_stamp() {
  local epoch="$1"
  date -u -r "$epoch" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -d "@$epoch" +%Y%m%dT%H%M%SZ
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    shasum -a 256 -- "$1" | awk '{print $1}'
  fi
}

create_fixture() {
  local now stamp database_name media_name database_path media_path

  CASE_ROOT="$TEST_ROOT/$1"
  OBJECT_ROOT="$CASE_ROOT/objects"
  REMOTE_ROOT="$CASE_ROOT/remote"
  TF_DIR="$CASE_ROOT/tf"
  TFVARS_FILE="$TF_DIR/terraform.tfvars"
  REWIND_ENV_FILE="$CASE_ROOT/operator.env"
  RESTORE_OUTPUT="$CASE_ROOT/restore-output.log"
  PLAN_JSON="$CASE_ROOT/plan.json"
  LISTING_FILE="$CASE_ROOT/listing.json"
  mkdir -p -- "$FAKE_BIN" "$OBJECT_ROOT/rewind-demo" "$REMOTE_ROOT" \
    "$REMOTE_ROOT/data" "$REMOTE_ROOT/media" "$REMOTE_ROOT/backups" "$REMOTE_ROOT/tmp" \
    "$TF_DIR"

  printf 'account_id = "123456789012"\n' > "$TFVARS_FILE"
  printf 'REWIND_BACKUP_PREFIX=rewind-demo\n' > "$REWIND_ENV_FILE"
  printf 'services: {}\n' > "$REMOTE_ROOT/compose.yaml"
  cp -- "$REWIND_ENV_FILE" "$REMOTE_ROOT/rewind.env"
  chmod 0750 "$REMOTE_ROOT/data" "$REMOTE_ROOT/media"

  sqlite3 "$REMOTE_ROOT/data/rewind.sqlite" <<'SQL'
CREATE TABLE state (value TEXT NOT NULL);
INSERT INTO state VALUES ('healthy-before');
SQL
  printf 'old-media\n' > "$REMOTE_ROOT/media/old.txt"

  now="$(date -u +%s)"
  stamp="$(epoch_stamp "$now")"
  database_name="rewind-${stamp}.sqlite.gz"
  media_name="rewind-${stamp}.media.tar.gz"
  database_path="$OBJECT_ROOT/rewind-demo/$database_name"
  media_path="$OBJECT_ROOT/rewind-demo/$media_name"

  sqlite3 "$CASE_ROOT/new.sqlite" <<'SQL'
CREATE TABLE state (value TEXT NOT NULL);
INSERT INTO state VALUES ('healthy-after');
SQL
  gzip -c "$CASE_ROOT/new.sqlite" > "$database_path"
  mkdir -- "$CASE_ROOT/new-media"
  printf 'new-media\n' > "$CASE_ROOT/new-media/new.txt"
  tar -C "$CASE_ROOT/new-media" -czf "$media_path" .

  DB_BYTES="$(wc -c < "$database_path" | tr -d '[:space:]')"
  MEDIA_BYTES="$(wc -c < "$media_path" | tr -d '[:space:]')"
  DB_SHA="$(sha256_file "$database_path")"
  MEDIA_SHA="$(sha256_file "$media_path")"
  MANIFEST_NAME="rewind-${stamp}.manifest.json"
  printf '{"created_at":"%s","database":{"key":"rewind-demo/%s","sha256":"%s","bytes":%s},"media":{"key":"rewind-demo/%s","sha256":"%s","bytes":%s}}\n' \
    "$stamp" "$database_name" "$DB_SHA" "$DB_BYTES" "$media_name" "$MEDIA_SHA" "$MEDIA_BYTES" \
    > "$OBJECT_ROOT/rewind-demo/$MANIFEST_NAME"
  printf '{"Contents":[{"Key":"rewind-demo/%s"}]}\n' "$MANIFEST_NAME" > "$LISTING_FILE"

  cat > "$PLAN_JSON" <<'JSON'
{"resource_changes":[
  {"address":"aws_lightsail_instance.rewind[0]","change":{"actions":["create"]}},
  {"address":"aws_lightsail_static_ip.rewind[0]","change":{"actions":["create"]}},
  {"address":"aws_lightsail_static_ip_attachment.rewind[0]","change":{"actions":["create"]}},
  {"address":"aws_lightsail_instance_public_ports.rewind[0]","change":{"actions":["create"]}}
]}
JSON
}

run_wake() {
  local requested_stage="${1:-}"
  : > "$COMMAND_LOG"
  set +e
  output="$({
    env \
      PATH="$FAKE_BIN:$ORIGINAL_PATH" \
      COMMAND_LOG="$COMMAND_LOG" \
      EXPECTED_AWS_ACCOUNT_ID='123456789012' \
      TF_AWS_PROFILE='fixture-terraform' \
      BACKUP_AWS_PROFILE='fixture-backup' \
      BACKUP_BUCKET='fixture-backups' \
      BACKUP_PREFIX='rewind-demo' \
      AWS_REGION='fixture-region' \
      TF_DIR="$TF_DIR" \
      TFVARS_FILE="$TFVARS_FILE" \
      REWIND_ENV_FILE="$REWIND_ENV_FILE" \
      RELEASE_BUNDLE="$RELEASE_BUNDLE" \
      RELEASE_BUNDLE_SHA256="$RELEASE_BUNDLE_SHA256" \
      OBJECT_ROOT="$OBJECT_ROOT" \
      LISTING_FILE="$LISTING_FILE" \
      PLAN_JSON="$PLAN_JSON" \
      REMOTE_ROOT="$REMOTE_ROOT" \
      FAKE_BIN="$FAKE_BIN" \
      ORIGINAL_PATH="$ORIGINAL_PATH" \
      RESTORE_SCRIPT="$RESTORE_SCRIPT" \
      RESTORE_OUTPUT="$RESTORE_OUTPUT" \
      RUNTIME_UID="$RUNTIME_UID" \
      RUNTIME_GID="$RUNTIME_GID" \
      BACKUP_VALIDATION_NOW="$BACKUP_VALIDATION_NOW" \
      BACKUP_MAX_AGE_SECONDS=3600 \
      BACKUP_TIMESTAMP_FUTURE_SKEW_SECONDS=300 \
      FAIL_STAGE="$requested_stage" \
      SSH_USER='fixture-user' \
      "$WAKE_SCRIPT" --latest --apply --confirm
  } 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output" > "$OUTPUT_FILE"
  WAKE_STATUS="$status"
}

assert_output_redacted() {
  local output
  output="$(cat "$OUTPUT_FILE")"
  [[ "$output" != *"$CASE_ROOT"* ]] || {
    printf 'Wake output leaked a fixture path:\n%s\n' "$output" >&2
    exit 1
  }
  [[ "$output" != *'PRIVATE KEY'* && "$output" != *'AWS_SECRET_ACCESS_KEY'* ]] || {
    printf 'Wake output leaked credential-shaped material:\n%s\n' "$output" >&2
    exit 1
  }
}

event_line_after() {
  local event="$1"
  local after="$2"
  awk -v event="$event" -v after="$after" 'NR > after && $0 == event { print NR; exit }' "$COMMAND_LOG"
}

assert_event_order() {
  local previous=0 event line
  for event in "$@"; do
    line="$(event_line_after "$event" "$previous")"
    [[ -n "$line" ]] || {
      printf 'Missing or out-of-order transcript event: %s\nTranscript:\n' "$event" >&2
      cat "$COMMAND_LOG" >&2
      exit 1
    }
    previous="$line"
  done
}

assert_no_events() {
  local event
  for event in "$@"; do
    if grep -Fxq "$event" "$COMMAND_LOG"; then
      printf 'Unexpected later-stage event: %s\nTranscript:\n' "$event" >&2
      cat "$COMMAND_LOG" >&2
      exit 1
    fi
  done
}

assert_success_fixture() {
  [[ "$WAKE_STATUS" == 0 ]] || {
    printf 'Expected successful recovery, got status %s:\n' "$WAKE_STATUS" >&2
    cat "$OUTPUT_FILE" >&2
    printf 'Transcript:\n' >&2
    cat "$COMMAND_LOG" >&2
    printf 'Restore output:\n' >&2
    cat "$RESTORE_OUTPUT" >&2
    exit 1
  }
  assert_output_redacted
  assert_event_order \
    'terraform.aws.identity' \
    'terraform.lifecycle.inventory' \
    'recovery.aws.identity' \
    'recovery.validate.list' \
    'recovery.validate.manifest-download' \
    'recovery.validate.archive-metadata' \
    'recovery.validate.archive-download' \
    'terraform.plan' \
    'terraform.show' \
    'terraform.apply' \
    'terraform.output' \
    'host.bootstrap.health' \
    'transfer.bundle' \
    'transfer.env' \
    'host.bundle.install' \
    'transfer.recovery' \
    'host.restore' \
    'restore.runtime.stop' \
    'restore.runtime.start' \
    'restore.runtime.health' \
    'host.runtime.start' \
    'host.final.health'

  [[ "$(sqlite3 "$REMOTE_ROOT/data/rewind.sqlite" 'SELECT value FROM state;')" == healthy-after ]]
  [[ -f "$REMOTE_ROOT/media/new.txt" && ! -e "$REMOTE_ROOT/media/old.txt" ]]
  [[ -z "$(find "$REMOTE_ROOT/backups" -maxdepth 1 -name '.rewind-*' -print -quit)" ]]
}

assert_failure_fixture() {
  local stage="$1"
  [[ "$WAKE_STATUS" != 0 ]] || {
    printf 'Expected %s failure, but recovery succeeded.\n' "$stage" >&2
    cat "$OUTPUT_FILE" >&2
    exit 1
  }
  assert_output_redacted
  case "$stage" in
    plan)
      assert_no_events terraform.apply terraform.output transfer.bundle transfer.env \
        transfer.recovery host.restore restore.runtime.stop restore.runtime.start \
        restore.runtime.health host.runtime.start host.final.health
      ;;
    apply)
      assert_no_events terraform.output transfer.bundle transfer.env transfer.recovery \
        host.restore restore.runtime.stop restore.runtime.start restore.runtime.health \
        host.runtime.start host.final.health
      ;;
    transfer)
      grep -Fxq 'transfer.recovery.failed' "$COMMAND_LOG"
      assert_no_events host.restore restore.runtime.stop restore.runtime.start \
        restore.runtime.health host.runtime.start host.final.health
      ;;
    restore)
      grep -Fxq 'restore.runtime.start.failed' "$COMMAND_LOG"
      assert_no_events host.runtime.start host.final.health
      ;;
    health)
      grep -Fxq 'host.final.health.failed' "$COMMAND_LOG"
      [[ "$(tail -n 1 "$COMMAND_LOG")" == 'host.final.health.failed' ]]
      ;;
    *)
      printf 'Unknown failure stage: %s\n' "$stage" >&2
      exit 1
      ;;
  esac
}

NOW_EPOCH="$(date -u +%s)"
BACKUP_VALIDATION_NOW="$NOW_EPOCH"

create_fixture success
run_wake ''
assert_success_fixture
printf 'success transcript:\n'
cat "$COMMAND_LOG"

for failure_stage in plan apply transfer restore health; do
  printf 'checking injected failure: %s\n' "$failure_stage"
  create_fixture "failure-$failure_stage"
  run_wake "$failure_stage"
  assert_failure_fixture "$failure_stage"
done

printf 'recreate-and-restore recovery smoke tests passed\n'
