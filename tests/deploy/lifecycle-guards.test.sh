#!/usr/bin/env bash
set -Eeuo pipefail

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rewind-lifecycle-guards.XXXXXX")"
cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
FAKE_BIN="$TEST_ROOT/bin"
LOG_FILE="$TEST_ROOT/commands.log"
TF_DIR="$TEST_ROOT/tf"
TFVARS_FILE="$TF_DIR/terraform.tfvars"
REWIND_ENV_FILE="$TEST_ROOT/rewind.env"
PLAN_JSON="$TEST_ROOT/plan.json"
mkdir -p -- "$FAKE_BIN" "$TF_DIR"
printf 'account_id = "330599756236"\n' > "$TFVARS_FILE"
printf 'fixture-only environment\n' > "$REWIND_ENV_FILE"

cat > "$PLAN_JSON" <<'JSON'
{"resource_changes":[
  {"address":"data.aws_iam_policy_document.operator","mode":"data","change":{"actions":["read"]}},
  {"address":"aws_lightsail_instance.rewind[0]","change":{"actions":["delete"]}},
  {"address":"aws_lightsail_static_ip.rewind[0]","change":{"actions":["delete"]}},
  {"address":"aws_lightsail_static_ip_attachment.rewind[0]","change":{"actions":["delete"]}},
  {"address":"aws_lightsail_instance_public_ports.rewind[0]","change":{"actions":["delete"]}},
  {"address":"aws_lightsail_distribution.web[0]","change":{"actions":["delete"]}},
  {"address":"aws_iam_role.power_controller[0]","change":{"actions":["delete"]}},
  {"address":"aws_iam_role_policy.power_controller[0]","change":{"actions":["delete"]}},
  {"address":"aws_iam_role_policy.operator[0]","change":{"actions":["delete"]}},
  {"address":"aws_iam_role_policy.scheduler[0]","change":{"actions":["delete"]}},
  {"address":"aws_lambda_function.power_controller[0]","change":{"actions":["delete"]}},
  {"address":"aws_iam_role.cost_safety_audit","change":{"actions":["update"]}},
  {"address":"aws_iam_role.cost_safety_audit_scheduler","change":{"actions":["update"]}},
  {"address":"aws_iam_role_policy.cost_safety_audit","change":{"actions":["update"]}},
  {"address":"aws_iam_role_policy.cost_safety_audit_scheduler","change":{"actions":["update"]}},
  {"address":"aws_lambda_function.cost_safety_audit","change":{"actions":["update"]}}
]}
JSON

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
if [[ "${SSH_MODE:-}" == backup ]]; then
  printf 'Local backup ready /srv/rewind/backups/rewind-20260919T120000Z.manifest.json /srv/rewind/backups/rewind-20260919T120000Z.sqlite.gz /srv/rewind/backups/rewind-20260919T120000Z.media.tar.gz\n'
fi
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

EXPECTED_INSTANCE='{"instances":[{"name":"rewind-demo","state":{"name":"running"},"publicIpAddress":"198.51.100.20","tags":[{"key":"Project","value":"rewind"},{"key":"Environment","value":"demo"},{"key":"ManagedBy","value":"terraform"}]}]}'
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
    SSH_MODE="${SSH_MODE:-}" \
    "$@" 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"
  return "$status"
}

assert_no_host_or_apply_commands() {
  ! grep -Eq '^(terraform .* (apply|plan)|ssh |scp |rsync )' "$LOG_FILE"
}

unset CALLER_ACCOUNT INSTANCE_INVENTORY STATIC_IP_INVENTORY SSH_MODE
if output="$(run_capture "$REPO_ROOT/infra/scripts/destroy-demo.sh" --apply 2>&1)"; then
  printf 'destroy --apply without confirmation unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'--apply requires explicit --confirm'* ]]
[[ ! -s "$LOG_FILE" ]]

if output="$(run_capture "$REPO_ROOT/infra/scripts/stop-demo.sh" --apply 2>&1)"; then
  printf 'stop --apply without confirmation unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'--apply requires explicit --confirm'* ]]
[[ ! -s "$LOG_FILE" ]]

if output="$(run_capture "$REPO_ROOT/infra/scripts/wake-demo.sh" --latest --apply 2>&1)"; then
  printf 'wake --apply without confirmation unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'--apply requires explicit --confirm'* ]]
[[ ! -s "$LOG_FILE" ]]

if output="$(run_capture "$REPO_ROOT/infra/scripts/destroy-demo.sh" --dry-run --apply --confirm 2>&1)"; then
  printf 'destroy dry-run/apply combination unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'--dry-run cannot be combined with --apply'* ]]
[[ ! -s "$LOG_FILE" ]]

