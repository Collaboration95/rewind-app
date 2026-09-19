#!/usr/bin/env bash
set -Eeuo pipefail

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rewind-wake-selection.XXXXXX")"
cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
FAKE_BIN="$TEST_ROOT/bin"
OBJECT_ROOT="$TEST_ROOT/objects"
LOG_FILE="$TEST_ROOT/commands.log"
LISTING_FILE="$TEST_ROOT/listing.json"
TF_DIR="$TEST_ROOT/tf"
TFVARS_FILE="$TF_DIR/terraform.tfvars"
REWIND_ENV_FILE="$TEST_ROOT/rewind.env"
PLAN_JSON="$TEST_ROOT/plan.json"
mkdir -p -- "$FAKE_BIN" "$OBJECT_ROOT" "$TF_DIR"
printf 'account_id = "330599756236"\n' > "$TFVARS_FILE"
printf 'test-only environment\n' > "$REWIND_ENV_FILE"
cat > "$PLAN_JSON" <<'JSON'
{"resource_changes":[
  {"address":"aws_lightsail_instance.rewind[0]","change":{"actions":["create"]}},
  {"address":"aws_lightsail_static_ip.rewind[0]","change":{"actions":["create"]}},
  {"address":"aws_lightsail_static_ip_attachment.rewind[0]","change":{"actions":["create"]}},
  {"address":"aws_lightsail_instance_public_ports.rewind[0]","change":{"actions":["create"]}}
]}
JSON

cat > "$FAKE_BIN/aws" <<'FAKE_AWS'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'aws %s\n' "$*" >> "$COMMAND_LOG"

if [[ "${1:-}" == s3api && "${2:-}" == list-objects-v2 ]]; then
  cat "$LISTING_FILE"
  exit 0
fi

if [[ "${1:-}" == sts && "${2:-}" == get-caller-identity ]]; then
  printf '330599756236\n'
  exit 0
fi

if [[ "${1:-}" == lightsail && "${2:-}" == get-instances ]]; then
  printf '{"instances":[]}\n'
  exit 0
fi

if [[ "${1:-}" == lightsail && "${2:-}" == get-static-ips ]]; then
  printf '{"staticIps":[]}\n'
  exit 0
fi

if [[ "${1:-}" == s3api && "${2:-}" == head-object ]]; then
  key=''
  previous=''
  for argument in "$@"; do
    if [[ "$previous" == --key ]]; then
      key="$argument"
      break
    fi
    previous="$argument"
  done
  object="$OBJECT_ROOT/$key"
  [[ -f "$object" ]] || exit 1
  wc -c < "$object" | tr -d '[:space:]'
  exit 0
fi

if [[ "${1:-}" == s3 && "${2:-}" == cp ]]; then
  uri="${3:-}"
  destination="${4:-}"
  key="${uri#s3://$BACKUP_BUCKET/}"
  source="$OBJECT_ROOT/$key"
  [[ -f "$source" ]] || exit 1
  mkdir -p -- "$(dirname -- "$destination")"
  cp -- "$source" "$destination"
  exit 0
fi

if [[ "${1:-}" == lightsail && "${2:-}" == get-instance ]]; then
  exit 1
fi

printf 'unexpected fake aws invocation\n' >&2
exit 2
FAKE_AWS

cat > "$FAKE_BIN/terraform" <<'FAKE_TERRAFORM'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'terraform %s\n' "$*" >> "$COMMAND_LOG"
for argument in "$@"; do
  case "$argument" in
    -out=*) : > "${argument#-out=}" ;;
  esac
done
if [[ "${2:-}" == show && "${3:-}" == -json ]]; then
  cat "$PLAN_JSON"
  exit 0
fi
case "${1:-}" in
  -chdir=*)
    case "${2:-}" in
      output) printf '198.51.100.20\n' ;;
    esac
    ;;
esac
exit 0
FAKE_TERRAFORM

