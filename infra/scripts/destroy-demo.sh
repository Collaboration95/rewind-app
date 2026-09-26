#!/usr/bin/env bash
# Back up the live Demo host, then hibernate disposable compute and its optional
# distribution through Terraform. Preserve the backup bucket and recovery IAM.
#
# The default is a read-only plan. Only --apply --confirm can reach the host
# backup, S3 upload, or Terraform apply stages.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/operator-common.sh"
# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/backup-manifest.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lifecycle-guards.sh"

TF_DIR="${TF_DIR:-$REPO_ROOT/infra/terraform/demo}"
TFVARS_FILE="${TFVARS_FILE:-$TF_DIR/terraform.tfvars}"
TF_AWS_PROFILE="${TF_AWS_PROFILE:-rewind-terraform-apply}"
BACKUP_AWS_PROFILE="${BACKUP_AWS_PROFILE:-$TF_AWS_PROFILE}"
BACKUP_BUCKET="${BACKUP_BUCKET:-rewind-demo-backups-330599756236}"
BACKUP_PREFIX="${BACKUP_PREFIX:-rewind-demo}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
SSH_USER="${SSH_USER:-ubuntu}"

APPLY=0
CONFIRM=0
DRY_RUN_REQUESTED=0
SSH_KNOWN_HOSTS_EPHEMERAL=0
SSH_KNOWN_HOSTS_FILE="${SSH_KNOWN_HOSTS_FILE:-}"
stage_dir=""
plan_file=""
plan_json=""

usage() {
  printf 'Usage: %s [--dry-run] | %s --apply --confirm\n' "$(basename "$0")" "$(basename "$0")" >&2
  printf '%s\n' 'Default and --dry-run modes perform read-only identity, inventory, and Terraform-plan checks.' >&2
  printf '%s\n' '--apply --confirm is the only form that may back up the host, upload S3 objects, or apply Terraform.' >&2
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN_REQUESTED=1 ;;
    --confirm) CONFIRM=1 ;;
    --apply) APPLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ "$APPLY" == 1 && "$DRY_RUN_REQUESTED" == 1 ]]; then
  lifecycle_guard_reject '--dry-run cannot be combined with --apply; no cloud or host command was run.'
  exit 2
fi
if [[ "$APPLY" == 1 && "$CONFIRM" != 1 ]]; then
  lifecycle_guard_reject '--apply requires explicit --confirm; no cloud or host command was run.'
  exit 2
fi
if [[ "$APPLY" == 0 && "$CONFIRM" == 1 ]]; then
  printf 'Dry-run selected: --confirm without --apply remains read-only.\n' >&2
fi

require_command terraform
require_command aws
require_command jq
[[ -d "$TF_DIR" ]] || { lifecycle_guard_reject 'the Terraform directory is missing.'; exit 1; }
[[ -f "$TFVARS_FILE" ]] || { lifecycle_guard_reject 'the Terraform variables file is missing.'; exit 1; }

if [[ "$APPLY" == 1 ]]; then
  require_command ssh
  require_command scp
fi

lifecycle_load_expected_account "$TFVARS_FILE"
lifecycle_require_aws_identity "$TF_AWS_PROFILE" 'Terraform'
lifecycle_require_existing_demo_instance "$TF_AWS_PROFILE"
host_ip="$LIFECYCLE_HOST_IP"

terraform_state_ip="$(AWS_PROFILE="$TF_AWS_PROFILE" terraform -chdir="$TF_DIR" \
  output -raw demo_static_ip 2>/dev/null || true)"
[[ "$terraform_state_ip" == "$host_ip" ]] || {
  lifecycle_guard_reject 'Terraform state and the identified Lightsail host disagree on the static IP.'
  exit 1
}

