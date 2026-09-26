#!/usr/bin/env bash
# Recreate the disposable host with Terraform, then restore a verified S3
# database/media recovery point before starting the runtime.
#
# The default is a read-only plan. Only --apply --confirm can reach Terraform
# apply, SSH, SCP, or rsync. --seed is an explicit first-install exception:
# it has no historical recovery point and therefore must never be mistaken for
# a recovery apply in operator output or documentation.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/operator-common.sh"
# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/backup-manifest.sh"
# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/recovery-selection.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lifecycle-guards.sh"

TF_DIR="${TF_DIR:-$REPO_ROOT/infra/terraform/demo}"
TFVARS_FILE="${TFVARS_FILE:-$TF_DIR/terraform.tfvars}"
TF_AWS_PROFILE="${TF_AWS_PROFILE:-rewind-terraform-apply}"
BACKUP_AWS_PROFILE="${BACKUP_AWS_PROFILE:-$TF_AWS_PROFILE}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
BACKUP_BUCKET="${BACKUP_BUCKET:-rewind-demo-backups-330599756236}"
BACKUP_PREFIX="${BACKUP_PREFIX:-rewind-demo}"
REWIND_ENV_FILE="${REWIND_ENV_FILE:-$REPO_ROOT/deploy/rewind.env}"
SSH_USER="${SSH_USER:-ubuntu}"
RELEASE_BUNDLE="${RELEASE_BUNDLE:-}"
RELEASE_BUNDLE_SHA256="${RELEASE_BUNDLE_SHA256:-}"

MANIFEST_SELECTOR=""
APPLY=0
CONFIRM=0
DRY_RUN_REQUESTED=0
SEED=0
stage_dir=""
plan_file=""
plan_json=""
SSH_KNOWN_HOSTS_EPHEMERAL=0
SSH_KNOWN_HOSTS_FILE="${SSH_KNOWN_HOSTS_FILE:-}"

usage() {
  printf 'Usage: %s [--latest | --manifest s3://bucket/key | --seed] [--dry-run]\n' "$(basename "$0")" >&2
  printf '       %s [--latest | --manifest s3://bucket/key | --seed] --apply --confirm\n' "$(basename "$0")" >&2
  printf '%s\n' 'Set RELEASE_BUNDLE to a verified release archive; default and --dry-run validate it with identity, inventory, recovery inputs, and the Terraform plan.' >&2
  printf '%s\n' '--apply --confirm is required before Terraform apply, SSH, SCP, or rsync can run.' >&2
  printf '%s\n' '--seed is only the explicit first-install path; it is not a historical recovery point.' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest)
      [[ -z "$MANIFEST_SELECTOR" ]] || { usage; exit 2; }
      MANIFEST_SELECTOR=latest
      shift
      ;;
    --manifest)
      [[ $# -ge 2 && -z "$MANIFEST_SELECTOR" ]] || { usage; exit 2; }
      MANIFEST_SELECTOR="$2"
      shift 2
      ;;
    --seed)
      [[ -z "$MANIFEST_SELECTOR" ]] || { usage; exit 2; }
      MANIFEST_SELECTOR=seed
      SEED=1
      shift
      ;;
    --dry-run) DRY_RUN_REQUESTED=1; shift ;;
    --confirm) CONFIRM=1; shift ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

[[ -n "$MANIFEST_SELECTOR" ]] || MANIFEST_SELECTOR=latest
if [[ "$APPLY" == 1 && "$DRY_RUN_REQUESTED" == 1 ]]; then
  lifecycle_guard_reject '--dry-run cannot be combined with --apply; no AWS, Terraform, or host command was run.'
  exit 2
fi
if [[ "$APPLY" == 1 && "$CONFIRM" != 1 ]]; then
  lifecycle_guard_reject '--apply requires explicit --confirm; no AWS, Terraform, or host command was run.'
  exit 2
fi
if [[ "$APPLY" == 0 && "$CONFIRM" == 1 ]]; then
  printf 'Dry-run selected: --confirm without --apply remains read-only.\n' >&2