for command_name in ssh scp rsync; do
  cat > "$FAKE_BIN/$command_name" <<FAKE_REMOTE
#!/usr/bin/env bash
printf '$command_name %s\n' "\$*" >> "\$COMMAND_LOG"
exit 0
FAKE_REMOTE
done
chmod +x "$FAKE_BIN/aws" "$FAKE_BIN/terraform" "$FAKE_BIN/ssh" "$FAKE_BIN/scp" "$FAKE_BIN/rsync"

export PATH="$FAKE_BIN:$PATH"
export COMMAND_LOG="$LOG_FILE"
export LISTING_FILE
export OBJECT_ROOT
export PLAN_JSON
export BACKUP_BUCKET='approved-backup-bucket'
export BACKUP_PREFIX='rewind-demo'
export BACKUP_AWS_PROFILE='test-backup-profile'
export TF_AWS_PROFILE='test-terraform-profile'
export AWS_REGION='ap-southeast-1'
export TF_DIR TFVARS_FILE REWIND_ENV_FILE
export BACKUP_MAX_AGE_SECONDS=3600
export BACKUP_TIMESTAMP_FUTURE_SKEW_SECONDS=300
NOW_EPOCH="$(date -u +%s)"
export BACKUP_VALIDATION_NOW="$NOW_EPOCH"

epoch_stamp() {
  local epoch="$1"
  date -u -r "$epoch" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -d "@$epoch" +%Y%m%dT%H%M%SZ
}

write_archive() {
  local key="$1"
  local content="$2"
  mkdir -p -- "$OBJECT_ROOT/$(dirname -- "$key")"
  printf '%s' "$content" > "$OBJECT_ROOT/$key"
}

write_manifest() {
  local stamp="$1"
  local key="rewind-demo/rewind-$stamp.manifest.json"
  local database_key="rewind-demo/rewind-$stamp.sqlite.gz"
  local media_key="rewind-demo/rewind-$stamp.media.tar.gz"
  local database_sha256="$2"
  local media_sha256="$3"
  local database_bytes="$4"
  local media_bytes="$5"
  mkdir -p -- "$OBJECT_ROOT/$(dirname -- "$key")"
  printf '{"created_at":"%s","database":{"key":"%s","sha256":"%s","bytes":%s},"media":{"key":"%s","sha256":"%s","bytes":%s}}\n' \
    "$stamp" "$database_key" "$database_sha256" "$database_bytes" \
    "$media_key" "$media_sha256" "$media_bytes" > "$OBJECT_ROOT/$key"
}

add_valid_candidate() {
  local stamp="$1"
  local database_key="rewind-demo/rewind-$stamp.sqlite.gz"
  local media_key="rewind-demo/rewind-$stamp.media.tar.gz"
  local database_path="$OBJECT_ROOT/$database_key"
  local media_path="$OBJECT_ROOT/$media_key"
  write_archive "$database_key" "database-$stamp\n"
  write_archive "$media_key" "media-$stamp\n"
  write_manifest "$stamp" "$(sha256sum "$database_path" | awk '{print $1}')" \
    "$(sha256sum "$media_path" | awk '{print $1}')" \
    "$(wc -c < "$database_path" | tr -d '[:space:]')" \
    "$(wc -c < "$media_path" | tr -d '[:space:]')"
}

OLD_STAMP="$(epoch_stamp "$((NOW_EPOCH - 240))")"
NEWER_VALID_STAMP="$(epoch_stamp "$((NOW_EPOCH - 180))")"
INCOMPLETE_STAMP="$(epoch_stamp "$((NOW_EPOCH - 90))")"
BAD_CHECKSUM_STAMP="$(epoch_stamp "$((NOW_EPOCH - 60))")"
MALFORMED_STAMP="$(epoch_stamp "$((NOW_EPOCH - 30))")"
WRONG_NAME_STAMP="$(epoch_stamp "$((NOW_EPOCH - 20))")"
MISMATCH_STAMP="$(epoch_stamp "$((NOW_EPOCH - 10))")"