validate_hibernation_plan() {
  local json_path="$1"

  jq -e '
    any(.resource_changes[]?;
      .address == "aws_lightsail_instance.rewind[0]" and
      (.change.actions // []) == ["delete"]
    )
  ' "$json_path" >/dev/null || {
    lifecycle_guard_reject 'the Terraform plan does not delete the disposable Demo instance.'
    return 1
  }

  if ! jq -e '
    all((.resource_changes // [])[];
      .mode == "data" or
      (.change.actions // []) == ["no-op"] or
      (
        .address as $address |
        .change.actions as $actions |
        (
          [
            "aws_lightsail_instance.rewind[0]",
            "aws_lightsail_static_ip.rewind[0]",
            "aws_lightsail_static_ip_attachment.rewind[0]",
            "aws_lightsail_instance_public_ports.rewind[0]",
            "aws_lightsail_distribution.web[0]",
            "aws_iam_role.power_controller[0]",
            "aws_iam_role_policy.power_controller[0]",
            "aws_iam_role_policy.operator[0]",
            "aws_iam_role_policy.scheduler[0]",
            "aws_lambda_function.power_controller[0]",
            "aws_scheduler_schedule.automatic_start[0]"
          ] | index($address)
        ) != null and $actions == ["delete"]
      ) or
      (
        .address as $address |
        .change.actions as $actions |
        (
          [
            "aws_iam_role.cost_safety_audit",
            "aws_iam_role.cost_safety_audit_scheduler",
            "aws_iam_role_policy.cost_safety_audit",
            "aws_iam_role_policy.cost_safety_audit_scheduler",
            "aws_lambda_function.cost_safety_audit"
          ] | index($address)
        ) != null and $actions == ["update"]
      )
    )
  ' "$json_path" >/dev/null; then
    lifecycle_guard_reject 'the Terraform plan contains an unexpected resource change; refusing hibernation.'
    return 1
  fi

}

run_hibernation_plan() {
  plan_file="$(mktemp "${TMPDIR:-/tmp}/rewind-hibernate.XXXXXX")"
  plan_json="$(mktemp "${TMPDIR:-/tmp}/rewind-hibernate.XXXXXX")"
  if ! AWS_PROFILE="$TF_AWS_PROFILE" terraform -chdir="$TF_DIR" plan \
    -var-file="$TFVARS_FILE" \
    -var='demo_instance_enabled=false' \
    -out="$plan_file"; then
    lifecycle_guard_reject 'Terraform could not create the hibernation plan; nothing was applied.'
    return 1
  fi
  if ! AWS_PROFILE="$TF_AWS_PROFILE" terraform -chdir="$TF_DIR" show -json "$plan_file" >"$plan_json"; then
    lifecycle_guard_reject 'the Terraform hibernation plan could not be inspected; refusing to continue.'
    return 1
  fi
  validate_hibernation_plan "$plan_json"
}

cleanup() {
  [[ -z "$stage_dir" ]] || rm -rf -- "$stage_dir"
  [[ -z "$plan_file" ]] || rm -f -- "$plan_file"
  [[ -z "$plan_json" ]] || rm -f -- "$plan_json"
  if [[ "$SSH_KNOWN_HOSTS_EPHEMERAL" == 1 ]]; then
    rm -f -- "$SSH_KNOWN_HOSTS_FILE"
  fi
}
trap cleanup EXIT

if [[ "$APPLY" == 0 ]]; then
  run_hibernation_plan
  printf 'Dry-run passed: the plan is eligible to remove disposable Demo compute/network and its optional public distribution, and disable legacy controller bindings.\n'
  printf '%s\n' 'No SSH backup, S3 upload, or Terraform apply was performed.'
  exit 0
fi

lifecycle_require_aws_identity "$BACKUP_AWS_PROFILE" 'Backup'
validate_backup_prefix "$BACKUP_PREFIX"

if [[ -z "$SSH_KNOWN_HOSTS_FILE" ]]; then
  SSH_KNOWN_HOSTS_FILE="$(mktemp "${TMPDIR:-/tmp}/rewind-known-hosts.XXXXXX")"
  SSH_KNOWN_HOSTS_EPHEMERAL=1
fi
SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="$SSH_KNOWN_HOSTS_FILE"
)

stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/rewind-hibernate.XXXXXX")"
printf 'Creating and verifying a fresh database/media backup before the reviewed apply ...\n'
backup_output=""
if ! backup_output="$(ssh "${SSH_OPTS[@]}" "$SSH_USER@$host_ip" \
  'cd /srv/rewind && ./deploy/backup.sh --local-only' 2>/dev/null)"; then
  lifecycle_guard_reject 'the host backup command failed; Terraform apply was not reached.'
  exit 1
fi
backup_line="$(sed -n 's/^Local backup ready //p' <<<"$backup_output" | tail -n 1)"
read -r remote_manifest remote_database remote_media <<<"$backup_line" || true
[[ -n "${remote_manifest:-}" && -n "${remote_database:-}" && -n "${remote_media:-}" && \
  "$remote_manifest" == /srv/rewind/backups/rewind-*.manifest.json && \
  "$remote_database" == /srv/rewind/backups/rewind-*.sqlite.gz && \
  "$remote_media" == /srv/rewind/backups/rewind-*.media.tar.gz ]] || {
  lifecycle_guard_reject 'the host backup did not return the three expected artifacts; Terraform apply was not reached.'
  exit 1
}
if ! scp "${SSH_OPTS[@]}" \
  "$SSH_USER@$host_ip:$remote_manifest" \
  "$SSH_USER@$host_ip:$remote_database" \
  "$SSH_USER@$host_ip:$remote_media" \
  "$stage_dir/" >/dev/null 2>&1; then
  lifecycle_guard_reject 'the verified host backup could not be copied to the operator; Terraform apply was not reached.'
  exit 1
fi

manifest_name="${remote_manifest##*/}"
database_name="${remote_database##*/}"
media_name="${remote_media##*/}"
validate_backup_manifest "$stage_dir/$manifest_name" "$BACKUP_PREFIX"
verify_backup_manifest_archives "$stage_dir"

manifest_key="$BACKUP_PREFIX/$manifest_name"
if ! AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3 cp "$stage_dir/$database_name" \
  "s3://$BACKUP_BUCKET/$BACKUP_MANIFEST_DATABASE_KEY" --sse AES256 --only-show-errors >/dev/null 2>&1 || \
  ! AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3 cp "$stage_dir/$media_name" \
  "s3://$BACKUP_BUCKET/$BACKUP_MANIFEST_MEDIA_KEY" --sse AES256 --only-show-errors >/dev/null 2>&1 || \
  ! AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3 cp "$stage_dir/$manifest_name" \
  "s3://$BACKUP_BUCKET/$manifest_key" --sse AES256 --only-show-errors >/dev/null 2>&1; then
  lifecycle_guard_reject 'the verified recovery point could not be uploaded; Terraform apply was not reached.'
  exit 1
fi
if ! AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3api head-object \
  --bucket "$BACKUP_BUCKET" --key "$BACKUP_MANIFEST_DATABASE_KEY" >/dev/null 2>&1 || \
  ! AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3api head-object \
  --bucket "$BACKUP_BUCKET" --key "$BACKUP_MANIFEST_MEDIA_KEY" >/dev/null 2>&1 || \
  ! AWS_PROFILE="$BACKUP_AWS_PROFILE" aws s3api head-object \
  --bucket "$BACKUP_BUCKET" --key "$manifest_key" >/dev/null 2>&1; then
  lifecycle_guard_reject 'the uploaded recovery point could not be verified in S3; Terraform apply was not reached.'
  exit 1
fi
printf 'Verified recovery point is ready for hibernation.\n'

run_hibernation_plan
printf 'Applying the reviewed hibernation plan: disposable compute and any configured public distribution will be deleted.\n'
if ! AWS_PROFILE="$TF_AWS_PROFILE" terraform -chdir="$TF_DIR" apply "$plan_file"; then
  lifecycle_guard_reject 'Terraform apply failed after the verified backup was secured.'
  exit 1
fi
printf 'Demo compute and public distribution hibernated. The verified S3 backup, recovery roles, and audit infrastructure remain.\n'
