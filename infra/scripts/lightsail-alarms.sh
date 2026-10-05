#!/usr/bin/env bash
# Idempotent Lightsail alarms for the hosted dev host (#166). Terraform's AWS
# provider has no Lightsail contact-method or alarm resources, so this script
# is the reviewed source of truth. Re-running updates the alarms in place.
set -Eeuo pipefail
export AWS_PROFILE=${AWS_PROFILE:-rewind-terraform-apply}
export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-ap-southeast-1}
INSTANCE=${REWIND_INSTANCE:-rewind-demo}
EMAIL=${REWIND_ALERT_EMAIL:?Set REWIND_ALERT_EMAIL to the alert recipient}

# One email contact per region; AWS sends a one-time verification link.
if ! aws lightsail get-contact-methods --protocols Email --query 'contactMethods[].contactEndpoint' --output text | grep -qx "$EMAIL"; then
  aws lightsail create-contact-method --protocol Email --contact-endpoint "$EMAIL" >/dev/null
  echo "Created the email contact; confirm the verification email to start receiving alerts."
fi

alarm() {
  aws lightsail put-alarm --alarm-name "$1" --monitored-resource-name "$INSTANCE" \
    --metric-name "$2" --comparison-operator "$3" --threshold "$4" \
    --evaluation-periods "$5" --datapoints-to-alarm "$5" --treat-missing-data "${6:-missing}" \
    --contact-protocols Email --notification-triggers ALARM OK --notification-enabled >/dev/null
  echo "Alarm $1 set."
}

# Host or runtime is unreachable (failed system/instance status checks).
alarm rewind-dev-status-check-failed StatusCheckFailed GreaterThanOrEqualToThreshold 1 2 breaching
# Sustained CPU saturation (for example a runaway compile).
alarm rewind-dev-cpu-high CPUUtilization GreaterThanOrEqualToThreshold 90 3
# Burstable instance about to be throttled.
alarm rewind-dev-burst-capacity-low BurstCapacityPercentage LessThanOrEqualToThreshold 10 3