add_valid_candidate "$OLD_STAMP"
add_valid_candidate "$NEWER_VALID_STAMP"

incomplete_db_key="rewind-demo/rewind-$INCOMPLETE_STAMP.sqlite.gz"
incomplete_media_key="rewind-demo/rewind-$INCOMPLETE_STAMP.media.tar.gz"
write_archive "$incomplete_db_key" "database-$INCOMPLETE_STAMP\n"
write_manifest "$INCOMPLETE_STAMP" \
  "$(sha256sum "$OBJECT_ROOT/$incomplete_db_key" | awk '{print $1}')" \
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  "$(wc -c < "$OBJECT_ROOT/$incomplete_db_key" | tr -d '[:space:]')" 17

bad_db_key="rewind-demo/rewind-$BAD_CHECKSUM_STAMP.sqlite.gz"
bad_media_key="rewind-demo/rewind-$BAD_CHECKSUM_STAMP.media.tar.gz"
write_archive "$bad_db_key" "database-$BAD_CHECKSUM_STAMP\n"
write_archive "$bad_media_key" "media-$BAD_CHECKSUM_STAMP\n"
write_manifest "$BAD_CHECKSUM_STAMP" \
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' \
  "$(wc -c < "$OBJECT_ROOT/$bad_db_key" | tr -d '[:space:]')" \
  "$(wc -c < "$OBJECT_ROOT/$bad_media_key" | tr -d '[:space:]')"

malformed_key="rewind-demo/rewind-$MALFORMED_STAMP.manifest.json"
mkdir -p -- "$OBJECT_ROOT/rewind-demo"
printf '{malformed-json}\n' > "$OBJECT_ROOT/$malformed_key"

wrong_name_key="rewind-demo/not-a-recovery-point.manifest.json"
printf '{malformed-json}\n' > "$OBJECT_ROOT/$wrong_name_key"

mismatch_key="rewind-demo/rewind-$MISMATCH_STAMP.manifest.json"
mismatch_media_key="rewind-demo/rewind-$MISMATCH_STAMP.media.tar.gz"
write_archive "$mismatch_media_key" "media-$MISMATCH_STAMP\n"
printf '{"created_at":"%s","database":{"key":"rewind-demo/not-matching.sqlite.gz","sha256":"%s","bytes":1},"media":{"key":"%s","sha256":"%s","bytes":%s}}\n' \
  "$MISMATCH_STAMP" \
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' \
  "$mismatch_media_key" \
  "$(sha256sum "$OBJECT_ROOT/$mismatch_media_key" | awk '{print $1}')" \
  "$(wc -c < "$OBJECT_ROOT/$mismatch_media_key" | tr -d '[:space:]')" > "$OBJECT_ROOT/$mismatch_key"

wrong_prefix_key="other-prefix/rewind-$WRONG_NAME_STAMP.manifest.json"
mkdir -p -- "$OBJECT_ROOT/other-prefix"
printf '{malformed-json}\n' > "$OBJECT_ROOT/$wrong_prefix_key"

printf '{"Contents":[{"Key":"%s"},{"Key":"%s"},{"Key":"%s"},{"Key":"%s"},{"Key":"%s"},{"Key":"%s"},{"Key":"%s"}]}' \
  "rewind-demo/rewind-$OLD_STAMP.manifest.json" \
  "rewind-demo/rewind-$NEWER_VALID_STAMP.manifest.json" \
  "rewind-demo/rewind-$INCOMPLETE_STAMP.manifest.json" \
  "rewind-demo/rewind-$BAD_CHECKSUM_STAMP.manifest.json" \
  "$malformed_key" "$wrong_name_key" "$wrong_prefix_key" > "$LISTING_FILE"

