#!/usr/bin/env bash
# Read-only AWS identity and Lightsail inventory guards shared by the hosted
# lifecycle scripts. These checks deliberately fail closed and never invoke a
# mutating AWS, Terraform, SSH, or host command.

lifecycle_guard_reject() {
  printf 'ERROR: lifecycle guard: %s\n' "$1" >&2
  return 1
}
lifecycle_load_expected_account() {
  local tfvars_file="${1:-}" configured_account

  configured_account="${EXPECTED_AWS_ACCOUNT_ID:-${TF_VAR_account_id:-}}"
  if [[ -z "$configured_account" && -f "$tfvars_file" ]]; then
    configured_account="$(awk '
      $1 == "account_id" && $2 == "=" {
        value = $3
        gsub(/["\047,]/, "", value)
        print value
        exit
      }
    ' "$tfvars_file")"
  fi

  [[ "$configured_account" =~ ^[0-9]{12}$ ]] || {
    lifecycle_guard_reject 'a 12-digit expected AWS account_id must be configured before any lifecycle operation.'
    return 1
  }
  LIFECYCLE_EXPECTED_ACCOUNT_ID="$configured_account"
}

lifecycle_require_aws_identity() {
  local profile="${1:-}" label="${2:-AWS}" account

  if ! account="$(AWS_PROFILE="$profile" aws sts get-caller-identity \
    --query Account --output text 2>/dev/null)"; then
    lifecycle_guard_reject "$label AWS identity could not be verified; refusing to continue."
    return 1
  fi
  [[ "$account" == "$LIFECYCLE_EXPECTED_ACCOUNT_ID" ]] || {
    lifecycle_guard_reject "$label AWS identity is not the configured Demo account; refusing to continue."
    return 1
  }
}

lifecycle_get_lightsail_instances() {
  AWS_PROFILE="$1" aws lightsail get-instances \
    --region "$AWS_REGION" --output json 2>/dev/null
}

lifecycle_get_lightsail_static_ips() {
  AWS_PROFILE="$1" aws lightsail get-static-ips \
    --region "$AWS_REGION" --output json 2>/dev/null
}

lifecycle_inventory_has_unexpected_instances() {
  local inventory="$1"

  jq -e --arg expected_name 'rewind-demo' '
    [(.instances // [])[]?
      | select((.name? | type) == "string")
      | select(
          .name != $expected_name and
          (
            (.name | startswith("rewind-")) or
            any((.tags // [])[]?;
              (.key == "Project" and .value == "rewind") or
              (.key == "Environment" and .value == "demo")
            )
          )
        )
    ] | length == 0
  ' <<<"$inventory" >/dev/null
}

lifecycle_inventory_has_unexpected_static_ips() {
  local inventory="$1"

  jq -e --arg expected_name 'rewind-demo-ip' '
    [(.staticIps // [])[]?
      | select((.name? | type) == "string")
      | select(
          .name != $expected_name and
          (
            (.name | startswith("rewind-")) or
            any((.tags // [])[]?;
              (.key == "Project" and .value == "rewind") or
              (.key == "Environment" and .value == "demo")
            )
          )
        )
    ] | length == 0
  ' <<<"$inventory" >/dev/null
}

lifecycle_require_no_unexpected_resources() {
  local profile="$1" instances static_ips

  if ! instances="$(lifecycle_get_lightsail_instances "$profile")"; then
    lifecycle_guard_reject 'Lightsail instance inventory could not be read; refusing to continue.'
    return 1
  fi
  if ! static_ips="$(lifecycle_get_lightsail_static_ips "$profile")"; then
    lifecycle_guard_reject 'Lightsail static-IP inventory could not be read; refusing to continue.'
    return 1
  fi
  lifecycle_inventory_has_unexpected_instances "$instances" || {
    lifecycle_guard_reject 'an unexpected Rewind Lightsail instance is present; refusing lifecycle mutation.'
    return 1
  }
  lifecycle_inventory_has_unexpected_static_ips "$static_ips" || {
    lifecycle_guard_reject 'an unexpected Rewind static IP is present; refusing lifecycle mutation.'
    return 1
  }
  LIFECYCLE_INSTANCE_INVENTORY="$instances"
  LIFECYCLE_STATIC_IP_INVENTORY="$static_ips"
}

lifecycle_instance_has_expected_tags() {
  local instance_json="$1"

  jq -e '
    any((.tags // [])[]?; .key == "Project" and .value == "rewind") and
    any((.tags // [])[]?; .key == "Environment" and .value == "demo") and
    any((.tags // [])[]?; .key == "ManagedBy" and .value == "terraform")
  ' <<<"$instance_json" >/dev/null
}

lifecycle_require_existing_demo_instance() {
  local profile="$1" instances static_ips instance_count static_ip_count instance_json

  lifecycle_require_no_unexpected_resources "$profile" || return 1
  instances="$LIFECYCLE_INSTANCE_INVENTORY"
  static_ips="$LIFECYCLE_STATIC_IP_INVENTORY"
  instance_count="$(jq '[.instances // [] | .[]? | select(.name == "rewind-demo")] | length' <<<"$instances")"
  [[ "$instance_count" == 1 ]] || {
    lifecycle_guard_reject 'the expected Rewind Demo instance is not present exactly once; refusing lifecycle mutation.'
    return 1
  }

  instance_json="$(jq -c '.instances[] | select(.name == "rewind-demo")' <<<"$instances")"
  lifecycle_instance_has_expected_tags "$instance_json" || {
    lifecycle_guard_reject 'the named Lightsail instance does not carry the expected Rewind Terraform identity tags.'
    return 1
  }
  [[ "$(jq -r '.state.name // empty' <<<"$instance_json")" == 'running' ]] || {
    lifecycle_guard_reject 'the expected Rewind Demo instance is not running; refusing to back up or destroy it.'
    return 1
  }
  LIFECYCLE_HOST_IP="$(jq -r '.publicIpAddress // empty' <<<"$instance_json")"
  [[ "$LIFECYCLE_HOST_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || {
    lifecycle_guard_reject 'the expected Rewind Demo instance has no valid public IPv4 identity.'
    return 1
  }

  static_ip_count="$(jq '[.staticIps // [] | .[]? | select(.name == "rewind-demo-ip")] | length' <<<"$static_ips")"
  [[ "$static_ip_count" == 1 ]] || {
    lifecycle_guard_reject 'the expected Rewind static IP is not present exactly once; refusing lifecycle mutation.'
    return 1
  }
  if ! jq -e '
    any(.staticIps // [] | .[]?;
      .name == "rewind-demo-ip" and
      ((.attachedTo // "") == "" or .attachedTo == "rewind-demo")
    )
  ' <<<"$static_ips" >/dev/null; then
    lifecycle_guard_reject 'the expected Rewind static IP is attached to an unexpected instance.'
    return 1
  fi
}

lifecycle_require_absent_demo_instance() {
  local profile="$1" instances instance_count

  lifecycle_require_no_unexpected_resources "$profile" || return 1
  instances="$LIFECYCLE_INSTANCE_INVENTORY"
  instance_count="$(jq '[.instances // [] | .[]? | select(.name == "rewind-demo")] | length' <<<"$instances")"
  [[ "$instance_count" == 0 ]] || {
    lifecycle_guard_reject 'the Rewind Demo instance already exists; refusing to replace a live host.'
    return 1
  }
}