fi

require_command terraform
require_command aws
require_command jq
require_command python3
[[ -n "$RELEASE_BUNDLE" && -f "$RELEASE_BUNDLE" ]] || {
  lifecycle_guard_reject 'RELEASE_BUNDLE must name a built release bundle.'
  exit 1
}
[[ "$RELEASE_BUNDLE_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  lifecycle_guard_reject 'RELEASE_BUNDLE_SHA256 must be the reviewed release digest.'
  exit 1
}
[[ "$(sha256sum "$RELEASE_BUNDLE" | cut -d ' ' -f 1)" == "$RELEASE_BUNDLE_SHA256" ]] || {
  lifecycle_guard_reject 'the release bundle differs from the reviewed digest.'
  exit 1
}
release_sha="$(python3 "$REPO_ROOT/deploy/release.py" verify "$RELEASE_BUNDLE")" || {
  lifecycle_guard_reject 'the release bundle failed provenance or checksum verification.'
  exit 1
}
[[ -d "$TF_DIR" ]] || { lifecycle_guard_reject 'the Terraform directory is missing.'; exit 1; }
[[ -f "$TFVARS_FILE" ]] || { lifecycle_guard_reject 'the Terraform variables file is missing.'; exit 1; }
[[ -f "$REWIND_ENV_FILE" ]] || {
  lifecycle_guard_reject 'the operator environment file is missing; recovery cannot continue.'
  exit 1
}

if [[ "$APPLY" == 1 ]]; then
  require_command ssh
  require_command scp
fi

lifecycle_load_expected_account "$TFVARS_FILE"
lifecycle_require_aws_identity "$TF_AWS_PROFILE" 'Terraform'
lifecycle_require_absent_demo_instance "$TF_AWS_PROFILE"

cleanup() {
  [[ -z "$stage_dir" ]] || rm -rf -- "$stage_dir"
  [[ -z "$plan_file" ]] || rm -f -- "$plan_file"
  [[ -z "$plan_json" ]] || rm -f -- "$plan_json"
  if [[ "$SSH_KNOWN_HOSTS_EPHEMERAL" == 1 ]]; then
    rm -f -- "$SSH_KNOWN_HOSTS_FILE"
  fi
}
trap cleanup EXIT

stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/rewind-wake.XXXXXX")"
manifest_name=""
database_name=""
media_name=""
recovery_dir=""

if [[ "$SEED" == 1 ]]; then
  printf 'Seed mode selected: no historical S3 recovery point will be restored.\n'
else
  lifecycle_require_aws_identity "$BACKUP_AWS_PROFILE" 'Backup'
  validate_backup_prefix "$BACKUP_PREFIX"
  if [[ "$MANIFEST_SELECTOR" == latest ]]; then
    recovery_select_latest "$stage_dir"
  else
    recovery_select_explicit "$MANIFEST_SELECTOR" "$stage_dir"
  fi
  manifest_name="$RECOVERY_SELECTION_MANIFEST_NAME"
  database_name="$RECOVERY_SELECTION_DATABASE_NAME"
  media_name="$RECOVERY_SELECTION_MEDIA_NAME"
  recovery_dir="$RECOVERY_SELECTION_DIR"
  MANIFEST_SELECTOR="$RECOVERY_SELECTION_URI"
  printf 'Verified recovery point selected: %s\n' "$MANIFEST_SELECTOR"
fi

validate_recreate_plan() {
  local json_path="$1"

  jq -e '
    any(.resource_changes[]?;
      .address == "aws_lightsail_instance.rewind[0]" and
      (.change.actions // []) == ["create"]
    )
  ' "$json_path" >/dev/null || {
    lifecycle_guard_reject 'the Terraform plan does not create the disposable Demo instance.'
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
        ) != null and $actions == ["create"]
      ) or
      (
        .address == "aws_iam_role_policy.power_controller[0]" and
        (.change.actions // []) == ["update"] and
        (.change.after_unknown.policy == true) and
        ((.change.after_unknown | keys) == ["policy"]) and
        ((.change.before | del(.policy)) == (.change.after | del(.policy))) and
        ((.change.before.policy | fromjson | .Statement) |
          any(.[];
            .Sid == "ControlOnlyTheRewindDemo" and
            .Effect == "Allow" and
            (.Action | sort) == ["lightsail:StartInstance", "lightsail:StopInstance"] and
            ((.Resource | if type == "array" then .[0] else . end) |
              test("^arn:aws:lightsail:[a-z0-9-]+:[0-9]{12}:Instance/[A-Za-z0-9-]+$"))
          ))
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
    lifecycle_guard_reject 'the Terraform plan contains an unexpected resource change; refusing recreation.'
    return 1
  fi

}

plan_file="$(mktemp "${TMPDIR:-/tmp}/rewind-wake.XXXXXX")"
plan_json="$(mktemp "${TMPDIR:-/tmp}/rewind-wake.XXXXXX")"
if ! AWS_PROFILE="$TF_AWS_PROFILE" terraform -chdir="$TF_DIR" plan \
  -var-file="$TFVARS_FILE" \
  -var='demo_instance_enabled=true' \
  -out="$plan_file"; then
  lifecycle_guard_reject 'Terraform could not create the recreation plan; nothing was applied.'
  exit 1
fi
if ! AWS_PROFILE="$TF_AWS_PROFILE" terraform -chdir="$TF_DIR" show -json "$plan_file" >"$plan_json"; then
  lifecycle_guard_reject 'the Terraform recreation plan could not be inspected; refusing to continue.'
  exit 1
fi
validate_recreate_plan "$plan_json"

if [[ "$APPLY" == 0 ]]; then
  printf 'Dry-run passed: the plan is eligible to recreate disposable Demo compute/network and its controller bindings.\n'
  printf '%s\n' 'No Terraform apply, SSH, SCP, or rsync was performed.'
  exit 0
fi

printf 'Applying the reviewed recreation plan ...\n'
if ! AWS_PROFILE="$TF_AWS_PROFILE" terraform -chdir="$TF_DIR" apply "$plan_file"; then
  lifecycle_guard_reject 'Terraform apply failed; host transfer and restore were not attempted.'
  exit 1
fi
host_ip="$(AWS_PROFILE="$TF_AWS_PROFILE" terraform -chdir="$TF_DIR" output -raw demo_static_ip 2>/dev/null || true)"
[[ "$host_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || {
  lifecycle_guard_reject 'Terraform did not return a valid new Demo static IP; host transfer was not attempted.'
  exit 1
}

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

printf 'Waiting for the new host bootstrap ...\n'
ready=0
for _ in $(seq 1 120); do
  if ssh "${SSH_OPTS[@]}" "$SSH_USER@$host_ip" \
    'test -f /srv/rewind/.host-bootstrap-prerequisites && docker compose version >/dev/null 2>&1' \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 5
done
[[ "$ready" == 1 ]] || {
  lifecycle_guard_reject 'the new host did not become ready within the bootstrap window.'
  exit 1
}

printf 'Copying the verified release and private runtime configuration ...\n'
if ! scp "${SSH_OPTS[@]}" "$RELEASE_BUNDLE" \
  "$SSH_USER@$host_ip:/tmp/rewind-release.tar" >/dev/null 2>&1; then
  lifecycle_guard_reject 'the application bundle transfer failed; restore was not attempted.'
  exit 1
fi
if ! scp "${SSH_OPTS[@]}" "$REPO_ROOT/deploy/release.py" "$REPO_ROOT/deploy/release-host.sh" \
  "$SSH_USER@$host_ip:/tmp/" >/dev/null 2>&1; then
  lifecycle_guard_reject 'release verifier transfer failed; restore was not attempted.'
  exit 1
fi
if ! scp "${SSH_OPTS[@]}" "$REWIND_ENV_FILE" \
  "$SSH_USER@$host_ip:/tmp/rewind.env" >/dev/null 2>&1; then
  lifecycle_guard_reject 'the private runtime configuration transfer failed; restore was not attempted.'
  exit 1
fi
if ! ssh "${SSH_OPTS[@]}" "$SSH_USER@$host_ip" '
  set -Eeuo pipefail
  sudo install -o ubuntu -g ubuntu -m 0600 /tmp/rewind.env /srv/rewind/rewind.env
  test "$(sha256sum /tmp/rewind-release.tar | cut -d " " -f 1)" = "'"$(sha256sum "$RELEASE_BUNDLE" | cut -d ' ' -f 1)"'"
  bash /tmp/release-host.sh prepare /tmp/rewind-release.tar
' >/dev/null 2>&1; then
  lifecycle_guard_reject 'host bundle installation failed; restore was not attempted.'
  exit 1
fi

if [[ "$SEED" == 1 ]]; then
  if ! ssh "${SSH_OPTS[@]}" "$SSH_USER@$host_ip" '
    set -Eeuo pipefail
    cd /srv/rewind
    export REWIND_RELEASE_SHA='"$release_sha"'
    docker compose --env-file /srv/rewind/rewind.env -f deploy/compose.yaml run --rm runtime migrate
    docker compose --env-file /srv/rewind/rewind.env -f deploy/compose.yaml up -d
    health_ready=0
    for _ in $(seq 1 30); do
      if curl --fail --silent --show-error http://127.0.0.1:8787/health; then
        health_ready=1
        break
      fi
      sleep 2
    done
    [[ "$health_ready" == 1 ]]
    ./deploy/release-host.sh promote
  ' >/dev/null 2>&1; then
    lifecycle_guard_reject 'seed-mode host initialization or health verification failed.'
    exit 1
  fi
  printf 'Demo seeded. No historical recovery point was restored; create and verify a full S3 backup before hibernating it.\n'
else
  if ! scp "${SSH_OPTS[@]}" \
    "$recovery_dir/$manifest_name" "$recovery_dir/$database_name" "$recovery_dir/$media_name" \
    "$SSH_USER@$host_ip:/tmp/" >/dev/null 2>&1; then
    lifecycle_guard_reject 'the verified recovery point transfer failed; restore was not attempted.'
    exit 1
  fi

  if ! ssh "${SSH_OPTS[@]}" "$SSH_USER@$host_ip" "
    set -Eeuo pipefail
    install -m 0600 /tmp/$manifest_name /srv/rewind/backups/$manifest_name
    install -m 0600 /tmp/$database_name /srv/rewind/backups/$database_name
    install -m 0600 /tmp/$media_name /srv/rewind/backups/$media_name
    cd /srv/rewind
    export REWIND_RELEASE_SHA='"$release_sha"'
    ENV_FILE=/srv/rewind/rewind.env COMPOSE_FILE=/srv/rewind/deploy/compose.yaml \
      DATA_DIR=/srv/rewind/data MEDIA_DIR=/srv/rewind/media BACKUP_DIR=/srv/rewind/backups \
      sudo env REWIND_RELEASE_SHA=$release_sha ENV_FILE=/srv/rewind/rewind.env COMPOSE_FILE=/srv/rewind/deploy/compose.yaml \
        DATA_DIR=/srv/rewind/data MEDIA_DIR=/srv/rewind/media BACKUP_DIR=/srv/rewind/backups \
        ./deploy/restore.sh --confirm /srv/rewind/backups/$manifest_name
    docker compose --env-file /srv/rewind/rewind.env -f deploy/compose.yaml up -d
    health_ready=0
    for _ in \$(seq 1 30); do
      if curl --fail --silent --show-error http://127.0.0.1:8787/health; then
        health_ready=1
        break
      fi
      sleep 2
    done
    [[ "\$health_ready" == 1 ]]
    ./deploy/release-host.sh promote
  " >/dev/null 2>&1; then
    lifecycle_guard_reject 'verified recovery restore or final health verification failed.'
    exit 1
  fi

  printf 'Demo recreated and restored from the verified recovery point.\n'
fi