run_wake() {
  : > "$COMMAND_LOG"
  env \
    BACKUP_BUCKET="$BACKUP_BUCKET" BACKUP_PREFIX="$BACKUP_PREFIX" \
    BACKUP_AWS_PROFILE="$BACKUP_AWS_PROFILE" TF_AWS_PROFILE="$TF_AWS_PROFILE" \
    AWS_REGION="$AWS_REGION" TF_DIR="$TF_DIR" TFVARS_FILE="$TFVARS_FILE" \
    REWIND_ENV_FILE="$REWIND_ENV_FILE" BACKUP_VALIDATION_NOW="$BACKUP_VALIDATION_NOW" \
    BACKUP_MAX_AGE_SECONDS="$BACKUP_MAX_AGE_SECONDS" \
    BACKUP_TIMESTAMP_FUTURE_SKEW_SECONDS="$BACKUP_TIMESTAMP_FUTURE_SKEW_SECONDS" \
    "$REPO_ROOT/infra/scripts/wake-demo.sh" "$@"
}

latest_output="$(run_wake --latest 2>&1)"
[[ "$latest_output" == *"rewind-$NEWER_VALID_STAMP.manifest.json"* ]] || {
  printf 'Expected the newest complete valid recovery point to be selected.\n%s\n' "$latest_output" >&2
  exit 1
}
[[ "$latest_output" != *"rewind-$BAD_CHECKSUM_STAMP.manifest.json"* ]] || {
  printf 'Checksum-invalid candidate was selected.\n%s\n' "$latest_output" >&2
  exit 1
}
grep -Fq 'terraform' "$COMMAND_LOG"
! grep -Eq '^(ssh|scp|rsync) ' "$COMMAND_LOG"

for invalid_uri in \
  "s3://other-backup-bucket/rewind-demo/rewind-$NEWER_VALID_STAMP.manifest.json" \
  "s3://$BACKUP_BUCKET/other-prefix/rewind-$NEWER_VALID_STAMP.manifest.json" \
  "not-an-s3-uri" \
  "s3://$BACKUP_BUCKET/rewind-demo/not-a-recovery-point.manifest.json" \
  "s3://$BACKUP_BUCKET/$mismatch_key"; do
  if output="$(run_wake --manifest "$invalid_uri" 2>&1)"; then
    printf 'Expected explicit recovery URI rejection: %s\n' "$invalid_uri" >&2
    exit 1
  fi
  [[ "$output" != *"$BACKUP_BUCKET"* && "$output" != *"$OBJECT_ROOT"* ]] || {
    printf 'Explicit-selection error was not redacted: %s\n' "$output" >&2
    exit 1
  }
  ! grep -Eq '^(terraform|ssh|scp|rsync) ' "$COMMAND_LOG"
  ! grep -Fq 'lightsail get-instance' "$COMMAND_LOG"
done

printf '{"Contents":[{"Key":"%s"},{"Key":"%s"},{"Key":"%s"}]}' \
  "rewind-demo/rewind-$INCOMPLETE_STAMP.manifest.json" \
  "$malformed_key" "$wrong_name_key" > "$LISTING_FILE"
if invalid_latest_output="$(run_wake --latest 2>&1)"; then
  printf 'Expected latest selection with no valid recovery point to fail.\n' >&2
  exit 1
fi
[[ "$invalid_latest_output" == *'no complete valid recovery point exists'* ]] || {
  printf 'Expected actionable invalid-latest error, got: %s\n' "$invalid_latest_output" >&2
  exit 1
}
[[ "$invalid_latest_output" != *"$BACKUP_BUCKET"* && "$invalid_latest_output" != *"$OBJECT_ROOT"* ]] || {
  printf 'Latest-selection error was not redacted: %s\n' "$invalid_latest_output" >&2
  exit 1
}
! grep -Eq '^(terraform|ssh|scp|rsync) ' "$COMMAND_LOG"
! grep -Fq 'lightsail get-instance' "$COMMAND_LOG"

printf 'wake recovery selection tests passed\n'
