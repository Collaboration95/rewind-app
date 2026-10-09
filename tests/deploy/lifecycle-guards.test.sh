#!/usr/bin/env bash
set -Eeuo pipefail

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rewind-lifecycle-guards.XXXXXX")"
cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
export RELEASE_BUNDLE="$TEST_ROOT/release.tar"
python3 "$REPO_ROOT/tests/deploy/make-release-fixture.py" "${GITHUB_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}" "$RELEASE_BUNDLE"
export RELEASE_BUNDLE_SHA256="$(sha256sum "$RELEASE_BUNDLE" | cut -d ' ' -f 1)"
FAKE_BIN="$TEST_ROOT/bin"
LOG_FILE="$TEST_ROOT/commands.log"
TF_DIR="$TEST_ROOT/tf"
TFVARS_FILE="$TF_DIR/terraform.tfvars"
REWIND_ENV_FILE="$TEST_ROOT/rewind.env"
PLAN_JSON="$TEST_ROOT/plan.json"
mkdir -p -- "$FAKE_BIN" "$TF_DIR"
printf 'account_id = "330599756236"\n' > "$TFVARS_FILE"
printf 'fixture-only environment\n' > "$REWIND_ENV_FILE"

printf '%s\n' '{"resource_changes":[]}' > "$PLAN_JSON"

cat > "$FAKE_BIN/aws" <<'FAKE_AWS'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'aws %s\n' "$*" >> "$COMMAND_LOG"

case "${1:-} ${2:-}" in
  'sts get-caller-identity')
    printf '%s\n' "${CALLER_ACCOUNT:-330599756236}"
    ;;
  'lightsail get-instances')
    if [[ -n "${INSTANCE_INVENTORY:-}" ]]; then
      printf '%s\n' "$INSTANCE_INVENTORY"
    else
      printf '%s\n' '{"instances":[]}'
    fi
    ;;
  'lightsail get-static-ips')
    if [[ -n "${STATIC_IP_INVENTORY:-}" ]]; then
      printf '%s\n' "$STATIC_IP_INVENTORY"
    else
      printf '%s\n' '{"staticIps":[]}'
    fi
    ;;
  's3api list-objects-v2'|'s3api head-object'|'s3 cp')
    printf '%s\n' '{"Contents":[]}'
    ;;
  *)
    printf 'unexpected fake aws invocation\n' >&2
    exit 2
    ;;
esac
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
if [[ "${2:-}" == output ]]; then
  printf '198.51.100.20\n'
fi
FAKE_TERRAFORM

cat > "$FAKE_BIN/ssh" <<'FAKE_SSH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'ssh %s\n' "$*" >> "$COMMAND_LOG"
FAKE_SSH

for command_name in scp rsync; do
  cat > "$FAKE_BIN/$command_name" <<FAKE_REMOTE
#!/usr/bin/env bash
set -Eeuo pipefail
printf '$command_name %s\n' "\$*" >> "\$COMMAND_LOG"
FAKE_REMOTE
done
chmod +x "$FAKE_BIN/aws" "$FAKE_BIN/terraform" "$FAKE_BIN/ssh" "$FAKE_BIN/scp" "$FAKE_BIN/rsync"

export PATH="$FAKE_BIN:$PATH"
COMMAND_LOG="$LOG_FILE"
export COMMAND_LOG LOG_FILE PLAN_JSON TF_DIR TFVARS_FILE REWIND_ENV_FILE
export BACKUP_BUCKET='approved-backup-bucket'
export BACKUP_PREFIX='rewind-demo'
export BACKUP_AWS_PROFILE='test-backup-profile'
export TF_AWS_PROFILE='test-terraform-profile'
export AWS_REGION='ap-southeast-1'

EXPECTED_STATIC_IP='{"staticIps":[{"name":"rewind-demo-ip","attachedTo":"rewind-demo"}]}'

run_capture() {
  local output status
  : > "$LOG_FILE"
  set +e
  output="$(env \
    TF_DIR="$TF_DIR" TFVARS_FILE="$TFVARS_FILE" REWIND_ENV_FILE="$REWIND_ENV_FILE" \
    BACKUP_BUCKET="$BACKUP_BUCKET" BACKUP_PREFIX="$BACKUP_PREFIX" \
    BACKUP_AWS_PROFILE="$BACKUP_AWS_PROFILE" TF_AWS_PROFILE="$TF_AWS_PROFILE" \
    AWS_REGION="$AWS_REGION" CALLER_ACCOUNT="${CALLER_ACCOUNT:-330599756236}" \
    INSTANCE_INVENTORY="${INSTANCE_INVENTORY:-}" \
    STATIC_IP_INVENTORY="${STATIC_IP_INVENTORY:-}" \
    "$@" 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"
  return "$status"
}

assert_no_host_or_apply_commands() {
  ! grep -Eq '^(terraform .* (apply|plan)|ssh |scp |rsync )' "$LOG_FILE"
}

unset CALLER_ACCOUNT INSTANCE_INVENTORY STATIC_IP_INVENTORY
if output="$(run_capture "$REPO_ROOT/infra/scripts/wake-demo.sh" --latest --apply 2>&1)"; then
  printf 'wake --apply without confirmation unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'--apply requires explicit --confirm'* ]]
[[ ! -s "$LOG_FILE" ]]

if output="$(run_capture "$REPO_ROOT/infra/scripts/wake-demo.sh" --latest --apply --dry-run --confirm 2>&1)"; then
  printf 'wake dry-run/apply combination unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'--dry-run cannot be combined with --apply'* ]]
[[ ! -s "$LOG_FILE" ]]

CALLER_ACCOUNT='999999999999' INSTANCE_INVENTORY='{"instances":[]}' STATIC_IP_INVENTORY='{"staticIps":[]}'
if output="$(run_capture "$REPO_ROOT/infra/scripts/wake-demo.sh" --latest --apply --confirm 2>&1)"; then
  printf 'wake with the wrong AWS account unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'not the configured Demo account'* ]]
grep -Fq 'aws sts get-caller-identity' "$LOG_FILE"
assert_no_host_or_apply_commands

CALLER_ACCOUNT='330599756236'
INSTANCE_INVENTORY='{"instances":[{"name":"rewind-unexpected","state":{"name":"running"},"publicIpAddress":"198.51.100.22","tags":[{"key":"Project","value":"rewind"}]}]}'
STATIC_IP_INVENTORY="$EXPECTED_STATIC_IP"
if output="$(run_capture "$REPO_ROOT/infra/scripts/wake-demo.sh" --latest --apply --confirm 2>&1)"; then
  printf 'wake with an unexpected instance unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'unexpected Rewind Lightsail instance'* ]]
assert_no_host_or_apply_commands
! grep -Eq '^aws s3' "$LOG_FILE"

printf 'lifecycle guard tests passed\n'
