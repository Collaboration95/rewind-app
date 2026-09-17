#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == "--i-have-a-current-s3-backup" ]] || { echo 'Refusing emergency stop without --i-have-a-current-s3-backup.' >&2; exit 2; }
INSTANCE_NAME="${REWIND_INSTANCE_NAME:-rewind-demo}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
AWS_PROFILE="${AWS_PROFILE:-default}"
AWS_PROFILE="$AWS_PROFILE" aws lightsail stop-instance --instance-name "$INSTANCE_NAME" --region "$AWS_REGION" >/dev/null
echo "Stop requested for $INSTANCE_NAME. The Lightsail monthly bundle still accrues while stopped."
