#!/usr/bin/env bash
# Start through the cloud controller. This profile cannot modify Lightsail.
set -Eeuo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
AWS_PROFILE="${AWS_PROFILE:-rewind-demo-operator}"
FUNCTION_NAME="${REWIND_POWER_CONTROLLER_FUNCTION:-rewind-demo-power-controller}"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

function_error="$(AWS_PROFILE="$AWS_PROFILE" aws lambda invoke \
  --function-name "$FUNCTION_NAME" \
  --region "$AWS_REGION" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"action":"start"}' \
  --query 'FunctionError' --output text \
  "$response_file")"
cat "$response_file"
[[ "$function_error" == "None" ]] || exit 1