if output="$(run_capture "$REPO_ROOT/infra/scripts/wake-demo.sh" --latest --apply --dry-run --confirm 2>&1)"; then
  printf 'wake dry-run/apply combination unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'--dry-run cannot be combined with --apply'* ]]
[[ ! -s "$LOG_FILE" ]]

INSTANCE_INVENTORY="$EXPECTED_INSTANCE" STATIC_IP_INVENTORY="$EXPECTED_STATIC_IP" \
  output="$(run_capture "$REPO_ROOT/infra/scripts/destroy-demo.sh" --dry-run 2>&1)"
[[ "$output" == *'Dry-run passed'* ]]
grep -Fq 'terraform' "$LOG_FILE"
! grep -Eq '^(ssh|scp|rsync) ' "$LOG_FILE"
! grep -Eq '^aws (s3|s3api)' "$LOG_FILE"
! grep -Eq 'terraform .* apply' "$LOG_FILE"

jq '(.resource_changes[] | select(.address == "aws_lightsail_distribution.web[0]").change.actions) = ["update"]' "$PLAN_JSON" > "$TEST_ROOT/unsafe-plan.json"
cp "$TEST_ROOT/unsafe-plan.json" "$PLAN_JSON"
if INSTANCE_INVENTORY="$EXPECTED_INSTANCE" STATIC_IP_INVENTORY="$EXPECTED_STATIC_IP" \
  output="$(run_capture "$REPO_ROOT/infra/scripts/destroy-demo.sh" --dry-run 2>&1)"; then
  printf 'distribution update unexpectedly passed hibernation allowlist\n' >&2
  exit 1
fi
[[ "$output" == *'unexpected resource change'* ]]
jq '(.resource_changes[] | select(.address == "aws_lightsail_distribution.web[0]").change.actions) = ["delete"]' "$PLAN_JSON" > "$TEST_ROOT/safe-plan.json"
cp "$TEST_ROOT/safe-plan.json" "$PLAN_JSON"

INSTANCE_INVENTORY="$EXPECTED_INSTANCE" STATIC_IP_INVENTORY="$EXPECTED_STATIC_IP" \
  output="$(run_capture "$REPO_ROOT/infra/scripts/destroy-demo.sh" 2>&1)"
[[ "$output" == *'Dry-run passed'* ]]
! grep -Eq '^(ssh|scp|rsync) ' "$LOG_FILE"
! grep -Eq '^aws (s3|s3api)' "$LOG_FILE"

CALLER_ACCOUNT='999999999999' INSTANCE_INVENTORY="$EXPECTED_INSTANCE" STATIC_IP_INVENTORY="$EXPECTED_STATIC_IP"
if output="$(run_capture "$REPO_ROOT/infra/scripts/destroy-demo.sh" --apply --confirm 2>&1)"; then
  printf 'destroy with the wrong AWS account unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'not the configured Demo account'* ]]
grep -Fq 'aws sts get-caller-identity' "$LOG_FILE"
assert_no_host_or_apply_commands

CALLER_ACCOUNT='330599756236'
INSTANCE_INVENTORY='{"instances":[{"name":"rewind-demo","state":{"name":"running"},"publicIpAddress":"198.51.100.20","tags":[{"key":"Project","value":"rewind"},{"key":"Environment","value":"demo"},{"key":"ManagedBy","value":"terraform"}]},{"name":"rewind-surprise","state":{"name":"running"},"publicIpAddress":"198.51.100.21","tags":[{"key":"Project","value":"rewind"}]}]}'
STATIC_IP_INVENTORY="$EXPECTED_STATIC_IP"
if output="$(run_capture "$REPO_ROOT/infra/scripts/destroy-demo.sh" --apply --confirm 2>&1)"; then
  printf 'destroy with an unexpected instance unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'unexpected Rewind Lightsail instance'* ]]
assert_no_host_or_apply_commands

INSTANCE_INVENTORY="$EXPECTED_INSTANCE" STATIC_IP_INVENTORY="$EXPECTED_STATIC_IP" SSH_MODE=backup
if output="$(run_capture "$REPO_ROOT/infra/scripts/destroy-demo.sh" --apply --confirm 2>&1)"; then
  printf 'destroy with an invalid host backup unexpectedly succeeded\n' >&2
  exit 1
fi
[[ "$output" == *'backup manifest rejected'* ]]
grep -Eq '^ssh ' "$LOG_FILE"
grep -Eq '^scp ' "$LOG_FILE"
! grep -Eq '^aws s3 ' "$LOG_FILE"
! grep -Eq 'terraform .* plan' "$LOG_FILE"
! grep -Eq 'terraform .* apply' "$LOG_FILE"

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
