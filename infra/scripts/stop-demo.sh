#!/usr/bin/env bash
# Stop only through the controller after the host uploaded a current manifest.
set -Eeuo pipefail

if [[ "$#" -ne 1 ]]; then
  echo 'Usage: stop-demo.sh rewind-demo/rewind-<timestamp>.manifest.json' >&2
  exit 2
fi

manifest_key="$1"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
AWS_PROFILE="${AWS_PROFILE:-rewind-demo-operator}"
FUNCTION_NAME="${REWIND_POWER_CONTROLLER_FUNCTION:-rewind-demo-power-controller}"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
payload="$(printf '{"action":"stop","backup_manifest_key":"%s"}' "$manifest_key")"

function_error="$(AWS_PROFILE="$AWS_PROFILE" aws lambda invoke \
  --function-name "$FUNCTION_NAME" \
  --region "$AWS_REGION" \
  --cli-binary-format raw-in-base64-out \
  --payload "$payload" \
  --query 'FunctionError' --output text \
  "$response_file")"
cat "$response_file"
[[ "$function_error" == "None" ]] || exit 1
